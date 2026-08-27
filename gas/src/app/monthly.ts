/**
 * 日次・月次の再計算（実装設計 §7.3, §7.5）。
 * core の `aggregateDay`/`aggregateMonth`/`selectUnitPrice` を呼び、結果をシート行に変換する。
 */
import { businessDateOf } from "@kadobo/shared/time";
import { aggregateDay, aggregateMonth, selectUnitPrice, type DailySummary } from "../core/aggregate";
import { lastDayOfMonthStr, weekdayLabelOf } from "./dateUtil";
import type { AppPorts, DailySummaryRow, MonthlyBillRow } from "./ports";
import { toLoggedEvent } from "./rawLog";

/** 対象業務日を再集計し、日次集計シートへ upsert する。集計結果を返す。 */
export function recomputeDaily(businessDate: string, ports: AppPorts): DailySummary {
  const rows = ports.sheets.getEventsForBusinessDate(businessDate);
  const events = rows.map(toLoggedEvent);
  const isToday = businessDate === businessDateOf(ports.clock.nowMs());
  const daily = aggregateDay(events, { isToday });

  const row: DailySummaryRow = {
    business_date: businessDate,
    weekday: weekdayLabelOf(businessDate),
    session_count: daily.session_count,
    first_start_jst: daily.first_start_jst,
    last_end_jst: daily.last_end_jst,
    break_seconds: daily.break_seconds,
    worked_seconds: daily.worked_seconds,
    worked_minutes: daily.worked_minutes,
    status: daily.status,
    correction_count: daily.correction_count,
    note: daily.note,
    updated_at: ports.clock.nowMs(),
  };
  ports.sheets.upsertDailySummary(row);
  return daily;
}

function rowToDailySummary(row: DailySummaryRow): DailySummary {
  return {
    status: row.status,
    session_count: row.session_count,
    first_start_jst: row.first_start_jst,
    last_end_jst: row.last_end_jst,
    break_seconds: row.break_seconds,
    worked_seconds: row.worked_seconds,
    worked_minutes: row.worked_minutes,
    correction_count: row.correction_count,
    sessions: [],
    note: row.note,
  };
}

/**
 * `client + month` の月次請求を再計算する（実装設計 §7.3 手順6）。
 * `LOCKED` の月は上書きしない（実装設計 §4.2.4: 締め後は金額を固定する）。
 */
export function recomputeMonthly(client: string, month: string, ports: AppPorts): void {
  const existing = ports.sheets.getMonthlyBill(client, month);
  if (existing !== null && existing.state === "LOCKED") {
    return;
  }

  const fromDate = `${month}-01`;
  const toDate = lastDayOfMonthStr(month);
  const dailySummaries = ports.sheets.getDailySummariesInRange(fromDate, toDate).map(rowToDailySummary);
  const workedMinutes = dailySummaries.reduce((sum, d) => sum + (d.worked_minutes ?? 0), 0);
  const hours = Math.round((workedMinutes / 60) * 100) / 100;

  const unitRows = ports.sheets.getUnitPriceRows();
  const selection = selectUnitPrice(unitRows, fromDate);

  if ("error" in selection) {
    const row: MonthlyBillRow = {
      client,
      month,
      worked_minutes: workedMinutes,
      hours,
      unit_price: 0,
      amount: 0,
      tax_amount: 0,
      withholding_amount: 0,
      net_amount: 0,
      state: existing?.state ?? "OPEN",
      mf_invoice_id: existing?.mf_invoice_id ?? null,
      locked_at: existing?.locked_at ?? null,
      note: selection.error === "NOT_FOUND" ? "単価マスタ: 該当なし" : "単価マスタ: 複数該当（要確認）",
      updated_at: ports.clock.nowMs(),
    };
    ports.sheets.upsertMonthlyBill(row);
    return;
  }

  const monthly = aggregateMonth(dailySummaries, selection);
  const row: MonthlyBillRow = {
    client,
    month,
    worked_minutes: monthly.worked_minutes,
    hours: monthly.hours,
    unit_price: selection.unit_price,
    amount: monthly.amount,
    tax_amount: monthly.tax_amount,
    withholding_amount: monthly.withholding_amount,
    net_amount: monthly.net_amount,
    state: existing?.state ?? "OPEN",
    mf_invoice_id: existing?.mf_invoice_id ?? null,
    locked_at: existing?.locked_at ?? null,
    note: null,
    updated_at: ports.clock.nowMs(),
  };
  ports.sheets.upsertMonthlyBill(row);
}

/** 対象業務日の日次・（その月の）月次を続けて再計算する（stamp/correction_submit 用）。 */
export function recomputeDailyAndMonthly(businessDate: string, ports: AppPorts): void {
  recomputeDaily(businessDate, ports);
  const client = ports.props.get("CLIENT_DEFAULT") ?? "A社";
  const month = businessDate.slice(0, 7);
  recomputeMonthly(client, month, ports);
}

/** `¥12,345` 形式（ロケール依存を避けるため自前でカンマ区切りする）。 */
export function formatYen(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(Math.round(n)).toString();
  const withCommas = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}¥${withCommas}`;
}
