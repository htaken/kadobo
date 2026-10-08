/**
 * `SheetsPort` の GAS 実装（実装設計 §7.1, §7.9, 経費フェーズ §5.1, §5.3）。
 * `SpreadsheetApp` 以外の I/O は行わない。
 *
 * 生ログは追記専用。日次集計・月次請求・内部シート・経費台帳は `business_date`／`client+month`／
 * `kind+key`／`証憑ID` を主キーとして 1 行 upsert する（経費台帳は `appendExpense` で追記した後、
 * `updateExpense` で証憑ID をキーに部分更新する）。
 */
import type { ExpenseCategory, ExpenseState, PaymentMethod, ReceiptType } from "@kadobo/shared/expense";
import { businessDateOf, formatJst } from "@kadobo/shared/time";
import type { RecentDay } from "../core/businessDate";
import type { JournalSyncState } from "../core/journalSync";
import type { LoggedEvent, LogEventType } from "../core/state";
import type { DailyStatus, Rounding, TaxCategory, UnitPriceRow, Withholding } from "../core/aggregate";
import {
  orderedColumnKeys,
  type DailySummaryRow,
  type ExpenseLedgerRow,
  type MonthlyBillRow,
  type RawLogRow,
  type SheetsPort,
} from "../app/ports";
import { shiftBusinessDate } from "../app/dateUtil";

const SHEET_NAMES = {
  rawLog: "生ログ",
  dailySummary: "日次集計",
  unitPrice: "単価マスタ",
  monthlyBill: "月次請求",
  expenseLedger: "経費台帳",
  internal: "内部",
  correctionRequest: "訂正削除申請",
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

/**
 * 月次請求の列（実装設計 MF連携 §5.1）。既存 14 列（`MONTHLY_BILL_HEADERS_V1`）に、締めの状態機械
 * が使う 4 列（`invoice_state`〜`close_card_ts`）を末尾に追加した 18 列。
 */
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
  // 🔄 MF連携フェーズで追加（実装設計 §5.1）。書くのは締め処理・MF 同期だけ。
  "invoice_state",
  "invoice_error",
  "invoice_attempted_at",
  "close_card_ts",
] as const;

/** 移行前（MVP/経費フェーズ時点）の月次請求ヘッダー。`migrateMonthlyBill` の一致判定専用。 */
const MONTHLY_BILL_HEADERS_V1 = MONTHLY_BILL_HEADERS.slice(0, 14);

/**
 * 経費台帳の列（実装設計 経費フェーズ §5.1）。MVP（WP3）の 14 列に、at-least-once 配送・監査・
 * 訂正取消フローに必要な 10 列（システム列 6 ＋ 業務列 4）を追加した 24 列（V2）。
 * 🔄 MF 連携フェーズ（実装設計 MF連携 §6.1）で、末尾に 7 列（業務列 2 ＋ システム列 5）を足した 31 列（V3）。
 * `EXPENSE_LEDGER_HEADERS_V1`（先頭 14 列）・`EXPENSE_LEDGER_HEADERS_V2`（先頭 24 列）は
 * `migrateExpenseLedger` の移行判定にのみ使う。
 */
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
  // 🔄 システム列（実装設計 §5.1 #E6）。保護・既定非表示（`EXPENSE_SYSTEM_COLUMN_*` 参照）。
  "idempotency_key",
  "slack_file_id",
  "drive_file_id",
  "元ファイル名",
  "last_error",
  "state_updated_at",
  // 🔄 業務列（実装設計 §7 #E5, §5.7）。システム列と異なり通常どおり編集可能・表示のまま。
  "税区分",
  "事業使用割合",
  "訂正元証憑ID",
  "訂正理由",
  // 🔄 MF 連携フェーズ（実装設計 MF連携 §6.1）。25・26 列目は業務列、27〜31 列目はシステム列。
  "支払方法",
  "MF明細ID",
  "MF連携状態",
  "MF連携エラー",
  "MF連携更新日時",
  "MF連携試行日時",
  "MF連携入力",
] as const;

/** 移行前（MVP §7.1）の経費台帳ヘッダー。`migrateExpenseLedger` の一致判定専用。 */
const EXPENSE_LEDGER_HEADERS_V1 = EXPENSE_LEDGER_HEADERS.slice(0, 14);
/** 経費フェーズ時点（24 列）の経費台帳ヘッダー。`migrateExpenseLedger` の一致判定専用。 */
const EXPENSE_LEDGER_HEADERS_V2 = EXPENSE_LEDGER_HEADERS.slice(0, 24);

/** システム列（`idempotency_key`〜`state_updated_at`）の開始列（1-based）と列数。 */
const EXPENSE_SYSTEM_COLUMN_START = 15;
const EXPENSE_SYSTEM_COLUMN_COUNT = 6;
const EXPENSE_SYSTEM_COLUMN_PROTECTION_DESCRIPTION =
  "経費台帳 システム列（idempotency_key〜state_updated_at）: GAS のみが更新します（手編集禁止）";

/**
 * 🔄 MF 連携のシステム列（`MF連携状態`〜`MF連携入力`。27〜31 列目、実装設計 MF連携 §6.1）の開始列
 * （1-based）と列数。既存のシステム列（15〜20）とは連続しないため、別の範囲保護にする。
 * **非表示にはしない**: 運用で `MF連携状態`・`MF連携エラー` を人が読み、`NEEDS_REVIEW`/`ERROR` から
 * 復帰させるとき `MF連携状態` を空に戻すため（保護は警告付きなので編集できる）。
 */
const EXPENSE_MF_SYSTEM_COLUMN_START = 27;
const EXPENSE_MF_SYSTEM_COLUMN_COUNT = 5;
const EXPENSE_MF_SYSTEM_COLUMN_PROTECTION_DESCRIPTION =
  "経費台帳 MF連携システム列（MF連携状態〜MF連携入力）: GAS のみが更新します（手編集は状態を空に戻す操作だけ）";

const INTERNAL_HEADERS = ["kind", "key", "value", "updated_at"] as const;

/**
 * 訂正削除申請シート（事務処理規程・電子取引 第2条）。国税庁ひな形の「取引情報訂正・削除申請書」に
 * 記載すべき 8 項目をそのまま列名にする（法的文書との対応を保つため言い換えない）。
 *
 * 経費台帳の訂正・取消フロー（実装設計 経費フェーズ §5.7, runbook §H.2）は `処理状態` を
 * `CORRECTED`／`VOID` にし `訂正理由`・`訂正元証憑ID` を記録するが、規程第2条が求める
 * 「申請日」「訂正・削除日付」「訂正・削除内容」の置き場所が無い。このシートは GAS の
 * 書込ポートを持たず、人手で 8 項目を記入する（runbook §H.2 参照）。
 */
const CORRECTION_REQUEST_HEADERS = [
  "申請日",
  "取引伝票番号",
  "取引件名",
  "取引先名",
  "訂正・削除日付",
  "訂正・削除内容",
  "訂正・削除理由",
  "処理担当者名",
] as const;

const SHEET_HEADERS: Record<string, readonly string[]> = {
  [SHEET_NAMES.rawLog]: RAW_LOG_HEADERS,
  [SHEET_NAMES.dailySummary]: DAILY_SUMMARY_HEADERS,
  [SHEET_NAMES.unitPrice]: UNIT_PRICE_HEADERS,
  [SHEET_NAMES.monthlyBill]: MONTHLY_BILL_HEADERS,
  [SHEET_NAMES.expenseLedger]: EXPENSE_LEDGER_HEADERS,
  [SHEET_NAMES.internal]: INTERNAL_HEADERS,
  [SHEET_NAMES.correctionRequest]: CORRECTION_REQUEST_HEADERS,
};

/** 警告付き保護をかけるシート（実装設計 §7.1）。 */
const PROTECTED_SHEETS: readonly string[] = [SHEET_NAMES.rawLog, SHEET_NAMES.dailySummary, SHEET_NAMES.internal];

/**
 * text 化しない列（本来数値・真偽値の列。1-based 列番号）。型自動変換バグ対策A。
 * Sheets は `appendRow`/`setValues` に渡した「数値・日付に見える文字列」を自動変換してしまう
 * （実機で確認: 内部シートの `value`（カード ts）が数値化して末尾ゼロが消失、`business_date` が
 * `Date` 化されて文字列比較が壊れる）。ここに挙げた列以外は書き込み前に text 書式（`@`）を
 * 適用して自動変換を防ぐ。
 *
 * 🔄 経費台帳（実装設計 経費フェーズ §5.1 の 🔄）: WP3 では書込ポートを持たずこのマップから
 * 除外されていたが、本 WP（WP8a）で書込ポートを持つため追加した。`日付`（`YYYY-MM-DD`）・
 * `証憑ID`（`R-...`）・`ファイルハッシュ`・`idempotency_key` 等は必ず text 化する必要がある
 * （`business_date` と同じ理由で `Date` 化・数値化されると文字列比較・突合が壊れる）。
 * `金額`・`サイズ`・`事業使用割合`・`state_updated_at`・`入力日時` は本来数値のため
 * 対象外（数値のまま）にする。
 */
const NON_TEXT_COLUMNS: Partial<Record<string, readonly number[]>> = {
  // occurred_at / received_at / processed_at / session_no / old_value / new_value
  [SHEET_NAMES.rawLog]: [5, 7, 8, 10, 13, 14],
  // session_count / break_seconds / worked_seconds / worked_minutes / correction_count / updated_at
  [SHEET_NAMES.dailySummary]: [3, 6, 7, 8, 10, 12],
  // unit_price / tax_inclusive
  [SHEET_NAMES.unitPrice]: [2, 4],
  // worked_minutes / hours / unit_price / amount / tax_amount / withholding_amount / net_amount /
  // locked_at（現状の型に合わせ number のまま） / updated_at / invoice_attempted_at
  [SHEET_NAMES.monthlyBill]: [3, 4, 5, 6, 7, 8, 9, 12, 14, 17],
  // 金額 / サイズ / 入力日時 / state_updated_at / 事業使用割合 /
  // 🔄 MF 連携: MF連携更新日時（29）・MF連携試行日時（30）も数値
  [SHEET_NAMES.expenseLedger]: [4, 11, 12, 20, 22, 29, 30],
  // updated_at（kind/key/value は text。value がカードの Slack ts で最重要）
  [SHEET_NAMES.internal]: [4],
  // 訂正削除申請（事務処理規程・電子取引 第2条）: 空配列＝全 8 列を text 化する。
  // 「取引伝票番号」は証憑ID（`R-YYYYMMDD-NNN`）、「申請日」「訂正・削除日付」は
  // `YYYY-MM-DD` で、いずれも Sheets に `Date` 化・数値化されると規程が求める記録として
  // 読めなくなる（`business_date` と同じ理由）。このシートは人手で記入するが、
  // `単価マスタ` と同じく GAS が書込ポートを持たない列でも先回りで text 化しておく。
  [SHEET_NAMES.correctionRequest]: [],
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
 * スプレッドシートを初期化する（実装設計 §7.1, §8 WP3 受入条件、経費フェーズ §5.1）。
 * 不足シート・ヘッダー行のみ作成する冪等な処理。既存データがあるシートのヘッダーは上書きしない。
 * 文字列列の text 書式（対策A）は既存シートにも毎回（冪等に）再適用する（ヘッダー書き込みの
 * 「空なら書く」ガードとは独立。単価マスタ等、GAS が書込ポートを持たず人手で編集される列も
 * ここで先回りして text 化しておく）。
 *
 * 🔄 経費台帳（`SHEET_NAMES.expenseLedger`）・月次請求（`SHEET_NAMES.monthlyBill`）はこの汎用
 * ループから除外し、それぞれ {@link migrateExpenseLedger}・{@link migrateMonthlyBill} で個別に
 * 扱う。本番シートには既に旧バージョンの列数のヘッダーがあるため、他シートと同じ「空なら書く」
 * ガードでは新しい列への拡張ができない。かつヘッダーが旧列数・新列数のどちらとも一致しない
 * 異常な状態では**何も書き換えず例外を投げて中断する**（fail closed。実装設計 経費フェーズ
 * §5.1・MF連携 §5.1 の 🔄）ため、単純な「不足列を末尾に足す」処理にはできない。
 */
export function setupSpreadsheet(spreadsheetId: string): void {
  const ss = SpreadsheetApp.openById(spreadsheetId);
  for (const [name, headers] of Object.entries(SHEET_HEADERS)) {
    if (name === SHEET_NAMES.expenseLedger || name === SHEET_NAMES.monthlyBill) {
      continue;
    }
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
  migrateExpenseLedger(ss);
  migrateMonthlyBill(ss);
}

/** 配列の内容が過不足なく完全一致するか（`migrateExpenseLedger` の見出し比較専用）。 */
function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 🔄 シートの実列数（`getMaxColumns()`）が `minColumns` に満たなければ末尾に列を追加して広げる
 * （コーディネーターレビュー指摘の修正。実装設計 経費フェーズ §5.1）。
 *
 * `getRange(row, col, numRows, numCols)` はシートの実際の列数を超えるレンジを要求すると
 * GAS の内部エラー（「範囲の列数が多すぎます」）を投げる。本番シートは既定 26 列だが、
 * 誰かが余分な列を削除して 24 列未満になっていた場合、`migrateExpenseLedger` が読み書きに
 * 使う 24 列ぶんの `getRange` がこの内部エラーで落ち、fail closed の分かりやすいメッセージに
 * 到達できなくなる。`insertColumnsAfter` は既存セルの位置を一切変えない安全な操作（末尾に
 * 空列を追加するだけ）なので、データを書き換えずに済む。
 */
function ensureMinColumns(sheet: GoogleAppsScript.Spreadsheet.Sheet, minColumns: number): void {
  const currentMax = sheet.getMaxColumns();
  if (currentMax < minColumns) {
    sheet.insertColumnsAfter(currentMax, minColumns - currentMax);
  }
}

/**
 * 経費台帳の列マイグレーション（実装設計 経費フェーズ §5.1 の 🔄、§9 WP8a 受入条件、
 * MF連携 §6.1）。
 *
 * - シートが無ければ新規作成し、最初から 31 列ヘッダー（V3）を書く（新規デプロイ・テスト用の
 *   空シートのケース。移行対象の実データが無いため判定不要）
 * - 既存ヘッダーが MVP の 14 列（{@link EXPENSE_LEDGER_HEADERS_V1}）と**完全一致**し、15 列目以降が
 *   空なら、15〜31 列目のヘッダーを追加する移行
 * - 既存ヘッダーが経費フェーズの 24 列（{@link EXPENSE_LEDGER_HEADERS_V2}）と完全一致し、25 列目以降が
 *   空なら、25〜31 列目のヘッダーを追加する移行（MF 連携の 7 列。既存 24 列の値には一切触れない）
 * - 既に 31 列（{@link EXPENSE_LEDGER_HEADERS}）と完全一致すれば、何もしない（2 回目以降の
 *   実行に対する冪等性）
 * - どれとも一致しない場合は**何も書き換えず**例外を投げて中断する（fail closed）。
 *   xlsx バックアップの上で実装設計 経費フェーズ §5.1・§10 の手順に従って手動確認すること
 */
function migrateExpenseLedger(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): void {
  const name = SHEET_NAMES.expenseLedger;
  let sheet = ss.getSheetByName(name);
  if (sheet === null) {
    sheet = ss.insertSheet(name);
  }
  // 🔄 この先の 31 列ぶんの getRange が「範囲の列数が多すぎます」で落ちないよう、
  // 読み書きより前に列数を確保する（既存セルには一切触れない）。
  ensureMinColumns(sheet, EXPENSE_LEDGER_HEADERS.length);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, EXPENSE_LEDGER_HEADERS.length).setValues([[...EXPENSE_LEDGER_HEADERS]]);
  } else {
    // 常に「移行後の 31 列」ぶんを読む。**先に 31 列との完全一致を判定し**、一致しなければ
    // 「先頭 N 列（N = 14 か 24）が旧ヘッダーと完全一致し、N+1 列目以降が空（＝拡張前）」のときだけ
    // 移行対象と判定する。
    const headerAll = (sheet.getRange(1, 1, 1, EXPENSE_LEDGER_HEADERS.length).getValues()[0] ?? []).map(str);
    const alreadyMigrated = arraysEqual(headerAll, EXPENSE_LEDGER_HEADERS);
    if (!alreadyMigrated) {
      const legacyHeaders = [EXPENSE_LEDGER_HEADERS_V2, EXPENSE_LEDGER_HEADERS_V1];
      const matched = legacyHeaders.find(
        (legacy) =>
          arraysEqual(headerAll.slice(0, legacy.length), legacy) &&
          headerAll.slice(legacy.length).every((v) => v === ""),
      );
      if (matched === undefined) {
        throw new Error(
          `経費台帳のヘッダーが想定と一致しません（MVP の 14 列にも経費フェーズの 24 列にも移行後の 31 列にも一致しません）。` +
            `自動移行は行わず中断しました。スプレッドシートを xlsx でバックアップしたうえで、` +
            `実装設計 経費フェーズ.md §5.1・§10 の移行手順に従って手動で確認してください。`,
        );
      }
      // 🔄 一度きりの列拡張移行。既存列（ヘッダー・データとも）には一切触れず、
      // 旧ヘッダーの右にヘッダーだけを追加する（列拡張は Sheets 側が自動で行う）。
      const newHeaders = EXPENSE_LEDGER_HEADERS.slice(matched.length);
      sheet.getRange(1, matched.length + 1, 1, newHeaders.length).setValues([newHeaders]);
    }
    // alreadyMigrated なら何もしない（2 回目以降の実行に対する冪等性）。
  }

  const maxRows = sheet.getMaxRows();
  if (maxRows >= 2) {
    applyTextFormat(sheet, name, 2, maxRows - 1, EXPENSE_LEDGER_HEADERS.length);
  }
  protectAndHideExpenseSystemColumns(sheet);
}

/**
 * 経費台帳のシステム列を保護し、既定で非表示にする（実装設計 §5.1 の 🔄。手編集されると冪等性と
 * 監査証跡が壊れるため）。対象は 2 つの範囲:
 * - `idempotency_key`〜`state_updated_at`（15〜20 列目）: 保護＋非表示
 * - 🔄 `MF連携状態`〜`MF連携入力`（27〜31 列目、実装設計 MF連携 §6.1）: 保護のみ（非表示にしない。
 *   人が読み、`MF連携状態` を空に戻して復帰させるため）
 * `証憑ID`〜`MF仕訳ID`・`税区分`〜`訂正理由`・`支払方法`・`MF明細ID` は対象外（引き続き人手編集・
 * 月次確認・訂正取消フローで編集する）。
 * 冪等: 既に同じ説明文の範囲保護があれば再度は付与しない。
 */
function protectAndHideExpenseSystemColumns(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  const ranges: { start: number; count: number; description: string; hide: boolean }[] = [
    {
      start: EXPENSE_SYSTEM_COLUMN_START,
      count: EXPENSE_SYSTEM_COLUMN_COUNT,
      description: EXPENSE_SYSTEM_COLUMN_PROTECTION_DESCRIPTION,
      hide: true,
    },
    {
      start: EXPENSE_MF_SYSTEM_COLUMN_START,
      count: EXPENSE_MF_SYSTEM_COLUMN_COUNT,
      description: EXPENSE_MF_SYSTEM_COLUMN_PROTECTION_DESCRIPTION,
      hide: false,
    },
  ];
  const existing = sheet.getProtections(SpreadsheetApp.ProtectionType.RANGE).map((p) => p.getDescription());
  for (const r of ranges) {
    if (!existing.includes(r.description)) {
      sheet
        .getRange(1, r.start, sheet.getMaxRows(), r.count)
        .protect()
        .setDescription(r.description)
        .setWarningOnly(true);
    }
    if (r.hide) {
      sheet.hideColumns(r.start, r.count);
    }
  }
}

/**
 * 月次請求の列マイグレーション（実装設計 MF連携 §5.1）。`migrateExpenseLedger` と同じ流儀
 * （既存列には一切触れず、末尾にヘッダーだけを追記する一度きりの移行）。
 *
 * - シートが無ければ新規作成し、最初から 18 列ヘッダーを書く
 * - 既存ヘッダーが旧 14 列（{@link MONTHLY_BILL_HEADERS_V1}）と完全一致すれば、右へ 4 列
 *   （`invoice_state`〜`close_card_ts`）を追加する
 * - 既に 18 列（{@link MONTHLY_BILL_HEADERS}）と完全一致すれば何もしない（冪等）
 * - どちらとも一致しなければ、何も書き換えず例外を投げて中断する（fail closed）
 */
function migrateMonthlyBill(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): void {
  const name = SHEET_NAMES.monthlyBill;
  let sheet = ss.getSheetByName(name);
  if (sheet === null) {
    sheet = ss.insertSheet(name);
  }
  ensureMinColumns(sheet, MONTHLY_BILL_HEADERS.length);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, MONTHLY_BILL_HEADERS.length).setValues([[...MONTHLY_BILL_HEADERS]]);
  } else {
    const header18 = (sheet.getRange(1, 1, 1, MONTHLY_BILL_HEADERS.length).getValues()[0] ?? []).map(str);
    const alreadyMigrated = arraysEqual(header18, MONTHLY_BILL_HEADERS);
    if (!alreadyMigrated) {
      const header14 = header18.slice(0, MONTHLY_BILL_HEADERS_V1.length);
      const extension = header18.slice(MONTHLY_BILL_HEADERS_V1.length);
      const isUnmigratedV1 = arraysEqual(header14, MONTHLY_BILL_HEADERS_V1) && extension.every((v) => v === "");
      if (!isUnmigratedV1) {
        throw new Error(
          `月次請求のヘッダーが想定と一致しません（既存 14 列にも移行後の 18 列にも一致しません）。` +
            `自動移行は行わず中断しました。スプレッドシートを xlsx でバックアップしたうえで、` +
            `実装設計 MF連携.md §5.1 の移行手順に従って手動で確認してください。`,
        );
      }
      const newHeaders = MONTHLY_BILL_HEADERS.slice(MONTHLY_BILL_HEADERS_V1.length);
      sheet.getRange(1, MONTHLY_BILL_HEADERS_V1.length + 1, 1, newHeaders.length).setValues([newHeaders]);
    }
    // alreadyMigrated なら何もしない（2 回目以降の実行に対する冪等性）。
  }

  const maxRows = sheet.getMaxRows();
  if (maxRows >= 2) {
    applyTextFormat(sheet, name, 2, maxRows - 1, MONTHLY_BILL_HEADERS.length);
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
    invoice_state: str(row[14]) as MonthlyBillRow["invoice_state"],
    invoice_error: strOrNull(row[15]),
    invoice_attempted_at: numOrNull(row[16]),
    close_card_ts: strOrNull(row[17]),
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
    r.invoice_state,
    r.invoice_error ?? "",
    r.invoice_attempted_at ?? "",
    r.close_card_ts ?? "",
  ];
}

function rowToExpense(row: unknown[]): ExpenseLedgerRow {
  return {
    receipt_id: str(row[0]),
    receipt_type: str(row[1]) as ReceiptType,
    date: strDate(row[2]),
    amount: Number(row[3]),
    partner: str(row[4]),
    category: str(row[5]) as ExpenseCategory,
    memo: str(row[6]),
    drive_link: str(row[7]),
    file_hash: str(row[8]),
    mime_type: str(row[9]),
    size: Number(row[10]),
    input_at: Number(row[11]),
    state: str(row[12]) as ExpenseState,
    mf_journal_id: strOrNull(row[13]),
    idempotency_key: str(row[14]),
    slack_file_id: str(row[15]),
    drive_file_id: str(row[16]),
    original_file_name: str(row[17]),
    last_error: strOrNull(row[18]),
    state_updated_at: Number(row[19]),
    tax_category: str(row[20]),
    business_use_ratio: Number(row[21]),
    correction_of_receipt_id: strOrNull(row[22]),
    correction_reason: strOrNull(row[23]),
    payment_method: str(row[24]) as PaymentMethod | "",
    mf_transaction_id: strOrNull(row[25]),
    mf_sync_state: str(row[26]) as JournalSyncState,
    mf_sync_error: strOrNull(row[27]),
    mf_sync_updated_at: numOrNull(row[28]),
    mf_sync_attempted_at: numOrNull(row[29]),
    mf_sync_input: str(row[30]),
  };
}

function expenseToRow(r: ExpenseLedgerRow): unknown[] {
  return [
    r.receipt_id,
    r.receipt_type,
    r.date,
    r.amount,
    r.partner,
    r.category,
    r.memo,
    r.drive_link,
    r.file_hash,
    r.mime_type,
    r.size,
    r.input_at,
    r.state,
    r.mf_journal_id ?? "",
    r.idempotency_key,
    r.slack_file_id,
    r.drive_file_id,
    r.original_file_name,
    r.last_error ?? "",
    r.state_updated_at,
    r.tax_category,
    r.business_use_ratio,
    r.correction_of_receipt_id ?? "",
    r.correction_reason ?? "",
    r.payment_method,
    r.mf_transaction_id ?? "",
    r.mf_sync_state,
    r.mf_sync_error ?? "",
    r.mf_sync_updated_at ?? "",
    r.mf_sync_attempted_at ?? "",
    r.mf_sync_input,
  ];
}

/**
 * 経費台帳の列番号（1-based）。{@link SheetsAdapter.updateExpenseColumns} が `patch` のキーから
 * 書く列を決めるために使う（`EXPENSE_LEDGER_HEADERS` の並びと一致させること）。
 */
const EXPENSE_COLUMN_INDEX: Record<keyof ExpenseLedgerRow, number> = {
  receipt_id: 1,
  receipt_type: 2,
  date: 3,
  amount: 4,
  partner: 5,
  category: 6,
  memo: 7,
  drive_link: 8,
  file_hash: 9,
  mime_type: 10,
  size: 11,
  input_at: 12,
  state: 13,
  mf_journal_id: 14,
  idempotency_key: 15,
  slack_file_id: 16,
  drive_file_id: 17,
  original_file_name: 18,
  last_error: 19,
  state_updated_at: 20,
  tax_category: 21,
  business_use_ratio: 22,
  correction_of_receipt_id: 23,
  correction_reason: 24,
  payment_method: 25,
  mf_transaction_id: 26,
  mf_sync_state: 27,
  mf_sync_error: 28,
  mf_sync_updated_at: 29,
  mf_sync_attempted_at: 30,
  mf_sync_input: 31,
};

/** シートへ書くセル値（`expenseToRow` の 1 列ぶんと同じ変換）。`null` は空セルにする。 */
function expenseCellValue(value: ExpenseLedgerRow[keyof ExpenseLedgerRow]): unknown {
  return value === null ? "" : value;
}

/**
 * 月次請求の列番号（1-based）。{@link SheetsAdapter.updateMonthlyBillColumns} が `patch` のキーから書く列を
 * 決めるために使う（`MONTHLY_BILL_HEADERS` の並びと一致させること）。
 */
const MONTHLY_COLUMN_INDEX: Record<keyof MonthlyBillRow, number> = {
  client: 1,
  month: 2,
  worked_minutes: 3,
  hours: 4,
  unit_price: 5,
  amount: 6,
  tax_amount: 7,
  withholding_amount: 8,
  net_amount: 9,
  state: 10,
  mf_invoice_id: 11,
  locked_at: 12,
  note: 13,
  updated_at: 14,
  invoice_state: 15,
  invoice_error: 16,
  invoice_attempted_at: 17,
  close_card_ts: 18,
};

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

  /**
   * 🔄 `client + month` の月次請求行の**指定列のセルだけ**を書く（実装設計 MF連携 §0, §8）。行全体は書き戻さない
   * （人が同時に編集した `state` 等を古い値で上書きしないため）。text 書式の列は 1 セルだけ書式を当ててから書く。
   * 行が無い場合は例外を投げる（`updateExpense` と同じ方針。新規作成は `upsertMonthlyBill`）。
   */
  updateMonthlyBillColumns(client: string, month: string, patch: Partial<MonthlyBillRow>): void {
    const values = this.dataRows(SHEET_NAMES.monthlyBill);
    const idx = values.findIndex((r) => str(r[0]) === client && strMonth(r[1]) === month);
    if (idx === -1) {
      throw new Error(`monthly_bill_not_found:${client}|${month}`);
    }
    const sheet = this.sheet(SHEET_NAMES.monthlyBill);
    const rowIndex = idx + 2;
    const textCols = textColumnIndices(SHEET_NAMES.monthlyBill);
    for (const [key, value] of Object.entries(patch) as [keyof MonthlyBillRow, MonthlyBillRow[keyof MonthlyBillRow]][]) {
      const col = MONTHLY_COLUMN_INDEX[key];
      if (col === undefined) {
        throw new Error(`unknown_monthly_bill_column:${String(key)}`);
      }
      if (textCols.includes(col)) {
        sheet.getRange(rowIndex, col, 1, 1).setNumberFormat("@");
      }
      sheet.getRange(rowIndex, col, 1, 1).setValues([[value === null ? "" : value]]);
    }
  }

  listMonthlyBills(): MonthlyBillRow[] {
    return this.dataRows(SHEET_NAMES.monthlyBill).map(rowToMonthlyBill);
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

  getInternalRows(kind: string): { key: string; value: string }[] {
    return this.dataRows(SHEET_NAMES.internal)
      .filter((r) => str(r[0]) === kind)
      .map((r) => ({ key: strDate(r[1]), value: str(r[2]) }));
  }

  // ---------------------------------------------------------------------------
  // 経費台帳（実装設計 経費フェーズ §5.1, §5.3）
  // ---------------------------------------------------------------------------

  appendExpense(row: ExpenseLedgerRow): void {
    this.appendFormattedRow(SHEET_NAMES.expenseLedger, expenseToRow(row));
  }

  findExpenseByIdempotencyKey(idempotencyKey: string): ExpenseLedgerRow | null {
    const sheet = this.sheet(SHEET_NAMES.expenseLedger);
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) {
      return null;
    }
    const finder = sheet
      .getRange(2, EXPENSE_SYSTEM_COLUMN_START, lastRow - 1, 1)
      .createTextFinder(idempotencyKey)
      .matchEntireCell(true);
    const match = finder.findNext();
    if (match === null) {
      return null;
    }
    const rowIndex = match.getRow();
    const rowValues = sheet.getRange(rowIndex, 1, 1, EXPENSE_LEDGER_HEADERS.length).getValues()[0];
    if (rowValues === undefined) {
      return null;
    }
    return rowToExpense(rowValues);
  }

  getExpenseByReceiptId(receiptId: string): ExpenseLedgerRow | null {
    const found = this.dataRows(SHEET_NAMES.expenseLedger).find((r) => str(r[0]) === receiptId);
    return found === undefined ? null : rowToExpense(found);
  }

  updateExpense(receiptId: string, patch: Partial<ExpenseLedgerRow>): void {
    const values = this.dataRows(SHEET_NAMES.expenseLedger);
    const idx = values.findIndex((r) => str(r[0]) === receiptId);
    if (idx === -1) {
      throw new Error(`expense_not_found:${receiptId}`);
    }
    const current = rowToExpense(values[idx]!);
    const merged: ExpenseLedgerRow = { ...current, ...patch };
    this.setFormattedRow(SHEET_NAMES.expenseLedger, idx + 2, expenseToRow(merged));
  }

  /**
   * 🔄 `patch` のキーに対応するセルだけを書く（実装設計 MF連携 §0, §6.1, §8）。他の列のセルには
   * 一切書き込まない（`updateExpense` のように行全体を書き戻さない）。**ロック内から呼ぶこと**。
   */
  updateExpenseColumns(
    receiptId: string,
    patch: Partial<ExpenseLedgerRow>,
    order?: readonly (keyof ExpenseLedgerRow)[],
  ): void {
    const values = this.dataRows(SHEET_NAMES.expenseLedger);
    const idx = values.findIndex((r) => str(r[0]) === receiptId);
    if (idx === -1) {
      throw new Error(`expense_not_found:${receiptId}`);
    }
    const sheet = this.sheet(SHEET_NAMES.expenseLedger);
    const rowIndex = idx + 2;
    for (const key of orderedColumnKeys(patch, order)) {
      const value = patch[key] as ExpenseLedgerRow[keyof ExpenseLedgerRow];
      const col = EXPENSE_COLUMN_INDEX[key];
      if (col === undefined) {
        throw new Error(`unknown_expense_column:${String(key)}`);
      }
      // text 書式の列は 1 セルだけに書式を適用してから書く（型自動変換バグ対策A）。
      if (textColumnIndices(SHEET_NAMES.expenseLedger).includes(col)) {
        sheet.getRange(rowIndex, col, 1, 1).setNumberFormat("@");
      }
      sheet.getRange(rowIndex, col, 1, 1).setValues([[expenseCellValue(value)]]);
    }
  }

  getAllExpenses(): ExpenseLedgerRow[] {
    return this.dataRows(SHEET_NAMES.expenseLedger).map(rowToExpense);
  }
}
