/**
 * `open_correction` / `correction_submit` ユースケース（実装設計 §7.5, §4.1.4, §2.4）。
 */
import { ulid } from "@kadobo/shared/ids";
import { formatJst, jstToMs } from "@kadobo/shared/time";
import type { GasRequest, GasResponse } from "@kadobo/shared/protocol";
import { renderCorrectionModal } from "../core/card";
import { applyCorrections } from "../core/correction";
import { isStampEvent, replay } from "../core/state";
import { redrawCardForBusinessDate } from "./cardHelpers";
import { recomputeDailyAndMonthly } from "./monthly";
import type { AppPorts, RawLogRow } from "./ports";
import { toLoggedEvent } from "./rawLog";

type OpenCorrectionRequest = Extract<GasRequest, { kind: "open_correction" }>;
type CorrectionSubmitRequest = Extract<GasRequest, { kind: "correction_submit" }>;

/**
 * `open_correction`: 当該業務日のイベント読込 → 本モーダル生成 → `views.update`。
 * `open_correction` は本質的に冪等なため重複判定は行わない（実装設計 §4.2）。
 */
export function handleOpenCorrection(req: OpenCorrectionRequest, ports: AppPorts): GasResponse {
  const rows = ports.sheets.getEventsForBusinessDate(req.business_date);
  const events = rows.map(toLoggedEvent);
  const modal = renderCorrectionModal(events, req.business_date) as Record<string, unknown>;

  const privateMetadata = JSON.stringify({
    channel_id: req.channel_id,
    message_ts: req.message_ts,
    business_date: req.business_date,
  });

  // `renderCorrectionModal` は private_metadata を含まない（core/card.ts の注記どおり、
  // 呼び出し側の app 層がここで付与する）。
  ports.slack.viewsUpdate({
    view_id: req.view_id,
    view: { ...modal, private_metadata: privateMetadata },
  });

  return { ok: true, applied: true };
}

function notifyCorrectionFailure(
  ports: AppPorts,
  userId: string,
  idempotencyKey: string,
  reasonText: string,
): void {
  try {
    ports.slack.dm(userId, `⚠️ 修正を反映できませんでした（${reasonText} / 処理ID: ${idempotencyKey}）`);
  } catch {
    // DM 失敗は握りつぶす（実装設計 §5.6 の通知はベストエフォート）。
  }
}

/**
 * `correction_submit`: 重複判定 → 対象検証（存在／`LOCKED` 月）→ `CORRECTION`（または `END`）
 * 追記 → 再計算 → カード再描画。
 */
export function handleCorrectionSubmit(req: CorrectionSubmitRequest, ports: AppPorts): GasResponse {
  const nowMs = ports.clock.nowMs();

  // 1. 重複判定。
  const existing = ports.sheets.findRawLogByIdempotencyKey(req.idempotency_key);
  if (existing !== null) {
    redrawCardForBusinessDate(existing.business_date, req.channel_id, ports, {
      preferredMessageTs: req.message_ts,
    });
    return { ok: true, applied: false, reason: "DUPLICATE" };
  }

  // 2. LOCKED 月チェック（実装設計 §4.2.4）。
  const client = ports.props.get("CLIENT_DEFAULT") ?? "A社";
  const month = req.business_date.slice(0, 7);
  const bill = ports.sheets.getMonthlyBill(client, month);
  if (bill !== null && bill.state === "LOCKED") {
    notifyCorrectionFailure(ports, req.user_id, req.idempotency_key, "締め済みの月のため修正できません");
    return { ok: true, applied: false, reason: "LOCKED_MONTH" };
  }

  // 3. 対象検証（存在確認）。
  const rows = ports.sheets.getEventsForBusinessDate(req.business_date);
  const events = rows.map(toLoggedEvent);
  const corrected = applyCorrections(events).filter(isStampEvent);
  const sorted = [...corrected].sort((a, b) => a.occurred_at - b.occurred_at);
  const currentReplay = replay(sorted);

  if (req.target === "add_end") {
    if (currentReplay.state !== "WORKING" && currentReplay.state !== "ON_BREAK") {
      notifyCorrectionFailure(ports, req.user_id, req.idempotency_key, "対象が見つかりません（すでに終了しています）");
      return { ok: true, applied: false, reason: "NOT_FOUND" };
    }

    const occurredAtMs = jstToMs(req.new_date, req.new_time);
    const row: RawLogRow = {
      event_id: ulid(nowMs, ports.random.randomBytes),
      idempotency_key: req.idempotency_key,
      business_date: req.business_date,
      event_type: "END",
      occurred_at: occurredAtMs,
      occurred_at_jst: formatJst(occurredAtMs),
      received_at: req.received_at_ms,
      processed_at: nowMs,
      source: "modal",
      session_no: currentReplay.sessionNo,
      memo: "手入力（押し忘れ）",
      correction_of: null,
      old_value: null,
      new_value: null,
      reason: req.reason,
    };
    ports.sheets.appendRawLog(row);
  } else {
    const targetEvent = sorted.find((e) => e.event_id === req.target);
    if (targetEvent === undefined) {
      notifyCorrectionFailure(ports, req.user_id, req.idempotency_key, "対象が見つかりません");
      return { ok: true, applied: false, reason: "NOT_FOUND" };
    }

    const newOccurredAtMs = jstToMs(req.new_date, req.new_time);
    const row: RawLogRow = {
      event_id: ulid(nowMs, ports.random.randomBytes),
      idempotency_key: req.idempotency_key,
      business_date: req.business_date,
      event_type: "CORRECTION",
      // CORRECTION 行の occurred_at は訂正操作自体の時刻（実装設計 §7.1）。
      occurred_at: req.received_at_ms,
      occurred_at_jst: formatJst(req.received_at_ms),
      received_at: req.received_at_ms,
      processed_at: nowMs,
      source: req.source,
      session_no: null,
      memo: "",
      correction_of: req.target,
      old_value: targetEvent.occurred_at,
      new_value: newOccurredAtMs,
      reason: req.reason,
    };
    ports.sheets.appendRawLog(row);
  }

  // 4. 再計算 → カード再描画。
  recomputeDailyAndMonthly(req.business_date, ports);
  redrawCardForBusinessDate(req.business_date, req.channel_id, ports, {
    preferredMessageTs: req.message_ts,
  });

  return { ok: true, applied: true };
}
