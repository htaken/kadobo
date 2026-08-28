/**
 * 稼働カードの再描画（実装設計 §2.2, §7.5, §7.6）。
 *
 * `redrawCardForBusinessDate` は生ログ（永続状態）から毎回カードを再構築し、対象 ts が
 * あれば `chat.update`、無ければ `chat.postMessage` して ts を保存する。
 *
 * 対象 ts の決定は {@link pushCard} を参照（`opts.preferredMessageTs`＝押されたボタンが
 * 載っていた実際のカードの ts＝優先。内部シートの `card` キーはフォールバック兼キャッシュ）。
 * `chat.update` が `message_not_found`/`cant_update_message` で失敗した場合は
 * `chat.postMessage` にフォールバックし、内部シートの ts を張り替える（自己修復）。
 *
 * 実装設計 §7.5 の「生ログ追記後の Slack 更新失敗は `{ok:true, applied:true}`」を満たすため、
 * この関数は Sheets 読取・Slack 呼出のいずれの失敗も内部で握りつぶし、例外を投げない
 * （呼び出し時点で記録そのものはすでに成功しているか、コマンド等の best-effort な再描画である
 * ため。詳細は WP3 最終報告の「逸脱・未決事項」を参照）。
 */
import { businessDateOf } from "@kadobo/shared/time";
import { aggregateDay, type DailyStatus, type SessionSummary } from "../core/aggregate";
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

/** `daily.status`（実装設計 §7.3）→ `renderCard` の `totalStatus` への対応。 */
function toTotalStatus(status: DailyStatus): "ok" | "in_progress" | "needs_fix" {
  switch (status) {
    case "OK":
      return "ok";
    case "進行中":
      return "in_progress";
    case "要修正":
      return "needs_fix";
  }
}

/** 完了済みセッション（`worked_seconds !== null`）の合計秒。進行中の未完了セッションは含めない。 */
function completedSecondsTotal(sessions: SessionSummary[]): number {
  return sessions.reduce((sum, s) => sum + (s.worked_seconds ?? 0), 0);
}

export function redrawCardForBusinessDate(
  businessDate: string,
  channelId: string,
  ports: AppPorts,
  opts?: { warning?: CardWarning; preferredMessageTs?: string },
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
      totalSeconds: daily.worked_seconds ?? completedSecondsTotal(daily.sessions),
      totalStatus: toTotalStatus(daily.status),
      statusLine,
      warning: opts?.warning,
    });

    pushCard(channelId, businessDate, blocks, `稼働記録 ${businessDate}`, ports, opts?.preferredMessageTs);
  } catch (e) {
    // カード再描画の失敗は致命的ではない（記録は既に完了している。次回の再描画で修復される）。
    // ただし原因が GAS の実行ログから追えるよう記録だけはしておく（観測性）。
    console.error("redrawCard failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
  }
}

/** `chat.update` の失敗理由から、`chat.postMessage` にフォールバックすべきかを判定する。 */
function isMessageGoneError(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("message_not_found") || message.includes("cant_update_message");
}

/**
 * カードを Slack へ反映する（実装設計 §7.5, §7.6）。
 *
 * 対象 ts は `preferredMessageTs`（呼び出し側が把握している「いま操作されたカード」の
 * 正確な ts）を最優先し、無ければ内部シートの `card` キャッシュを使う。
 *
 * - 対象 ts があれば `chat.update` を試す。
 *   - 成功: 内部シートの保存値が対象 ts と異なれば（または未保存なら）上書きする（自己修復。
 *     内部シートの ts が Sheets の型変換等で壊れていても、次回以降は正しい値に揃う）。
 *   - `message_not_found`/`cant_update_message` で失敗: そのメッセージ自体が失われている
 *     ため `chat.postMessage` で新規カードを投稿し、返った ts を内部シートへ登録し直す。
 *   - それ以外の失敗（トークン不正・`invalid_blocks` 等）: 上位（`redrawCardForBusinessDate`
 *     の catch）と同様に握りつぶすが、観測性のため `console.error` でログする。
 * - 対象 ts が無ければ（初回）従来どおり `chat.postMessage` → 内部シートへ登録する。
 */
function pushCard(
  channelId: string,
  businessDate: string,
  blocks: object[],
  text: string,
  ports: AppPorts,
  preferredMessageTs?: string,
): void {
  const key = `${channelId}:${businessDate}`;
  const storedTs = ports.sheets.getInternalValue("card", key);
  const target = preferredMessageTs ?? storedTs;

  if (target !== null) {
    try {
      ports.slack.update({ channel: channelId, ts: target, text, blocks });
      if (storedTs !== target) {
        ports.sheets.setInternalValue("card", key, target);
      }
    } catch (e) {
      if (isMessageGoneError(e)) {
        const posted = ports.slack.postMessage({ channel: channelId, text, blocks });
        ports.sheets.setInternalValue("card", key, posted.ts);
        return;
      }
      console.error("pushCard update failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
    }
    return;
  }

  const posted = ports.slack.postMessage({ channel: channelId, text, blocks });
  ports.sheets.setInternalValue("card", key, posted.ts);
}
