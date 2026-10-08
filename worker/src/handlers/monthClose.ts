/**
 * `block_actions`（`kado_month_close`）ハンドラ（実装設計 MF連携 §5.3, §10.1）。
 *
 * 1. `value`（JSON）を防御的にパースする。`client`/`month`/`net_amount` の形が不正なら
 *    ACK のみで無視する（何も記録しない）。
 * 2. 即 ACK
 * 3. `waitUntil`: `month_close` を組み立てて D1 ジャーナルへ記録（冪等 INSERT）→
 *    `forwarding_enabled` を確認 → GAS へ POST → 結果を記録（`kado_correct`/`stamp` と同じ流れ）
 *
 * `kado_correct`（`open_correction`）と異なり `views.open` は使わない（ボタンはモーダルを開かない）。
 * `stamp` と異なり **Worker はカードを一切書き換えない**（⏳ 表示もしない）。カードの更新は
 * GAS 側（`app/monthClose.ts`）が行う（実装設計 §10.1）。pending は他の種別と同じく Cron 再送
 * （`cron.ts`）の対象になる（`open_correction` のような「再送しない」特別扱いはしない）。
 */
import { buttonIdempotencyKey, ulid } from "@kadobo/shared/ids";
import type { GasRequest } from "@kadobo/shared/protocol";
import type { Env } from "../env";
import { sendToGas } from "../gas";
import * as journal from "../journal";
import { notifyRejectedDm } from "../notify";
import type { SlackBlockAction, SlackBlockActionsPayload } from "../slack/parse";
import { randomBytes } from "../webcrypto";

/** 締めボタンの `value`（JSON。実装設計 §5.2）をパースした結果。 */
export interface MonthCloseButtonValue {
  client: string;
  month: string;
  net_amount: number;
}

/**
 * ボタンの `value`（JSON 文字列）を防御的にパースする（実装設計 §10.1）。
 * 形が不正（JSON でない・オブジェクトでない・必須フィールドの型が違う）なら `null`。
 */
export function parseMonthCloseValue(raw: string | undefined): MonthCloseButtonValue | null {
  if (raw === undefined) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  if (
    typeof o.client !== "string" ||
    typeof o.month !== "string" ||
    typeof o.net_amount !== "number" ||
    !Number.isFinite(o.net_amount)
  ) {
    return null;
  }
  return { client: o.client, month: o.month, net_amount: o.net_amount };
}

export interface HandleKadoMonthCloseInput {
  env: Env;
  ctx: ExecutionContext;
  action: SlackBlockAction;
  payload: SlackBlockActionsPayload;
  fetchImpl?: typeof fetch;
}

export async function handleKadoMonthClose(input: HandleKadoMonthCloseInput): Promise<Response> {
  const { env, ctx, action, payload } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  const value = parseMonthCloseValue(action.value);
  if (value === null) {
    // 不正な value: 何も記録せず ACK のみで無視する（実装設計 §10.1）。
    return new Response(null, { status: 200 });
  }
  ctx.waitUntil(processMonthCloseBackground({ env, action, payload, value, fetchImpl }));
  return new Response(null, { status: 200 });
}

async function processMonthCloseBackground(input: {
  env: Env;
  action: SlackBlockAction;
  payload: SlackBlockActionsPayload;
  value: MonthCloseButtonValue;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { env, action, payload, value, fetchImpl } = input;
  const now = Date.now();
  const idempotencyKey = buttonIdempotencyKey({
    user_id: payload.user.id,
    message_ts: payload.message.ts,
    action_id: "kado_month_close",
    action_ts: action.action_ts,
  });
  const journalId = ulid(now, randomBytes);
  const gasRequest: GasRequest = {
    kind: "month_close",
    idempotency_key: idempotencyKey,
    user_id: payload.user.id,
    channel_id: payload.channel.id,
    message_ts: payload.message.ts,
    client: value.client,
    month: value.month,
    shown_net_amount: value.net_amount,
    received_at_ms: now,
    source: "button",
  };
  const insertResult = await journal.insertJournal(env.DB, {
    id: journalId,
    idempotency_key: idempotencyKey,
    kind: "month_close",
    payload: JSON.stringify(gasRequest),
    now,
  });
  if (!insertResult.inserted) {
    // 同一操作の重複配信。既に別の実行が処理しているはず。
    return;
  }

  const forwardingEnabled = await journal.isForwardingEnabled(env.DB);
  if (!forwardingEnabled) {
    // GAS へは送らず pending のまま残す（Cron 再送に委ねる。実装設計 経費フェーズ §5.9.1 と同じ方針）。
    return;
  }

  const outcome = await sendToGas(env, gasRequest, { fetchImpl });
  await journal.recordAttemptResult(env.DB, journalId, outcome, Date.now());

  if (outcome.status === "rejected") {
    await notifyRejectedDm(env, payload.user.id, journalId, outcome.error, fetchImpl);
  }
}
