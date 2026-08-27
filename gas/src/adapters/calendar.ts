/**
 * `CalendarPort` の GAS 実装（実装設計 §7.7, 要件定義 §4.1.1）。
 * 日本の祝日カレンダー（`ja.japanese#holiday@group.v.calendar.google.com`）を
 * `CalendarApp` で参照する。GAS プロジェクトのタイムゾーンは `Asia/Tokyo` 固定
 * （`appsscript.json`）なので、素の `Date` コンストラクタで作った当日 00:00〜23:59:59 が
 * そのまま JST の当日区間になる。
 */
import type { CalendarPort } from "../app/ports";

const HOLIDAY_CALENDAR_ID = "ja.japanese#holiday@group.v.calendar.google.com";

export class CalendarAdapter implements CalendarPort {
  isHoliday(businessDate: string): boolean {
    const [yearStr, monthStr, dayStr] = businessDate.split("-");
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);

    try {
      const calendar = CalendarApp.getCalendarById(HOLIDAY_CALENDAR_ID);
      const start = new Date(year, month - 1, day, 0, 0, 0);
      const end = new Date(year, month - 1, day, 23, 59, 59);
      return calendar.getEvents(start, end).length > 0;
    } catch {
      // カレンダーが参照できない場合は「祝日ではない」扱いにする（trigMorningCard は投稿を続行）。
      return false;
    }
  }
}
