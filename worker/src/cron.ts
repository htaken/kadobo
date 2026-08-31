/**
 * `scheduled` ハンドラの中身（実装設計 §6.6）。
 *
 * - `*\/5 * * * *`: pending 再送。`forwarding_enabled` を確認 → `created_at` 昇順に最大 16 件取得 →
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
 * その数に含まれる。1 件の再送が最悪ケースで消費する外部サブリクエストは **3 件**:
 *
 * 1. `sendToGas` の POST … 1 件
 * 2. GAS の `/exec` が返す `script.googleusercontent.com` への 302 追従（`redirect: "follow"`）… 1 件
 * 3. `notifyRejectedDm`（DM）または `notifyRetryMention`（メンション）の `chat.postMessage` … 1 件
 *
 * 3 は「たまたま全件が同時に通知条件を満たす」場合に全件へ付く。pending は GAS 障害でまとめて
 * 溜まるため `attempts` が揃って `RETRY_NOTIFY_AT` に達しやすく、また共有シークレット不一致等で
 * GAS が全件に `retryable:false` を返せば全件が `notifyRejectedDm` に入る。**最悪ケースは現実的**。
 *
 * したがって `3n <= 50` すなわち **n <= 16**。cron は 5 分ごとに再実行されるため、あふれた分は
 * 次サイクルで処理され取りこぼしにはならない。
 * （D1 へのアクセスは「内部サービス」枠＝Free プラン 1,000 件/起動の別勘定なのでここには数えない）
 */
const RETRY_BATCH_LIMIT = 16;

/**
 * 再送失敗通知のリンク先に使う `message_ts`。
 * `command` と `expense_submit` は稼働カードに紐づかないため持たない。
 */
function messageTsOf(request: GasRequest): string | undefined {
  return request.kind === "command" || request.kind === "expense_submit"
    ? undefined
    : request.message_ts;
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
