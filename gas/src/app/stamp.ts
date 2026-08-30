/**
 * `stamp`（打刻 4 ボタン）ユースケース（実装設計 §7.5, §4.1.2, §4.1.3）。
 */
import { ulid } from "@kadobo/shared/ids";
import { businessDateOf, formatJst } from "@kadobo/shared/time";
import type { GasRequest, GasResponse, StampActionId } from "@kadobo/shared/protocol";
import { resolveBusinessDate } from "../core/businessDate";
import { applyCorrections } from "../core/correction";
import { isStampEvent, replay, transition, type EventType, type State } from "../core/state";
import { redrawCardForBusinessDate } from "./cardHelpers";
import { recomputeDailyAndMonthly } from "./monthly";
import type { AppPorts, RawLogRow } from "./ports";
import { toLoggedEvent } from "./rawLog";

type StampRequest = Extract<GasRequest, { kind: "stamp" }>;

const ACTION_TO_EVENT: Record<StampActionId, EventType> = {
  kado_start: "START",
  kado_break_start: "BREAK_START",
  kado_break_end: "BREAK_END",
  kado_end: "END",
};

/** 不正遷移時の ephemeral 文言（実装設計 §7.2「すでに稼働中です」等）。現在状態別。 */
const INVALID_TRANSITION_MESSAGES: Record<State, string> = {
  IDLE: "まだ開始していません。",
  WORKING: "すでに稼働中です。",
  ON_BREAK: "すでに休憩中です。",
  CLOSED: "本日の記録は確定しています。",
};

export function handleStamp(req: StampRequest, ports: AppPorts): GasResponse {
  const nowMs = ports.clock.nowMs();

  // 1. 重複判定（実装設計 §4.2: 生ログの idempotency_key 列で完全一致）。
  //
  // 再送の理由は「生ログ追記までは成功したが、その後の再計算またはカード更新で落ちた／
  // Worker への応答が届かなかった」ケースを含む。したがって重複分岐でも初回と同じ
  // 「再計算 → カード再描画」を必ずやり直す（再計算を飛ばすと、日次・月次が欠落したまま
  // D1 だけ done になり、二度と復旧しない）。どちらも冪等なので追記なしで安全に反復できる。
  const existing = ports.sheets.findRawLogByIdempotencyKey(req.idempotency_key);
  if (existing !== null) {
    recomputeDailyAndMonthly(existing.business_date, ports);
    redrawCardForBusinessDate(existing.business_date, req.channel_id, ports, {
      preferredMessageTs: req.message_ts,
    });
    return { ok: true, applied: false, reason: "DUPLICATE" };
  }

  // 2. 業務日決定（実装設計 §7.2 の跨日ルール）。
  const referenceDate = businessDateOf(req.occurred_at_ms);
  const recentDays = ports.sheets.getRecentDaysEvents(referenceDate, 1);
  const businessDate = resolveBusinessDate(req.occurred_at_ms, recentDays);

  // 3. 現在状態（対象業務日のイベントを訂正適用後に再生）。
  const dayRows = ports.sheets.getEventsForBusinessDate(businessDate);
  const dayEvents = dayRows.map(toLoggedEvent);
  const corrected = applyCorrections(dayEvents).filter(isStampEvent);
  const sorted = [...corrected].sort((a, b) => a.occurred_at - b.occurred_at);
  const before = replay(sorted);

  // 4. 遷移検証。
  const eventType = ACTION_TO_EVENT[req.action_id];
  const nextState = transition(before.state, eventType);

  if (nextState === null) {
    if (req.response_url !== undefined) {
      const message = INVALID_TRANSITION_MESSAGES[before.state];
      try {
        ports.slack.postEphemeral(req.response_url, `⚠️ ${message}`);
      } catch {
        // response_url は 30 分・5 回の制限があり失敗し得る。カード再描画は別途行うため無視する。
      }
    }
    redrawCardForBusinessDate(businessDate, req.channel_id, ports, {
      preferredMessageTs: req.message_ts,
    });
    return { ok: true, applied: false, reason: "INVALID_TRANSITION" };
  }

  // 5. 生ログ 1 行追記。
  const sessionNo = eventType === "START" ? before.sessionNo + 1 : before.sessionNo;
  const row: RawLogRow = {
    event_id: ulid(nowMs, ports.random.randomBytes),
    idempotency_key: req.idempotency_key,
    business_date: businessDate,
    event_type: eventType,
    occurred_at: req.occurred_at_ms,
    occurred_at_jst: formatJst(req.occurred_at_ms),
    received_at: req.received_at_ms,
    processed_at: nowMs,
    source: req.source,
    session_no: sessionNo,
    memo: "",
    correction_of: null,
    old_value: null,
    new_value: null,
    reason: "",
  };
  ports.sheets.appendRawLog(row);

  // 6. 日次・月次再計算 → カード再描画（実装設計 §7.5: 追記後の Slack 更新失敗は applied:true）。
  recomputeDailyAndMonthly(businessDate, ports);
  redrawCardForBusinessDate(businessDate, req.channel_id, ports, {
    preferredMessageTs: req.message_ts,
  });

  return { ok: true, applied: true };
}
