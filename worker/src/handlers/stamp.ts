/**
 * `block_actions`（stamp 系 4 ボタン）ハンドラ（実装設計 §6.2）。
 *
 * 1. 冪等キー生成 → D1 に `pending` で INSERT（重複なら ACK して終了）
 * 2. 即 ACK（200、空ボディ）
 * 3. `ctx.waitUntil()` 内で順に:
 *    - `chat.update`: `status` ブロックと `actions` ブロックを除去し ⏳ context を追加
 *      （処理中はボタンを消して二度押しを防ぐ。ボタンは GAS の再描画か下記の ⚠️ 表示で戻る）
 *    - `forwarding_enabled` を確認 → GAS へ POST → §3.3 の表に従い D1 更新
 *    - 失敗時の表示は「GAS がカードに触れていないと確定できるか」で分岐する（{@link isCardSafeToOverwrite}）
 */
import { buttonIdempotencyKey, ulid } from "@kadobo/shared/ids";
import { formatHm, slackTsToMs } from "@kadobo/shared/time";
import { isGasPreApplyError, type GasRequest, type StampActionId } from "@kadobo/shared/protocol";
import type { Env } from "../env";
import { sendToGas } from "../gas";
import * as journal from "../journal";
import type { AttemptOutcome } from "../journal";
import { notifyRejectedDm, notifyUncertainOutcome } from "../notify";
import { chatUpdate } from "../slack/api";
import type { SlackBlock, SlackBlockAction, SlackBlockActionsPayload } from "../slack/parse";
import { randomBytes } from "../webcrypto";

const DEFAULT_LABELS: Record<StampActionId, string> = {
  kado_start: "開始",
  kado_break_start: "休憩",
  kado_break_end: "再開",
  kado_end: "終了",
};

/**
 * `status` ブロックを除去し、末尾に新しい `status` context ブロックを追加する（実装設計 §2.2, §6.2）。
 *
 * `opts.removeActions` を立てると `actions` ブロック（打刻ボタン群）も併せて除去する。
 * ⏳「記録中…」の表示中はこれを使い、GAS の応答が返るまでの間の二度押しを防ぐ。
 * ボタンは GAS 側のカード再描画、または失敗時の ⚠️ 表示（元 blocks を復元する）で戻る。
 */
export function withStatusBlock(
  blocks: SlackBlock[] | undefined,
  statusText: string,
  opts: { removeActions?: boolean } = {},
): SlackBlock[] {
  const base = (blocks ?? []).filter(
    (b) => b.block_id !== "status" && !(opts.removeActions === true && b.block_id === "actions"),
  );
  return [...base, { type: "context", block_id: "status", elements: [{ type: "mrkdwn", text: statusText }] }];
}

/**
 * 失敗時に「押下時の古い blocks」でカードを `chat.update` してよいかを判定する。
 *
 * GAS がすでに記録・カード再描画まで終えていた場合、Worker が古い blocks で上書きすると
 * 正しいカードを巻き戻してしまう（Codex 指摘: timeout 時の上書き競合）。上書きしてよいのは
 * 次のいずれかに限る:
 *
 * - `rejected`: GAS が `retryable:false` で明示的に失敗を宣言した（＝未適用）。かつ Cron 再送も
 *   されない終局状態なので、ここでカードを戻さないとボタンが消えたまま復旧しない。
 * - `pending` かつ {@link isGasPreApplyError}: `LOCK_TIMEOUT` 等、GAS がユースケース本体に
 *   入る前に返したエラー。カードには触れていない。
 *
 * timeout・ネットワーク断・HTTP エラー・GAS の総括 catch（Sheets 一時エラー等、追記後に
 * 落ちた可能性がある）は、いずれも適用有無が不明なため上書きしない。カードは ⏳ のまま残し、
 * Cron 再送（最大 5 分）で GAS が正しい状態に描き直す。
 */
export function isCardSafeToOverwrite(outcome: AttemptOutcome): boolean {
  if (outcome.status === "done") {
    return false;
  }
  if (outcome.status === "rejected") {
    return true;
  }
  return isGasPreApplyError(outcome.error);
}

export interface HandleStampInput {
  env: Env;
  ctx: ExecutionContext;
  action: SlackBlockAction;
  payload: SlackBlockActionsPayload;
  fetchImpl?: typeof fetch;
}

export async function handleStamp(input: HandleStampInput): Promise<Response> {
  const { env, ctx, action, payload } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = Date.now();
  const idempotencyKey = buttonIdempotencyKey({
    user_id: payload.user.id,
    message_ts: payload.message.ts,
    action_id: action.action_id,
    action_ts: action.action_ts,
  });
  const journalId = ulid(now, randomBytes);
  const occurredAtMs = slackTsToMs(action.action_ts);
  const gasRequest: GasRequest = {
    kind: "stamp",
    idempotency_key: idempotencyKey,
    user_id: payload.user.id,
    channel_id: payload.channel.id,
    message_ts: payload.message.ts,
    action_id: action.action_id as StampActionId,
    occurred_at_ms: occurredAtMs,
    received_at_ms: now,
    source: "button",
    response_url: payload.response_url,
  };
  const insertResult = await journal.insertJournal(env.DB, {
    id: journalId,
    idempotency_key: idempotencyKey,
    kind: "stamp",
    payload: JSON.stringify(gasRequest),
    now,
  });
  if (!insertResult.inserted) {
    return new Response(null, { status: 200 });
  }
  ctx.waitUntil(
    processStampBackground({ env, action, payload, gasRequest, journalId, occurredAtMs, fetchImpl }),
  );
  return new Response(null, { status: 200 });
}

async function processStampBackground(input: {
  env: Env;
  action: SlackBlockAction;
  payload: SlackBlockActionsPayload;
  gasRequest: GasRequest;
  journalId: string;
  occurredAtMs: number;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { env, action, payload, gasRequest, journalId, occurredAtMs, fetchImpl } = input;
  const label =
    action.text?.text ?? DEFAULT_LABELS[action.action_id as StampActionId] ?? action.action_id;
  const timeHm = formatHm(occurredAtMs);
  const text = payload.message.text ?? label;

  // 処理中は actions を外す（⏳ 表示中の二度押し防止）。
  const pendingBlocks = withStatusBlock(payload.message.blocks, `⏳ ${label} ${timeHm} 記録中…`, {
    removeActions: true,
  });
  try {
    await chatUpdate(
      env.SLACK_BOT_TOKEN,
      { channel: payload.channel.id, ts: payload.message.ts, text, blocks: pendingBlocks },
      fetchImpl,
    );
  } catch {
    // カード表示更新の失敗は致命的ではない（GAS 成功時にカードは再描画される）。
  }

  const forwardingEnabled = await journal.isForwardingEnabled(env.DB);
  if (!forwardingEnabled) {
    // GAS へは一切送っていないのでカードは押下時のまま。安全に元 blocks へ戻せる。
    await restoreCardWithStatus(env, payload, text, "⚠️ 記録待ち（自動再試行中）", fetchImpl);
    return;
  }

  const outcome = await sendToGas(env, gasRequest, { fetchImpl });
  await journal.recordAttemptResult(env.DB, journalId, outcome, Date.now());

  if (outcome.status === "done") {
    return;
  }

  if (isCardSafeToOverwrite(outcome)) {
    const statusText =
      outcome.status === "rejected" ? "⚠️ 記録に失敗しました（DM をご確認ください）" : "⚠️ 記録待ち（自動再試行中）";
    await restoreCardWithStatus(env, payload, text, statusText, fetchImpl);
  } else {
    // 適用有無が不明。カードは ⏳ のまま残し（GAS が描いた結果を壊さない）、本人にだけ知らせる。
    await notifyUncertainOutcome(env, { userId: payload.user.id, responseUrl: payload.response_url }, fetchImpl);
  }

  if (outcome.status === "rejected") {
    await notifyRejectedDm(env, payload.user.id, journalId, outcome.error, fetchImpl);
  }
}

/**
 * 押下時の元 blocks（`actions` を含む）へ戻したうえで `status` を差し替える。
 * ⏳ で外したボタンがここで復活するため、ユーザーは操作をやり直せる。
 * GAS がカードに触れていないと確定できる場合にのみ呼ぶこと（{@link isCardSafeToOverwrite}）。
 */
async function restoreCardWithStatus(
  env: Env,
  payload: SlackBlockActionsPayload,
  text: string,
  statusText: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const blocks = withStatusBlock(payload.message.blocks, statusText);
  await chatUpdate(
    env.SLACK_BOT_TOKEN,
    { channel: payload.channel.id, ts: payload.message.ts, text, blocks },
    fetchImpl,
  ).catch(() => {});
}
