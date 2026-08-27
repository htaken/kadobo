/**
 * `block_actions`（stamp 系 4 ボタン）ハンドラ（実装設計 §6.2）。
 *
 * 1. 冪等キー生成 → D1 に `pending` で INSERT（重複なら ACK して終了）
 * 2. 即 ACK（200、空ボディ）
 * 3. `ctx.waitUntil()` 内で順に:
 *    - `chat.update`: `status` ブロックを除去し ⏳ context を追加
 *    - `forwarding_enabled` を確認 → GAS へ POST → §3.3 の表に従い D1 更新。
 *      失敗なら `status` ブロックを ⚠️ に
 */
import { buttonIdempotencyKey, ulid } from "@kadobo/shared/ids";
import { formatHm, slackTsToMs } from "@kadobo/shared/time";
import type { GasRequest, StampActionId } from "@kadobo/shared/protocol";
import type { Env } from "../env";
import { sendToGas } from "../gas";
import * as journal from "../journal";
import { notifyRejectedDm } from "../notify";
import { chatUpdate } from "../slack/api";
import type { SlackBlock, SlackBlockAction, SlackBlockActionsPayload } from "../slack/parse";
import { randomBytes } from "../webcrypto";

const DEFAULT_LABELS: Record<StampActionId, string> = {
  kado_start: "開始",
  kado_break_start: "休憩",
  kado_break_end: "再開",
  kado_end: "終了",
};

/** `status` ブロックを除去し、末尾に新しい `status` context ブロックを追加する（実装設計 §2.2, §6.2）。 */
export function withStatusBlock(blocks: SlackBlock[] | undefined, statusText: string): SlackBlock[] {
  const base = (blocks ?? []).filter((b) => b.block_id !== "status");
  return [...base, { type: "context", block_id: "status", elements: [{ type: "mrkdwn", text: statusText }] }];
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

  const pendingBlocks = withStatusBlock(payload.message.blocks, `⏳ ${label} ${timeHm} 記録中…`);
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
    await showWaitingStatus(env, payload, text, fetchImpl);
    return;
  }

  const outcome = await sendToGas(env, gasRequest, { fetchImpl });
  await journal.recordAttemptResult(env.DB, journalId, outcome, Date.now());

  if (outcome.status !== "done") {
    await showWaitingStatus(env, payload, text, fetchImpl);
  }
  if (outcome.status === "rejected") {
    await notifyRejectedDm(env, payload.user.id, journalId, outcome.error, fetchImpl);
  }
}

async function showWaitingStatus(
  env: Env,
  payload: SlackBlockActionsPayload,
  text: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const waitingBlocks = withStatusBlock(payload.message.blocks, "⚠️ 記録待ち（自動再試行中）");
  await chatUpdate(
    env.SLACK_BOT_TOKEN,
    { channel: payload.channel.id, ts: payload.message.ts, text, blocks: waitingBlocks },
    fetchImpl,
  ).catch(() => {});
}
