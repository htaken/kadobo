/**
 * `scheduled` ハンドラの中身（実装設計 §6.6）。
 *
 * - `*\/5 * * * *`: pending 再送。`forwarding_enabled` を確認 → `created_at` 昇順に最大 20 件取得 →
 *   `source` を `'retry'` にして直列に GAS へ POST → §3.3 に従い更新。
 *   `attempts` が `RETRY_NOTIFY_AT` に達した時点、以後 `RETRY_NOTIFY_EVERY` 回ごとにメンション通知。
 * - `17 3 * * *`: §5 の 30 日削除・nonce 削除。
 */
import { JOURNAL_RETENTION_DAYS, RETRY_NOTIFY_AT, RETRY_NOTIFY_EVERY, type GasRequest } from "@kadobo/shared/protocol";
import type { Env } from "./env";
import { sendToGas } from "./gas";
import * as journal from "./journal";
import { notifyRejectedDm, notifyRetryMention } from "./notify";

const NONCE_TTL_MS = 10 * 60 * 1000;

/**
 * 1 起動あたりに再送する pending の最大件数（実装設計 §6.6）。
 *
 * Workers Free プランの**外部サブリクエスト上限は 1 起動あたり 50 件**で、リダイレクトチェーンも
 * その数に含まれる。GAS の `/exec` は必ず `script.googleusercontent.com` へ 302 を返し `sendToGas` は
 * `redirect: "follow"` なので、1 件の再送につき 2 件を消費する。さらに `notifyRejectedDm`／
 * `notifyRetryMention`（Slack API）も同じ枠を使う。
 *
 * したがって上限は 25 件未満に抑える必要がある。20 件なら通知が全件に付いても 50 件に収まる。
 * cron は 5 分ごとに再実行されるため、あふれた分は次サイクルで処理され取りこぼしにはならない。
 * （D1 へのアクセスは「内部サービス」枠＝Free プラン 1,000 件/起動の別勘定なのでここには数えない）
 */
const RETRY_BATCH_LIMIT = 20;

function messageTsOf(request: GasRequest): string | undefined {
  return request.kind === "command" ? undefined : request.message_ts;
}

export interface RunRetryCronOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** `*\/5 * * * *`: pending の再送（実装設計 §6.6）。 */
export async function runRetryCron(env: Env, opts: RunRetryCronOptions = {}): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());

  const forwardingEnabled = await journal.isForwardingEnabled(env.DB);
  if (!forwardingEnabled) {
    return;
  }

  const pendingRows = await journal.listPending(env.DB, RETRY_BATCH_LIMIT);
  for (const row of pendingRows) {
    const original = JSON.parse(row.payload) as GasRequest;
    if (original.kind === "open_correction") {
      // open_correction は再送しない設計（実装設計 §3.3 注記）。初回失敗で必ず rejected になるため
      // 本来ここには来ないが、念のためスキップする（`source` 型が 'retry' を許容しないため）。
      continue;
    }
    const retryRequest: GasRequest = { ...original, source: "retry" };
    const outcome = await sendToGas(env, retryRequest, { fetchImpl });
    const attemptsAfter = row.attempts + 1;
    await journal.recordAttemptResult(env.DB, row.id, outcome, now());

    if (outcome.status === "rejected") {
      await notifyRejectedDm(env, original.user_id, row.id, outcome.error, fetchImpl);
      continue;
    }
    if (outcome.status === "pending") {
      const shouldNotify =
        attemptsAfter >= RETRY_NOTIFY_AT && (attemptsAfter - RETRY_NOTIFY_AT) % RETRY_NOTIFY_EVERY === 0;
      if (shouldNotify) {
        await notifyRetryMention(
          env,
          { channelId: original.channel_id, userId: original.user_id, messageTs: messageTsOf(original) },
          fetchImpl,
        );
        await journal.updateNotifiedAt(env.DB, row.id, now());
      }
    }
  }
}

export interface RunCleanupCronOptions {
  now?: () => number;
}

/** `17 3 * * *`: 30 日超の journal 削除・10 分超の nonce 削除（実装設計 §5, §6.6）。 */
export async function runCleanupCron(env: Env, opts: RunCleanupCronOptions = {}): Promise<void> {
  const now = (opts.now ?? (() => Date.now()))();
  const journalCutoff = now - JOURNAL_RETENTION_DAYS * 24 * 3600 * 1000;
  await journal.deleteOldJournal(env.DB, journalCutoff);
  await journal.deleteOldNonces(env.DB, now - NONCE_TTL_MS);
}
