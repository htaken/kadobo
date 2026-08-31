/**
 * 時刻・JST 変換・業務日計算（実装設計 §4.1）。
 * DOM/Node 固有 API・`Intl` に依存しない。JST は UTC+9 固定（DST 無し）として計算する。
 */

const JST_OFFSET_MS = 9 * 3600 * 1000;

/** JST の暦日時分秒（要素はすべて JST 表記のローカル値）。 */
export interface JstDateTime {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** `Date.prototype.getUTCDay()` と同じ規約（0=日曜 … 6=土曜）。 */
  weekday: number;
}

/**
 * Slack の `action_ts`（例 `"1756260000.123456"`）を UNIX epoch ms に変換する（実装設計 §4.1）。
 * `秒*1000 + 小数部先頭3桁` を文字列操作で求める（浮動小数で計算しない）。
 * 小数部が無い場合・3 桁未満の場合も正しく扱う（右側を `0` で埋めてから先頭 3 桁を取る）。
 */
export function slackTsToMs(actionTs: string): number {
  const dotIndex = actionTs.indexOf(".");
  const secStr = dotIndex === -1 ? actionTs : actionTs.slice(0, dotIndex);
  const fracStr = dotIndex === -1 ? "" : actionTs.slice(dotIndex + 1);
  const sec = parseInt(secStr, 10);
  const fracMs = parseInt((fracStr + "000").slice(0, 3), 10);
  return sec * 1000 + fracMs;
}

/**
 * UTC epoch ms を JST の暦日時分秒に変換する（実装設計 §4.1）。
 * `new Date(ms + 9*3600*1000)` の `getUTC*` を使う（DST 無し、`Intl` に依存しない）。
 */
export function toJst(ms: number): JstDateTime {
  const d = new Date(ms + JST_OFFSET_MS);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function pad4(n: number): string {
  return n.toString().padStart(4, "0");
}

/** JST の `YYYY-MM-DD` を返す（業務日、実装設計 §4.1）。 */
export function businessDateOf(ms: number): string {
  const t = toJst(ms);
  return `${pad4(t.year)}-${pad2(t.month)}-${pad2(t.day)}`;
}

/** JST の `YYYY-MM-DD HH:mm:ss` を返す（生ログの `occurred_at_jst` 等）。 */
export function formatJst(ms: number): string {
  const t = toJst(ms);
  return `${businessDateOf(ms)} ${pad2(t.hour)}:${pad2(t.minute)}:${pad2(t.second)}`;
}

/** JST の `HH:mm` を返す（カード表示用）。 */
export function formatHm(ms: number): string {
  const t = toJst(ms);
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/**
 * JST の `YYYY-MM-DD` と `HH:mm` から UTC epoch ms を求める（修正モーダルの入力変換等）。
 * `Date.UTC` によるカレンダー計算のみを使い、JST オフセットを差し引く。
 */
export function jstToMs(dateStr: string, timeStr: string): number {
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const [hourStr, minuteStr] = timeStr.split(":");
  const year = parseInt(yearStr ?? "", 10);
  const month = parseInt(monthStr ?? "", 10);
  const day = parseInt(dayStr ?? "", 10);
  const hour = parseInt(hourStr ?? "", 10);
  const minute = parseInt(minuteStr ?? "", 10);
  const utcMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  return utcMs - JST_OFFSET_MS;
}

/** 西暦年がうるう年か（4 で割り切れるが 100 で割り切れない、または 400 で割り切れる）。 */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `month`（1〜12。呼び出し側で範囲チェック済みであること）の日数。 */
export function daysInMonthOf(year: number, month: number): number {
  const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return DAYS_IN_MONTH[month - 1]!;
}

/**
 * `date` が `YYYY-MM-DD` 形式（4 桁年・2 桁月・2 桁日のゼロ埋め）で、かつ**実在する日付**か
 * （月 01-12、日はその月の実日数。うるう年考慮）。
 *
 * `Date` のパースは環境によって緩い補正をする（`2026-02-30` を 3/2 として受けるなど）ため
 * 頼らず、自前で判定する。**Worker と GAS の両方から使う**（実装設計 経費フェーズ §4.3・§5.5 の
 * 二重検証。同じ判定を 2 箇所に書くと片方だけ直る事故が起きるため、`shared` に置く）。
 */
export function isValidDateString(date: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (m === null) {
    return false;
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12) {
    return false;
  }
  return day >= 1 && day <= daysInMonthOf(year, month);
}
