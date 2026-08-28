/**
 * 稼働カードの再描画（実装設計 §2.2, §7.5, §7.6）。
 *
 * `redrawCardForBusinessDate` は生ログ（永続状態）から毎回カードを再構築し、内部シートの
 * `card` キー（`${channel_id}:${business_date}`）があれば `chat.update`、無ければ
 * `chat.postMessage` して ts を保存する。
 *
 * 実装設計 §7.5 の「生ログ追記後の Slack 更新失敗は `{ok:true, applied:true}`」を満たすため、
 * この関数は Sheets 読取・Slack 呼出のいずれの失敗も内部で握りつぶし、例外を投げない
 * （呼び出し時点で記録そのものはすでに成功しているか、コマンド等の best-effort な再描画である
 * ため。詳細は WP3 最終報告の「逸脱・未決事項」を参照）。
 */
import { businessDateOf } from "@kadobo/shared/time";
import { aggregateDay } from "../core/aggregate";
import type { CardWarning } from "../core/card";
import { renderCard, renderStatusLine } from "../core/card";
import { applyCorrections } from "../core/correction";
import { isStampEvent, replay, type LoggedEvent } from "../core/state";
import type { AppPorts } from "./ports";
import { toLoggedEvent } from "./rawLog";

const EVENT_LABEL_JA: Record<string, string> = {
  START: "開始",
  BREAK_START: "休憩開始",
  BREAK_END: "休憩終了",
  END: "終了",
};

function computeStatusLine(sortedStampEvents: LoggedEvent[]): string | null {
  const last = sortedStampEvents[sortedStampEvents.length - 1];
  if (last === undefined) {
    return null;
  }
  const label = EVENT_LABEL_JA[last.event_type] ?? last.event_type;
  return renderStatusLine({ kind: "done", label, occurredAtMs: last.occurred_at });
}

export function redrawCardForBusinessDate(
  businessDate: string,
  channelId: string,
  ports: AppPorts,
  opts?: { warning?: CardWarning },
): void {
  try {
    const rows = ports.sheets.getEventsForBusinessDate(businessDate);
    const events = rows.map(toLoggedEvent);
    const corrected = applyCorrections(events).filter(isStampEvent);
    const sorted = [...corrected].sort((a, b) => a.occurred_at - b.occurred_at);
    const state = replay(sorted).state;
    const isToday = businessDate === businessDateOf(ports.clock.nowMs());
    const daily = aggregateDay(events, { isToday });
    const statusLine = computeStatusLine(sorted);

    const blocks = renderCard({
      business_date: businessDate,
      state,
      sessions: daily.sessions,
      totalSeconds: daily.worked_seconds,
      statusLine,
      warning: opts?.warning,
    });

    pushCard(channelId, businessDate, blocks, `稼働記録 ${businessDate}`, ports);
  } catch (e) {
    // カード再描画の失敗は致命的ではない（記録は既に完了している。次回の再描画で修復される）。
    // ただし原因が GAS の実行ログから追えるよう記録だけはしておく（観測性）。
    console.error("redrawCard failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
  }
}

function pushCard(
  channelId: string,
  businessDate: string,
  blocks: object[],
  text: string,
  ports: AppPorts,
): void {
  const key = `${channelId}:${businessDate}`;
  const existingTs = ports.sheets.getInternalValue("card", key);
  if (existingTs !== null) {
    ports.slack.update({ channel: channelId, ts: existingTs, text, blocks });
    return;
  }
  const posted = ports.slack.postMessage({ channel: channelId, text, blocks });
  ports.sheets.setInternalValue("card", key, posted.ts);
}
