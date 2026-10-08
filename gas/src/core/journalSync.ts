/**
 * 経費の仕訳連携（実装設計 MF連携 §6.1〜§6.4, §6.7）の純関数。GAS グローバル・HTTP・シートには依存しない。
 *
 * - §6.3 の同期状態の型と、kadobo が行う遷移の表（{@link canTransition}）
 * - §6.2 の対象判定（{@link decideSyncTarget}）
 * - §6.4 の科目対応表と `POST /journals` 本文の組み立て（**`tax_id`・`invoice_kind` は送らない**）
 * - §2.2 の `remark`・`memo`・`tags`
 * - §6.1 の `MF連携入力`（`mf_sync_input`）の要約と変更検出
 * - `GET /journals` の応答の読み取り（タグ検索・重複検出）
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
 * （列だけ更新する）は常に許す。`JOURNALIZING` 関連は WP-M5 の範囲だが、状態機械として今回定義する。
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
