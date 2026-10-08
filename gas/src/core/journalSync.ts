/**
 * 経費の仕訳連携（実装設計 MF連携 §6.1〜§6.4, §6.7）の純関数。GAS グローバル・HTTP・シートには依存しない。
 *
 * - §6.3 の同期状態の型と、kadobo が行う遷移の表（{@link canTransition}）
 * - §6.2 の対象判定（{@link decideSyncTarget}）
 * - §6.4 の科目対応表と `POST /journals` 本文の組み立て（**`tax_id`・`invoice_kind` は送らない**）
 * - §2.2 の `remark`・`memo`・`tags`
 * - §6.1 の `MF連携入力`（`mf_sync_input`）の要約と変更検出
 * - `GET /journals` の応答の読み取り（タグ検索・重複検出）
 * - WP-M5 の ③ 連携明細: 照合（{@link matchTransactions}）、明細ルールの判定（{@link classifyTransaction}）、
 *   `journalize` と `PUT /journals/{id}` の本文、訂正・取消の引継ぎ計画（{@link planLinkedCancellation}）、
 *   `GET /transactions` の期間分割（{@link splitDateRangeBySpan}）
 *
 * 引数の行は {@link SyncRowView}（`ExpenseLedgerRow` が構造的に満たす最小の形）にしてあり、
 * `app/ports.ts` には依存しない（`ports.ts` がこのファイルの {@link JournalSyncState} を参照する）。
 */
import type { ExpenseCategory, ExpenseState, PaymentMethod } from "@kadobo/shared/expense";
import { isPaymentMethod } from "@kadobo/shared/expense";

// ---------------------------------------------------------------------------
// §6.3 同期状態
// ---------------------------------------------------------------------------

/** `MF連携状態`（27 列目）の値。空文字 = 未着手（実装設計 §6.3）。 */
export const JOURNAL_SYNC_STATES = [
  "NOT_TARGET",
  "PENDING",
  "CREATING",
  "WAITING_TRANSACTION",
  "JOURNALIZING",
  "UNKNOWN",
  "NEEDS_REVIEW",
  "SYNCED",
  "REVERSING",
  "REVERSED",
  "ERROR",
] as const;

export type JournalSyncState = "" | (typeof JOURNAL_SYNC_STATES)[number];

export function isJournalSyncState(v: unknown): v is JournalSyncState {
  return v === "" || (typeof v === "string" && (JOURNAL_SYNC_STATES as readonly string[]).includes(v));
}

/**
 * 仕訳がまだ無い状態（実装設計 §6.3 手順 2・3、§6.7）。取消なら `REVERSED` にするだけ。
 * `MF仕訳ID` が入っていれば手入力の取り込み（B7）の対象になる。
 */
export const NO_JOURNAL_STATES: readonly JournalSyncState[] = ["", "PENDING", "WAITING_TRANSACTION", "NEEDS_REVIEW"];

/**
 * 手入力の `MF仕訳ID` を取り込んで `SYNCED` にしてよい状態（実装設計 §6.3 手順 3 の 4 状態に、`UNKNOWN` を足す）。
 * `UNKNOWN` の依頼文（§6.4）が「あれば `MF仕訳ID` に ID を書いてください」と案内するため、
 * その記入を取り込めるようにする。
 */
export const IMPORTABLE_STATES: readonly JournalSyncState[] = [...NO_JOURNAL_STATES, "UNKNOWN"];

/**
 * kadobo が行う遷移の表（実装設計 §6.3, §6.4, §6.7）。人がシートで状態を書き換える操作（空に戻す等）は
 * ここを通らない。`from → to` が表に無ければ {@link canTransition} は `false`。同じ状態への書き込み
 * （列だけ更新する）は常に許す。`JOURNALIZING` 関連（③。WP-M5）もこの表で定義する。
 */
const TRANSITIONS: Record<JournalSyncState, readonly JournalSyncState[]> = {
  // `REVERSING` は取消された行に人が `MF仕訳ID` を記入していた場合（仕訳がある。§6.7）。
  "": ["NOT_TARGET", "PENDING", "WAITING_TRANSACTION", "NEEDS_REVIEW", "SYNCED", "REVERSING", "REVERSED"],
  NOT_TARGET: [],
  PENDING: ["CREATING", "SYNCED", "WAITING_TRANSACTION", "NEEDS_REVIEW", "REVERSING", "REVERSED"],
  CREATING: ["SYNCED", "UNKNOWN", "ERROR", "PENDING"],
  WAITING_TRANSACTION: ["JOURNALIZING", "SYNCED", "NEEDS_REVIEW", "REVERSING", "REVERSED"],
  JOURNALIZING: ["SYNCED", "NEEDS_REVIEW", "ERROR"],
  UNKNOWN: ["SYNCED"],
  NEEDS_REVIEW: ["SYNCED", "JOURNALIZING", "REVERSING", "REVERSED"],
  SYNCED: ["NEEDS_REVIEW", "REVERSING"],
  // 削除が業務エラー（404 以外の 4xx）になったら `ERROR`（人が MF で削除する）。
  REVERSING: ["REVERSED", "ERROR"],
  REVERSED: [],
  ERROR: [],
};

export function canTransition(from: JournalSyncState, to: JournalSyncState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

/** 経費台帳の `処理状態` が取消（訂正・取消）を表すか（実装設計 §6.7）。 */
export function isCancelledExpenseState(state: ExpenseState): boolean {
  return state === "CORRECTED" || state === "VOID";
}

// ---------------------------------------------------------------------------
// 行の最小ビュー
// ---------------------------------------------------------------------------

/** この純関数群が読む台帳行の項目。`ExpenseLedgerRow` が構造的に満たす。 */
export interface SyncRowView {
  receipt_id: string;
  date: string;
  amount: number;
  partner: string;
  category: ExpenseCategory;
  drive_link: string;
  state: ExpenseState;
  business_use_ratio: number;
  payment_method: PaymentMethod | "";
  mf_journal_id: string | null;
  mf_transaction_id: string | null;
  mf_sync_input: string;
}

// ---------------------------------------------------------------------------
// §6.2 対象判定
// ---------------------------------------------------------------------------

export type SyncWaitReason = "no_start_date" | "registering" | "not_completed" | "no_payment_method";

export type SyncDecision =
  | { kind: "not_target" }
  | { kind: "wait"; reason: SyncWaitReason }
  | { kind: "needs_review"; reason: string }
  | { kind: "ready"; method: PaymentMethod };

/**
 * 実装設計 §6.2 の判定（毎回の実行でやり直す。結果を「対象外」として保存しない）。
 *
 * - `startDate`（`MF_SYNC_START_DATE`）が未設定（`null`）→ 同期しない（`wait`）
 * - `日付 < startDate` → `not_target`。**永久に対象外にするのはこの行だけ**（開業前の支出は人が分類する）
 * - `処理状態` が `RECEIVED`・`FILE_SAVED`（登録中）→ 待つ。`COMPLETED` 以外（`ERROR` 等）も待つ
 * - `支払方法` が空・不正 → 待つ（後から人が記入すれば次の実行で対象になる）
 * - `事業使用割合 !== 100` → `needs_review`（家事按分は MF の機能で行う。§2.4）
 * - すべて満たす → `ready`
 */
export function decideSyncTarget(row: SyncRowView, startDate: string | null): SyncDecision {
  if (startDate === null || startDate === "") {
    return { kind: "wait", reason: "no_start_date" };
  }
  if (row.date < startDate) {
    return { kind: "not_target" };
  }
  if (row.state === "RECEIVED" || row.state === "FILE_SAVED") {
    return { kind: "wait", reason: "registering" };
  }
  if (row.state !== "COMPLETED") {
    return { kind: "wait", reason: "not_completed" };
  }
  if (!isPaymentMethod(row.payment_method)) {
    return { kind: "wait", reason: "no_payment_method" };
  }
  if (row.business_use_ratio !== 100) {
    return {
      kind: "needs_review",
      reason: `事業使用割合が ${row.business_use_ratio} のため自動では仕訳しません`,
    };
  }
  return { kind: "ready", method: row.payment_method };
}

/** `decideSyncTarget` の結果から、空の行が進む次の状態（書き込まない場合は `null`）。実装設計 §6.3 の「（空）」の行。 */
export function initialStateFor(decision: SyncDecision): JournalSyncState | null {
  switch (decision.kind) {
    case "not_target":
      return "NOT_TARGET";
    case "needs_review":
      return "NEEDS_REVIEW";
    case "ready":
      return decision.method === "cash" ? "PENDING" : "WAITING_TRANSACTION";
    case "wait":
      return null;
  }
}

// ---------------------------------------------------------------------------
// §6.4 科目の対応
// ---------------------------------------------------------------------------

/** 貸方（現金・立替）の科目名。 */
export const CASH_CREDITOR_ACCOUNT_NAME = "事業主借";

/** カテゴリ → 借方科目名。`その他` だけ `雑費` に寄せる（実装設計 §6.4）。 */
export const CATEGORY_ACCOUNT_NAMES: Record<ExpenseCategory, string> = {
  通信費: "通信費",
  消耗品費: "消耗品費",
  旅費交通費: "旅費交通費",
  新聞図書費: "新聞図書費",
  会議費: "会議費",
  支払手数料: "支払手数料",
  その他: "雑費",
};

/**
 * 仕訳連携で名前引きする科目名の一覧（S-M3 で名前完全一致を確かめた 8 件。実装設計 §11.1）。
 * `app/mf/pingFormat.ts` の `S_M3_ACCOUNT_NAMES` はこれの別名。
 */
export const JOURNAL_ACCOUNT_NAMES: readonly string[] = [
  "通信費",
  "消耗品費",
  "旅費交通費",
  "新聞図書費",
  "会議費",
  "支払手数料",
  "雑費",
  CASH_CREDITOR_ACCOUNT_NAME,
];

/** カテゴリから借方科目名を返す。 */
export function debitAccountNameOf(category: ExpenseCategory): string {
  return CATEGORY_ACCOUNT_NAMES[category];
}

// ---------------------------------------------------------------------------
// §2.2 remark・memo・tags
// ---------------------------------------------------------------------------

/** MF の `remark`（摘要）・`memo` の最大文字数（実装設計 §2.2。コードポイント単位で数える）。 */
export const MF_TEXT_MAX_LENGTH = 200;

function truncateCodePoints(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

/**
 * 台帳の `取引先` は Sheets 数式インジェクション対策で先頭に `'` が付き得る（`escapeSheetFormula`）。
 * MF に送る文字列からはその 1 文字を外す。
 */
export function unescapeSheetFormula(s: string): string {
  if (s.length >= 2 && s.charAt(0) === "'" && "=+-@".includes(s.charAt(1))) {
    return s.slice(1);
  }
  return s;
}

/** `remark`: `{証憑ID} {取引先}`。200 字で切る（実装設計 §2.2, §6.4）。 */
export function buildRemark(receiptId: string, partner: string): string {
  return truncateCodePoints(`${receiptId} ${unescapeSheetFormula(partner)}`, MF_TEXT_MAX_LENGTH);
}

/** `memo`: `Driveリンク`。空、または 200 字を超えるなら `undefined`（省略する。実装設計 §6.4）。 */
export function buildMemo(driveLink: string): string | undefined {
  if (driveLink === "" || Array.from(driveLink).length > MF_TEXT_MAX_LENGTH) {
    return undefined;
  }
  return driveLink;
}

/** `tags`: `[証憑ID]`（二重登録防止の検索キー。実装設計 §2.2）。 */
export function buildTags(receiptId: string): string[] {
  return [receiptId];
}

// ---------------------------------------------------------------------------
// §6.1 mf_sync_input（作成時の入力の要約）
// ---------------------------------------------------------------------------

/**
 * `金額|日付|カテゴリ|支払方法|明細ID`（実装設計 §6.1 の列 31）。仕訳を作った後に人が業務列を直した
 * ことを検出する（{@link hasInputChanged}）。
 */
export function summarizeSyncInput(row: SyncRowView): string {
  return [row.amount, row.date, row.category, row.payment_method, row.mf_transaction_id ?? ""].join("|");
}

/**
 * `mf_sync_input` の 5 番目の項目（kadobo が仕訳を作るときに押さえた明細 ID）。要約が空・明細 ID が無ければ `null`。
 * 人が記入した `MF明細ID`（要約の明細 ID と違う、または要約が空）と、kadobo が押さえた明細 ID を見分けるのに使う。
 */
export function inputTransactionId(input: string): string | null {
  const t = input.split("|")[4];
  return t !== undefined && t !== "" ? t : null;
}

/**
 * `mf_sync_input` に保存した**作成時の日付**（2 番目の項目）。仕訳を作った時点の `日付` で、作成後に台帳の
 * `日付` を直されても変わらない回収キー（`GET /journals?start_date&end_date` の検索日）として使う。
 * 要約が空・形式が違えば `null`。
 */
export function creationDateFromInput(input: string): string | null {
  const d = input.split("|")[1];
  return d !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

/**
 * 保存済みの要約（`mf_sync_input`）と今の業務列から作った要約が違うか。保存済みが空（要約を持たない
 * 行。手で状態を書いた場合など）は比較できないので `false`。
 */
export function hasInputChanged(row: SyncRowView): boolean {
  return row.mf_sync_input !== "" && row.mf_sync_input !== summarizeSyncInput(row);
}

// ---------------------------------------------------------------------------
// §6.4 POST /journals 本文
// ---------------------------------------------------------------------------

export interface JournalRequestBody {
  journal: {
    transaction_date: string;
    journal_type: "journal_entry";
    branches: {
      debitor: { account_id: string; value: number };
      creditor: { account_id: string; value: number };
      remark: string;
    }[];
    memo?: string;
    tags: string[];
  };
}

/**
 * ② 現金・立替の `POST /journals` 本文（実装設計 §6.4）。`経費 ／ 事業主借`。**`tax_id`・`invoice_kind` は
 * 送らない**（免税事業者は税区分を登録できない。§3.2）。`account_id` は MF が返したパーセントエンコード
 * 済みの文字列をそのまま入れる（エンコードしない。§3.2 🔬）。
 */
export function buildJournalRequestBody(
  row: SyncRowView,
  accountIds: { debit: string; credit: string },
): JournalRequestBody {
  const memo = buildMemo(row.drive_link);
  const journal: JournalRequestBody["journal"] = {
    transaction_date: row.date,
    journal_type: "journal_entry",
    branches: [
      {
        debitor: { account_id: accountIds.debit, value: row.amount },
        creditor: { account_id: accountIds.credit, value: row.amount },
        remark: buildRemark(row.receipt_id, row.partner),
      },
    ],
    tags: buildTags(row.receipt_id),
  };
  if (memo !== undefined) {
    journal.memo = memo;
  }
  return { journal };
}

// ---------------------------------------------------------------------------
// GET /journals の応答の読み取り
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** `GET /journals` の応答（`{ journals: [...], metadata }`）から仕訳の配列を取り出す。 */
export function extractJournalList(res: unknown): Record<string, unknown>[] {
  const r = asRecord(res);
  if (Array.isArray(r.journals)) {
    return r.journals as Record<string, unknown>[];
  }
  return Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
}

/** `GET /journals/{id}`・`POST /journals` の応答（`{ journal: {...} }`）から仕訳を取り出す。無ければ `null`。 */
export function extractJournalItem(res: unknown): Record<string, unknown> | null {
  const j = asRecord(res).journal;
  return typeof j === "object" && j !== null ? (j as Record<string, unknown>) : null;
}

/** 仕訳の `id`（パーセントエンコード済みの文字列。そのまま返す）。取れなければ `null`。 */
export function journalIdOf(journal: Record<string, unknown>): string | null {
  const id = journal.id;
  if (typeof id === "string" && id !== "") {
    return id;
  }
  return typeof id === "number" ? String(id) : null;
}

/** `metadata.total_pages`（数値で取れたときだけ）。 */
export function totalPagesOf(res: unknown): number | null {
  const n = asRecord(asRecord(res).metadata).total_pages;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** 仕訳の `tags` に `tag` が（完全一致で）含まれるか。 */
export function journalHasTag(journal: Record<string, unknown>, tag: string): boolean {
  return Array.isArray(journal.tags) && journal.tags.some((t) => t === tag);
}

/**
 * 同じ証憑 ID のタグを持つ仕訳が 2 件以上ある証憑 ID を返す（実装設計 §6.4・§6.6 の二重作成の事後検知）。
 * `receiptIds` に含まれるタグだけを数える（`kadobo-rule` 等の他のタグは対象外）。仕訳 ID で重複を除く。
 */
export function findDuplicateReceiptTags(
  journals: readonly Record<string, unknown>[],
  receiptIds: ReadonlySet<string>,
): { receiptId: string; journalIds: string[] }[] {
  const byReceipt = new Map<string, Set<string>>();
  journals.forEach((j, i) => {
    const id = journalIdOf(j) ?? `(id なし ${i})`;
    if (!Array.isArray(j.tags)) {
      return;
    }
    for (const t of j.tags) {
      if (typeof t === "string" && receiptIds.has(t)) {
        const set = byReceipt.get(t) ?? new Set<string>();
        set.add(id);
        byReceipt.set(t, set);
      }
    }
  });
  const out: { receiptId: string; journalIds: string[] }[] = [];
  for (const [receiptId, ids] of byReceipt) {
    if (ids.size >= 2) {
      out.push({ receiptId, journalIds: [...ids] });
    }
  }
  return out.sort((a, b) => (a.receiptId < b.receiptId ? -1 : a.receiptId > b.receiptId ? 1 : 0));
}

/**
 * `start`〜`end`（両端含む、`YYYY-MM-DD`）を暦年の境目で分割する（各区間は 366 日以内。実装設計 §6.6）。
 * `GET /journals` は指定日を含む会計期間の仕訳だけを返すため（OpenAPI の説明）、個人事業の会計期間
 * （暦年）をまたがない区間にする。`start > end` なら空。
 */
export function splitRangeByCalendarYear(start: string, end: string): { start: string; end: string }[] {
  if (start > end) {
    return [];
  }
  const startYear = Number(start.slice(0, 4));
  const endYear = Number(end.slice(0, 4));
  const out: { start: string; end: string }[] = [];
  for (let y = startYear; y <= endYear; y++) {
    const yearStart = `${String(y).padStart(4, "0")}-01-01`;
    const yearEnd = `${String(y).padStart(4, "0")}-12-31`;
    out.push({ start: start > yearStart ? start : yearStart, end: end < yearEnd ? end : yearEnd });
  }
  return out;
}

// ---------------------------------------------------------------------------
// §6.5 ③ 連携明細との照合（純関数）
// ---------------------------------------------------------------------------

/** 連携サービスの種別。`linked_card` → `card`（`MF_CARD_ACCOUNT_IDS`）、`linked_bank` → `bank`（`MF_BANK_ACCOUNT_IDS`）。 */
export type ServiceKind = "card" | "bank";

/** 支払方法に対応する連携サービスの種別（実装設計 §6.5）。`cash`・空・不正は `null`。 */
export function serviceKindOf(method: PaymentMethod | ""): ServiceKind | null {
  if (method === "linked_card") {
    return "card";
  }
  if (method === "linked_bank") {
    return "bank";
  }
  return null;
}

/** 照合の日付幅: 経費の `日付` の前 2 日〜後 5 日（S-M4 でカード明細の `date` が利用日と確認。実装設計 §6.5）。 */
export const MATCH_DAYS_BEFORE = 2;
export const MATCH_DAYS_AFTER = 5;
/** 候補 0 件のまま日付からこの日数たった行は 1 回だけ通知する（実装設計 §6.5）。 */
export const NO_CANDIDATE_NOTICE_DAYS = 14;
/** `GET /transactions` の `start_date`〜`end_date` の差の上限（日。実装設計 §3.2）。 */
export const TRANSACTION_QUERY_MAX_SPAN_DAYS = 366;
/** 明細ルールで仕訳した仕訳の `tags`（実装設計 §6.6）。 */
export const RULE_TAG = "kadobo-rule";
/** 取消で付け替えた仕訳の `tags`（実装設計 §6.7）。 */
export const VOID_TAG = "kadobo-void";
/** 私用の相手科目・取消の付け替え先（実装設計 §2.3, §6.6, §6.7）。 */
export const PRIVATE_ACCOUNT_NAME = "事業主貸";

/** `YYYY-MM-DD` を暦日単位で移動する（UTC の暦計算。`app/dateUtil.ts` と同じ計算の core 版）。 */
export function shiftDate(date: string, deltaDays: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + deltaDays));
  return `${String(t.getUTCFullYear()).padStart(4, "0")}-${String(t.getUTCMonth() + 1).padStart(2, "0")}-${String(t.getUTCDate()).padStart(2, "0")}`;
}

/**
 * `start`〜`end`（両端含む）を、各区間の `end − start` が `maxSpanDays` 以内になるよう分割する
 * （`GET /transactions` は差が 366 日以内。実装設計 §3.2, §6.5）。`start > end` なら空。
 */
export function splitDateRangeBySpan(
  start: string,
  end: string,
  maxSpanDays: number = TRANSACTION_QUERY_MAX_SPAN_DAYS,
): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let cur = start;
  while (cur <= end) {
    const limit = shiftDate(cur, maxSpanDays);
    const e = limit < end ? limit : end;
    out.push({ start: cur, end: e });
    cur = shiftDate(e, 1);
  }
  return out;
}

/** 連携明細 1 件（`GET /transactions` の応答から取り出した必要な項目）。 */
export interface MfTransaction {
  /** 明細 ID。MF が返したパーセントエンコード済みの文字列（そのまま持つ）。 */
  id: string;
  date: string;
  value: number;
  /** `INCOME` / `EXPENSE`。 */
  side: string;
  content: string;
  /** `none`・`registered`・`excluded` など。 */
  status: string;
  connected_account_id: string;
  /** どの設定（`MF_CARD_ACCOUNT_IDS`／`MF_BANK_ACCOUNT_IDS`）の連携サービスから取ったか。 */
  service: ServiceKind;
}

function asRec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 明細 ID の突き合わせ用キー（人が貼ったエンコード有無の違いを吸収する）。 */
export function transactionKey(id: string): string {
  return safeDecode(id.trim());
}

/** `GET /transactions` の応答（`{ transactions: [...] }`）から明細を取り出す。`id`・`date`・`value` が読めない要素は除く。 */
export function parseTransactions(res: unknown, service: ServiceKind): MfTransaction[] {
  const raw = asRec(res).transactions;
  const out: MfTransaction[] = [];
  for (const o of Array.isArray(raw) ? (raw as unknown[]) : []) {
    const r = asRec(o);
    const id = typeof r.id === "string" ? r.id : "";
    const date = typeof r.date === "string" ? r.date : "";
    const value = typeof r.value === "number" ? r.value : typeof r.value === "string" ? Number(r.value) : NaN;
    if (id === "" || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value)) {
      continue;
    }
    out.push({
      id,
      date,
      value,
      side: typeof r.side === "string" ? r.side : "",
      content: typeof r.content === "string" ? r.content : "",
      status: typeof r.journalizing_status === "string" ? r.journalizing_status : "",
      connected_account_id: typeof r.connected_account_id === "string" ? r.connected_account_id : "",
      service,
    });
  }
  return out;
}

// ---- 明細ルール（§6.6） ----------------------------------------------------

export const RULE_TARGETS = ["card", "bank", "any"] as const;
export const RULE_ACTION_PRIVATE = "私用として仕訳";
export const RULE_ACTION_IGNORE = "無視";

/**
 * `MF明細ルール` シートの 1 行（実装設計 §6.6）。シートの値をほぼそのまま持ち、検証は {@link ruleDefects} で行う
 * （無効な行も一覧に残し、週次で報告するため）。
 */
export interface MfTransactionRule {
  /** ルール名（通知・摘要に使う）。 */
  name: string;
  /** `card` / `bank` / `any`（検証前の生の値）。 */
  target: string;
  /** 内容に含む文字列（明細の `content` の部分一致。必須）。 */
  content: string;
  /** 金額。空なら `null`（金額を問わない）。数値に読めない値は `NaN`。 */
  amount: number | null;
  /** `私用として仕訳` / `無視`（検証前の生の値）。 */
  action: string;
  /** 「私用として仕訳」のときの相手科目名。 */
  account: string;
  /** `有効` 列が TRUE か。 */
  enabled: boolean;
  /** シート上の実際の行番号（1 始まり。ヘッダーが 1 行目）。週次報告の「n 行目」に使う。無ければ省略。 */
  row?: number;
}

/** ルールの構造上の不備（空なら使える形）。`有効` は見ない。 */
export function ruleDefects(rule: MfTransactionRule): string[] {
  const out: string[] = [];
  if (rule.name.trim() === "") {
    out.push("ルール名が空です");
  }
  if (rule.content.trim() === "") {
    out.push("内容に含む文字列が空です");
  }
  if (!(RULE_TARGETS as readonly string[]).includes(rule.target)) {
    out.push(`対象が card・bank・any のどれでもありません（${rule.target === "" ? "空" : rule.target}）`);
  }
  if (rule.action !== RULE_ACTION_PRIVATE && rule.action !== RULE_ACTION_IGNORE) {
    out.push(`処理が「${RULE_ACTION_PRIVATE}」「${RULE_ACTION_IGNORE}」のどちらでもありません（${rule.action === "" ? "空" : rule.action}）`);
  }
  if (rule.amount !== null && !Number.isFinite(rule.amount)) {
    out.push("金額が数値ではありません");
  }
  if (rule.action === RULE_ACTION_PRIVATE && rule.account.trim() === "") {
    out.push("勘定科目が空です");
  }
  return out;
}

/** 週次報告に出す「無効」の理由（不備と、`有効` が TRUE でないこと）。空なら有効なルール。 */
export function ruleProblems(rule: MfTransactionRule): string[] {
  const out = ruleDefects(rule);
  if (!rule.enabled) {
    out.push("有効が TRUE ではありません（使っていません）");
  }
  return out;
}

/** 照合で使えるルールか（`有効` が TRUE で、不備が無い）。 */
export function isRuleUsable(rule: MfTransactionRule): boolean {
  return rule.enabled && ruleDefects(rule).length === 0;
}

/** 部分一致の比較用に正規化する（全角半角・大文字小文字の違いを吸収。NFKC）。 */
export function normalizeForMatch(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * 明細に当たるルールを返す（実装設計 §6.6 `classifyTransaction`）。有効なルールをシートの上から順に見て、
 * 最初に当たったものを使う。`対象` は `card`/`bank` が明細の取得元と一致するか `any`。`内容に含む文字列` は
 * 部分一致、`金額` があれば一致を要求する。当たらなければ `null`（経費の照合に進む明細）。
 */
export function classifyTransaction(
  tx: { content: string; value: number },
  rules: readonly MfTransactionRule[],
  side: ServiceKind,
): { rule: MfTransactionRule; index: number } | null {
  const content = normalizeForMatch(tx.content);
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index]!;
    if (!isRuleUsable(rule)) {
      continue;
    }
    if (rule.target !== "any" && rule.target !== side) {
      continue;
    }
    if (!content.includes(normalizeForMatch(rule.content.trim()))) {
      continue;
    }
    if (rule.amount !== null && rule.amount !== tx.value) {
      continue;
    }
    return { rule, index };
  }
  return null;
}

// ---- 照合（§6.5） -----------------------------------------------------------

/** 照合・訂正の判定が読む台帳行の項目（`ExpenseLedgerRow` が構造的に満たす）。 */
export interface LedgerRowView extends SyncRowView {
  mf_sync_state: JournalSyncState;
  correction_of_receipt_id: string | null;
  input_at: number;
}

/** 明細を使っている行の状態（実装設計 §6.5。`REVERSED`・`ERROR` の行は明細を手放している）。 */
export const USED_TRANSACTION_STATES: readonly JournalSyncState[] = ["JOURNALIZING", "SYNCED", "REVERSING", "NEEDS_REVIEW"];

function hasText(v: string | null): v is string {
  return v !== null && v !== "";
}

/**
 * 使用中の明細（`transactionKey`）の集合。{@link USED_TRANSACTION_STATES} の行の `MF明細ID`。
 * `exceptReceiptId` の行は数えない（その行自身が明細を確認するとき）。
 */
export function usedTransactionKeys(rows: readonly LedgerRowView[], exceptReceiptId?: string): Set<string> {
  const used = new Set<string>();
  for (const r of rows) {
    if (r.receipt_id !== exceptReceiptId && USED_TRANSACTION_STATES.includes(r.mf_sync_state) && hasText(r.mf_transaction_id)) {
      used.add(transactionKey(r.mf_transaction_id));
    }
  }
  return used;
}

const MAX_CORRECTION_DEPTH = 10;

export type CancelRoute = { route: "put" } | { route: "delete" } | { route: "unknown"; reason: string };

/**
 * 取消（`CORRECTED`/`VOID`）で仕訳を **PUT で書き換える**（連携明細から作った仕訳）か **DELETE する**（現金・立替）かを、
 * **作成経路**で決める（レビュー B2）。現在の `支払方法` だけでは決めない（人が支払方法を変えると、連携仕訳を
 * DELETE して明細が対象外になったり、現金仕訳を PUT したりするため）。
 *
 * 作成経路は `mf_sync_input`（`金額|日付|カテゴリ|支払方法|明細ID`。kadobo が仕訳を作る・取り込むときに保存）の
 * 支払方法と明細 ID、現在の `MF明細ID`・`支払方法` で判定する:
 * - 連携（`put`）: 作成時の支払方法が `linked_*`、明細 ID があり、現在の `MF明細ID`・`支払方法` と一致
 * - 現金（`delete`）: 作成時の支払方法が `cash`、明細 ID が無く、現在も `cash` で `MF明細ID` が無い
 * - 要約が空（手で状態や `MF仕訳ID` を書いた行）は現在の列だけで見る: `linked_*` かつ `MF明細ID` あり → `put`、
 *   `cash` かつ `MF明細ID` なし → `delete`
 * - それ以外（明細 ID があるのに `cash`、`cash` で作ったのに `linked_*`、`linked_*` なのに明細 ID なし 等）は
 *   `unknown`（自動では消さず、人の確認に回す）
 */
export function cancellationRoute(
  row: Pick<SyncRowView, "payment_method" | "mf_transaction_id" | "mf_sync_input">,
): CancelRoute {
  const curTx = hasText(row.mf_transaction_id) ? row.mf_transaction_id : null;
  const method = row.payment_method;
  const input = row.mf_sync_input;
  if (input === "") {
    if (serviceKindOf(method) !== null && curTx !== null) {
      return { route: "put" };
    }
    if (method === "cash" && curTx === null) {
      return { route: "delete" };
    }
    return {
      route: "unknown",
      reason:
        method === "cash"
          ? "現金・立替の支払方法ですが MF明細ID があります"
          : "連携の支払方法ですが、MF明細ID がなく、連携明細から作った仕訳か判定できません",
    };
  }
  const inputMethod = input.split("|")[3] ?? "";
  const inputTx = inputTransactionId(input);
  if (inputMethod === "linked_card" || inputMethod === "linked_bank") {
    if (inputTx !== null && curTx !== null && transactionKey(inputTx) === transactionKey(curTx) && method === inputMethod) {
      return { route: "put" };
    }
    return {
      route: "unknown",
      reason: `連携明細から作った仕訳（作成時 ${inputMethod}）ですが、現在の支払方法は ${method === "" ? "空" : method}、MF明細ID は ${curTx === null ? "空" : "作成時と異なる値"} です`,
    };
  }
  if (inputMethod === "cash") {
    if (inputTx === null && curTx === null && method === "cash") {
      return { route: "delete" };
    }
    return {
      route: "unknown",
      reason: `現金・立替として作った仕訳ですが、現在の支払方法は ${method === "" ? "空" : method}、MF明細ID は ${curTx === null ? "空" : "あり"} です`,
    };
  }
  return { route: "unknown", reason: "作成時の支払方法を判定できません（MF連携入力が想定外の形です）" };
}

/**
 * 訂正元をたどって、連携明細の仕訳を持つ（作成中・反映済み・取消中）行があるか。ある間は、訂正後の新しい行を
 * 通常の照合に出さない（旧仕訳を PUT で引き継ぐ。実装設計 §6.5 🔄）。
 */
export function holdsJournalAncestor(row: LedgerRowView, byId: ReadonlyMap<string, LedgerRowView>): boolean {
  let cur: LedgerRowView = row;
  for (let i = 0; i < MAX_CORRECTION_DEPTH; i++) {
    const parentId = cur.correction_of_receipt_id;
    const parent = hasText(parentId) ? byId.get(parentId) : undefined;
    if (parent === undefined) {
      return false;
    }
    if (
      cancellationRoute(parent).route === "put" &&
      (parent.mf_sync_state === "JOURNALIZING" || parent.mf_sync_state === "SYNCED" || parent.mf_sync_state === "REVERSING")
    ) {
      return true;
    }
    cur = parent;
  }
  return false;
}

export function indexLedgerRows<T extends LedgerRowView>(rows: readonly T[]): Map<string, T> {
  return new Map(rows.map((r) => [r.receipt_id, r]));
}

/** 連携明細の取込み待ちか（`WAITING_TRANSACTION`・連携の支払方法・登録完了・仕訳なし・訂正元の仕訳の引継ぎ待ちでない）。 */
export function isWaitingForTransaction(row: LedgerRowView, byId: ReadonlyMap<string, LedgerRowView>): boolean {
  return (
    row.mf_sync_state === "WAITING_TRANSACTION" &&
    serviceKindOf(row.payment_method) !== null &&
    row.state === "COMPLETED" &&
    !hasText(row.mf_journal_id) &&
    !holdsJournalAncestor(row, byId)
  );
}

/** 明細 `tx` が行 `row` の候補になる条件（連携サービス・金額・日付幅）。使用中かどうかは見ない。 */
export function isCandidateFor(row: { payment_method: PaymentMethod | ""; amount: number; date: string }, tx: MfTransaction): boolean {
  return (
    serviceKindOf(row.payment_method) === tx.service &&
    tx.value === row.amount &&
    tx.date >= shiftDate(row.date, -MATCH_DAYS_BEFORE) &&
    tx.date <= shiftDate(row.date, MATCH_DAYS_AFTER)
  );
}

export type MatchOutcome =
  | { kind: "matched"; receipt_id: string; transaction: MfTransaction }
  | { kind: "none"; receipt_id: string }
  | { kind: "review"; receipt_id: string; candidates: MfTransaction[]; reason: "multiple" | "contested" };

function compareTx(a: MfTransaction, b: MfTransaction): number {
  return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * 実装設計 §6.5 の照合。`rows` は台帳の全行、`txs` は取得した未仕訳の明細（明細ルールに当たったものは呼び出し側が
 * 除く）。対象は {@link isWaitingForTransaction} の行すべて（バッチに限らない）。
 *
 * 行 r の候補 = 支払方法に対応する連携サービスの明細で、`value === 金額` かつ
 * `date ∈ [日付 − 2, 日付 + 5]` かつ使用中でない明細。**自動で確定するのは一対一のときだけ**:
 * r の候補がちょうど t の 1 件で、t を候補にしている待ち行が r だけのとき。候補が複数、または明細の取り合いは
 * `review`（候補の一覧つき）、候補 0 件は `none`。日付が近いものを優先する規則は無い（取り合いを許さない）。
 */
export function matchTransactions(rows: readonly LedgerRowView[], txs: readonly MfTransaction[]): MatchOutcome[] {
  const byId = indexLedgerRows(rows);
  const used = usedTransactionKeys(rows);
  const free = txs.filter((t) => !used.has(transactionKey(t.id)));
  const waiting = rows.filter((r) => isWaitingForTransaction(r, byId));

  const candidatesOf = new Map<string, MfTransaction[]>();
  const contenders = new Map<string, Set<string>>();
  for (const r of waiting) {
    const cands = free.filter((t) => isCandidateFor(r, t)).sort(compareTx);
    candidatesOf.set(r.receipt_id, cands);
    for (const t of cands) {
      const key = transactionKey(t.id);
      const set = contenders.get(key) ?? new Set<string>();
      set.add(r.receipt_id);
      contenders.set(key, set);
    }
  }

  return waiting.map((r): MatchOutcome => {
    const cands = candidatesOf.get(r.receipt_id) ?? [];
    if (cands.length === 0) {
      return { kind: "none", receipt_id: r.receipt_id };
    }
    if (cands.length > 1) {
      return { kind: "review", receipt_id: r.receipt_id, candidates: cands, reason: "multiple" };
    }
    const only = cands[0]!;
    if ((contenders.get(transactionKey(only.id))?.size ?? 0) > 1) {
      return { kind: "review", receipt_id: r.receipt_id, candidates: cands, reason: "contested" };
    }
    return { kind: "matched", receipt_id: r.receipt_id, transaction: only };
  });
}

/** 候補 0 件のまま日付から {@link NO_CANDIDATE_NOTICE_DAYS} 日たったか（`today` は `YYYY-MM-DD`）。 */
export function isNoCandidateNoticeDue(rowDate: string, today: string): boolean {
  return shiftDate(rowDate, NO_CANDIDATE_NOTICE_DAYS) <= today;
}

// ---- journalize・PUT の本文 ---------------------------------------------------

export interface JournalizeRequestBody {
  transaction_id: string;
  transaction_date: string;
  account_id: string;
  remark: string;
  memo?: string;
  tags: string[];
}

/**
 * ③ `POST /transactions/journalize` の本文（実装設計 §6.5）。`transaction_date` は**経費台帳の `日付`**
 * （省略すると明細の日付になるため、必ず指定する。§3.2）。`remark`・`memo`・`tags` は §2.2 と同じ。
 * `tax_id`・`invoice_kind` は送らない。
 */
export function buildJournalizeBody(row: SyncRowView, transactionId: string, accountId: string): JournalizeRequestBody {
  const body: JournalizeRequestBody = {
    transaction_id: transactionId,
    transaction_date: row.date,
    account_id: accountId,
    remark: buildRemark(row.receipt_id, row.partner),
    tags: buildTags(row.receipt_id),
  };
  const memo = buildMemo(row.drive_link);
  if (memo !== undefined) {
    body.memo = memo;
  }
  return body;
}

/** 明細ルール（私用として仕訳）の `remark`: `私用: {ルール名}`。 */
export function buildRuleRemark(ruleName: string): string {
  return truncateCodePoints(`私用: ${ruleName}`, MF_TEXT_MAX_LENGTH);
}

/** 明細ルールの `POST /transactions/journalize` 本文（実装設計 §6.6）。`transaction_date` は明細の日付。 */
export function buildRuleJournalizeBody(tx: MfTransaction, ruleName: string, accountId: string): JournalizeRequestBody {
  return {
    transaction_id: tx.id,
    transaction_date: tx.date,
    account_id: accountId,
    remark: buildRuleRemark(ruleName),
    tags: [RULE_TAG],
  };
}

/** 取消した仕訳の `remark`: `取消: {証憑ID} {取引先}`（実装設計 §6.7）。 */
export function buildVoidRemark(receiptId: string, partner: string): string {
  return truncateCodePoints(`取消: ${receiptId} ${unescapeSheetFormula(partner)}`, MF_TEXT_MAX_LENGTH);
}

/** 取消した仕訳の `tags`: `[証憑ID, "kadobo-void"]`（実装設計 §6.7）。 */
export function buildVoidTags(receiptId: string): string[] {
  return [receiptId, VOID_TAG];
}

function numberOf(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function stringOf(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** 既存の仕訳の借方・貸方（1 行の仕訳。複数行・片側欠けは `null`）。 */
export function singleBranchOf(
  journal: Record<string, unknown>,
): { debitor: Record<string, unknown>; creditor: Record<string, unknown>; debitValue: number; creditValue: number } | null {
  const branches = journal.branches;
  if (!Array.isArray(branches) || branches.length !== 1) {
    return null;
  }
  const b = asRec(branches[0]);
  const debitor = asRec(b.debitor);
  const creditor = asRec(b.creditor);
  const debitValue = numberOf(debitor.value);
  const creditValue = numberOf(creditor.value);
  if (stringOf(debitor.account_id) === null || stringOf(creditor.account_id) === null || debitValue === null || creditValue === null) {
    return null;
  }
  return { debitor, creditor, debitValue, creditValue };
}

export interface JournalUpdateBody {
  journal: {
    transaction_date: string;
    journal_type: string;
    branches: {
      debitor: Record<string, unknown>;
      creditor: Record<string, unknown>;
      remark: string;
    }[];
    memo?: string;
    tags: string[];
  };
}

export interface JournalUpdatePatch {
  /** 新しい借方科目の ID。 */
  debitAccountId: string;
  /** 新しい借方金額。省略すると既存のまま。 */
  debitValue?: number;
  remark: string;
  tags: string[];
  /** 省略（`undefined`）なら `memo` キーを付けない（PUT は省略した項目を上書きするので、残したいときは既存の値を渡す）。 */
  memo?: string;
  /** 新しい取引日。省略すると既存のまま。 */
  transactionDate?: string;
}

/**
 * ③ の訂正・取消の `PUT /journals/{id}` 本文（実装設計 §6.7 🔄）。`GET /journals/{id}` で読んだ既存の仕訳
 * （`extractJournalItem` の結果）を元に、**借方の `account_id`・`value`、`remark`、`tags`、`memo`** を差し替える。
 * 貸方（連携明細の側）の科目・金額は変えない。借方の補助科目は旧科目のものなので引き継がず、部門・取引先コードと
 * 貸方の補助科目は引き継ぐ。`tax_id`・`invoice_kind` は送らない（§3.2）。
 *
 * 1 行の仕訳でない、または借方・貸方が読めないときは `{ ok: false }`（自動では直さない）。借方金額を変えて貸方と
 * 一致しなくなる場合も `{ ok: false }`（MF が貸借不一致で拒否するため。送らずに人の確認に回す）。
 */
export function buildJournalUpdateBody(
  existing: Record<string, unknown>,
  patch: JournalUpdatePatch,
): { ok: true; body: JournalUpdateBody } | { ok: false; reason: string } {
  const single = singleBranchOf(existing);
  if (single === null) {
    return { ok: false, reason: "仕訳が 1 行の借方・貸方の形ではないため、自動では更新できません" };
  }
  const debitValue = patch.debitValue ?? single.debitValue;
  if (debitValue !== single.creditValue) {
    return {
      ok: false,
      reason: `借方金額 ${debitValue} 円が貸方（連携明細の側）${single.creditValue} 円と一致しないため、自動では更新できません`,
    };
  }
  const carry = (side: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      const s = stringOf(side[k]);
      if (s !== null) {
        out[k] = s;
      }
    }
    return out;
  };
  const journal: JournalUpdateBody["journal"] = {
    transaction_date: patch.transactionDate ?? stringOf(existing.transaction_date) ?? "",
    journal_type: stringOf(existing.journal_type) ?? "journal_entry",
    branches: [
      {
        debitor: {
          account_id: patch.debitAccountId,
          value: debitValue,
          ...carry(single.debitor, ["department_id", "trade_partner_code"]),
        },
        creditor: {
          account_id: stringOf(single.creditor.account_id) as string,
          value: single.creditValue,
          ...carry(single.creditor, ["sub_account_id", "department_id", "trade_partner_code"]),
        },
        remark: patch.remark,
      },
    ],
    tags: patch.tags,
  };
  if (journal.transaction_date === "") {
    return { ok: false, reason: "既存の仕訳に取引日がないため、自動では更新できません" };
  }
  if (patch.memo !== undefined) {
    journal.memo = patch.memo;
  }
  return { ok: true, body: { journal } };
}

/**
 * 既存の仕訳が、`PUT` で送ろうとする本文と同じ内容か（引継ぎ復旧で、PUT が既に反映済みかを見る。レビュー B1）。
 * 取引日・借方の科目と金額・貸方の科目と金額・摘要・タグ・メモを比べる。
 */
export function journalMatchesUpdate(existing: Record<string, unknown>, body: JournalUpdateBody): boolean {
  const single = singleBranchOf(existing);
  const want = body.journal.branches[0];
  const branch = Array.isArray(existing.branches) ? (existing.branches[0] as Record<string, unknown> | undefined) : undefined;
  if (single === null || want === undefined || branch === undefined) {
    return false;
  }
  const tags = Array.isArray(existing.tags) ? existing.tags : [];
  const memo = typeof existing.memo === "string" ? existing.memo : "";
  return (
    stringOf(existing.transaction_date) === body.journal.transaction_date &&
    single.debitor.account_id === want.debitor.account_id &&
    single.debitValue === want.debitor.value &&
    single.creditor.account_id === want.creditor.account_id &&
    single.creditValue === want.creditor.value &&
    (typeof branch.remark === "string" ? branch.remark : "") === want.remark &&
    tags.length === body.journal.tags.length &&
    tags.every((t, i) => t === body.journal.tags[i]) &&
    memo === (body.journal.memo ?? "")
  );
}

// ---- 訂正・取消の引継ぎ計画（§6.7 🔄・§6.5） --------------------------------------

export type CancelPlan =
  /** まだ動かない（訂正後の新しい行が未登録・登録中・エラー、または開業日が未設定）。 */
  | { kind: "wait" }
  /** 借方を `事業主貸` に付け替える（`VOID`、または引き継げる新しい行が無い）。 */
  | { kind: "void" }
  /** 新しい行 `successor` の内容で同じ仕訳を更新して引き継ぐ。 */
  | { kind: "inherit"; successor: string }
  /** `successor` が既にこの仕訳を持っている（引継ぎ済み。不足セルを補って旧行を `REVERSED` にする）。 */
  | { kind: "done"; successor: string }
  /**
   * `successor` が同じ仕訳 ID を持つが確定していない（引継ぎの途中でセル書込みが失敗した。レビュー B1）。
   * `void` にせず、MF の仕訳を新しい行の内容と照合して必要なら PUT をやり直し、不足セルを補って完了する。
   */
  | { kind: "recover"; successor: string };

/** `row` を訂正元とする行（子孫まで）。深さは {@link MAX_CORRECTION_DEPTH} まで。 */
function descendantsOf(row: LedgerRowView, rows: readonly LedgerRowView[]): LedgerRowView[] {
  const out: LedgerRowView[] = [];
  const seen = new Set<string>([row.receipt_id]);
  let frontier = [row.receipt_id];
  for (let depth = 0; depth < MAX_CORRECTION_DEPTH && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const r of rows) {
      if (hasText(r.correction_of_receipt_id) && frontier.includes(r.correction_of_receipt_id) && !seen.has(r.receipt_id)) {
        seen.add(r.receipt_id);
        out.push(r);
        next.push(r.receipt_id);
      }
    }
    frontier = next;
  }
  return out;
}

/**
 * 連携明細から作った仕訳を持つ行 `row`（`CORRECTED`/`VOID`）の取消の進め方（実装設計 §6.7 🔄・§6.5）。
 * 削除ではなく `PUT /journals/{id}` で書き換える。
 * - `VOID` → `void`
 * - `CORRECTED` → 訂正後の新しい行（`訂正元証憑ID` が `row`。訂正の連鎖は子孫まで見る）の `COMPLETED` の行で
 *   引き継ぐ。新しい行が無い・登録中・エラー・さらに訂正待ちなら `wait`。引継ぎの条件は、新しい行が仕訳なし・
 *   同じ支払方法・同じ金額・自動仕訳の対象（`decideSyncTarget` が ready）。満たさなければ `void`
 *   （旧仕訳は事業主貸にして、新しい行は通常の照合に回る）
 */
export function planLinkedCancellation(
  row: LedgerRowView,
  rows: readonly LedgerRowView[],
  startDate: string | null,
): CancelPlan {
  if (row.state === "VOID") {
    return { kind: "void" };
  }
  const desc = descendantsOf(row, rows);
  if (desc.length === 0) {
    return { kind: "wait" };
  }
  // 同じ仕訳 ID を持つ子孫が最優先（引継ぎ済み、または途中で止まった引継ぎの復旧。`void` にしない）。
  const holder = hasText(row.mf_journal_id) ? desc.find((d) => d.mf_journal_id === row.mf_journal_id) : undefined;
  if (holder !== undefined) {
    if (holder.mf_sync_state === "SYNCED") {
      return { kind: "done", successor: holder.receipt_id };
    }
    return holder.state === "COMPLETED" && (holder.mf_sync_state === "" || holder.mf_sync_state === "WAITING_TRANSACTION")
      ? { kind: "recover", successor: holder.receipt_id }
      : { kind: "wait" };
  }
  if (desc.some((d) => d.state === "RECEIVED" || d.state === "FILE_SAVED" || d.state === "ERROR")) {
    return { kind: "wait" };
  }
  // 訂正済み（CORRECTED）で、さらに訂正後の行がまだ無い行があれば、その登録を待つ。
  if (desc.some((d) => d.state === "CORRECTED" && !desc.some((c) => c.correction_of_receipt_id === d.receipt_id))) {
    return { kind: "wait" };
  }
  const live = desc.filter((d) => d.state === "COMPLETED").sort((a, b) => b.input_at - a.input_at);
  if (live.length === 0) {
    return { kind: "void" };
  }
  if (startDate === null || startDate === "") {
    return { kind: "wait" };
  }
  const pick = live[0]!;
  const inheritable =
    (pick.mf_sync_state === "" || pick.mf_sync_state === "WAITING_TRANSACTION") &&
    !hasText(pick.mf_journal_id) &&
    pick.payment_method === row.payment_method &&
    pick.amount === row.amount &&
    decideSyncTarget(pick, startDate).kind === "ready";
  return inheritable ? { kind: "inherit", successor: pick.receipt_id } : { kind: "void" };
}
