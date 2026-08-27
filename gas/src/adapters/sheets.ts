/**
 * `SheetsPort` の GAS 実装（実装設計 §7.1, §7.9）。`SpreadsheetApp` 以外の I/O は行わない。
 *
 * 生ログは追記専用。日次集計・月次請求・内部シートは `business_date`／`client+month`／
 * `kind+key` を主キーとして 1 行 upsert する。経費台帳は WP3 では書込ポートを持たない
 * （`setupSpreadsheet` が作成するのみ）。
 */
import type { RecentDay } from "../core/businessDate";
import type { LoggedEvent, LogEventType } from "../core/state";
import type { DailyStatus, Rounding, TaxCategory, UnitPriceRow, Withholding } from "../core/aggregate";
import type { DailySummaryRow, MonthlyBillRow, RawLogRow, SheetsPort } from "../app/ports";
import { shiftBusinessDate } from "../app/dateUtil";

const SHEET_NAMES = {
  rawLog: "生ログ",
  dailySummary: "日次集計",
  unitPrice: "単価マスタ",
  monthlyBill: "月次請求",
  expenseLedger: "経費台帳",
  internal: "内部",
} as const;

const RAW_LOG_HEADERS = [
  "event_id",
  "idempotency_key",
  "business_date",
  "event_type",
  "occurred_at",
  "occurred_at_jst",
  "received_at",
  "processed_at",
  "source",
  "session_no",
  "memo",
  "correction_of",
  "old_value",
  "new_value",
  "reason",
] as const;

const DAILY_SUMMARY_HEADERS = [
  "business_date",
  "weekday",
  "session_count",
  "first_start_jst",
  "last_end_jst",
  "break_seconds",
  "worked_seconds",
  "worked_minutes",
  "status",
  "correction_count",
  "note",
  "updated_at",
] as const;

const UNIT_PRICE_HEADERS = [
  "client",
  "unit_price",
  "tax_category",
  "tax_inclusive",
  "tax_display",
  "rounding",
  "withholding",
  "valid_from",
  "valid_to",
] as const;

const MONTHLY_BILL_HEADERS = [
  "client",
  "month",
  "worked_minutes",
  "hours",
  "unit_price",
  "amount",
  "tax_amount",
  "withholding_amount",
  "net_amount",
  "state",
  "mf_invoice_id",
  "locked_at",
  "note",
  "updated_at",
] as const;

const EXPENSE_LEDGER_HEADERS = [
  "証憑ID",
  "証憑区分",
  "日付",
  "金額",
  "取引先",
  "カテゴリ",
  "メモ",
  "Driveリンク",
  "ファイルハッシュ",
  "元MIME",
  "サイズ",
  "入力日時",
  "処理状態",
  "MF仕訳ID",
] as const;

const INTERNAL_HEADERS = ["kind", "key", "value", "updated_at"] as const;

const SHEET_HEADERS: Record<string, readonly string[]> = {
  [SHEET_NAMES.rawLog]: RAW_LOG_HEADERS,
  [SHEET_NAMES.dailySummary]: DAILY_SUMMARY_HEADERS,
  [SHEET_NAMES.unitPrice]: UNIT_PRICE_HEADERS,
  [SHEET_NAMES.monthlyBill]: MONTHLY_BILL_HEADERS,
  [SHEET_NAMES.expenseLedger]: EXPENSE_LEDGER_HEADERS,
  [SHEET_NAMES.internal]: INTERNAL_HEADERS,
};

/** 警告付き保護をかけるシート（実装設計 §7.1）。 */
const PROTECTED_SHEETS: readonly string[] = [SHEET_NAMES.rawLog, SHEET_NAMES.dailySummary, SHEET_NAMES.internal];

/**
 * スプレッドシートを初期化する（実装設計 §7.1, §8 WP3 受入条件）。不足シート・ヘッダー行のみ
 * 作成する冪等な処理。既存データがあるシートのヘッダーは上書きしない。
 */
export function setupSpreadsheet(spreadsheetId: string): void {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  for (const [name, headers] of Object.entries(SHEET_HEADERS)) {
    let sheet = ss.getSheetByName(name);
    if (sheet === null) {
      sheet = ss.insertSheet(name);
    }
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1, 1, 1, headers.length).setValues([[...headers]]);
    }
    if (PROTECTED_SHEETS.includes(name)) {
      const alreadyProtected = sheet.getProtections(SpreadsheetApp.ProtectionType.SHEET).length > 0;
      if (!alreadyProtected) {
        sheet.protect().setDescription(`${name}: GAS のみが更新します（手編集禁止）`).setWarningOnly(true);
      }
    }
  }
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") {
    return null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function strOrNull(v: unknown): string | null {
  const s = str(v);
  return s === "" ? null : s;
}

function rowToRawLog(row: unknown[]): RawLogRow {
  return {
    event_id: str(row[0]),
    idempotency_key: str(row[1]),
    business_date: str(row[2]),
    event_type: str(row[3]) as LogEventType,
    occurred_at: Number(row[4]),
    occurred_at_jst: str(row[5]),
    received_at: Number(row[6]),
    processed_at: Number(row[7]),
    source: str(row[8]),
    session_no: numOrNull(row[9]),
    memo: str(row[10]),
    correction_of: strOrNull(row[11]),
    old_value: numOrNull(row[12]),
    new_value: numOrNull(row[13]),
    reason: str(row[14]),
  };
}

function rawLogToRow(r: RawLogRow): unknown[] {
  return [
    r.event_id,
    r.idempotency_key,
    r.business_date,
    r.event_type,
    r.occurred_at,
    r.occurred_at_jst,
    r.received_at,
    r.processed_at,
    r.source,
    r.session_no ?? "",
    r.memo,
    r.correction_of ?? "",
    r.old_value ?? "",
    r.new_value ?? "",
    r.reason,
  ];
}

function rowToDailySummary(row: unknown[]): DailySummaryRow {
  return {
    business_date: str(row[0]),
    weekday: str(row[1]),
    session_count: Number(row[2]),
    first_start_jst: strOrNull(row[3]),
    last_end_jst: strOrNull(row[4]),
    break_seconds: Number(row[5]),
    worked_seconds: numOrNull(row[6]),
    worked_minutes: numOrNull(row[7]),
    status: str(row[8]) as DailyStatus,
    correction_count: Number(row[9]),
    note: strOrNull(row[10]),
    updated_at: Number(row[11]),
  };
}

function dailySummaryToRow(r: DailySummaryRow): unknown[] {
  return [
    r.business_date,
    r.weekday,
    r.session_count,
    r.first_start_jst ?? "",
    r.last_end_jst ?? "",
    r.break_seconds,
    r.worked_seconds ?? "",
    r.worked_minutes ?? "",
    r.status,
    r.correction_count,
    r.note ?? "",
    r.updated_at,
  ];
}

function rowToUnitPrice(row: unknown[]): UnitPriceRow {
  return {
    client: str(row[0]),
    unit_price: Number(row[1]),
    tax_category: str(row[2]) as TaxCategory,
    tax_inclusive: row[3] === true || str(row[3]).toLowerCase() === "true",
    tax_display: str(row[4]) as UnitPriceRow["tax_display"],
    rounding: str(row[5]) as Rounding,
    withholding: str(row[6]) as Withholding,
    valid_from: str(row[7]),
    valid_to: strOrNull(row[8]),
  };
}

function rowToMonthlyBill(row: unknown[]): MonthlyBillRow {
  return {
    client: str(row[0]),
    month: str(row[1]),
    worked_minutes: Number(row[2]),
    hours: Number(row[3]),
    unit_price: Number(row[4]),
    amount: Number(row[5]),
    tax_amount: Number(row[6]),
    withholding_amount: Number(row[7]),
    net_amount: Number(row[8]),
    state: str(row[9]),
    mf_invoice_id: strOrNull(row[10]),
    locked_at: numOrNull(row[11]),
    note: strOrNull(row[12]),
    updated_at: Number(row[13]),
  };
}

function monthlyBillToRow(r: MonthlyBillRow): unknown[] {
  return [
    r.client,
    r.month,
    r.worked_minutes,
    r.hours,
    r.unit_price,
    r.amount,
    r.tax_amount,
    r.withholding_amount,
    r.net_amount,
    r.state,
    r.mf_invoice_id ?? "",
    r.locked_at ?? "",
    r.note ?? "",
    r.updated_at,
  ];
}

export class SheetsAdapter implements SheetsPort {
  private readonly spreadsheetId: string;
  private spreadsheet: GoogleAppsScript.Spreadsheet.Spreadsheet | null = null;

  constructor(spreadsheetId: string) {
    this.spreadsheetId = spreadsheetId;
  }

  private ss(): GoogleAppsScript.Spreadsheet.Spreadsheet {
    if (this.spreadsheet === null) {
      this.spreadsheet = SpreadsheetApp.openById(this.spreadsheetId);
    }
    return this.spreadsheet;
  }

  private sheet(name: string): GoogleAppsScript.Spreadsheet.Sheet {
    const sheet = this.ss().getSheetByName(name);
    if (sheet === null) {
      throw new Error(`sheet_not_found:${name}`);
    }
    return sheet;
  }

  /** ヘッダー行を除く全データ行を返す（1 行も無ければ空配列）。 */
  private dataRows(name: string): unknown[][] {
    const sheet = this.sheet(name);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return [];
    }
    const lastCol = SHEET_HEADERS[name]?.length ?? sheet.getLastColumn();
    return sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  }

  appendRawLog(row: RawLogRow): void {
    this.sheet(SHEET_NAMES.rawLog).appendRow(rawLogToRow(row));
  }

  findRawLogByIdempotencyKey(idempotencyKey: string): RawLogRow | null {
    const sheet = this.sheet(SHEET_NAMES.rawLog);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return null;
    }
    const finder = sheet
      .getRange(2, 2, lastRow - 1, 1)
      .createTextFinder(idempotencyKey)
      .matchEntireCell(true);
    const match = finder.findNext();
    if (match === null) {
      return null;
    }
    const rowIndex = match.getRow();
    const rowValues = sheet.getRange(rowIndex, 1, 1, RAW_LOG_HEADERS.length).getValues()[0];
    if (rowValues === undefined) {
      return null;
    }
    return rowToRawLog(rowValues);
  }

  getEventsForBusinessDate(businessDate: string): RawLogRow[] {
    return this.dataRows(SHEET_NAMES.rawLog)
      .filter((row) => str(row[2]) === businessDate)
      .map(rowToRawLog);
  }

  getRecentDaysEvents(referenceBusinessDate: string, days: number): RecentDay[] {
    const result: RecentDay[] = [];
    for (let i = 1; i <= days; i++) {
      const date = shiftBusinessDate(referenceBusinessDate, -i);
      const events: LoggedEvent[] = this.getEventsForBusinessDate(date).map((row) => ({
        event_id: row.event_id,
        event_type: row.event_type,
        occurred_at: row.occurred_at,
        correction_of: row.correction_of ?? undefined,
        new_value: row.new_value ?? undefined,
      }));
      result.push({ business_date: date, events });
    }
    return result;
  }

  upsertDailySummary(row: DailySummaryRow): void {
    const sheet = this.sheet(SHEET_NAMES.dailySummary);
    const values = this.dataRows(SHEET_NAMES.dailySummary);
    const idx = values.findIndex((r) => str(r[0]) === row.business_date);
    const rowValues = dailySummaryToRow(row);
    if (idx === -1) {
      sheet.appendRow(rowValues);
      return;
    }
    sheet.getRange(idx + 2, 1, 1, DAILY_SUMMARY_HEADERS.length).setValues([rowValues]);
  }

  getDailySummary(businessDate: string): DailySummaryRow | null {
    const found = this.dataRows(SHEET_NAMES.dailySummary).find((r) => str(r[0]) === businessDate);
    return found === undefined ? null : rowToDailySummary(found);
  }

  getDailySummariesInRange(fromDate: string, toDate: string): DailySummaryRow[] {
    return this.dataRows(SHEET_NAMES.dailySummary)
      .filter((r) => {
        const d = str(r[0]);
        return d >= fromDate && d <= toDate;
      })
      .map(rowToDailySummary)
      .sort((a, b) => (a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : 0));
  }

  getUnitPriceRows(): UnitPriceRow[] {
    return this.dataRows(SHEET_NAMES.unitPrice).map(rowToUnitPrice);
  }

  upsertMonthlyBill(row: MonthlyBillRow): void {
    const sheet = this.sheet(SHEET_NAMES.monthlyBill);
    const values = this.dataRows(SHEET_NAMES.monthlyBill);
    const idx = values.findIndex((r) => str(r[0]) === row.client && str(r[1]) === row.month);
    const rowValues = monthlyBillToRow(row);
    if (idx === -1) {
      sheet.appendRow(rowValues);
      return;
    }
    sheet.getRange(idx + 2, 1, 1, MONTHLY_BILL_HEADERS.length).setValues([rowValues]);
  }

  getMonthlyBill(client: string, month: string): MonthlyBillRow | null {
    const found = this.dataRows(SHEET_NAMES.monthlyBill).find((r) => str(r[0]) === client && str(r[1]) === month);
    return found === undefined ? null : rowToMonthlyBill(found);
  }

  getInternalValue(kind: string, key: string): string | null {
    const found = this.dataRows(SHEET_NAMES.internal).find((r) => str(r[0]) === kind && str(r[1]) === key);
    return found === undefined ? null : str(found[2]);
  }

  setInternalValue(kind: string, key: string, value: string): void {
    const sheet = this.sheet(SHEET_NAMES.internal);
    const values = this.dataRows(SHEET_NAMES.internal);
    const idx = values.findIndex((r) => str(r[0]) === kind && str(r[1]) === key);
    const rowValues = [kind, key, value, Date.now()];
    if (idx === -1) {
      sheet.appendRow(rowValues);
      return;
    }
    sheet.getRange(idx + 2, 1, 1, INTERNAL_HEADERS.length).setValues([rowValues]);
  }
}
