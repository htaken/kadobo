/**
 * 時間トリガーの本体（実装設計 §7.7、経費フェーズ §5.6）。ポート注入済みで、Node の Vitest から
 * テストできる。`entry.ts` の `trigMorningCard`/`trigEveningCheck`/`trigMonthly`/
 * `trigWeeklyOrphanCheck` はここへ委譲するだけ。
 */
import { businessDateOf, formatJst } from "@kadobo/shared/time";
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
import type { AppPorts, DriveFileInfo } from "./ports";
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

// ---------------------------------------------------------------------------
// 経費: 週次の突合（実装設計 経費フェーズ §5.6）
// ---------------------------------------------------------------------------

/** `expense_scan/last_success_at`（§5.2）が 8 日以上前ならトリガー停止を疑い報告する閾値。 */
const EXPENSE_SCAN_STALE_MS = 8 * 24 * 60 * 60 * 1000;

/** ms の経過時間を「n日n時間」／「n時間n分」／「n分」の日本語表記にする（週次突合の報告専用）。 */
function formatElapsed(ms: number): string {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  if (days > 0) {
    return `${days}日${hours}時間`;
  }
  if (hours > 0) {
    return `${hours}時間${totalMinutes % 60}分`;
  }
  return `${totalMinutes % 60}分`;
}

/**
 * 毎週月曜 07 時台トリガー（実装設計 §5.6）。経費台帳を**全件**走査し、5 種の異常
 * ——①停滞行 ②消えた証憑 ③サイズ不一致 ④通知漏れ ⑤前回実行からの経過（トリガー停止の
 * 自己検出）——を検出する。初版の「直近 8 日の差分検査」は月数十件規模には過剰で、かつ
 * `COMPLETED` 後の削除・差替えやトリガーの長期停止を検出できなかったため、
 * 全面簡素化して全件走査にした（§5.6 の 🔄）。
 *
 * 1 件以上あればチャンネルへ 1 通にまとめて投稿し、0 件なら投稿しない
 * （`trigMorningCard`/`trigEveningCheck` と同じ「該当なしは静かに終える」方針）。
 * 正常完了時（走査自体が最後まで走った時）に内部シート `expense_scan/last_success_at`
 * （§5.2）を更新する。
 */
export function trigWeeklyOrphanCheck(ports: AppPorts): void {
  const channelId = ports.props.get("SLACK_CHANNEL_ID");
  if (channelId === null) {
    return;
  }

  const nowMs = ports.clock.nowMs();
  const rows = ports.sheets.getAllExpenses();

  const staleLines: string[] = [];
  const missingLines: string[] = [];
  const sizeMismatchLines: string[] = [];
  const missedNotifyLines: string[] = [];

  for (const row of rows) {
    // ①停滞行: `処理状態 ∉ {COMPLETED, VOID, CORRECTED}`（`ERROR` も含む。§5.6 の 1）。
    if (row.state !== "COMPLETED" && row.state !== "VOID" && row.state !== "CORRECTED") {
      staleLines.push(
        `${row.receipt_id}: ${row.state}（${formatElapsed(nowMs - row.state_updated_at)}経過）`,
      );
    }

    // ②消えた証憑・③サイズ不一致: `drive_file_id` が採番済みの行のみ対象。
    // `drive.getById()` の例外は**この行の判定だけ**を諦めて次の行へ進む（1 行の失敗で週次
    // チェック全体が落ちると他の異常が報告できなくなるため。`trigEveningCheck` の
    // `workerStatus` 失敗許容と同じ考え方で、こちらは行単位で行う）。
    if (row.drive_file_id !== "") {
      let info: DriveFileInfo | null;
      try {
        info = ports.drive.getById(row.drive_file_id);
      } catch {
        continue;
      }
      if (info === null || info.trashed) {
        missingLines.push(`${row.receipt_id}: Drive 上に見つかりません（drive_file_id=${row.drive_file_id}）`);
      } else if (info.size !== row.size) {
        sizeMismatchLines.push(`${row.receipt_id}: 台帳 ${row.size} バイト ／ Drive ${info.size} バイト`);
      }
    }

    // ④通知漏れ: `COMPLETED` かつ `last_error` に値がある（WP8b の DM 送信失敗の記録）。
    if (row.state === "COMPLETED" && row.last_error !== null) {
      missedNotifyLines.push(`${row.receipt_id}: ${row.last_error}`);
    }
  }

  // ⑤前回実行からの経過（トリガー停止の自己検出）。未実行（`null`）ならまだ比較対象が無いので
  // 報告しない。
  const lastSuccessAt = ports.sheets.getInternalValue("expense_scan", "last_success_at");
  let staleTriggerLine: string | null = null;
  if (lastSuccessAt !== null) {
    const lastSuccessMs = parseInt(lastSuccessAt, 10);
    const elapsedMs = nowMs - lastSuccessMs;
    if (elapsedMs >= EXPENSE_SCAN_STALE_MS) {
      staleTriggerLine =
        `前回の正常完了（${formatJst(lastSuccessMs)}）から ${formatElapsed(elapsedMs)} 経過しています。` +
        "週次トリガーが止まっていないか確認してください。";
    }
  }

  const sections: string[] = [];
  if (staleLines.length > 0) {
    sections.push(`⚠️ 停滞行（${staleLines.length}件）\n${staleLines.map((l) => `・${l}`).join("\n")}`);
  }
  if (missingLines.length > 0) {
    sections.push(`⚠️ 消えた証憑（${missingLines.length}件）\n${missingLines.map((l) => `・${l}`).join("\n")}`);
  }
  if (sizeMismatchLines.length > 0) {
    sections.push(
      `⚠️ サイズ不一致（${sizeMismatchLines.length}件）\n${sizeMismatchLines.map((l) => `・${l}`).join("\n")}`,
    );
  }
  if (missedNotifyLines.length > 0) {
    sections.push(
      `⚠️ 通知漏れ（${missedNotifyLines.length}件）\n${missedNotifyLines.map((l) => `・${l}`).join("\n")}`,
    );
  }
  if (staleTriggerLine !== null) {
    sections.push(`⚠️ ${staleTriggerLine}`);
  }

  if (sections.length > 0) {
    postBestEffort(ports, channelId, [`📋 経費 週次突合（${businessDateOf(nowMs)}）`, ...sections].join("\n\n"));
  }

  ports.sheets.setInternalValue("expense_scan", "last_success_at", String(nowMs));
}
