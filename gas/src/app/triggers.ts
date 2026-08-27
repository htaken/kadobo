/**
 * 時間トリガーの本体（実装設計 §7.7）。ポート注入済みで、Node の Vitest からテストできる。
 * `entry.ts` の `trigMorningCard`/`trigEveningCheck`/`trigMonthly` はここへ委譲するだけ。
 */
import { businessDateOf } from "@kadobo/shared/time";
import type { CardWarning } from "../core/card";
import { applyCorrections } from "../core/correction";
import { isStampEvent, replay, type State } from "../core/state";
import { redrawCardForBusinessDate } from "./cardHelpers";
import {
  lastDayOfMonthStr,
  previousMonthOf,
  shiftBusinessDate,
  weekdayIndexOf,
} from "./dateUtil";
import { formatYen, recomputeDaily, recomputeMonthly } from "./monthly";
import type { AppPorts } from "./ports";
import { toLoggedEvent } from "./rawLog";

function stateFor(businessDate: string, ports: AppPorts): State {
  const rows = ports.sheets.getEventsForBusinessDate(businessDate);
  const events = rows.map(toLoggedEvent);
  const corrected = applyCorrections(events).filter(isStampEvent);
  const sorted = [...corrected].sort((a, b) => a.occurred_at - b.occurred_at);
  return replay(sorted).state;
}

/** 週末／祝日カレンダー／内部シートの任意休業日（実装設計 §7.7 `trigMorningCard`）。 */
function isRestDay(businessDate: string, ports: AppPorts): boolean {
  const weekday = weekdayIndexOf(businessDate); // 0=日 6=土
  if (weekday === 0 || weekday === 6) {
    return true;
  }
  if (ports.calendar.isHoliday(businessDate)) {
    return true;
  }
  return ports.sheets.getInternalValue("holiday", businessDate) !== null;
}

/**
 * 毎日 07 時台トリガー。平日判定（週末・祝日・任意休業日を除外）→ 前日が稼働中／休憩中のまま
 * なら警告付きで、当日の稼働カードを投稿・再描画する。
 */
export function trigMorningCard(ports: AppPorts): void {
  const today = businessDateOf(ports.clock.nowMs());
  if (isRestDay(today, ports)) {
    return;
  }
  const channelId = ports.props.get("SLACK_CHANNEL_ID");
  if (channelId === null) {
    return;
  }

  const prevDate = shiftBusinessDate(today, -1);
  const prevState = stateFor(prevDate, ports);
  const warning: CardWarning | undefined =
    prevState === "WORKING" || prevState === "ON_BREAK"
      ? { text: `前日（${prevDate}）が稼働中／休憩中のままです。`, business_date: prevDate }
      : undefined;

  redrawCardForBusinessDate(today, channelId, ports, { warning });
}

function postBestEffort(ports: AppPorts, channelId: string, text: string, blocks?: object[]): void {
  try {
    ports.slack.postMessage({ channel: channelId, text, blocks });
  } catch {
    // 通知自体の失敗は握りつぶす（実装設計 §5.6 の通知はベストエフォート）。
  }
}

/**
 * 毎日 22 時台トリガー。当日が稼働中／休憩中のまま／Worker の pending 残り／過去 7 日の
 * 「要修正」の 3 種を独立にチェックし、該当があればそれぞれ通知する（実装設計 §7.7, §4.1.6）。
 */
export function trigEveningCheck(ports: AppPorts): void {
  const today = businessDateOf(ports.clock.nowMs());
  const channelId = ports.props.get("SLACK_CHANNEL_ID");
  if (channelId === null) {
    return;
  }
  const userId = ports.props.get("SLACK_USER_ID");

  // (1) 当日が稼働中／休憩中のまま。
  const state = stateFor(today, ports);
  if (state === "WORKING" || state === "ON_BREAK") {
    const mention = userId !== null ? `<@${userId}> ` : "";
    const blocks: object[] = [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${mention}⚠️ 本日（${today}）がまだ「稼働中／休憩中」のままです。終了時刻を確認してください。`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: "kado_correct",
            text: { type: "plain_text", text: "✏️ 修正", emoji: true },
            value: today,
          },
        ],
      },
    ];
    postBestEffort(ports, channelId, `⚠️ ${today} が稼働中のままです`, blocks);
  }

  // (2) Worker の pending 残り。
  const status = ports.workerStatus.fetchStatus();
  if (status !== null && status.pending > 0) {
    postBestEffort(ports, channelId, `⚠️ 記録待ちの処理が ${status.pending} 件あります（Worker 側で再送中）。`);
  }

  // (3) 過去 7 日の「要修正」一覧。
  const fromDate = shiftBusinessDate(today, -6);
  const summaries = ports.sheets.getDailySummariesInRange(fromDate, today);
  const needsFix = summaries.filter((s) => s.status === "要修正").map((s) => s.business_date);
  if (needsFix.length > 0) {
    postBestEffort(ports, channelId, `⚠️ 過去7日で「要修正」の日があります: ${needsFix.join(", ")}`);
  }
}

/**
 * 毎月 1 日 06 時台トリガー。前月の日次を再計算し、月次請求行を更新する（`state` は変更しない。
 * `LOCKED` 済みの月は `recomputeMonthly` 側で上書きしない）。要修正一覧と月合計を通知する。
 */
export function trigMonthly(ports: AppPorts): void {
  const today = businessDateOf(ports.clock.nowMs());
  const prevMonth = previousMonthOf(today);
  const fromDate = `${prevMonth}-01`;
  const toDate = lastDayOfMonthStr(prevMonth);

  let cursor = fromDate;
  while (cursor <= toDate) {
    const rows = ports.sheets.getEventsForBusinessDate(cursor);
    if (rows.length > 0) {
      recomputeDaily(cursor, ports);
    }
    cursor = shiftBusinessDate(cursor, 1);
  }

  const client = ports.props.get("CLIENT_DEFAULT") ?? "A社";
  recomputeMonthly(client, prevMonth, ports);

  const summaries = ports.sheets.getDailySummariesInRange(fromDate, toDate);
  const needsFix = summaries.filter((s) => s.status === "要修正").map((s) => s.business_date);
  const bill = ports.sheets.getMonthlyBill(client, prevMonth);

  const channelId = ports.props.get("SLACK_CHANNEL_ID");
  if (channelId === null) {
    return;
  }

  const lines = [`📅 ${prevMonth} 月次集計`];
  if (bill !== null) {
    lines.push(`稼働 ${bill.hours}h ／ 金額 ${formatYen(bill.amount)}`);
  }
  lines.push(needsFix.length > 0 ? `⚠️ 要修正: ${needsFix.join(", ")}` : "要修正なし");

  postBestEffort(ports, channelId, lines.join("\n"));
}
