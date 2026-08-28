/**
 * `SheetsPort` の GAS 実装（実装設計 §7.1, §7.9）。`SpreadsheetApp` 以外の I/O は行わない。
 *
 * 生ログは追記専用。日次集計・月次請求・内部シートは `business_date`／`client+month`／
 * `kind+key` を主キーとして 1 行 upsert する。経費台帳は WP3 では書込ポートを持たない
 * （`setupSpreadsheet` が作成するのみ）。
 */
import { businessDateOf, formatJst } from "@kadobo/shared/time";
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
 * text 化しない列（本来数値・真偽値の列。1-based 列番号）。型自動変換バグ対策A。
 * Sheets は `appendRow`/`setValues` に渡した「数値・日付に見える文字列」を自動変換してしまう
 * （実機で確認: 内部シートの `value`（カード ts）が数値化して末尾ゼロが消失、`business_date` が
 * `Date` 化されて文字列比較が壊れる）。ここに挙げた列以外は書き込み前に text 書式（`@`）を
 * 適用して自動変換を防ぐ。経費台帳は WP3 では書込ポートを持たないためこのマップに含めない
 * （{@link textColumnIndices} が空配列を返し、対象外になる）。
 */
const NON_TEXT_COLUMNS: Partial<Record<string, readonly number[]>> = {
  // occurred_at / received_at / processed_at / session_no / old_value / new_value
  [SHEET_NAMES.rawLog]: [5, 7, 8, 10, 13, 14],
  // session_count / break_seconds / worked_seconds / worked_minutes / correction_count / updated_at
  [SHEET_NAMES.dailySummary]: [3, 6, 7, 8, 10, 12],
  // unit_price / tax_inclusive
  [SHEET_NAMES.unitPrice]: [2, 4],
  // worked_minutes / hours / unit_price / amount / tax_amount / withholding_amount / net_amount /
  // locked_at（現状の型に合わせ number のまま） / updated_at
  [SHEET_NAMES.monthlyBill]: [3, 4, 5, 6, 7, 8, 9, 12, 14],
  // updated_at（kind/key/value は text。value がカードの Slack ts で最重要）
  [SHEET_NAMES.internal]: [4],
};

/** シートの text 化すべき列（1-based）を返す。`NON_TEXT_COLUMNS` に無いシートは対象外（`[]`）。 */
function textColumnIndices(name: string): number[] {
  const headers = SHEET_HEADERS[name];
  const nonText = NON_TEXT_COLUMNS[name];
  if (headers === undefined || nonText === undefined) {
    return [];
  }
  const nonTextSet = new Set(nonText);
  const result: number[] = [];
  for (let i = 1; i <= headers.length; i++) {
    if (!nonTextSet.has(i)) {
      result.push(i);
    }
  }
  return result;
}

/**
 * シート上の text 化対象列の `rowIndex` から `numRows` 行に `setNumberFormat("@")` を適用する
 * （冪等・型自動変換バグ対策A）。`setupSpreadsheet` は既存の全データ行（`2 〜 getMaxRows()`）に、
 * 1 行の追記・更新ヘルパ（`appendFormattedRow`/`setFormattedRow`）は対象の 1 行だけに適用する。
 */
function applyTextFormat(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  name: string,
  rowIndex: number,
  numRows: number,
  numCols: number,
): void {
  if (numRows < 1) {
    return;
  }
  for (const col of textColumnIndices(name)) {
    if (col <= numCols) {
      sheet.getRange(rowIndex, col, numRows, 1).setNumberFormat("@");
    }
  }
}

/**
 * スプレッドシートを初期化する（実装設計 §7.1, §8 WP3 受入条件）。不足シート・ヘッダー行のみ
 * 作成する冪等な処理。既存データがあるシートのヘッダーは上書きしない。
 * 文字列列の text 書式（対策A）は既存シートにも毎回（冪等に）再適用する（ヘッダー書き込みの
 * 「空なら書く」ガードとは独立。単価マスタ等、GAS が書込ポートを持たず人手で編集される列も
 * ここで先回りして text 化しておく）。
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
    const maxRows = sheet.getMaxRows();
    if (maxRows >= 2) {
      applyTextFormat(sheet, name, 2, maxRows - 1, headers.length);
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

// ---------------------------------------------------------------------------
// 型自動変換バグ対策B（読み取り側の防御的正規化）。
//
// text 書式（対策A）を適用する前に書かれた既存データや、書式が何らかの理由で外れた
// エッジケースでは、`business_date`（"YYYY-MM-DD"）等の日付・年月文字列列が Sheets に
// よって `Date` 型へ自動変換されて格納され得る。読み取り時に `Date` を検出したら JST の
// カレンダー値へ復元してから文字列化する。`Date#getTime()` は変換元テキストが表す時刻を
// 正しく保持している（Apps Script が返す `Date` はどの実行環境で読んでも絶対時刻として
// 正しい）ので、`@kadobo/shared/time` の JST 変換ユーティリティにそのまま渡せる
// （GAS 実行環境のローカルタイムゾーン設定に依存しない）。
//
// 数値化された ts（内部シートの `value` 列、末尾ゼロの桁落ち）は文字列としての情報が
// 失われており読み取り側では復元不能。これは対策Aの text 書式で根治する。
// ---------------------------------------------------------------------------

/** `Date` 化された日付セル（business_date 等）を JST の "YYYY-MM-DD" に復元する。 */
function strDate(v: unknown): string {
  return v instanceof Date ? businessDateOf(v.getTime()) : str(v);
}

function strDateOrNull(v: unknown): string | null {
  const s = strDate(v);
  return s === "" ? null : s;
}

/** `Date` 化された日時セル（occurred_at_jst 等）を JST の "YYYY-MM-DD HH:mm:ss" に復元する。 */
function strDateTime(v: unknown): string {
  return v instanceof Date ? formatJst(v.getTime()) : str(v);
}

function strDateTimeOrNull(v: unknown): string | null {
  const s = strDateTime(v);
  return s === "" ? null : s;
}

/** `Date` 化された年月セル（月次請求の `month`＝"YYYY-MM"）を復元する。 */
function strMonth(v: unknown): string {
  return v instanceof Date ? businessDateOf(v.getTime()).slice(0, 7) : str(v);
}

function rowToRawLog(row: unknown[]): RawLogRow {
  return {
    event_id: str(row[0]),
    idempotency_key: str(row[1]),
    business_date: strDate(row[2]),
    event_type: str(row[3]) as LogEventType,
    occurred_at: Number(row[4]),
    occurred_at_jst: strDateTime(row[5]),
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
    business_date: strDate(row[0]),
    weekday: str(row[1]),
    session_count: Number(row[2]),
    first_start_jst: strDateTimeOrNull(row[3]),
    last_end_jst: strDateTimeOrNull(row[4]),
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
    valid_from: strDate(row[7]),
    valid_to: strDateOrNull(row[8]),
  };
}

function rowToMonthlyBill(row: unknown[]): MonthlyBillRow {
  return {
    client: str(row[0]),
    month: strMonth(row[1]),
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

  /**
   * 末尾に 1 行追記する（型自動変換バグ対策A）。`appendRow` は書き込み前に書式を指定できない
   * ため、追記先の行番号を算出してから文字列列に text 書式（`@`）を設定し、`setValues` で
   * 書き込む（`appendRawLog`・`upsertDailySummary`・`upsertMonthlyBill`・`setInternalValue`
   * 共通のヘルパ）。
   */
  private appendFormattedRow(name: string, rowValues: unknown[]): void {
    const sheet = this.sheet(name);
    const rowIndex = sheet.getLastRow() + 1;
    applyTextFormat(sheet, name, rowIndex, 1, rowValues.length);
    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  }

  /** 既存行（`rowIndex`、1-based）を上書きする。書式適用は {@link appendFormattedRow} と同様。 */
  private setFormattedRow(name: string, rowIndex: number, rowValues: unknown[]): void {
    const sheet = this.sheet(name);
    applyTextFormat(sheet, name, rowIndex, 1, rowValues.length);
    sheet.getRange(rowIndex, 1, 1, rowValues.length).setValues([rowValues]);
  }

  appendRawLog(row: RawLogRow): void {
    this.appendFormattedRow(SHEET_NAMES.rawLog, rawLogToRow(row));
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
      .filter((row) => strDate(row[2]) === businessDate)
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
    const values = this.dataRows(SHEET_NAMES.dailySummary);
    const idx = values.findIndex((r) => strDate(r[0]) === row.business_date);
    const rowValues = dailySummaryToRow(row);
    if (idx === -1) {
      this.appendFormattedRow(SHEET_NAMES.dailySummary, rowValues);
      return;
    }
    this.setFormattedRow(SHEET_NAMES.dailySummary, idx + 2, rowValues);
  }

  getDailySummary(businessDate: string): DailySummaryRow | null {
    const found = this.dataRows(SHEET_NAMES.dailySummary).find((r) => strDate(r[0]) === businessDate);
    return found === undefined ? null : rowToDailySummary(found);
  }

  getDailySummariesInRange(fromDate: string, toDate: string): DailySummaryRow[] {
    return this.dataRows(SHEET_NAMES.dailySummary)
      .filter((r) => {
        const d = strDate(r[0]);
        return d >= fromDate && d <= toDate;
      })
      .map(rowToDailySummary)
      .sort((a, b) => (a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : 0));
  }

  getUnitPriceRows(): UnitPriceRow[] {
    return this.dataRows(SHEET_NAMES.unitPrice).map(rowToUnitPrice);
  }

  upsertMonthlyBill(row: MonthlyBillRow): void {
    const values = this.dataRows(SHEET_NAMES.monthlyBill);
    const idx = values.findIndex((r) => str(r[0]) === row.client && strMonth(r[1]) === row.month);
    const rowValues = monthlyBillToRow(row);
    if (idx === -1) {
      this.appendFormattedRow(SHEET_NAMES.monthlyBill, rowValues);
      return;
    }
    this.setFormattedRow(SHEET_NAMES.monthlyBill, idx + 2, rowValues);
  }

  getMonthlyBill(client: string, month: string): MonthlyBillRow | null {
    const found = this.dataRows(SHEET_NAMES.monthlyBill).find(
      (r) => str(r[0]) === client && strMonth(r[1]) === month,
    );
    return found === undefined ? null : rowToMonthlyBill(found);
  }

  getInternalValue(kind: string, key: string): string | null {
    const found = this.dataRows(SHEET_NAMES.internal).find((r) => str(r[0]) === kind && strDate(r[1]) === key);
    return found === undefined ? null : str(found[2]);
  }

  setInternalValue(kind: string, key: string, value: string): void {
    const values = this.dataRows(SHEET_NAMES.internal);
    const idx = values.findIndex((r) => str(r[0]) === kind && strDate(r[1]) === key);
    const rowValues = [kind, key, value, Date.now()];
    if (idx === -1) {
      this.appendFormattedRow(SHEET_NAMES.internal, rowValues);
      return;
    }
    this.setFormattedRow(SHEET_NAMES.internal, idx + 2, rowValues);
  }
}
