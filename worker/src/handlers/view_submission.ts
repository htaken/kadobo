/**
 * `view_submission`（`callback_id: kado_correction`）ハンドラ（実装設計 §6.4, §2.4）。
 *
 * 1. `state.values` から `target`・`date`・`time`・`reason` を取り出し検証。
 *    不足は `{response_action:'errors', errors:{...}}` を同期で返す
 * 2. OK なら冪等キー生成 → D1 INSERT → `{response_action:'clear'}` を返す
 * 3. `waitUntil`: GAS へ POST。失敗は `pending` のまま Cron 再送
 */
import { modalIdempotencyKey, ulid } from "@kadobo/shared/ids";
import type { GasRequest } from "@kadobo/shared/protocol";
import type { Env } from "../env";
import { sendToGas } from "../gas";
import * as journal from "../journal";
import { notifyRejectedDm } from "../notify";
import { getStateValue, type SlackViewSubmissionPayload } from "../slack/parse";
import { randomBytes, sha256Hex } from "../webcrypto";

const REASON_MAX_LENGTH = 200;

export interface HandleViewSubmissionInput {
  env: Env;
  ctx: ExecutionContext;
  payload: SlackViewSubmissionPayload;
  fetchImpl?: typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

interface CorrectionPrivateMetadata {
  channel_id: string;
  message_ts: string;
  business_date: string;
}

function parsePrivateMetadata(raw: string): CorrectionPrivateMetadata | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as CorrectionPrivateMetadata).channel_id === "string" &&
      typeof (parsed as CorrectionPrivateMetadata).message_ts === "string" &&
      typeof (parsed as CorrectionPrivateMetadata).business_date === "string"
    ) {
      return parsed as CorrectionPrivateMetadata;
    }
    return null;
  } catch {
    return null;
  }
}

export async function handleViewSubmission(input: HandleViewSubmissionInput): Promise<Response> {
  const { env, ctx, payload } = input;
  const fetchImpl = input.fetchImpl ?? fetch;

  const values = payload.view.state.values;
  const target = getStateValue(values, "target", "target_select")?.selected_option?.value;
  const newDate = getStateValue(values, "date", "date_pick")?.selected_date;
  const newTime = getStateValue(values, "time", "time_pick")?.selected_time;
  const reason = getStateValue(values, "reason", "reason_input")?.value;

  const errors: Record<string, string> = {};
  if (!target) {
    errors.target = "対象を選択してください";
  }
  if (!newDate) {
    errors.date = "日付を選択してください";
  }
  if (!newTime) {
    errors.time = "時刻を選択してください";
  }
  if (!reason) {
    errors.reason = "理由を入力してください";
  } else if (reason.length > REASON_MAX_LENGTH) {
    errors.reason = `理由は${REASON_MAX_LENGTH}文字以内で入力してください`;
  }
  if (Object.keys(errors).length > 0) {
    return jsonResponse({ response_action: "errors", errors });
  }

  const meta = parsePrivateMetadata(payload.view.private_metadata);
  if (!meta) {
    // private_metadata が壊れている（想定外）。ユーザーにやり直しを促す。
    return jsonResponse({
      response_action: "errors",
      errors: { reason: "内部エラーが発生しました。カードを再描画してもう一度お試しください。" },
    });
  }

  const now = Date.now();
  const stateHash16 = (await sha256Hex(JSON.stringify(values))).slice(0, 16);
  const idempotencyKey = modalIdempotencyKey(payload.view.id, stateHash16);
  const gasRequest: GasRequest = {
    kind: "correction_submit",
    idempotency_key: idempotencyKey,
    user_id: payload.user.id,
    view_id: payload.view.id,
    channel_id: meta.channel_id,
    message_ts: meta.message_ts,
    business_date: meta.business_date,
    // 上の検証で非空を確認済み（`errors` が空なら 4 項目とも文字列）。
    target: target as string,
    new_date: newDate as string,
    new_time: newTime as string,
    reason: reason as string,
    received_at_ms: now,
    source: "modal",
  };
  const journalId = ulid(now, randomBytes);
  const insertResult = await journal.insertJournal(env.DB, {
    id: journalId,
    idempotency_key: idempotencyKey,
    kind: "correction_submit",
    payload: JSON.stringify(gasRequest),
    now,
  });

  ctx.waitUntil(
    (async () => {
      if (!insertResult.inserted) {
        return;
      }
      const forwardingEnabled = await journal.isForwardingEnabled(env.DB);
      if (!forwardingEnabled) {
        return;
      }
      const outcome = await sendToGas(env, gasRequest, { fetchImpl });
      await journal.recordAttemptResult(env.DB, journalId, outcome, Date.now());
      if (outcome.status === "rejected") {
        await notifyRejectedDm(env, payload.user.id, journalId, outcome.error, fetchImpl);
      }
    })(),
  );

  return jsonResponse({ response_action: "clear" });
}
