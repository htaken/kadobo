/**
 * `business_date`（`YYYY-MM-DD`、JST の暦日として扱う）に対する純粋な暦計算ヘルパー（app 層）。
 *
 * `business_date` はすでに JST の暦日文字列なので、ここでは JST オフセットの往復変換を行わず
 * 暦日として直接計算する（`core/businessDate.ts` の非公開 `shiftDateStr` と同種の計算を
 * app 層向けに用意したもの。トリガー・コマンドの日付範囲計算にのみ使い、状態機械・集計等の
 * 業務ロジックは含まない）。
 */

/** `YYYY-MM-DD` を暦日単位で `deltaDays` だけ移動する。 */
export function shiftBusinessDate(dateStr: string, deltaDays: number): string {
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const shifted = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return toDateStr(shifted);
}

function toDateStr(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** `YYYY-MM-DD` の月初日（`YYYY-MM-01`）。 */
export function startOfMonth(dateStr: string): string {
  return `${dateStr.slice(0, 7)}-01`;
}

/** `YYYY-MM` の月末日（`YYYY-MM-DD`）。 */
export function lastDayOfMonthStr(monthStr: string): string {
  const [yearStr, monthNumStr] = monthStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthNumStr);
  // 翌月の 0 日目 = 当月の最終日。
  return toDateStr(new Date(Date.UTC(year, month, 0)));
}

/** `Date.prototype.getUTCDay()` と同じ規約（0=日曜 … 6=土曜）。 */
export function weekdayIndexOf(dateStr: string): number {
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const WEEKDAY_LABEL_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

export function weekdayLabelOf(dateStr: string): string {
  return WEEKDAY_LABEL_JA[weekdayIndexOf(dateStr)] ?? "";
}

/** `dateStr` を含む週の月曜日（`YYYY-MM-DD`）。 */
export function startOfWeek(dateStr: string): string {
  const wd = weekdayIndexOf(dateStr);
  const deltaToMonday = wd === 0 ? -6 : -(wd - 1);
  return shiftBusinessDate(dateStr, deltaToMonday);
}

/** `dateStr` の属する月の前月（`YYYY-MM`）。 */
export function previousMonthOf(dateStr: string): string {
  const [yearStr, monthStr] = dateStr.slice(0, 7).split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const prevMonthLastDay = new Date(Date.UTC(year, month - 1, 0));
  const y = String(prevMonthLastDay.getUTCFullYear()).padStart(4, "0");
  const m = String(prevMonthLastDay.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}
