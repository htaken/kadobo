/**
 * `block_actions`（`kado_correct`）ハンドラ（実装設計 §6.3, §2.4）。
 *
 * 1. 即 ACK
 * 2. `waitUntil`: `views.open(trigger_id, ローディングビュー)` → 返った `view.id` を含む
 *    `open_correction` をジャーナル INSERT → GAS へ POST →
 *    失敗なら `rejected` にして `views.update` でエラー表示
 *
 * `open_correction` は再送しない（実装設計 §3.3 の注記）: `sendToGas` の判定結果が
 * `pending`（transport 失敗／`retryable:true`）であっても、`open_correction` に限っては
 * 常に `rejected` として記録する。陳腐化した `view_id` への再送は意味を持たないため。
 */
import { buttonIdempotencyKey, ulid } from "@kadobo/shared/ids";
import type { GasRequest } from "@kadobo/shared/protocol";
import type { Env } from "../env";
import { sendToGas } from "../gas";
import * as journal from "../journal";
import type { SlackModalView } from "../slack/api";
import { viewsOpen, viewsUpdate } from "../slack/api";
import type { SlackBlockAction, SlackBlockActionsPayload } from "../slack/parse";
import { randomBytes } from "../webcrypto";

export const CORRECTION_CALLBACK_ID = "kado_correction";

interface CorrectionPrivateMetadata {
  channel_id: string;
  message_ts: string;
  business_date: string;
}

function buildPrivateMetadata(meta: CorrectionPrivateMetadata): string {
  return JSON.stringify(meta);
}

function buildLoadingView(meta: CorrectionPrivateMetadata): SlackModalView {
  return {
    type: "modal",
    callback_id: CORRECTION_CALLBACK_ID,
    title: { type: "plain_text", text: "稼働記録の修正" },
    private_metadata: buildPrivateMetadata(meta),
    blocks: [{ type: "section", block_id: "loading", text: { type: "mrkdwn", text: "⏳ 読み込み中…" } }],
  };
}

function buildErrorView(meta: CorrectionPrivateMetadata): SlackModalView {
  return {
    type: "modal",
    callback_id: CORRECTION_CALLBACK_ID,
    title: { type: "plain_text", text: "稼働記録の修正" },
    private_metadata: buildPrivateMetadata(meta),
    blocks: [
      {
        type: "section",
        block_id: "error",
        text: { type: "mrkdwn", text: "接続できませんでした。閉じてもう一度お試しください。" },
      },
    ],
  };
}

export interface HandleKadoCorrectInput {
  env: Env;
  ctx: ExecutionContext;
  action: SlackBlockAction;
  payload: SlackBlockActionsPayload;
  fetchImpl?: typeof fetch;
}

export async function handleKadoCorrect(input: HandleKadoCorrectInput): Promise<Response> {
  const { env, ctx, action, payload } = input;
  const fetchImpl = input.fetchImpl ?? fetch;
  ctx.waitUntil(processKadoCorrectBackground({ env, action, payload, fetchImpl }));
  return new Response(null, { status: 200 });
}

async function processKadoCorrectBackground(input: {
  env: Env;
  action: SlackBlockAction;
  payload: SlackBlockActionsPayload;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { env, action, payload, fetchImpl } = input;
  // `value` = 修正対象の business_date（実装設計 §2.3）。前日警告ボタンの場合は前日の日付。
  const businessDate = action.value ?? "";
  const meta: CorrectionPrivateMetadata = {
    channel_id: payload.channel.id,
    message_ts: payload.message.ts,
    business_date: businessDate,
  };

  let viewId: string;
  try {
    const opened = await viewsOpen(
      env.SLACK_BOT_TOKEN,
      { trigger_id: payload.trigger_id, view: buildLoadingView(meta) },
      fetchImpl,
    );
    viewId = opened.view.id;
  } catch {
    // trigger_id 失効等で views.open 自体が失敗 → 表示するモーダルが無いため、これ以上できることはない。
    return;
  }

  const now = Date.now();
  const idempotencyKey = buttonIdempotencyKey({
    user_id: payload.user.id,
    message_ts: payload.message.ts,
    action_id: "kado_correct",
    action_ts: action.action_ts,
  });
  const journalId = ulid(now, randomBytes);
  const gasRequest: GasRequest = {
    kind: "open_correction",
    idempotency_key: idempotencyKey,
    user_id: payload.user.id,
    channel_id: payload.channel.id,
    message_ts: payload.message.ts,
    view_id: viewId,
    business_date: businessDate,
    received_at_ms: now,
    source: "button",
  };
  const insertResult = await journal.insertJournal(env.DB, {
    id: journalId,
    idempotency_key: idempotencyKey,
    kind: "open_correction",
    payload: JSON.stringify(gasRequest),
    now,
  });
  if (!insertResult.inserted) {
    // 同一操作の重複配信。既に別の実行が同じ view を処理しているはずなので、ここでは何もしない。
    return;
  }

  const outcome = await sendToGas(env, gasRequest, { fetchImpl });
  if (outcome.status === "done") {
    await journal.recordAttemptResult(env.DB, journalId, outcome, Date.now());
    return; // GAS が views.update で本ビューに差し替える。
  }

  // open_correction は再送しない: pending 判定であっても rejected として確定させる。
  const error = outcome.error;
  await journal.recordAttemptResult(env.DB, journalId, { status: "rejected", error }, Date.now());
  await viewsUpdate(env.SLACK_BOT_TOKEN, { view_id: viewId, view: buildErrorView(meta) }, fetchImpl).catch(
    () => {},
  );
}
