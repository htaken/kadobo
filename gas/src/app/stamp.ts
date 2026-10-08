/**
 * `stamp`（打刻 4 ボタン）ユースケース（実装設計 §7.5, §4.1.2, §4.1.3）。
 */
import { ulid } from "@kadobo/shared/ids";
import { businessDateOf, formatJst } from "@kadobo/shared/time";
import type { GasRequest, GasResponse, StampActionId } from "@kadobo/shared/protocol";
import { resolveBusinessDate } from "../core/businessDate";
import { applyCorrections } from "../core/correction";
import { isMonthFrozen } from "../core/monthClose";
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

/**
 * 締めた月への打刻の遅延到着を検出し、DM 通知・内部シート記録を行う（実装設計 MF連携 §5.8）。
 *
 * 生ログへの追記・日次再計算はこれまでどおり行う（月次行は `isMonthFrozen` により
 * `recomputeMonthly` で書かれない）。内部シート `late_stamp/<event_id>` に既に記録済みなら
 * 何もしない（冪等。この関数自体は呼び出し側で毎回無条件に呼んでも安全）。
 *
 * 🔄 レビュー指摘: **新規に生ログを追記した経路（`handleStamp` 手順6.5）からのみ呼ぶこと。**
 * 重複判定（`findRawLogByIdempotencyKey` が既存行を見つける分岐）から呼んではいけない。
 * その分岐に来るのは「生ログには既に追記済みの打刻の再送」であり、元の追記が締めより前なら
 * その打刻は既に締めた金額に含まれている。締め後に再送が届いただけで「遅れて届きました」と
 * DM するのは誤報になる。
 */
function notifyLateStampIfFrozen(ports: AppPorts, userId: string, eventId: string, businessDate: string): void {
  const client = ports.props.get("CLIENT_DEFAULT") ?? "A社";
  const month = businessDate.slice(0, 7);
  const bill = ports.sheets.getMonthlyBill(client, month);
  if (bill === null || !isMonthFrozen(bill.state)) {
    return;
  }
  if (ports.sheets.getInternalValue("late_stamp", eventId) !== null) {
    return;
  }
  ports.sheets.setInternalValue("late_stamp", eventId, businessDate);
  try {
    ports.slack.dm(
      userId,
      `⚠️ 締め済みの${month}への打刻が遅れて届きました。差異は翌月調整として扱ってください。`,
    );
  } catch {
    // DM 失敗は握りつぶす（実装設計 §5.6 と同じ「通知はベストエフォート」方針）。
  }
}

export function handleStamp(req: StampRequest, ports: AppPorts): GasResponse {
  const nowMs = ports.clock.nowMs();

  // 1. 重複判定（実装設計 §4.2: 生ログの idempotency_key 列で完全一致）。
  //
  // 再送の理由は「生ログ追記までは成功したが、その後の再計算またはカード更新で落ちた／
  // Worker への応答が届かなかった」ケースを含む。したがって重複分岐でも初回と同じ
  // 「再計算 → カード再描画」を必ずやり直す（再計算を飛ばすと、日次・月次が欠落したまま
  // D1 だけ done になり、二度と復旧しない）。どちらも冪等なので追記なしで安全に反復できる。
  //
  // 🔄 レビュー指摘: この分岐は「生ログには既に追記済みの打刻の再送」であり、元の追記が
  // 締めより前なら、その打刻は既に締めた金額に含まれている。ここで §5.8 の遅延打刻通知
  // （`notifyLateStampIfFrozen`）を呼ぶと、締め後に再送が届いただけで「遅れて届きました」と
  // 誤報することになるため、呼ばない（通知は新規追記した経路＝手順6.5のみで行う）。
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
  // 6.5 締めた月への遅延打刻の通知（実装設計 §5.8）。月次行自体は isMonthFrozen により
  // recomputeMonthly で書き換わらない。
  notifyLateStampIfFrozen(ports, req.user_id, row.event_id, businessDate);
  redrawCardForBusinessDate(businessDate, req.channel_id, ports, {
    preferredMessageTs: req.message_ts,
  });

  return { ok: true, applied: true };
}
