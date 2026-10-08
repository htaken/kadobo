/**
 * 請求書の作成・照合・追跡（実装設計 MF連携 §5.5, §5.7, §7）。
 *
 * `ensureInvoiceCreated`: `state = LOCKED` かつ `invoice_state ∈ {PENDING, UNKNOWN}` の
 * すべての月を対象に、月ごとに `lease("mf_invoice/<client>:<month>", 10分)` を取ってから
 * 処理する（取れなければその月は何もしない＝別の実行が処理中）。MF の呼び出しはロックの外
 * （`withLease` の `fn` の中）で行う。シートへの書込みはすべて短いスクリプトロックの中で
 * 行を読み直し、読み直した行が `LOCKED` でなくなっていたら書かずに終える（実装設計 §0, §5.5）。
 *
 * `trackBillingStatus`: `state ∈ {MF_CREATED, SENT}` の月次行ごとに `GET /billings/{id}` を
 * 1 回呼び、送付・入金の遷移を反映する（実装設計 §5.7）。
 *
 * `warnMismatchDaily`: `invoice_state = MISMATCH` の月に毎日 1 回だけ警告する（実装設計 §5.5）。
 *
 * `weeklyInvoiceKeepalive`: 週次の疎通（実装設計 §4.2）。`GET /office` を通常の呼び出しとして
 * 1 回呼ぶ（401 なら `MfInvoiceClient` が通常どおりトークンを更新する）。
 *
 * 🔄 判断が必要だった点（設計書に明記が無い）: このファイルの各関数が MF 呼び出しで投げる例外
 * （`MfAuthError`/`MfReauthRequiredError`/`MfTransientError` のうち POST の結果分岐で個別に
 * 処理するもの以外）は、ここでは捕まえずそのまま呼び出し元（`trigMfSync`）へ
 * 伝播させる。`triggers.ts` 側が各ステップ（`ensureInvoiceCreated` 等）ごとに 1 つの
 * try/catch で囲み、`notifyMfFailure(ports, "invoice", err)` を呼ぶ設計にしたため
 * （実装設計 §7 の「各ステップは独立に try/catch」は月 1 件ずつではなく関数単位という理解）。
 * この結果、ある月の処理中に（例えば `/billings?document_number=` の検索で）一時的な通信障害が
 * 起きると、その回の `ensureInvoiceCreated` は他の対象月をまだ処理していなくても打ち切られるが、
 * 対象月は毎時のトリガーで再評価されるため実害は小さいと判断した。
 */
import { businessDateOf } from "@kadobo/shared/time";
import {
  selectUnitPrice,
  type DailyStatus,
  type UnitPriceRow,
} from "../core/aggregate";
import {
  buildInvoiceRequest,
  compareAmounts,
  dueDateOf,
  invoiceBillingNumberOf,
  normalizeBillingStatus,
  type InvoiceRequestBody,
  type MfBillingAmounts,
  type MfBillingStatusInput,
} from "../core/invoice";
import { nextStateOnBillingStatus, type MonthCloseState } from "../core/monthClose";
import { lastDayOfMonthStr } from "./dateUtil";
import { isInvoiceEnabled } from "./mf/flags";
import { makeMfInvoiceClient, type MfInvoiceClient } from "./mf/invoiceClient";
import { MfApiError, MfOutcomeUnknownError, MfTransientError } from "./mf/errors";
import { withLease } from "./mf/lease";
import { extraHolidaysOf } from "./monthClose";
import { ConfigMissingError, type AppPorts, type MonthlyBillRow } from "./ports";

const LEASE_TTL_MS = 10 * 60 * 1000;
const UNKNOWN_NOTICE_DELAY_MS = 24 * 60 * 60 * 1000;
const NOTICE_KIND = "mf_notice";

/**
 * MF の請求書詳細画面 URL（`https://invoice.moneyforward.com/billings/{id}` 形式）。
 * 🔄 確定仕様ではない（設計書 §5.5 の指示どおり、実際の URL 形式は未確認のため定数にしてある）。
 * 実物で見え方を確認し、違っていればここだけを直せばよい。
 */
const MF_BILLING_URL_PREFIX = "https://invoice.moneyforward.com/billings/";

// ---------------------------------------------------------------------------
// 共通ヘルパ
// ---------------------------------------------------------------------------

function postBestEffort(ports: AppPorts, text: string): void {
  const channelId = ports.props.get("SLACK_CHANNEL_ID");
  if (channelId === null) {
    return;
  }
  try {
    ports.slack.postMessage({ channel: channelId, text });
  } catch (e) {
    console.error("invoice postBestEffort failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function strField(r: Record<string, unknown>, key: string): string | undefined {
  const v = r[key];
  return typeof v === "string" ? v : undefined;
}

/** `id` フィールドを文字列として取り出す（数値で返る場合も文字列化する）。 */
function extractId(obj: unknown): string | null {
  const r = asRecord(obj);
  const direct = r.id;
  if (typeof direct === "string" && direct !== "") {
    return direct;
  }
  if (typeof direct === "number") {
    return String(direct);
  }
  const nested = asRecord(r.billing).id;
  if (typeof nested === "string" && nested !== "") {
    return nested;
  }
  if (typeof nested === "number") {
    return String(nested);
  }
  return null;
}

/**
 * `GET /billings?document_number=` の 1 ページ分の応答から配列を取り出す。応答は
 * `{ data: Billing[], pagination: {...} }`（MF の OpenAPI 定義で確認済み。`data` キー）。
 * トップレベル配列・`billings` キーも念のためフォールバックとして受け止める。
 */
function extractBillingsArray(res: unknown): Record<string, unknown>[] {
  const r = asRecord(res);
  if (Array.isArray(r.data)) {
    return r.data as Record<string, unknown>[];
  }
  if (Array.isArray(r.billings)) {
    return r.billings as Record<string, unknown>[];
  }
  if (Array.isArray(res)) {
    return res as Record<string, unknown>[];
  }
  return [];
}

/** `Billing` の請求書番号フィールドは `billing_number`（MF の OpenAPI 定義で確認済み）。 */
function documentNumberOf(row: Record<string, unknown>): string | null {
  const v = row.billing_number;
  return typeof v === "string" ? v : null;
}

/**
 * `GET /billings/{id}` の応答から金額・ステータス項目を含む本体を取り出す。応答は `Billing`
 * をそのまま返す（`{billing: {...}}` のようなラップは無い。MF の OpenAPI 定義で確認済み）。
 * 念のため `billing` キーでラップされていた場合のフォールバックも残す。
 */
function extractBillingDetail(res: unknown): Record<string, unknown> {
  const r = asRecord(res);
  const nested = r.billing;
  if (typeof nested === "object" && nested !== null) {
    return asRecord(nested);
  }
  return r;
}

function toBillingAmounts(detail: Record<string, unknown>): MfBillingAmounts {
  return {
    subtotal_price: strField(detail, "subtotal_price"),
    excise_price: strField(detail, "excise_price"),
    total_price: strField(detail, "total_price"),
    deduct_price: strField(detail, "deduct_price"),
  };
}

function toBillingStatusInput(detail: Record<string, unknown>): MfBillingStatusInput {
  const paymentStatus = detail.payment_status;
  return {
    email_status: strField(detail, "email_status"),
    posting_status: strField(detail, "posting_status"),
    payment_status:
      typeof paymentStatus === "string" || typeof paymentStatus === "number" ? paymentStatus : undefined,
  };
}

function mfBillingUrl(id: string): string {
  return `${MF_BILLING_URL_PREFIX}${id}`;
}

/**
 * 読み直した行がまだ `LOCKED` なら請求書関連の列だけを書く（実装設計 §0, §5.5）。書けたら
 * `true`、読み直した行が無い・`LOCKED` でなくなっていたら書かずに `false` を返す。
 */
function writeInvoiceColumnsIfLocked(
  ports: AppPorts,
  client: string,
  month: string,
  patch: Partial<MonthlyBillRow>,
): boolean {
  return ports.lock.withLock(() => {
    const current = ports.sheets.getMonthlyBill(client, month);
    if (current === null || current.state !== "LOCKED") {
      return false;
    }
    ports.sheets.updateMonthlyBillColumns(client, month, patch);
    return true;
  });
}

function requireDepartmentId(ports: AppPorts): string {
  const v = ports.props.get("MF_DEPARTMENT_ID");
  if (v === null || v === "") {
    throw new ConfigMissingError(
      "MF_DEPARTMENT_ID",
      "MF_DEPARTMENT_ID が未設定です（実装設計 MF連携 §5.4）。MF で取引先・部署を登録してから設定してください。",
    );
  }
  return v;
}

function notifyConfigMissingInvoice(ports: AppPorts, propertyKey: string): void {
  const operatorId = ports.props.get("SLACK_USER_ID");
  if (operatorId === null) {
    return;
  }
  try {
    ports.slack.dm(
      operatorId,
      `⚠️ 請求書機能の設定が未完了です（${propertyKey} が未設定）。` +
        "MF で取引先・部署を登録し、Script Property に設定してから再試行してください。",
    );
  } catch {
    // 通知自体の失敗はベストエフォート（`expense.ts` の `notifyConfigMissing` と同じ方針）。
  }
}

// ---------------------------------------------------------------------------
// ensureInvoiceCreated（実装設計 §5.5）
// ---------------------------------------------------------------------------

/**
 * `GET /billings?document_number=` を全ページ取得し、`billing_number` が完全一致するものだけを
 * 返す（実装設計 §5.5）。
 *
 * `GET /billings` の 200 応答は `{ data: Billing[], pagination: { total_count, total_pages,
 * per_page, current_page } }`（`per_page` は 1〜100、既定 100。MF の OpenAPI 定義で確認済み）。
 * `pagination` が取れた場合は `current_page < total_pages` の間だけ次ページへ進む。`pagination`
 * が無い・数値でない想定外の応答のときだけ、フォールバックとして「配列件数が `per_page` ちょうど
 * なら次ページがある」という推測で続ける。無限ループを避けるため `SEARCH_MAX_PAGES` で必ず止める。
 */
const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 20;

/** `GET /billings` 応答の `pagination`（`total_pages`/`current_page` が数値で取れた場合のみ返す）。 */
function extractPagination(res: unknown): { total_pages: number; current_page: number } | null {
  const p = asRecord(asRecord(res).pagination);
  const totalPages = p.total_pages;
  const currentPage = p.current_page;
  if (typeof totalPages === "number" && typeof currentPage === "number") {
    return { total_pages: totalPages, current_page: currentPage };
  }
  return null;
}

function searchBillingsByDocumentNumber(client: MfInvoiceClient, billingNumber: string): Record<string, unknown>[] {
  const matched: Record<string, unknown>[] = [];
  let page = 1;
  while (page <= SEARCH_MAX_PAGES) {
    const path =
      `/billings?document_number=${encodeURIComponent(billingNumber)}` +
      `&page=${page}&per_page=${SEARCH_PER_PAGE}`;
    const res = client.request("get", path);
    const rows = extractBillingsArray(res);
    for (const row of rows) {
      if (documentNumberOf(row) === billingNumber) {
        matched.push(row);
      }
    }

    const pagination = extractPagination(res);
    if (pagination !== null) {
      if (pagination.current_page >= pagination.total_pages) {
        break;
      }
    } else if (rows.length < SEARCH_PER_PAGE) {
      break;
    }
    page++;
  }
  return matched;
}

interface DailyNoteRowLike {
  business_date: string;
  weekday: string;
  status: DailyStatus;
  worked_minutes: number | null;
}

function buildRequestOrThrow(ports: AppPorts, bill: MonthlyBillRow): InvoiceRequestBody {
  const departmentId = requireDepartmentId(ports);
  const unitSelection = selectUnitPrice(ports.sheets.getUnitPriceRows(), `${bill.month}-01`);
  if ("error" in unitSelection) {
    // `hasMonthBlockers`（`app/monthClose.ts`）が単価マスタエラーを検出できていれば
    // 月は LOCKED に到達しない想定。到達した場合は想定外として呼び出し元へ伝播させる。
    throw new Error(`INVOICE_UNIT_PRICE_${unitSelection.error}:${bill.month}`);
  }
  const unit: UnitPriceRow = unitSelection;
  const dueDate = dueDateOf(bill.month, (d) => ports.calendar.isHoliday(d), extraHolidaysOf(ports));
  const daily: DailyNoteRowLike[] = ports.sheets.getDailySummariesInRange(
    `${bill.month}-01`,
    lastDayOfMonthStr(bill.month),
  );
  return buildInvoiceRequest(bill, unit, daily, { department_id: departmentId, due_date: dueDate });
}

/** 検索結果 2 件以上（重複）の処理（実装設計 §5.5）。 */
function handleDuplicate(ports: AppPorts, bill: MonthlyBillRow, billingNumber: string, count: number): void {
  writeInvoiceColumnsIfLocked(ports, bill.client, bill.month, {
    invoice_state: "ERROR",
    invoice_error: `MF に billing_number=${billingNumber} の請求書が ${count} 件あります（重複）。`,
  });
  postBestEffort(
    ports,
    `⚠️ MF に請求書番号 ${billingNumber}（${bill.client} ${bill.month}）の請求書が ${count} 件あります。` +
      "重複を確認し、不要な方を削除してください。",
  );
}

/** 24 時間たっても見つからない `UNKNOWN` の月に、1 回だけ Slack で依頼する（実装設計 §5.5）。 */
function maybeNotifyUnknownTimeout(ports: AppPorts, bill: MonthlyBillRow): void {
  if (bill.invoice_attempted_at === null) {
    return;
  }
  const elapsed = ports.clock.nowMs() - bill.invoice_attempted_at;
  if (elapsed < UNKNOWN_NOTICE_DELAY_MS) {
    return;
  }
  const key = `unknown/${bill.client}:${bill.month}`;
  const shouldNotify = ports.lock.withLock(() => {
    const already = ports.sheets.getInternalValue(NOTICE_KIND, key);
    if (already !== null) {
      return false;
    }
    ports.sheets.setInternalValue(NOTICE_KIND, key, String(ports.clock.nowMs()));
    return true;
  });
  if (shouldNotify) {
    postBestEffort(
      ports,
      `MF に請求書が無ければ、月次請求シートの invoice_state を PENDING に戻してください（作り直します）。` +
        `あれば mf_invoice_id に ID を書いてください（${bill.client} ${bill.month}）。`,
    );
  }
}

/** 金額照合（実装設計 §5.5 手順3）の結果を書き、Slack へ通知する。 */
function compareAndFinalize(
  ports: AppPorts,
  bill: MonthlyBillRow,
  invoiceId: string,
  detail: Record<string, unknown>,
): void {
  const cmp = compareAmounts(bill, toBillingAmounts(detail));
  if (cmp.match) {
    const wrote = writeInvoiceColumnsIfLocked(ports, bill.client, bill.month, {
      state: "MF_CREATED",
      invoice_state: "CREATED",
      invoice_error: null,
    });
    if (wrote) {
      postBestEffort(
        ports,
        `✅ 請求書を作成しました（未送付。${bill.client} ${bill.month}）。MF で確認して送付してください。\n${mfBillingUrl(invoiceId)}`,
      );
    }
    return;
  }
  const wrote = writeInvoiceColumnsIfLocked(ports, bill.client, bill.month, {
    state: "MF_CREATED",
    invoice_state: "MISMATCH",
    invoice_error: cmp.summary,
  });
  if (wrote) {
    postBestEffort(
      ports,
      `⚠️ 金額が一致しません。送付しないでください（${bill.client} ${bill.month}）。\n${cmp.summary}`,
    );
  }
}

/** 1 か月分の作成・照合処理（実装設計 §5.5 の擬似コード）。lease 取得後、ロックの外で呼ばれる。 */
function processOneInvoice(ports: AppPorts, invoiceClient: MfInvoiceClient, client: string, month: string): void {
  const current = ports.sheets.getMonthlyBill(client, month);
  if (current === null || current.state !== "LOCKED") {
    return;
  }

  if (current.mf_invoice_id !== null && current.mf_invoice_id !== "") {
    const detail = extractBillingDetail(invoiceClient.request("get", `/billings/${encodeURIComponent(current.mf_invoice_id)}`));
    compareAndFinalize(ports, current, current.mf_invoice_id, detail);
    return;
  }

  const billingNumber = invoiceBillingNumberOf(month);
  const found = searchBillingsByDocumentNumber(invoiceClient, billingNumber);

  if (found.length >= 2) {
    handleDuplicate(ports, current, billingNumber, found.length);
    return;
  }

  if (found.length === 1) {
    const id = extractId(found[0]);
    if (id === null) {
      // 想定外: 検索結果はあるが id が取れない。次回また検索させる（書込みなし）。
      return;
    }
    writeInvoiceColumnsIfLocked(ports, client, month, { mf_invoice_id: id });
    const detail = extractBillingDetail(invoiceClient.request("get", `/billings/${encodeURIComponent(id)}`));
    compareAndFinalize(ports, current, id, detail);
    return;
  }

  // found.length === 0
  if (current.invoice_state !== "PENDING") {
    // invoice_state === "UNKNOWN": 何もしない（次回また検索する）。24 時間経過なら 1 回だけ依頼。
    maybeNotifyUnknownTimeout(ports, current);
    return;
  }

  let body: InvoiceRequestBody;
  try {
    body = buildRequestOrThrow(ports, current);
  } catch (e) {
    if (e instanceof ConfigMissingError) {
      writeInvoiceColumnsIfLocked(ports, client, month, {
        invoice_state: "ERROR",
        invoice_error: `CONFIG_MISSING:${e.propertyKey}`,
      });
      notifyConfigMissingInvoice(ports, e.propertyKey);
      return;
    }
    throw e;
  }

  const attemptedAt = ports.clock.nowMs();
  const wroteAttempt = writeInvoiceColumnsIfLocked(ports, client, month, { invoice_attempted_at: attemptedAt });
  if (!wroteAttempt) {
    return;
  }

  try {
    const created = invoiceClient.request("post", "/invoice_template_billings", body, { create: true });
    const id = extractId(created);
    if (id === null) {
      // 201 なのに id が取れない（想定外の応答形）。UNKNOWN にして次回の検索で回収させる。
      writeInvoiceColumnsIfLocked(ports, client, month, { invoice_state: "UNKNOWN" });
      return;
    }
    writeInvoiceColumnsIfLocked(ports, client, month, { mf_invoice_id: id });
    const detail = extractBillingDetail(invoiceClient.request("get", `/billings/${encodeURIComponent(id)}`));
    compareAndFinalize(ports, current, id, detail);
  } catch (e) {
    if (e instanceof MfOutcomeUnknownError) {
      writeInvoiceColumnsIfLocked(ports, client, month, { invoice_state: "UNKNOWN" });
      postBestEffort(
        ports,
        `MF で作成されたか確認できません。自動では作り直しません（${client} ${month}）。`,
      );
      return;
    }
    if (e instanceof MfApiError) {
      writeInvoiceColumnsIfLocked(ports, client, month, {
        invoice_state: "ERROR",
        invoice_error: e.message,
      });
      return;
    }
    if (e instanceof MfTransientError) {
      // PENDING のまま（次回のトリガーで再試行）。
      return;
    }
    throw e;
  }
}

/**
 * 請求書の作成・照合（実装設計 §5.5）。`isInvoiceEnabled` が無効なら何もしない
 * （`invoice_state = MANUAL` の月はそもそも対象条件 `{PENDING, UNKNOWN}` に含まれないため、
 * フラグを後から有効にしても作られない。実装設計 §5.1 B7）。
 */
export function ensureInvoiceCreated(ports: AppPorts): void {
  if (!isInvoiceEnabled(ports.props)) {
    return;
  }
  const invoiceClient = makeMfInvoiceClient(ports);
  const targets = ports.sheets
    .listMonthlyBills()
    .filter((b) => b.state === "LOCKED" && (b.invoice_state === "PENDING" || b.invoice_state === "UNKNOWN"));

  for (const target of targets) {
    withLease(ports, `mf_invoice/${target.client}:${target.month}`, LEASE_TTL_MS, () => {
      processOneInvoice(ports, invoiceClient, target.client, target.month);
    });
  }
}

// ---------------------------------------------------------------------------
// trackBillingStatus（実装設計 §5.7）
// ---------------------------------------------------------------------------

function trackingMessage(state: MonthCloseState, client: string, month: string): string | null {
  if (state === "SENT") {
    return `📤 請求書を送付しました（${client} ${month}）。MF で確認済みです。`;
  }
  if (state === "PAID") {
    return `💰 入金を確認しました（${client} ${month}）。`;
  }
  return null;
}

/**
 * 送付・入金の追跡（実装設計 §5.7）。`state ∈ {MF_CREATED, SENT}` の月次行ごとに
 * `GET /billings/{id}` を 1 回呼び、`normalizeBillingStatus` → `nextStateOnBillingStatus` で
 * 遷移したら `state` 列だけを書き、Slack に 1 行通知する。
 */
export function trackBillingStatus(ports: AppPorts): void {
  if (!isInvoiceEnabled(ports.props)) {
    return;
  }
  const invoiceClient = makeMfInvoiceClient(ports);
  const targets = ports.sheets
    .listMonthlyBills()
    .filter(
      (b) => (b.state === "MF_CREATED" || b.state === "SENT") && b.mf_invoice_id !== null && b.mf_invoice_id !== "",
    );

  for (const target of targets) {
    const detail = extractBillingDetail(
      invoiceClient.request("get", `/billings/${encodeURIComponent(target.mf_invoice_id as string)}`),
    );
    const normalized = normalizeBillingStatus(toBillingStatusInput(detail));

    const wroteState = ports.lock.withLock(() => {
      const current = ports.sheets.getMonthlyBill(target.client, target.month);
      if (current === null) {
        return null;
      }
      const nextState = nextStateOnBillingStatus(current.state as MonthCloseState, normalized);
      if (nextState === current.state) {
        return null;
      }
      ports.sheets.updateMonthlyBillColumns(target.client, target.month, { state: nextState });
      return nextState;
    });

    if (wroteState !== null) {
      const text = trackingMessage(wroteState, target.client, target.month);
      if (text !== null) {
        postBestEffort(ports, text);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// warnMismatchDaily（実装設計 §5.5）
// ---------------------------------------------------------------------------

/**
 * `invoice_state = MISMATCH` の月に毎日 1 回だけ警告する（実装設計 §5.5）。抑止は内部シート
 * `mf_notice/mismatch/<client>:<month>` に業務日（`YYYY-MM-DD`）を記録して行う。
 */
export function warnMismatchDaily(ports: AppPorts): void {
  if (!isInvoiceEnabled(ports.props)) {
    return;
  }
  const today = businessDateOf(ports.clock.nowMs());
  const targets = ports.sheets.listMonthlyBills().filter((b) => b.invoice_state === "MISMATCH");

  for (const target of targets) {
    const key = `mismatch/${target.client}:${target.month}`;
    const shouldNotify = ports.lock.withLock(() => {
      const last = ports.sheets.getInternalValue(NOTICE_KIND, key);
      if (last === today) {
        return false;
      }
      ports.sheets.setInternalValue(NOTICE_KIND, key, today);
      return true;
    });
    if (shouldNotify) {
      postBestEffort(
        ports,
        `⚠️ 金額が一致しません。送付しないでください（${target.client} ${target.month}）。\n${target.invoice_error ?? ""}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// weeklyInvoiceKeepalive（実装設計 §4.2）
// ---------------------------------------------------------------------------

/**
 * 週次の疎通（実装設計 §4.2）。`GET /office` を通常の呼び出しとして 1 回呼ぶ。アクセストークンは
 * 1 時間で切れるため、1 週間ぶりの呼び出しは 401 → `MfInvoiceClient` が通常どおり更新する
 * （リフレッシュトークンが毎週入れ替わり、失効に数週間前に気づけるようにする）。
 */
export function weeklyInvoiceKeepalive(ports: AppPorts): void {
  if (!isInvoiceEnabled(ports.props)) {
    return;
  }
  const invoiceClient = makeMfInvoiceClient(ports);
  invoiceClient.request("get", "/office");
}
