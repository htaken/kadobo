/**
 * 請求書関連の純関数（実装設計 MF連携 §5.4〜§5.7, §8）。
 *
 * `core` は `app` に依存しない（`gas/src/core/` はヘキサゴナル構成で GAS API にも `app` 層にも
 * 依存しない純関数のみを置く方針。実装設計 §0）ため、`buildInvoiceRequest`/`renderDailyNote` の
 * 引数は `app/ports.ts` の `MonthlyBillRow`/`DailySummaryRow` を直接 import せず、必要な項目だけの
 * 構造的部分型（{@link InvoiceBillInput}/{@link DailyNoteRow}）を独自に定義する（`MonthlyBillRow`/
 * `DailySummaryRow` をそのまま渡しても構造的に一致するため呼び出し側は無変換で渡せる）。
 */
import type { DailyStatus, UnitPriceRow } from "./aggregate";
import type { NormalizedBillingStatus } from "./monthClose";

/** `MF_EXTRA_HOLIDAYS` の既定値（`MM-DD`。実装設計 §5.6）。年末年始は祝日カレンダーに無いため。 */
export const DEFAULT_EXTRA_HOLIDAYS: readonly string[] = ["12-31", "01-02", "01-03"];

/** `YYYY-MM-DD` を暦日単位で `deltaDays` だけ移動する（純粋な暦計算。`core/businessDate.ts` と同種）。 */
function shiftDateStr(dateStr: string, deltaDays: number): string {
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

/** `Date.prototype.getUTCDay()` と同じ規約（0=日曜 … 6=土曜）。 */
function weekdayIndexOf(dateStr: string): number {
  const [yearStr, monthStr, dayStr] = dateStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** `YYYY-MM` の翌月（`YYYY-MM`）。 */
function nextMonthOf(monthStr: string): string {
  const [yearStr, monthNumStr] = monthStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthNumStr); // 1-12
  const d = new Date(Date.UTC(year, month, 1)); // 当月 1 日の翌月 = month（0-based で当月扱い）
  const y = String(d.getUTCFullYear()).padStart(4, "0");
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** `YYYY-MM` の月末日（`YYYY-MM-DD`）。 */
function lastDayOfMonth(monthStr: string): string {
  const [yearStr, monthNumStr] = monthStr.split("-");
  const year = Number(yearStr);
  const month = Number(monthNumStr);
  // 翌月の 0 日目 = 当月の最終日。
  return toDateStr(new Date(Date.UTC(year, month, 0)));
}

/**
 * 支払期日を計算する（実装設計 §5.4, §5.6）。対象月の翌月末を起点に、土日・祝日
 * （`isCalendarHoliday`）・`extraHolidays`（`MM-DD`、既定 {@link DEFAULT_EXTRA_HOLIDAYS}）に
 * 当たる間は前の営業日へ戻る。
 *
 * `isCalendarHoliday` は `CalendarPort.isHoliday` 相当の判定を呼び出し側（app 層）が注入する
 * （この関数自体は「同じ入力・同じ `isCalendarHoliday` に対して常に同じ結果を返す」という
 * 意味で純関数として扱う。他の core 関数と同じく GAS API には直接依存しない）。
 *
 * @param month 対象月（締める月）`YYYY-MM`。支払期日はその翌月末が起点になる。
 */
export function dueDateOf(
  month: string,
  isCalendarHoliday: (dateStr: string) => boolean,
  extraHolidays: readonly string[] = DEFAULT_EXTRA_HOLIDAYS,
): string {
  let date = lastDayOfMonth(nextMonthOf(month));
  while (isRestDay(date, isCalendarHoliday, extraHolidays)) {
    date = shiftDateStr(date, -1);
  }
  return date;
}

function isRestDay(
  dateStr: string,
  isCalendarHoliday: (dateStr: string) => boolean,
  extraHolidays: readonly string[],
): boolean {
  const weekday = weekdayIndexOf(dateStr);
  if (weekday === 0 || weekday === 6) {
    return true;
  }
  if (isCalendarHoliday(dateStr)) {
    return true;
  }
  const mmdd = dateStr.slice(5);
  return extraHolidays.includes(mmdd);
}

// ---------------------------------------------------------------------------
// 日別明細（`note`）の組み立て（実装設計 §5.4）
// ---------------------------------------------------------------------------

/** {@link renderDailyNote} が必要とする日次集計 1 行分（`DailySummaryRow` の構造的部分型）。 */
export interface DailyNoteRow {
  /** `YYYY-MM-DD`（JST）。 */
  business_date: string;
  /** `weekdayLabelOf` で計算済みの曜日ラベル（`月`〜`日`）。 */
  weekday: string;
  status: DailyStatus;
  worked_minutes: number | null;
}

/** `note` の上限文字数（実装設計 §5.4）。超えたら末尾を切り {@link NOTE_TRUNCATE_SUFFIX} を付ける。 */
const NOTE_MAX_LEN = 2000;
const NOTE_TRUNCATE_SUFFIX = "（以下省略。日別明細は別添）";

/** `YYYY-MM-DD` → `MM/DD`。 */
function mmddOf(dateStr: string): string {
  return dateStr.slice(5).replace("-", "/");
}

/** 分数を `H:MM`（時は 0 埋めなし、分は 2 桁）で表す（`core/card.ts` の `formatDurationColon` と同じ規約）。 */
function hmFromMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${String(m).padStart(2, "0")}`;
}

/**
 * 請求書 `note`（日別明細）を組み立てる（実装設計 §5.4）。`日次集計` の `OK` 行を日付昇順に
 * `MM/DD(曜) H:MM` で 1 行ずつ並べ、末尾に `合計 {hours} 時間（{minutes} 分）` を付ける。
 *
 * 🔄 判断が必要だった点（設計書に明記が無い）: 末尾の `{hours}`/`{minutes}` の定義。
 * `{minutes}` は `OK` 行の `worked_minutes` 合計（生の分）、`{hours}` はそれを
 * `aggregateMonth`（実装設計 §7.3）と同じ丸め方（1/100 時間単位）で時間に換算した値とした。
 *
 * 全体が {@link NOTE_MAX_LEN}（2000 字）を超える場合は、末尾（合計行を含む）を切り捨てて
 * {@link NOTE_TRUNCATE_SUFFIX} を付ける。付けた後の全体は常に 2000 字以内になる。
 */
export function renderDailyNote(daily: readonly DailyNoteRow[]): string {
  const okRows = daily
    .filter((d) => d.status === "OK")
    .slice()
    .sort((a, b) => (a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : 0));

  const lines = okRows.map(
    (d) => `${mmddOf(d.business_date)}(${d.weekday}) ${hmFromMinutes(d.worked_minutes ?? 0)}`,
  );
  const totalMinutes = okRows.reduce((sum, d) => sum + (d.worked_minutes ?? 0), 0);
  const hours = Math.round((totalMinutes * 100) / 60) / 100;
  const trailer = `合計 ${hours} 時間（${totalMinutes} 分）`;

  const full = [...lines, trailer].join("\n");
  if (full.length <= NOTE_MAX_LEN) {
    return full;
  }
  return full.slice(0, NOTE_MAX_LEN - NOTE_TRUNCATE_SUFFIX.length) + NOTE_TRUNCATE_SUFFIX;
}

// ---------------------------------------------------------------------------
// 請求書の組み立て（実装設計 §5.4）
// ---------------------------------------------------------------------------

/** 請求書番号の接頭辞（実装設計 §5.4）。単一取引先を前提にした冪等キー（§13 U4）。 */
const INVOICE_BILLING_NUMBER_PREFIX = "KD-";

/** `YYYY-MM` → `KD-YYYYMM`（実装設計 §5.4）。`ensureInvoiceCreated` の検索クエリにも使う。 */
export function invoiceBillingNumberOf(month: string): string {
  return `${INVOICE_BILLING_NUMBER_PREFIX}${month.replace("-", "")}`;
}

/** {@link buildInvoiceRequest} が必要とする月次請求行の項目（`MonthlyBillRow` の構造的部分型）。 */
export interface InvoiceBillInput {
  client: string;
  /** `YYYY-MM`。 */
  month: string;
  hours: number;
}

/** {@link buildInvoiceRequest} の呼び出し側（app 層）が計算済みで渡す設定値。 */
export interface BuildInvoiceRequestConfig {
  /** `MF_DEPARTMENT_ID`。 */
  department_id: string;
  /** `dueDateOf` で計算済みの支払期日（`YYYY-MM-DD`）。休日判定は `CalendarPort` に依存するため
   * app 層で計算してから渡す（この関数自体は GAS API に依存しない）。 */
  due_date: string;
}

export interface InvoiceRequestItem {
  name: string;
  detail: string;
  unit: string;
  quantity: number;
  price: number;
  excise: "ten_percent" | "untaxable";
  is_deduct_withholding_tax: boolean;
}

/** `POST /invoice_template_billings` の本文（実装設計 §5.4 の表）。 */
export interface InvoiceRequestBody {
  department_id: string;
  billing_number: string;
  billing_date: string;
  sales_date: string;
  due_date: string;
  title: string;
  items: InvoiceRequestItem[];
  note: string;
  memo: string;
}

function monthNumberOf(month: string): number {
  return Number(month.split("-")[1]);
}

function yearOf(month: string): string {
  return month.split("-")[0] ?? "";
}

/**
 * 請求書の POST 本文を組み立てる（実装設計 §5.4 の表そのまま）。
 *
 * `POST /invoice_template_billings`（`BillingNewTemplateCreateRequest`）の本文は
 * `department_id`/`billing_number`/`billing_date`/`sales_date`/`due_date`/`title`/`items`
 * （`name`/`detail`/`unit`/`price`/`quantity`/`excise`/`is_deduct_withholding_tax`）/`note`/`memo`
 * をトップレベルに並べる形（キーで包まない）。MF の OpenAPI 定義で確認済み。`note` の上限は
 * 2000 字（{@link renderDailyNote} の `NOTE_MAX_LEN` と一致）、`billing_number` の上限は 30 字。
 */
export function buildInvoiceRequest(
  bill: InvoiceBillInput,
  unit: UnitPriceRow,
  daily: readonly DailyNoteRow[],
  cfg: BuildInvoiceRequestConfig,
): InvoiceRequestBody {
  const billingDate = lastDayOfMonth(bill.month);
  const m = monthNumberOf(bill.month);
  const y = yearOf(bill.month);

  return {
    department_id: cfg.department_id,
    billing_number: invoiceBillingNumberOf(bill.month),
    billing_date: billingDate,
    sales_date: billingDate,
    due_date: cfg.due_date,
    title: `${m}月分 業務委託料`,
    items: [
      {
        name: `${y}年${m}月分 業務委託料`,
        detail: `稼働 ${bill.hours} 時間`,
        unit: "時間",
        quantity: bill.hours,
        price: unit.unit_price,
        excise: unit.tax_category === "課税" ? "ten_percent" : "untaxable",
        is_deduct_withholding_tax: unit.withholding === "10.21%",
      },
    ],
    note: renderDailyNote(daily),
    memo: `kadobo client=${bill.client} month=${bill.month}`,
  };
}

// ---------------------------------------------------------------------------
// 金額照合（実装設計 §5.5 手順3）
// ---------------------------------------------------------------------------

/** {@link compareAmounts} が必要とする月次請求行の項目（`MonthlyBillRow` の構造的部分型）。 */
export interface InvoiceCompareBillInput {
  amount: number;
  tax_amount: number;
  withholding_amount: number;
  net_amount: number;
}

/** `GET /billings/{id}` の応答のうち金額項目（すべて文字列。実装設計 §3.1）。 */
export interface MfBillingAmounts {
  subtotal_price?: string;
  excise_price?: string;
  total_price?: string;
  deduct_price?: string;
}

export interface CompareAmountsResult {
  match: boolean;
  /** 不一致時の差額要約（`invoice_error` にそのまま入れる）。一致時は空文字列。 */
  summary: string;
}

/** 整数化する。数値でない・空は `null`（不一致扱い。実装設計 §5.5）。 */
function parseAmountOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * 請求書の金額照合（実装設計 §5.5 手順3の 5 条件）。応答の金額は文字列なので整数化して比較する
 * （数値でない・空は不一致扱い）。`deduct_price` が無い・空は 0 として扱う。
 */
export function compareAmounts(bill: InvoiceCompareBillInput, billing: MfBillingAmounts): CompareAmountsResult {
  const subtotal = parseAmountOrNull(billing.subtotal_price);
  const excise = parseAmountOrNull(billing.excise_price);
  const total = parseAmountOrNull(billing.total_price);
  const deduct = parseAmountOrNull(billing.deduct_price) ?? 0;

  const checks: { label: string; ok: boolean; expected: number; actual: number | null }[] = [
    { label: "報酬額", ok: subtotal === bill.amount, expected: bill.amount, actual: subtotal },
    { label: "消費税相当額", ok: excise === bill.tax_amount, expected: bill.tax_amount, actual: excise },
    {
      label: "税込額",
      ok: total !== null && total === bill.amount + bill.tax_amount,
      expected: bill.amount + bill.tax_amount,
      actual: total,
    },
    {
      label: "源泉徴収額",
      ok: deduct === bill.withholding_amount,
      expected: bill.withholding_amount,
      actual: deduct,
    },
    {
      label: "差引入金予定額",
      ok: total !== null && total - deduct === bill.net_amount,
      expected: bill.net_amount,
      actual: total === null ? null : total - deduct,
    },
  ];

  const mismatches = checks.filter((c) => !c.ok);
  if (mismatches.length === 0) {
    return { match: true, summary: "" };
  }
  const summary = mismatches
    .map((c) => `${c.label}: MF${c.actual === null ? "(数値でない)" : c.actual} / シート${c.expected}`)
    .join("、");
  return { match: false, summary };
}

// ---------------------------------------------------------------------------
// ステータス正規化（実装設計 §3.1, §5.7）
// ---------------------------------------------------------------------------

/** `GET /billings/{id}` の応答のうちステータス項目。 */
export interface MfBillingStatusInput {
  email_status?: string;
  posting_status?: string;
  /** `"2"`（文字列コード）または数値、あるいは日本語ラベル `入金済み`。 */
  payment_status?: string | number;
}

const SENT_EMAIL_STATUSES = new Set(["sent", "already_read", "送付済み", "受領済み"]);
const SENT_POSTING_STATUSES = new Set(["sent", "郵送済み"]);
const PAID_PAYMENT_STATUSES = new Set(["2", "入金済み"]);

/**
 * `GET /billings/{id}` の応答を正規化する（実装設計 §3.1, §5.7）。ステータスの表記が
 * 日本語ラベル・コード値（`payment_status` は文字列 `"2"` のことがある）の間で揺れているため、
 * ここで両方に対応してから真偽値へ落とす。
 */
export function normalizeBillingStatus(billing: MfBillingStatusInput): NormalizedBillingStatus {
  const sent =
    (billing.email_status !== undefined && SENT_EMAIL_STATUSES.has(billing.email_status)) ||
    (billing.posting_status !== undefined && SENT_POSTING_STATUSES.has(billing.posting_status));
  const paymentKey = billing.payment_status === undefined ? undefined : String(billing.payment_status);
  const paid = paymentKey !== undefined && PAID_PAYMENT_STATUSES.has(paymentKey);
  return { sent, paid };
}
