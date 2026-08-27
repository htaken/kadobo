/**
 * 新イベントの業務日決定（実装設計 §7.2 の跨日ルール）。純関数のみ。
 */

import { businessDateOf } from "@kadobo/shared/time";
import { applyCorrections } from "./correction";
import { isStampEvent, replay, type LoggedEvent } from "./state";

/** ある業務日に属する（訂正適用前の）生ログイベント。 */
export interface RecentDay {
  /** `YYYY-MM-DD`（JST）。 */
  business_date: string;
  events: LoggedEvent[];
}

/** `YYYY-MM-DD` を暦日単位で `deltaDays` だけ移動する（純粋な暦計算。JST オフセット不要）。 */
function shiftDateStr(dateStr: string, deltaDays: number): string {
  const parts = dateStr.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  const y = String(shifted.getUTCFullYear()).padStart(4, "0");
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 新イベントの業務日を決定する（実装設計 §7.2）。
 *
 * 直近の業務日（前日）の再生結果（訂正適用後）が `WORKING`/`ON_BREAK` なら、その業務日に
 * 帰属させる（跨日）。それ以外は `occurred_at` の JST 日付をそのまま使う。
 *
 * `recentDays` は前日を含む直近日の生ログ（訂正適用前でよい。本関数が内部で
 * `applyCorrections` → `isStampEvent` フィルタ → `replay` を行う）。前日のデータが
 * `recentDays` に含まれない場合は「前日は未稼働（IDLE）」として扱う。
 */
export function resolveBusinessDate(
  occurredAtMs: number,
  recentDays: RecentDay[],
): string {
  const todayDate = businessDateOf(occurredAtMs);
  const prevDate = shiftDateStr(todayDate, -1);
  const prevDay = recentDays.find((d) => d.business_date === prevDate);
  if (prevDay !== undefined) {
    const corrected = applyCorrections(prevDay.events).filter(isStampEvent);
    const prevState = replay(corrected).state;
    if (prevState === "WORKING" || prevState === "ON_BREAK") {
      return prevDate;
    }
  }
  return todayDate;
}
