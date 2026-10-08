/**
 * 経費の仕訳連携（実装設計 MF連携 §6.1〜§6.8）。
 * - WP-M4: ② 現金・立替（`POST /journals`）と、取消（`DELETE /journals/{id}`）・手入力の取り込み・変更検出
 * - WP-M5: ③ 連携カード・口座の明細との照合（§6.5）、明細ルール（§6.6）、`JOURNALIZING` の回収、
 *   連携明細から作った仕訳の訂正・取消（`PUT /journals/{id}`。§6.7 🔄）、週次報告（未登録の支出・私用として
 *   処理した明細・無効なルール）
 *
 * {@link syncExpenses} は §6.3「1 回の実行で処理する順番」どおりに進む:
 * 1. 回収（`CREATING`・`UNKNOWN` は `tags` の検索、`JOURNALIZING` は明細 ID での検索、`REVERSING` は
 *    `DELETE`（現金）・`PUT`（連携）のやり直し）
 * 2. 取消（`CORRECTED`/`VOID` → §6.7。現金は `DELETE`、連携は `PUT` で書き換え）
 * 3. 手入力の取り込み（B7）
 * 4. 変更検出
 * 5. 新規: ② 現金（`MF_JOURNAL_ENABLED`）、③ 明細ルールの適用 → 人が記入した `MF明細ID` の検証 → 照合 →
 *    `journalize`（`MF_MATCH_ENABLED`）
 *
 * 1〜3（維持作業）は 1 つの「維持キュー」にまとめ、内部シート `mf_sync/cursor` に保存した位置から巡回する
 * （同じ未解決行が毎回先頭を塞がないため）。API を呼ぶ行の予算 20 行は、維持作業に最大 10 行、新規に残り
 * （最大 10 行）を割り当て、新規が余れば維持作業の続きに回す（レビュー M3）。実行全体は
 * `trigMfSync` 開始時刻基準の絶対期限（{@link RunDeadline}、4 分）で打ち切る（レビュー M4）。
 *
 * **ロックの扱い（§0, §6.8）**: シートの読み書きは短い `ports.lock.withLock` の中で行い、MF の呼び出しは
 * ロックの外で行う。書くときは行を読み直し、§6.1 の列（`MF仕訳ID`・`MF明細ID`・27〜31 列目）だけを
 * `updateExpenseColumns` で書く（業務列は書かない）。Slack・`notifyMf*` もロックの外で呼ぶ。
 *
 * **ID の扱い（§3.2 🔬）**: 会計 API の ID はパーセントエンコード済みの文字列。本文（`account_id` 等）には
 * そのまま入れる。パスに置くときは `pathWithId`（1 回エンコード）、クエリに置くときは `{ raw }`
 * （`connected_account_id`・`transaction_ids`。エンコードすると 400。S-M4 の実測）に集約する。
 *
 * **フラグ（§9）**: 全体は `MF_ENABLED`。② の新規作成は `MF_JOURNAL_ENABLED`、③ の新規（明細ルールの適用・
 * 照合・`journalize`・未登録支出の報告）は `MF_MATCH_ENABLED` も要る。回収・取消（`PUT` による訂正取消を含む）・
 * 取り込み・変更検出は `MF_ENABLED` だけで動く（作りかけを放置しないため）。
 */
import { businessDateOf } from "@kadobo/shared/time";
import {
  CASH_CREDITOR_ACCOUNT_NAME,
  IMPORTABLE_STATES,
  JOURNAL_ACCOUNT_NAMES,
  NO_JOURNAL_STATES,
  PRIVATE_ACCOUNT_NAME,
  NO_CANDIDATE_NOTICE_DAYS,
  RULE_ACTION_IGNORE,
  RULE_ACTION_PRIVATE,
  RULE_TAG,
  buildJournalRequestBody,
  buildJournalUpdateBody,
  buildJournalizeBody,
  buildMemo,
  buildRemark,
  buildRuleJournalizeBody,
  buildTags,
  buildVoidRemark,
  buildVoidTags,
  canTransition,
  classifyTransaction,
  creationDateFromInput,
  debitAccountNameOf,
  decideSyncTarget,
  extractJournalItem,
  extractJournalList,
  findDuplicateReceiptTags,
  hasInputChanged,
  holdsJournalAncestor,
  indexLedgerRows,
  initialStateFor,
  inputTransactionId,
  isCancelledExpenseState,
  isCandidateFor,
  isNoCandidateNoticeDue,
  isRuleUsable,
  isWaitingForTransaction,
  journalHasTag,
  journalIdOf,
  matchTransactions,
  parseTransactions,
  planLinkedCancellation,
  ruleDefects,
  serviceKindOf,
  shiftDate,
  singleBranchOf,
  splitDateRangeBySpan,
  splitRangeByCalendarYear,
  summarizeSyncInput,
  totalPagesOf,
  transactionKey,
  usedTransactionKeys,
  type MfTransaction,
  type MfTransactionRule,
  type ServiceKind,
} from "../core/journalSync";
import { makeMfAccountingClient, pathWithId, type MfAccountingClient, type MfQueryValue } from "./mf/accountingClient";
import { MF_RUN_DEADLINE_MS, RunDeadline, RunDeadlineExceededError } from "./mf/deadline";
import { MfApiError, MfOutcomeUnknownError, isMfNotFound } from "./mf/errors";
import { isJournalEnabled, isMatchEnabled, isMfEnabled } from "./mf/flags";
import { withLease } from "./mf/lease";
import { lookupAccountsByName } from "./mf/pingFormat";
import { shiftBusinessDate } from "./dateUtil";
import { ConfigMissingError, type AppPorts, type ExpenseLedgerRow } from "./ports";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** 同期の lease キー（内部シート `lease/mf_sync`）。実装設計 §6.8。 */
export const MF_SYNC_LEASE_KEY = "mf_sync";
const LEASE_TTL_MS = 10 * 60 * 1000;
/** `trigMfSync` 1 回で API を呼ぶ行の上限（`MF_SYNC_BATCH`。実装設計 §6.8）。 */
export const MF_SYNC_BATCH = 20;
/** 実行開始（`trigMfSync` の開始）からこの時間たったら新しい行に手を付けずに終える（§6.8）。 */
export const MF_SYNC_DEADLINE_MS = MF_RUN_DEADLINE_MS;
/** 維持作業（回収・取消・取り込み）に最初に割り当てる行数。残りは新規に回す（レビュー M3）。 */
export const MF_SYNC_MAINTENANCE_FIRST = 10;
/** 維持作業の巡回位置（内部シート `mf_sync/cursor`。最後に手を付けた証憑 ID）。 */
const CURSOR_KIND = "mf_sync";
const CURSOR_KEY = "cursor";
/** `CREATING` から 24 時間たっても見つからなければ `UNKNOWN`（§6.4）。 */
const UNKNOWN_AFTER_MS = 24 * 60 * 60 * 1000;
/** 科目名 → ID の解決結果を `TtlCachePort` に置くキーと保存秒数（§6.4。6 時間）。 */
export const MF_ACCOUNTS_CACHE_KEY = "mf_acc_accounts";
const ACCOUNTS_CACHE_TTL_SEC = 6 * 60 * 60;
const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 50;
const NOTICE_KIND = "mf_notice";
const ERROR_TEXT_MAX = 200;
/** `GET /transactions` の `per_page`（最大 500。実装設計 §6.5）と、1 連携サービスあたりの最大ページ数。 */
const TX_PER_PAGE = 500;
const TX_MAX_PAGES = 50;
/**
 * 明細ルールを適用するために遡る日数の下限（実装設計 §6.5 の「待ち行の日付の最小値 − 3 日」だけでは、待ち行が無いとき
 * NISA のような証憑の無い明細を取得できないため、取得期間の開始は両者のうち古い方にする。判断メモを報告に記載）。
 */
export const MF_RULE_LOOKBACK_DAYS = 45;
/** 待ち行の日付から遡って明細を取得する日数（実装設計 §6.5）。 */
const FETCH_DAYS_BEFORE_ROW = 3;
/** 未登録の支出として報告する経過日数（実装設計 §6.6）。 */
const UNREGISTERED_AFTER_DAYS = 7;

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
    console.error("journalSync postBestEffort failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
  }
}

function dmOperatorBestEffort(ports: AppPorts, text: string): void {
  const userId = ports.props.get("SLACK_USER_ID");
  if (userId === null) {
    return;
  }
  try {
    ports.slack.dm(userId, text);
  } catch {
    // 通知自体の失敗はベストエフォート。
  }
}

function truncate(s: string, max = ERROR_TEXT_MAX): string {
  const chars = Array.from(s);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : s;
}

function errorText(e: unknown): string {
  return truncate(e instanceof Error ? e.message : String(e));
}

function hasValue(v: string | null): v is string {
  return v !== null && v !== "";
}

/** 同期が書いてよい列だけの型（`MF仕訳ID`・`MF明細ID`・27〜31 列目。実装設計 §6.1）。 */
type MfColumnsPatch = Partial<
  Pick<
    ExpenseLedgerRow,
    | "mf_journal_id"
    | "mf_transaction_id"
    | "mf_sync_state"
    | "mf_sync_error"
    | "mf_sync_updated_at"
    | "mf_sync_attempted_at"
    | "mf_sync_input"
  >
>;

/** 短いロックの中で全行を読む（実装設計 §6.8 手順 1）。 */
function snapshotRows(ports: AppPorts): ExpenseLedgerRow[] {
  return ports.lock.withLock(() => ports.sheets.getAllExpenses());
}

/**
 * セル単位の書込みの順序。確定を表す `mf_sync_state` を**最後**にし、`MF仕訳ID`・試行時刻・入力要約を先に書く
 * （途中で失敗しても「状態だけ進んで必要な情報が無い」行を残さない。レビュー M2）。
 */
const MF_WRITE_ORDER = [
  "mf_journal_id",
  "mf_transaction_id",
  "mf_sync_error",
  "mf_sync_attempted_at",
  "mf_sync_input",
  "mf_sync_updated_at",
  "mf_sync_state",
] as const;

/**
 * 短いロックの中で行を読み直し、`guard` を満たすときだけ §6.1 の列を書く（実装設計 §6.8 手順 3）。
 * 書けたら書いた後の行を、書かなかった（行が無い・`guard` を満たさない）ら `null` を返す。
 * `mf_sync_state` を変える書込みは {@link canTransition} の表を通す（`force` は「仕訳が MF に存在すると
 * 分かっている」書込みで、人が状態を書き換えていても `MF仕訳ID` を失わないため表を飛ばす）。
 * `mf_sync_updated_at` は毎回現在時刻にする。
 */
function writeIfCurrent(
  ports: AppPorts,
  receiptId: string,
  guard: (row: ExpenseLedgerRow) => boolean,
  patch: MfColumnsPatch,
  opts: { force?: boolean } = {},
): ExpenseLedgerRow | null {
  return ports.lock.withLock(() => {
    const current = ports.sheets.getExpenseByReceiptId(receiptId);
    if (current === null || !guard(current)) {
      return null;
    }
    if (
      patch.mf_sync_state !== undefined &&
      opts.force !== true &&
      !canTransition(current.mf_sync_state, patch.mf_sync_state)
    ) {
      throw new Error(`mf_sync_invalid_transition:${receiptId}:${current.mf_sync_state}->${patch.mf_sync_state}`);
    }
    const full: MfColumnsPatch = { ...patch, mf_sync_updated_at: ports.clock.nowMs() };
    ports.sheets.updateExpenseColumns(receiptId, full, MF_WRITE_ORDER);
    return { ...current, ...full };
  });
}

/** 内部シート `mf_notice/<key>` に同じ日付が無ければ記録して `true`（1 日 1 回の通知の抑止）。 */
function claimDailyNotice(ports: AppPorts, key: string): boolean {
  const today = businessDateOf(ports.clock.nowMs());
  return ports.lock.withLock(() => {
    if (ports.sheets.getInternalValue(NOTICE_KIND, key) === today) {
      return false;
    }
    ports.sheets.setInternalValue(NOTICE_KIND, key, today);
    return true;
  });
}

type BudgetPhase = "maintenance" | "new";

/**
 * 1 回の実行の「API を呼ぶ行」の予算（20 行。実装設計 §6.8）と、絶対期限（{@link RunDeadline}）の確認。
 * 維持作業は最初 {@link MF_SYNC_MAINTENANCE_FIRST} 行まで。新規は残り全部。{@link RunBudget.openMaintenance}
 * で維持作業の上限を外し、新規が余らせた分を使えるようにする。
 */
class RunBudget {
  private used = 0;
  private maintenanceUsed = 0;
  private maintenanceCap = MF_SYNC_MAINTENANCE_FIRST;

  constructor(private readonly deadline: RunDeadline) {}

  /** 新しい行に API を呼ぶ手を付けてよければ数えて `true`。上限・期限切れなら `false`。 */
  tryStartRow(phase: BudgetPhase): boolean {
    if (this.used >= MF_SYNC_BATCH || this.deadline.isExpired()) {
      return false;
    }
    if (phase === "maintenance" && this.maintenanceUsed >= this.maintenanceCap) {
      return false;
    }
    this.used++;
    if (phase === "maintenance") {
      this.maintenanceUsed++;
    }
    return true;
  }

  /** 維持作業の上限を全体の上限まで広げる（新規が余らせた分を維持作業の続きに回す）。 */
  openMaintenance(): void {
    this.maintenanceCap = MF_SYNC_BATCH;
  }
}

interface SyncCtx {
  ports: AppPorts;
  client: MfAccountingClient;
  budget: RunBudget;
  deadline: RunDeadline;
  /** `MF_SYNC_START_DATE`。未設定は `null`。 */
  startDate: string | null;
  /** 作成の結果が分からなかった（`MfOutcomeUnknownError`）ので、この実行ではこれ以上作らない。 */
  halted: boolean;
  /** この実行で `GET /accounts` を取得済みか（足りない科目名のたびに取り直さないため）。 */
  accountsFetched: boolean;
}

// ---------------------------------------------------------------------------
// MF 呼び出し（ID は MF が返したパーセントエンコード済みの文字列。パスに置くときは pathWithId）
// ---------------------------------------------------------------------------

/**
 * `GET /journals?start_date&end_date` を全ページ取得し、`tags` に `tag` を含む仕訳を返す
 * （実装設計 §6.4 の冪等確認。`tag` は証憑 ID）。
 */
export function findJournalsByTag(
  client: MfAccountingClient,
  tag: string,
  startDate: string,
  endDate: string,
  deadline?: RunDeadline,
): Record<string, unknown>[] {
  const matched: Record<string, unknown>[] = [];
  for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
    // 期限切れ: 途中までの結果を「見つからなかった」と読むと二重作成になるので、結果を返さず例外にする。
    if (deadline?.isExpired() === true) {
      throw new RunDeadlineExceededError();
    }
    const res = client.request("get", "/journals", {
      start_date: startDate,
      end_date: endDate,
      page: String(page),
      per_page: String(SEARCH_PER_PAGE),
    });
    const list = extractJournalList(res);
    for (const j of list) {
      if (journalHasTag(j, tag)) {
        matched.push(j);
      }
    }
    const totalPages = totalPagesOf(res);
    if (totalPages !== null ? page >= totalPages : list.length < SEARCH_PER_PAGE) {
      break;
    }
  }
  return matched;
}

/**
 * `GET /journals/{id}`（パスは `pathWithId`）。存在すれば `true`、存在しない（{@link isMfNotFound}: 404、または
 * 400 `invalid_request_path_parameter`）なら `false`（他の失敗は投げる）。
 */
function journalExists(client: MfAccountingClient, id: string): boolean {
  try {
    client.request("get", pathWithId("/journals", id));
    return true;
  } catch (e) {
    if (isMfNotFound(e)) {
      return false;
    }
    throw e;
  }
}

/** `DELETE /journals/{id}`。存在しない（{@link isMfNotFound}）は削除済みとして成功扱い（実装設計 §6.7）。 */
function deleteJournal(client: MfAccountingClient, id: string): void {
  try {
    client.request("delete", pathWithId("/journals", id));
  } catch (e) {
    if (isMfNotFound(e)) {
      return;
    }
    throw e;
  }
}

/**
 * 科目名 → ID の対応表。`GET /accounts?available=true` の結果を `TtlCachePort` に 6 時間置く（§6.4）。
 * `wanted` のすべてがキャッシュにあれば API を呼ばない。足りなければ取り直す（この実行で取得済みなら取り直さず、
 * 見つからない名前は表に載せない）。表には {@link JOURNAL_ACCOUNT_NAMES}・`事業主貸`・`wanted` のうち
 * 名前完全一致で 1 件に決まったものだけが入る。見つからない名前の扱い（止める／ルールを無効にする）は呼び出し側が決める。
 */
function loadAccountMap(ctx: SyncCtx, wanted: readonly string[]): Record<string, string> {
  const { ports, client } = ctx;
  let cached: Record<string, string> = {};
  const cachedRaw = ports.ttlCache.get(MF_ACCOUNTS_CACHE_KEY);
  if (cachedRaw !== null) {
    try {
      cached = JSON.parse(cachedRaw) as Record<string, string>;
    } catch {
      cached = {}; // 壊れたキャッシュは捨てて取り直す。
    }
  }
  if (wanted.every((n) => typeof cached[n] === "string" && cached[n] !== "")) {
    return cached;
  }
  if (ctx.accountsFetched) {
    return cached;
  }
  const res = client.request("get", "/accounts", { available: "true" });
  ctx.accountsFetched = true;
  const map: Record<string, string> = {};
  const names = [...new Set([...JOURNAL_ACCOUNT_NAMES, PRIVATE_ACCOUNT_NAME, ...wanted])];
  for (const l of lookupAccountsByName(res, names)) {
    if (l.status === "one" && l.matches[0] !== undefined) {
      map[l.name] = l.matches[0].id;
    }
  }
  ports.ttlCache.put(MF_ACCOUNTS_CACHE_KEY, JSON.stringify(map), ACCOUNTS_CACHE_TTL_SEC);
  return map;
}

/**
 * 科目名 → ID。`names` のどれかが（名前完全一致・有効な科目として）1 件に決まらなければ {@link ConfigMissingError}
 * （勝手に別科目へ寄せない）。
 */
function resolveAccountIds(ctx: SyncCtx, names: readonly string[]): Record<string, string> {
  const map = loadAccountMap(ctx, names);
  const missing = names.filter((n) => map[n] === undefined);
  if (missing.length > 0) {
    throw new ConfigMissingError(
      "MF_ACCOUNTS",
      `MF の勘定科目が名前完全一致で 1 件に決まりません: ${missing.join("、")}（実装設計 MF連携 §6.4）。MF の勘定科目を確認してください。`,
    );
  }
  return map;
}

// ---------------------------------------------------------------------------
// 1〜3. 維持作業（回収・取消・手入力の取り込み）
// ---------------------------------------------------------------------------

const UNKNOWN_REQUEST_TEXT =
  "MF に仕訳が無ければ MF連携状態 を空に戻してください（作り直します）。あれば MF仕訳ID に ID を書いてください。";

/**
 * `CREATING`・`UNKNOWN` の回収検索の範囲（`[開始日, 終了日]` の配列。レビュー M1）。
 * - `mf_sync_input` に保存した**作成時の日付**を最優先の検索日にする（作成後に台帳の `日付` を直されても
 *   仕訳は作成時の `transaction_date` のまま MF にあるため）。現在の `日付` と違えば両方の日で検索する。
 * - 要約が無い行は、試行時刻（無ければ更新時刻）の前後 1 日と、現在の `日付` を検索する。
 */
function recoverySearchRanges(row: ExpenseLedgerRow): { start: string; end: string }[] {
  const ranges: { start: string; end: string }[] = [];
  const add = (start: string, end: string): void => {
    if (!ranges.some((r) => r.start === start && r.end === end)) {
      ranges.push({ start, end });
    }
  };
  const created = creationDateFromInput(row.mf_sync_input);
  if (created !== null) {
    add(created, created);
  } else {
    const base = row.mf_sync_attempted_at ?? row.mf_sync_updated_at;
    if (base !== null) {
      const d = businessDateOf(base);
      add(shiftBusinessDate(d, -1), shiftBusinessDate(d, 1));
    }
  }
  add(row.date, row.date);
  return ranges;
}

/** `CREATING`・`UNKNOWN` の行を `tags` の検索で回収する（実装設計 §6.4）。 */
function recoverCreating(ctx: SyncCtx, row: ExpenseLedgerRow): void {
  const { ports, client } = ctx;
  let id: string | null = null;
  for (const range of recoverySearchRanges(row)) {
    const found = findJournalsByTag(client, row.receipt_id, range.start, range.end, ctx.deadline);
    id = found.length > 0 ? journalIdOf(found[0]!) : null;
    if (id !== null) {
      break;
    }
  }
  if (id !== null) {
    writeIfCurrent(
      ports,
      row.receipt_id,
      (cur) => cur.mf_sync_state === "CREATING" || cur.mf_sync_state === "UNKNOWN",
      { mf_journal_id: id, mf_sync_state: "SYNCED", mf_sync_error: null },
      { force: true },
    );
    return;
  }
  if (row.mf_sync_state !== "CREATING") {
    return; // UNKNOWN は依頼済み。次回また検索するだけ。
  }
  // 試行時刻が空の `CREATING`（保存の途中で失敗した等）は、更新時刻を試行時刻の代わりにする（レビュー M2）。
  const attemptedAt = row.mf_sync_attempted_at ?? row.mf_sync_updated_at;
  if (attemptedAt === null) {
    return;
  }
  if (ports.clock.nowMs() - attemptedAt < UNKNOWN_AFTER_MS) {
    return; // 試行から 24 時間未満は待つ（次回また検索する）。
  }
  const written = writeIfCurrent(ports, row.receipt_id, (cur) => cur.mf_sync_state === "CREATING", {
    mf_sync_state: "UNKNOWN",
    mf_sync_error: "作成の結果が確認できないまま 24 時間たちました",
  });
  if (written !== null) {
    postBestEffort(ports, `⚠️ ${row.receipt_id}: MF で仕訳が作成されたか確認できません。${UNKNOWN_REQUEST_TEXT}`);
  }
}

/**
 * 取消に伴う仕訳の処理を行い、`REVERSED` にして 1 行通知する（`REVERSING` から呼ぶ。実装設計 §6.7）。
 * 現金・立替（②）は `DELETE`、連携明細から作った仕訳（③）は `PUT` で書き換える（削除すると明細が対象外になるため）。
 */
function finishReversal(ctx: SyncCtx, row: ExpenseLedgerRow): void {
  const { ports } = ctx;
  if (!hasValue(row.mf_journal_id)) {
    writeIfCurrent(ports, row.receipt_id, (cur) => cur.mf_sync_state === "REVERSING", {
      mf_sync_state: "ERROR",
      mf_sync_error: "取消中ですが MF仕訳ID がありません",
    });
    return;
  }
  if (serviceKindOf(row.payment_method) !== null) {
    finishReversalByPut(ctx, row);
    return;
  }
  finishReversalByDelete(ctx, row, row.mf_journal_id);
}

/** 現金・立替の取消: `DELETE /journals/{id}`（404、または 400 `invalid_request_path_parameter` は削除済みとして成功）。 */
function finishReversalByDelete(ctx: SyncCtx, row: ExpenseLedgerRow, id: string): void {
  const { ports, client } = ctx;
  try {
    deleteJournal(client, id);
  } catch (e) {
    if (e instanceof MfApiError) {
      const written = writeIfCurrent(ports, row.receipt_id, (cur) => cur.mf_sync_state === "REVERSING", {
        mf_sync_state: "ERROR",
        mf_sync_error: errorText(e),
      });
      if (written !== null) {
        postBestEffort(
          ports,
          `⚠️ ${row.receipt_id}: 取消に伴う MF の仕訳の削除が拒否されました（${errorText(e)}）。MF で仕訳を削除してください。`,
        );
      }
      return;
    }
    throw e;
  }
  const written = writeIfCurrent(ports, row.receipt_id, (cur) => cur.mf_sync_state === "REVERSING", {
    mf_sync_state: "REVERSED",
    mf_sync_error: null,
  });
  if (written !== null) {
    postBestEffort(ports, `🗑 ${row.receipt_id}: 訂正・取消のため MF の仕訳を削除しました。`);
  }
}

// ---------------------------------------------------------------------------
// ③ の維持作業: 訂正・取消（PUT）と JOURNALIZING の回収
// ---------------------------------------------------------------------------

function numberText(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 連携明細から作った仕訳の取消（実装設計 §6.7 🔄）。**削除ではなく `PUT /journals/{id}`** で書き換える
 * （削除すると明細が `excluded` になり、未仕訳に戻らないため）。{@link planLinkedCancellation} で進め方を決める:
 * - `void`: 借方を `事業主貸` に付け替え、`remark` を `取消: {証憑ID} {取引先}`、`tags` を `[証憑ID, "kadobo-void"]` にする
 * - `inherit`: 訂正後の新しい行の金額・科目・摘要・タグで同じ仕訳を更新し、新しい行を `SYNCED`
 *   （`MF仕訳ID`・`MF明細ID` を引き継ぐ）、旧行を `REVERSED` にする
 * - `done`: 新しい行が既に引き継いでいる。旧行を `REVERSED` にするだけ
 * PUT は全体の上書きなので、結果不明でやり直しても二重にならない（`REVERSING` のまま次回やり直す）。
 */
function finishReversalByPut(ctx: SyncCtx, row: ExpenseLedgerRow): void {
  const { ports, client } = ctx;
  const id = row.mf_journal_id as string;
  const rows = snapshotRows(ports);
  const plan = planLinkedCancellation(row, rows, ctx.startDate);
  if (plan.kind === "wait") {
    return; // `REVERSING` のまま。新しい行の状態が整ったら次回進める。
  }
  const stillReversing = (cur: ExpenseLedgerRow): boolean => cur.mf_sync_state === "REVERSING";
  const markError = (reason: string): void => {
    const written = writeIfCurrent(ports, row.receipt_id, stillReversing, {
      mf_sync_state: "ERROR",
      mf_sync_error: truncate(reason),
    });
    if (written !== null) {
      postBestEffort(
        ports,
        `⚠️ ${row.receipt_id}: 取消に伴う MF の仕訳の更新ができませんでした（${truncate(reason)}）。MF で仕訳を直してください。`,
      );
    }
  };
  const markReversed = (text: string): void => {
    const written = writeIfCurrent(ports, row.receipt_id, stillReversing, { mf_sync_state: "REVERSED", mf_sync_error: null });
    if (written !== null) {
      postBestEffort(ports, text);
    }
  };

  const successor = plan.kind === "void" ? null : (rows.find((r) => r.receipt_id === plan.successor) ?? null);
  if (plan.kind === "done") {
    markReversed(`🔁 ${row.receipt_id}: 訂正後の ${plan.successor} が MF の仕訳を引き継ぎ済みです。`);
    return;
  }

  // 既存の仕訳を読む（PUT は省略した項目を上書きするため、貸方など変えない項目は読んだ値を送る）。
  let existing: Record<string, unknown> | null;
  try {
    existing = extractJournalItem(client.request("get", pathWithId("/journals", id)));
  } catch (e) {
    if (isMfNotFound(e)) {
      markReversed(`🗑 ${row.receipt_id}: MF の仕訳が見つかりません（削除済みとして扱います）。MF で確認してください。`);
      return;
    }
    throw e;
  }
  if (existing === null) {
    markError("GET /journals/{id} の応答に仕訳がありません");
    return;
  }

  const debitName = successor === null ? PRIVATE_ACCOUNT_NAME : debitAccountNameOf(successor.category);
  const accounts = resolveAccountIds(ctx, [debitName]);
  const debitAccountId = accounts[debitName] as string;
  const built =
    successor === null
      ? buildJournalUpdateBody(existing, {
          debitAccountId,
          remark: buildVoidRemark(row.receipt_id, row.partner),
          tags: buildVoidTags(row.receipt_id),
          memo: typeof existing.memo === "string" && existing.memo !== "" ? existing.memo : undefined,
        })
      : buildJournalUpdateBody(existing, {
          debitAccountId,
          debitValue: successor.amount,
          remark: buildRemark(successor.receipt_id, successor.partner),
          tags: buildTags(successor.receipt_id),
          memo: buildMemo(successor.drive_link),
          transactionDate: successor.date,
        });
  if (!built.ok) {
    markError(built.reason);
    return;
  }
  try {
    client.request("put", pathWithId("/journals", id), {}, built.body);
  } catch (e) {
    if (e instanceof MfApiError) {
      markError(errorText(e));
      return;
    }
    throw e; // 429・5xx・認証: `REVERSING` のまま次回やり直す（PUT は何度送っても同じ結果）。
  }

  if (successor === null) {
    markReversed(`🗑 ${row.receipt_id}: 取消のため MF の仕訳を事業主貸に付け替えました（明細は削除していません）。`);
    return;
  }
  // 新しい行に仕訳を引き継ぐ。書けなければ旧行は `REVERSING` のまま（次回、計画を立て直す）。
  const inherited = writeIfCurrent(
    ports,
    successor.receipt_id,
    (cur) =>
      cur.state === "COMPLETED" &&
      !hasValue(cur.mf_journal_id) &&
      (cur.mf_sync_state === "" || cur.mf_sync_state === "WAITING_TRANSACTION") &&
      summarizeSyncInput(cur) === summarizeSyncInput(successor),
    {
      mf_journal_id: id,
      mf_transaction_id: row.mf_transaction_id,
      mf_sync_state: "SYNCED",
      mf_sync_error: null,
      mf_sync_input: summarizeSyncInput({ ...successor, mf_transaction_id: row.mf_transaction_id }),
    },
    { force: true },
  );
  if (inherited === null) {
    return;
  }
  markReversed(`🔁 ${row.receipt_id}: 訂正のため MF の仕訳を ${successor.receipt_id} の内容に更新しました（明細は同じまま）。`);
}

/** `JOURNALIZING` の行の検索日（`mf_sync_input` の作成時の日付。無ければ現在の `日付`）。 */
function journalizingDate(row: ExpenseLedgerRow): string {
  return creationDateFromInput(row.mf_sync_input) ?? row.date;
}

/**
 * `GET /journals?transaction_ids=<明細 ID>`（クエリの ID は `{ raw }`。期間は作成時の日付 ± 1 日。実装設計 §6.5）。
 * 見つかった仕訳の ID。見つからない、または MF が 400（存在しない明細 ID 等）を返したら `null`。
 */
function findJournalIdByTransaction(ctx: SyncCtx, txId: string, date: string): string | null {
  try {
    const res = ctx.client.request("get", "/journals", {
      start_date: shiftDate(date, -1),
      end_date: shiftDate(date, 1),
      transaction_ids: { raw: txId },
      page: "1",
      per_page: String(SEARCH_PER_PAGE),
    });
    const key = transactionKey(txId);
    for (const j of extractJournalList(res)) {
      const tid = typeof j.transaction_id === "string" ? j.transaction_id : null;
      if (tid === null || transactionKey(tid) === key) {
        const id = journalIdOf(j);
        if (id !== null) {
          return id;
        }
      }
    }
    return null;
  } catch (e) {
    if (e instanceof MfApiError) {
      return null;
    }
    throw e;
  }
}

/** 連携サービスの設定（`MF_CARD_ACCOUNT_IDS`・`MF_BANK_ACCOUNT_IDS`。カンマ区切り、MF が返した文字列そのまま）。 */
interface ConfiguredService {
  kind: ServiceKind;
  id: string;
}

function configuredServices(ports: AppPorts): ConfiguredService[] {
  const out: ConfiguredService[] = [];
  const seen = new Set<string>();
  const sources: [ServiceKind, string][] = [
    ["card", "MF_CARD_ACCOUNT_IDS"],
    ["bank", "MF_BANK_ACCOUNT_IDS"],
  ];
  for (const [kind, key] of sources) {
    const raw = ports.props.get(key);
    for (const part of raw === null ? [] : raw.split(",")) {
      const id = part.trim();
      const k = `${kind}:${transactionKey(id)}`;
      if (id !== "" && !seen.has(k)) {
        seen.add(k);
        out.push({ kind, id });
      }
    }
  }
  return out;
}

/**
 * `GET /transactions` を連携サービスごとに全ページ取得する（実装設計 §6.5）。`connected_account_id` は **`{ raw }`**
 * （1 回エンコードすると 400。S-M4）。期間は 366 日を超えるなら分割する。`unjournalizedExpense` のとき
 * `side=EXPENSE`・`journalizing_statuses=none` で絞る（そうでなければ全ステータス・全収支）。
 * `MF_SYNC_START_DATE` より前の明細は捨てる。ページ取得の前に絶対期限を確認し、過ぎていたら途中までの結果を返さず
 * {@link RunDeadlineExceededError} にする（一部だけを「全部」と読むと誤判定になるため）。
 */
function fetchTransactions(
  ctx: SyncCtx,
  services: readonly ConfiguredService[],
  from: string,
  to: string,
  opts: { unjournalizedExpense: boolean; startDate: string | null; useDeadline: boolean },
): MfTransaction[] {
  const byKey = new Map<string, MfTransaction>();
  for (const svc of services) {
    for (const range of splitDateRangeBySpan(from, to)) {
      for (let page = 1; page <= TX_MAX_PAGES; page++) {
        if (opts.useDeadline && ctx.deadline.isExpired()) {
          throw new RunDeadlineExceededError();
        }
        const query: Record<string, MfQueryValue> = {
          connected_account_id: { raw: svc.id },
          start_date: range.start,
          end_date: range.end,
          order: "desc",
          page: String(page),
          per_page: String(TX_PER_PAGE),
        };
        if (opts.unjournalizedExpense) {
          query.side = "EXPENSE";
          query.journalizing_statuses = "none";
        }
        const res = ctx.client.request("get", "/transactions", query);
        const items = parseTransactions(res, svc.kind);
        for (const t of items) {
          if (opts.startDate !== null && t.date < opts.startDate) {
            continue;
          }
          if (opts.unjournalizedExpense && (t.status !== "none" || t.side !== "EXPENSE")) {
            continue;
          }
          byKey.set(transactionKey(t.id), t);
        }
        const totalPages = totalPagesOf(res);
        if (totalPages !== null ? page >= totalPages : items.length < TX_PER_PAGE) {
          break;
        }
      }
    }
  }
  return [...byKey.values()];
}

/**
 * `JOURNALIZING` の回収（実装設計 §6.5）。`journalize` を送った後に落ちた・結果不明だった行を片づける。
 * 1. `GET /journals?transaction_ids=<{raw}>`（期間は作成時日付 ± 1）→ あれば `MF仕訳ID` を書いて `SYNCED`
 * 2. 無ければ `GET /transactions`（全ステータス）で明細を探す
 *    - 未仕訳（`none`）→ `journalize` をやり直す（1 つの明細から仕訳は 1 つしかできないので二重にならない）。
 *      ただし `rejected`（直前の `journalize` を MF が 400 等で拒否した）なら、作られていないことが確実なので
 *      `ERROR` にして通知する（同じ拒否を繰り返さない）
 *    - 仕訳済みなのに 1 で見つからない・明細が見つからない → `NEEDS_REVIEW`（人が MF で確認）
 * 連携サービスの設定が無い等で明細を確かめられないときは何もしない。
 */
function recoverJournalizing(ctx: SyncCtx, row: ExpenseLedgerRow, rejected: MfApiError | null): void {
  const { ports } = ctx;
  const isJournalizing = (cur: ExpenseLedgerRow): boolean => cur.mf_sync_state === "JOURNALIZING";
  const toReview = (reason: string): void => {
    const written = writeIfCurrent(ports, row.receipt_id, isJournalizing, {
      mf_sync_state: "NEEDS_REVIEW",
      mf_sync_error: truncate(reason),
    });
    if (written !== null) {
      postBestEffort(ports, `⚠️ ${row.receipt_id}: ${truncate(reason)}。MF で確認し、経費台帳の MF連携状態・MF明細ID・MF仕訳ID を直してください。`);
    }
  };
  const txId = row.mf_transaction_id;
  if (!hasValue(txId)) {
    toReview("JOURNALIZING ですが MF明細ID がありません");
    return;
  }

  const foundId = findJournalIdByTransaction(ctx, txId, journalizingDate(row));
  if (foundId !== null) {
    writeIfCurrent(
      ports,
      row.receipt_id,
      isJournalizing,
      { mf_journal_id: foundId, mf_sync_state: "SYNCED", mf_sync_error: null },
      { force: true },
    );
    return;
  }

  const services = configuredServices(ports).filter((s) => s.kind === serviceKindOf(row.payment_method));
  if (services.length === 0) {
    return; // 連携サービスの設定が無く、明細の状態を確かめられない。
  }
  const today = businessDateOf(ports.clock.nowMs());
  const base = row.date < journalizingDate(row) ? row.date : journalizingDate(row);
  let from = shiftDate(base, -FETCH_DAYS_BEFORE_ROW);
  if (ctx.startDate !== null && from < ctx.startDate) {
    from = ctx.startDate;
  }
  const key = transactionKey(txId);
  const tx = fetchTransactions(ctx, services, from, today, {
    unjournalizedExpense: false,
    startDate: null,
    useDeadline: true,
  }).find((t) => transactionKey(t.id) === key);

  if (tx === undefined) {
    toReview("連携明細が見つかりません（MF で削除・対象外にされた可能性があります）");
    return;
  }
  if (tx.status !== "none") {
    toReview(`連携明細は ${tx.status} ですが、kadobo の検索では仕訳が見つかりません`);
    return;
  }
  if (rejected !== null) {
    const message = errorText(rejected);
    const written = writeIfCurrent(ports, row.receipt_id, isJournalizing, {
      mf_sync_state: "ERROR",
      mf_sync_error: message,
    });
    if (written !== null) {
      postBestEffort(
        ports,
        `⚠️ ${row.receipt_id}: MF が明細からの仕訳の作成を拒否しました（${message}）。原因を直して、経費台帳の MF連携状態 を空に戻してください。`,
      );
    }
    return;
  }
  if (ctx.halted) {
    return; // この実行では結果不明の作成があったため、新たに送らない。
  }
  // 未仕訳のまま: journalize をやり直す。
  const accounts = resolveAccountIds(ctx, [debitAccountNameOf(row.category)]);
  const marked = writeIfCurrent(ports, row.receipt_id, isJournalizing, {
    mf_sync_attempted_at: ports.clock.nowMs(),
  });
  if (marked !== null) {
    sendJournalize(ctx, marked, accounts[debitAccountNameOf(row.category)] as string);
  }
}

/**
 * `POST /transactions/journalize` を送り、結果を書く（呼ぶ前に `JOURNALIZING`・`MF明細ID` を保存済みであること。B3）。
 * - 201 → `MF仕訳ID` を書いて `SYNCED`
 * - 応答が得られた 4xx（{@link MfApiError}）→ 明細の状態を確認してから決める（{@link recoverJournalizing}）
 * - 結果不明（{@link MfOutcomeUnknownError}）→ `JOURNALIZING` のまま、この実行ではこれ以上作らない（次回の回収へ）
 * - 429・認証・設定不備 → 状態を変えず上へ投げる（`JOURNALIZING` のまま次回の回収で送り直す。何も作られていない）
 */
function sendJournalize(ctx: SyncCtx, row: ExpenseLedgerRow, accountId: string): void {
  const { ports, client } = ctx;
  const body = buildJournalizeBody(row, row.mf_transaction_id as string, accountId);
  let res: unknown;
  try {
    res = client.request("post", "/transactions/journalize", {}, body, { create: true });
  } catch (e) {
    if (e instanceof MfOutcomeUnknownError) {
      console.error(`journalSync: journalize outcome unknown (${row.receipt_id}): ${errorText(e)}`);
      ctx.halted = true;
      return;
    }
    if (e instanceof MfApiError) {
      recoverJournalizing(ctx, row, e);
      return;
    }
    throw e;
  }
  const item = extractJournalItem(res);
  const id = item === null ? null : journalIdOf(item);
  if (id === null) {
    console.error(`journalSync: journalize 201 response without journal id (${row.receipt_id})`);
    return; // JOURNALIZING のまま。次回、明細 ID の検索で回収する。
  }
  writeIfCurrent(
    ports,
    row.receipt_id,
    () => true,
    { mf_journal_id: id, mf_sync_state: "SYNCED", mf_sync_error: null },
    { force: true },
  );
}

/** 取消された行に仕訳があるか（`SYNCED`、または `MF仕訳ID` が入っている「仕訳が無い状態」の行。§6.7）。 */
function cancelledRowHasJournal(row: ExpenseLedgerRow): boolean {
  return (
    isCancelledExpenseState(row.state) &&
    (row.mf_sync_state === "SYNCED" || (hasValue(row.mf_journal_id) && NO_JOURNAL_STATES.includes(row.mf_sync_state)))
  );
}

/** 手入力の取り込みの「存在しない」の理由文（行ごとに ID を含むので、ID が直れば別の文になる）。 */
function importNotFoundMessage(id: string): string {
  return `MF仕訳ID が見つかりません（${truncate(id, 80)} の仕訳が MF にありません）`;
}

/** 手入力の `MF仕訳ID` を取り込む対象か（実装設計 §6.3 手順 3 ＋ `UNKNOWN`）。MF を呼ぶ前に判定できる範囲。 */
function isImportCandidate(row: ExpenseLedgerRow): boolean {
  if (!IMPORTABLE_STATES.includes(row.mf_sync_state) || !hasValue(row.mf_journal_id)) {
    return false;
  }
  // kadobo が変更を検出して `NEEDS_REVIEW` にした行は、人が `MF連携状態` を空に戻すまで取り込み直さない
  // （取り込むと確認を待たずに `SYNCED` へ戻って変更検出が無意味になる）。
  if (row.mf_sync_state === "NEEDS_REVIEW" && hasInputChanged(row)) {
    return false;
  }
  // 既に「見つかりません」と記録済みの ID は、ID が直るまで毎回 GET しない（予算を食い続けないため）。
  if (row.mf_sync_error === importNotFoundMessage(row.mf_journal_id)) {
    return false;
  }
  return true;
}

/**
 * 維持作業の対象か（回収・削除／更新のやり直し・取消・取り込みのどれかが要る行）。連携明細から作った仕訳の取消は、
 * 訂正後の新しい行の登録を待つ間（{@link planLinkedCancellation} が `wait`）は対象にしない（予算を使わない）。
 */
function isMaintenanceCandidate(row: ExpenseLedgerRow, rows: readonly ExpenseLedgerRow[], startDate: string | null): boolean {
  if (
    row.mf_sync_state === "CREATING" ||
    row.mf_sync_state === "UNKNOWN" ||
    row.mf_sync_state === "REVERSING" ||
    row.mf_sync_state === "JOURNALIZING"
  ) {
    return true;
  }
  if (cancelledRowHasJournal(row)) {
    return serviceKindOf(row.payment_method) === null || planLinkedCancellation(row, rows, startDate).kind !== "wait";
  }
  return isImportCandidate(row);
}

function importRow(ctx: SyncCtx, row: ExpenseLedgerRow): void {
  const { ports, client } = ctx;
  const id = row.mf_journal_id as string;
  if (journalExists(client, id)) {
    writeIfCurrent(
      ports,
      row.receipt_id,
      (cur) => cur.mf_journal_id === id && IMPORTABLE_STATES.includes(cur.mf_sync_state),
      {
        mf_sync_state: "SYNCED",
        mf_sync_error: null,
        mf_sync_input: summarizeSyncInput(row),
      },
    );
    return;
  }
  // MF に無い ID が書かれている。人の確認を待つ（状態が `UNKNOWN` のときは変えず、理由だけ書く）。
  const message = importNotFoundMessage(id);
  const wasNeedsReview = row.mf_sync_state === "NEEDS_REVIEW";
  const patch: MfColumnsPatch =
    row.mf_sync_state === "UNKNOWN"
      ? { mf_sync_error: message }
      : { mf_sync_state: "NEEDS_REVIEW", mf_sync_error: message };
  const written = writeIfCurrent(
    ports,
    row.receipt_id,
    (cur) => cur.mf_journal_id === id && IMPORTABLE_STATES.includes(cur.mf_sync_state),
    patch,
  );
  if (written !== null && !wasNeedsReview) {
    postBestEffort(ports, `⚠️ ${row.receipt_id}: ${message}。MF仕訳ID を直してください。`);
  }
}

/**
 * 維持作業 1 行ぶん。行は 1 行 = 予算 1 行として数える（検索・削除・確認の複数回の呼び出しを含む）。
 * 回収した行がその取消なら同じ実行で削除まで進める（実装設計 §11.2 の「その間に取消 → 回収後に DELETE」）。
 */
function processMaintenanceRow(ctx: SyncCtx, receiptId: string): void {
  const { ports } = ctx;
  const read = (): ExpenseLedgerRow | null => ports.lock.withLock(() => ports.sheets.getExpenseByReceiptId(receiptId));
  let row = read();
  if (row === null) {
    return;
  }
  if (row.mf_sync_state === "CREATING" || row.mf_sync_state === "UNKNOWN") {
    recoverCreating(ctx, row);
    row = read();
    if (row === null) {
      return;
    }
  }
  if (row.mf_sync_state === "JOURNALIZING") {
    recoverJournalizing(ctx, row, null);
    row = read();
    if (row === null) {
      return;
    }
  }
  if (row.mf_sync_state === "REVERSING") {
    finishReversal(ctx, row);
    return;
  }
  if (cancelledRowHasJournal(row)) {
    if (serviceKindOf(row.payment_method) !== null) {
      const plan = planLinkedCancellation(row, snapshotRows(ports), ctx.startDate);
      if (plan.kind === "wait") {
        return; // 訂正後の新しい行の登録待ち。何もしない（予算は消費済みだが、次回以降は対象にならない）。
      }
    }
    const s = row.mf_sync_state;
    const marked = writeIfCurrent(
      ports,
      receiptId,
      (cur) => isCancelledExpenseState(cur.state) && cur.mf_sync_state === s,
      { mf_sync_state: "REVERSING", mf_sync_error: null },
    );
    if (marked !== null) {
      finishReversal(ctx, marked);
    }
    return;
  }
  if (isImportCandidate(row)) {
    importRow(ctx, row);
  }
}

/** 仕訳が無い状態の取消は `REVERSED` にするだけ（MF は呼ばない。実装設計 §6.7）。予算を使わない。 */
function reverseWithoutJournalStep(ctx: SyncCtx): void {
  const { ports } = ctx;
  for (const row of snapshotRows(ports)) {
    if (!isCancelledExpenseState(row.state) || hasValue(row.mf_journal_id) || !NO_JOURNAL_STATES.includes(row.mf_sync_state)) {
      continue;
    }
    const s = row.mf_sync_state;
    writeIfCurrent(
      ports,
      row.receipt_id,
      (cur) => isCancelledExpenseState(cur.state) && cur.mf_sync_state === s && !hasValue(cur.mf_journal_id),
      { mf_sync_state: "REVERSED", mf_sync_error: null },
    );
  }
}

/** 維持キュー: 対象行の証憑 ID を、保存した巡回位置の次から一巡する順に並べたもの。 */
interface MaintenanceQueue {
  ids: string[];
  pos: number;
  /** 最後に手を付けた行（巡回位置として保存する）。 */
  lastStarted: string | null;
}

function buildMaintenanceQueue(ports: AppPorts, startDate: string | null): MaintenanceQueue {
  const rows = snapshotRows(ports);
  const cursor = ports.lock.withLock(() => ports.sheets.getInternalValue(CURSOR_KIND, CURSOR_KEY));
  const cursorIdx = cursor === null || cursor === "" ? -1 : rows.findIndex((r) => r.receipt_id === cursor);
  const ordered = [...rows.slice(cursorIdx + 1), ...rows.slice(0, cursorIdx + 1)];
  return {
    ids: ordered.filter((r) => isMaintenanceCandidate(r, rows, startDate)).map((r) => r.receipt_id),
    pos: 0,
    lastStarted: null,
  };
}

/** 維持キューを予算の許す限り処理する。キューを最後まで処理し終えたら `true`。 */
function runMaintenanceQueue(ctx: SyncCtx, q: MaintenanceQueue): boolean {
  while (q.pos < q.ids.length) {
    if (!ctx.budget.tryStartRow("maintenance")) {
      return false;
    }
    const id = q.ids[q.pos]!;
    q.pos++;
    q.lastStarted = id;
    processMaintenanceRow(ctx, id);
  }
  return true;
}

/** 巡回位置の保存。最後まで回ったら空にして次回は先頭から。 */
function saveCursor(ports: AppPorts, q: MaintenanceQueue): void {
  const finished = q.pos >= q.ids.length;
  const value = finished ? "" : (q.lastStarted ?? "");
  ports.lock.withLock(() => {
    if ((ports.sheets.getInternalValue(CURSOR_KIND, CURSOR_KEY) ?? "") !== value) {
      ports.sheets.setInternalValue(CURSOR_KIND, CURSOR_KEY, value);
    }
  });
}

// ---------------------------------------------------------------------------
// 4. 変更検出
// ---------------------------------------------------------------------------

function detectChangeStep(ctx: SyncCtx): void {
  const { ports } = ctx;
  for (const row of snapshotRows(ports)) {
    if (row.mf_sync_state !== "SYNCED" || isCancelledExpenseState(row.state) || !hasInputChanged(row)) {
      continue;
    }
    const written = writeIfCurrent(
      ports,
      row.receipt_id,
      (cur) => cur.mf_sync_state === "SYNCED" && hasInputChanged(cur),
      {
        mf_sync_state: "NEEDS_REVIEW",
        mf_sync_error: truncate(`作成後に業務列が変更されました（作成時 ${row.mf_sync_input} → 現在 ${summarizeSyncInput(row)}）`),
      },
    );
    if (written !== null) {
      postBestEffort(
        ports,
        `⚠️ ${row.receipt_id}: 仕訳を作った後に金額・日付・カテゴリ・支払方法が変更されました。MF の仕訳は自動では直しません。` +
          "MF で直したうえで、経費台帳の MF連携状態 を空に戻してください。",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 5. 新規
// ---------------------------------------------------------------------------

/** 空・`PENDING` の行を §6.2 で判定し直して状態を進める（MF は呼ばない）。 */
function classifyStep(ctx: SyncCtx, startDate: string): void {
  const { ports } = ctx;
  for (const row of snapshotRows(ports)) {
    const s = row.mf_sync_state;
    if ((s !== "" && s !== "PENDING") || hasValue(row.mf_journal_id)) {
      continue; // `MF仕訳ID` がある行は手入力の取り込み（3）に任せる。kadobo は作らない（B7）。
    }
    const decision = decideSyncTarget(row, startDate);
    const next = initialStateFor(decision);
    if (next === null || next === s || !canTransition(s, next)) {
      continue;
    }
    const patch: MfColumnsPatch = {
      mf_sync_state: next,
      mf_sync_error: decision.kind === "needs_review" ? decision.reason : null,
    };
    const written = writeIfCurrent(
      ports,
      row.receipt_id,
      (cur) => cur.mf_sync_state === s && !hasValue(cur.mf_journal_id),
      patch,
    );
    if (written !== null && next === "NEEDS_REVIEW") {
      postBestEffort(
        ports,
        `⚠️ ${row.receipt_id}: ${patch.mf_sync_error ?? ""}。MF で仕訳して、経費台帳の MF仕訳ID に ID を書いてください。`,
      );
    }
  }
}

/**
 * ② 現金・立替の 1 行を作る（実装設計 §6.4）。冪等確認 → ロック内で `CREATING`・試行時刻・入力要約を
 * 書く → POST。応答が得られた 400 と 429 は「作られていない」ので作り直してよい。結果が分からないとき
 * （`MfOutcomeUnknownError`）は `CREATING` のまま次回の回収に任せる。
 */
function createCashJournal(ctx: SyncCtx, row: ExpenseLedgerRow): void {
  const { ports, client } = ctx;
  const accounts = resolveAccountIds(ctx, [debitAccountNameOf(row.category), CASH_CREDITOR_ACCOUNT_NAME]);

  // 1. 冪等確認: 既に tags に証憑 ID を持つ仕訳があれば、それを採用する。
  const found = findJournalsByTag(client, row.receipt_id, row.date, row.date, ctx.deadline);
  const foundId = found.length > 0 ? journalIdOf(found[0]!) : null;
  if (foundId !== null) {
    writeIfCurrent(
      ports,
      row.receipt_id,
      (cur) => cur.mf_sync_state === "PENDING",
      { mf_journal_id: foundId, mf_sync_state: "SYNCED", mf_sync_error: null, mf_sync_input: summarizeSyncInput(row) },
      { force: true },
    );
    return;
  }

  // 2. ロック内で CREATING・試行時刻・入力要約を書く（POST の前に保存する。状態を最後に書く）。
  // 再読込した行が、科目解決・タグ検索に使ったスナップショット（`row`）と同じ入力で、§6.2 の対象条件
  // （現金・100%・COMPLETED・開業日以降）をなお満たすときだけ進む。違えばこの実行では POST せず、状態も
  // 変えない（次回の実行が再評価する。レビュー B2）。本文・借方科目・入力要約は同じスナップショットから作る。
  const input = summarizeSyncInput(row);
  const marked = writeIfCurrent(
    ports,
    row.receipt_id,
    (cur) => {
      if (cur.mf_sync_state !== "PENDING" || cur.state !== "COMPLETED" || hasValue(cur.mf_journal_id)) {
        return false;
      }
      const d = decideSyncTarget(cur, ctx.startDate);
      return d.kind === "ready" && d.method === "cash" && summarizeSyncInput(cur) === input;
    },
    {
      mf_sync_state: "CREATING",
      mf_sync_attempted_at: ports.clock.nowMs(),
      mf_sync_input: input,
      mf_sync_error: null,
    },
  );
  if (marked === null) {
    return;
  }

  // 3. POST（ロックの外）。
  const body = buildJournalRequestBody(marked, {
    debit: accounts[debitAccountNameOf(row.category)]!,
    credit: accounts[CASH_CREDITOR_ACCOUNT_NAME]!,
  });
  let res: unknown;
  try {
    res = client.request("post", "/journals", {}, body, { create: true });
  } catch (e) {
    if (e instanceof MfOutcomeUnknownError) {
      // 作られたか分からない。CREATING のまま次回の回収（tags の検索）に任せる。
      console.error(`journalSync: create outcome unknown (${row.receipt_id}): ${errorText(e)}`);
      ctx.halted = true;
      return;
    }
    if (e instanceof MfApiError) {
      const message = errorText(e);
      const written = writeIfCurrent(ports, row.receipt_id, (cur) => cur.mf_sync_state === "CREATING", {
        mf_sync_state: "ERROR",
        mf_sync_error: message,
      });
      if (written !== null) {
        postBestEffort(
          ports,
          `⚠️ ${row.receipt_id}: MF が仕訳の作成を拒否しました（${message}）。原因を直して、経費台帳の MF連携状態 を空に戻してください。`,
        );
      }
      return;
    }
    // 429（MfTransientError）・認証・設定不備など、リクエストが受理されなかった失敗は PENDING に戻す。
    writeIfCurrent(ports, row.receipt_id, (cur) => cur.mf_sync_state === "CREATING", {
      mf_sync_state: "PENDING",
    });
    throw e;
  }

  // 4. 201 → MF仕訳ID を書いて SYNCED。id が取れなければ CREATING のまま回収に任せる。
  const item = extractJournalItem(res);
  const id = item === null ? null : journalIdOf(item);
  if (id === null) {
    console.error(`journalSync: 201 response without journal id (${row.receipt_id})`);
    return;
  }
  writeIfCurrent(
    ports,
    row.receipt_id,
    () => true,
    { mf_journal_id: id, mf_sync_state: "SYNCED", mf_sync_error: null },
    { force: true },
  );
}

function createStep(ctx: SyncCtx): void {
  const { ports } = ctx;
  const candidates = snapshotRows(ports).filter(
    (r) =>
      r.mf_sync_state === "PENDING" &&
      r.payment_method === "cash" &&
      r.state === "COMPLETED" &&
      !hasValue(r.mf_journal_id),
  );
  for (const row of candidates) {
    if (ctx.halted || !ctx.budget.tryStartRow("new")) {
      return;
    }
    createCashJournal(ctx, row);
  }
}

// ---------------------------------------------------------------------------
// 5'. ③ 連携明細との照合（実装設計 §6.5, §6.6）
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<ServiceKind, string> = { card: "カード", bank: "口座" };

/** 内部シート `mf_notice/<key>` が無ければ記録して `true`（1 回だけの通知の抑止）。 */
function claimOnceNotice(ports: AppPorts, key: string): boolean {
  return ports.lock.withLock(() => {
    if (ports.sheets.getInternalValue(NOTICE_KIND, key) !== null) {
      return false;
    }
    ports.sheets.setInternalValue(NOTICE_KIND, key, String(ports.clock.nowMs()));
    return true;
  });
}

/**
 * `MF明細ルール` シートを読む。読めない（シートが無い等）ときは、証憑を伴わない明細（NISA・カード引落し）を
 * 経費の候補に混ぜてしまうため、③ の新規をこの実行では止めて運用者に 1 日 1 回知らせる（`null`）。
 */
function loadRules(ctx: SyncCtx): MfTransactionRule[] | null {
  const { ports } = ctx;
  try {
    return ports.lock.withLock(() => ports.sheets.getMfTransactionRules());
  } catch (e) {
    console.error(`journalSync: MF明細ルール を読めません: ${errorText(e)}`);
    if (claimDailyNotice(ports, "mf_rules_sheet")) {
      dmOperatorBestEffort(
        ports,
        `⚠️ MF明細ルール シートを読めないため、連携明細の照合を止めました（${errorText(e)}）。setupSpreadsheet を実行してシートを作ってください。`,
      );
    }
    return null;
  }
}

function txLabel(tx: MfTransaction): string {
  return `${tx.date} ${numberText(tx.value)}円 ${tx.content === "" ? "(内容なし)" : tx.content}`;
}

/** 連携明細を取りに行く行（`日付 >= 開業日` で、まだ明細を待っている連携の行）。 */
function wantsTransaction(row: ExpenseLedgerRow, startDate: string, byId: ReadonlyMap<string, ExpenseLedgerRow>): boolean {
  return (
    serviceKindOf(row.payment_method) !== null &&
    row.state === "COMPLETED" &&
    !hasValue(row.mf_journal_id) &&
    row.date >= startDate &&
    ((row.mf_sync_state === "WAITING_TRANSACTION" && !holdsJournalAncestor(row, byId)) || row.mf_sync_state === "NEEDS_REVIEW")
  );
}

/** 人が `MF明細ID` を記入した `NEEDS_REVIEW` の行（検証して `JOURNALIZING` に進める対象。§6.5）。 */
function isHumanTransactionRow(row: ExpenseLedgerRow, startDate: string): boolean {
  if (
    row.mf_sync_state !== "NEEDS_REVIEW" ||
    !hasValue(row.mf_transaction_id) ||
    hasValue(row.mf_journal_id) ||
    serviceKindOf(row.payment_method) === null ||
    row.state !== "COMPLETED"
  ) {
    return false;
  }
  // kadobo が自分で押さえた明細 ID（回収で NEEDS_REVIEW にした行）は、人が書き直すまで検証し直さない
  // （検証すると「未仕訳の明細に見つかりません」で、回収時の理由を上書きしてしまう）。
  const claimed = inputTransactionId(row.mf_sync_input);
  if (claimed !== null && transactionKey(claimed) === transactionKey(row.mf_transaction_id)) {
    return false;
  }
  return decideSyncTarget(row, startDate).kind === "ready";
}

/**
 * 明細ルール（NISA・カード引落し。実装設計 §6.6）。取得した未仕訳の明細それぞれにルールを当て、当たった明細の
 * `transactionKey` の集合を返す（経費の照合の候補から外す）。
 * - `無視` → 外すだけ
 * - `私用として仕訳` → `POST /transactions/journalize`（`account_id` = ルールの勘定科目、`remark` = `私用: {ルール名}`、
 *   `tags` = `["kadobo-rule"]`、`transaction_date` は明細の日付）。応答が失われても、次回「未仕訳のまま」なら送り直すだけ
 *   （1 つの明細から仕訳は 1 つしかできない）
 *   - 同じ明細が経費台帳のどれかの行の候補にもなっているときは仕訳せず、Slack で知らせる（ルールの誤設定の安全策）
 *   - ルールの勘定科目が MF で 1 件に決まらないときは仕訳せず、1 日 1 回 DM する（週次報告にも出る）
 */
function applyRules(
  ctx: SyncCtx,
  txs: readonly MfTransaction[],
  rules: readonly MfTransactionRule[],
  rows: readonly ExpenseLedgerRow[],
  startDate: string,
): Set<string> {
  const { ports } = ctx;
  const hit = new Set<string>();
  const byId = indexLedgerRows(rows);
  const used = usedTransactionKeys(rows);
  const wanting = rows.filter((r) => wantsTransaction(r, startDate, byId));

  const todo: { tx: MfTransaction; rule: MfTransactionRule }[] = [];
  const sorted = [...txs].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
  for (const tx of sorted) {
    const key = transactionKey(tx.id);
    if (used.has(key)) {
      continue; // 人が経費の明細として指定した等、使用中の明細には触れない。
    }
    const cls = classifyTransaction(tx, rules, tx.service);
    if (cls === null) {
      continue;
    }
    hit.add(key);
    if (cls.rule.action === RULE_ACTION_IGNORE) {
      continue;
    }
    const conflicts = wanting.filter((r) => isCandidateFor(r, tx));
    if (conflicts.length > 0) {
      holdRuleConflict(ctx, cls.rule, tx, conflicts);
      continue;
    }
    todo.push({ tx, rule: cls.rule });
  }
  if (todo.length === 0) {
    return hit;
  }

  const accountNames = [...new Set(todo.map((t) => t.rule.account.trim()))];
  const accounts = loadAccountMap(ctx, accountNames);
  for (const { tx, rule } of todo) {
    const accountId = accounts[rule.account.trim()];
    if (accountId === undefined) {
      if (claimDailyNotice(ports, `rule_account/${rule.name}`)) {
        dmOperatorBestEffort(
          ports,
          `⚠️ 明細ルール「${rule.name}」の勘定科目「${rule.account}」が MF で名前完全一致の 1 件に決まらないため、私用の仕訳を作れません。ルールの勘定科目を直してください。`,
        );
      }
      continue;
    }
    if (ctx.halted || !ctx.budget.tryStartRow("new")) {
      break;
    }
    journalizeByRule(ctx, tx, rule, accountId);
  }
  return hit;
}

/** 私用ルールに当たったが経費の候補にもなる明細を保留する（仕訳しない。明細ごとに Slack で 1 回知らせる）。 */
function holdRuleConflict(ctx: SyncCtx, rule: MfTransactionRule, tx: MfTransaction, conflicts: readonly ExpenseLedgerRow[]): void {
  const { ports } = ctx;
  const ids = conflicts.map((r) => r.receipt_id);
  for (const r of conflicts) {
    if (r.mf_sync_state === "WAITING_TRANSACTION") {
      // 人が `MF明細ID` を記入して決められるよう、NEEDS_REVIEW にする。
      writeIfCurrent(ports, r.receipt_id, (cur) => cur.mf_sync_state === "WAITING_TRANSACTION" && !hasValue(cur.mf_journal_id), {
        mf_sync_state: "NEEDS_REVIEW",
        mf_sync_error: truncate(`明細ルール「${rule.name}」に当たる明細と金額・日付が同じです。経費の明細なら MF明細ID を記入してください`),
      });
    }
  }
  if (claimOnceNotice(ports, `rule_conflict/${transactionKey(tx.id)}`)) {
    postBestEffort(
      ports,
      `⚠️ 明細ルール「${rule.name}」に当たりましたが、経費 ${ids.join("、")} と金額・日付が合う明細です（${txLabel(tx)}）。` +
        "私用として仕訳せず保留します。どちらか確認してください。" +
        `経費の明細なら、該当行の MF明細ID に ${tx.id} を記入してください。私用なら、ルールの条件（内容・金額）を絞ってください。`,
    );
  }
}

/** 明細ルールによる私用の仕訳 1 件（予算を数えた後に呼ぶ）。 */
function journalizeByRule(ctx: SyncCtx, tx: MfTransaction, rule: MfTransactionRule, accountId: string): void {
  const { ports, client } = ctx;
  try {
    client.request("post", "/transactions/journalize", {}, buildRuleJournalizeBody(tx, rule.name, accountId), { create: true });
  } catch (e) {
    if (e instanceof MfOutcomeUnknownError) {
      // 作られたか分からない。次回「未仕訳のまま」なら送り直す（作られていれば一覧に出なくなる）。
      console.error(`journalSync: rule journalize outcome unknown (${errorText(e)})`);
      ctx.halted = true;
      return;
    }
    if (e instanceof MfApiError) {
      console.error(`journalSync: rule journalize rejected (${errorText(e)})`);
      if (claimOnceNotice(ports, `rule_error/${transactionKey(tx.id)}`)) {
        postBestEffort(
          ports,
          `⚠️ 明細ルール「${rule.name}」の私用の仕訳を MF が拒否しました（${errorText(e)}）。明細: ${txLabel(tx)}。MF で確認してください。`,
        );
      }
      return;
    }
    throw e;
  }
}

/**
 * 連携明細 `tx` から仕訳を作る（実装設計 §6.5 B3）。ロック内で `MF明細ID`・`JOURNALIZING`・試行時刻・入力要約を
 * **先に**書き（明細が他の行に使われていないこと・入力が変わっていないことをその場で確かめる）、ロックの外で
 * `journalize` を送る。書けなければ（行が変わった・明細が他の行に取られた）何もしない。
 */
function startJournalize(ctx: SyncCtx, row: ExpenseLedgerRow, tx: MfTransaction): void {
  const { ports } = ctx;
  const debitName = debitAccountNameOf(row.category);
  const accounts = resolveAccountIds(ctx, [debitName]);
  const fromState = row.mf_sync_state;
  const input = summarizeSyncInput({ ...row, mf_transaction_id: tx.id });
  const txKey = transactionKey(tx.id);
  const marked = ports.lock.withLock((): ExpenseLedgerRow | null => {
    const all = ports.sheets.getAllExpenses();
    const cur = all.find((r) => r.receipt_id === row.receipt_id);
    if (
      cur === undefined ||
      cur.mf_sync_state !== fromState ||
      cur.state !== "COMPLETED" ||
      hasValue(cur.mf_journal_id) ||
      !canTransition(cur.mf_sync_state, "JOURNALIZING")
    ) {
      return null;
    }
    const d = decideSyncTarget(cur, ctx.startDate);
    if (d.kind !== "ready" || d.method !== row.payment_method) {
      return null;
    }
    if (hasValue(cur.mf_transaction_id) && transactionKey(cur.mf_transaction_id) !== txKey) {
      return null;
    }
    if (summarizeSyncInput({ ...cur, mf_transaction_id: tx.id }) !== input) {
      return null;
    }
    if (usedTransactionKeys(all, cur.receipt_id).has(txKey)) {
      return null;
    }
    const patch = {
      mf_transaction_id: tx.id,
      mf_sync_state: "JOURNALIZING" as const,
      mf_sync_attempted_at: ports.clock.nowMs(),
      mf_sync_input: input,
      mf_sync_error: null,
      mf_sync_updated_at: ports.clock.nowMs(),
    };
    ports.sheets.updateExpenseColumns(row.receipt_id, patch, MF_WRITE_ORDER);
    return { ...cur, ...patch };
  });
  if (marked === null) {
    return;
  }
  sendJournalize(ctx, marked, accounts[debitName] as string);
}

function candidateLines(candidates: readonly MfTransaction[]): string {
  const shown = candidates.slice(0, REPORT_LIST_MAX).map((t) => `・${t.id} ${txLabel(t)}`);
  return [...shown, ...(candidates.length > REPORT_LIST_MAX ? [`・ほか ${candidates.length - REPORT_LIST_MAX} 件`] : [])].join("\n");
}

/** 人が記入した `MF明細ID` を確かめて、通れば `JOURNALIZING` から `journalize` へ進める（実装設計 §6.5）。 */
function humanTransactionStep(
  ctx: SyncCtx,
  rows: readonly ExpenseLedgerRow[],
  txs: readonly MfTransaction[],
  startDate: string,
): void {
  const { ports } = ctx;
  for (const row of rows) {
    if (!isHumanTransactionRow(row, startDate)) {
      continue;
    }
    const txId = row.mf_transaction_id as string;
    const key = transactionKey(txId);
    const kind = serviceKindOf(row.payment_method) as ServiceKind;
    const tx = txs.find((t) => transactionKey(t.id) === key && t.service === kind);
    let problem: string | null = null;
    if (tx === undefined) {
      problem = `MF明細ID が、${KIND_LABEL[kind]}の連携サービスの未仕訳の明細に見つかりません`;
    } else if (tx.value !== row.amount) {
      problem = `金額が一致しません（明細 ${numberText(tx.value)} 円 ／ 経費 ${numberText(row.amount)} 円）`;
    } else if (usedTransactionKeys(rows, row.receipt_id).has(key)) {
      problem = "他の行が使用中の明細です";
    }
    if (problem !== null) {
      if (row.mf_sync_error !== problem) {
        const message = problem;
        const written = writeIfCurrent(
          ports,
          row.receipt_id,
          (cur) => cur.mf_sync_state === "NEEDS_REVIEW" && cur.mf_transaction_id === row.mf_transaction_id,
          { mf_sync_error: message },
        );
        if (written !== null) {
          postBestEffort(ports, `⚠️ ${row.receipt_id}: 記入された MF明細ID を使えません（${message}）。MF明細ID を直してください。`);
        }
      }
      continue;
    }
    if (tx === undefined) {
      continue;
    }
    if (ctx.halted || !ctx.budget.tryStartRow("new")) {
      return;
    }
    startJournalize(ctx, row, tx);
  }
}

/** `照合` の結果を行に反映する（一対一は `journalize`、候補が複数・取り合いは `NEEDS_REVIEW`、候補 0 件は 14 日後に 1 回通知）。 */
function matchOutcomesStep(
  ctx: SyncCtx,
  rows: readonly ExpenseLedgerRow[],
  txs: readonly MfTransaction[],
  services: readonly ConfiguredService[],
): void {
  const { ports } = ctx;
  const byId = new Map(rows.map((r) => [r.receipt_id, r]));
  const today = businessDateOf(ports.clock.nowMs());
  for (const o of matchTransactions(rows, txs)) {
    const row = byId.get(o.receipt_id);
    if (row === undefined) {
      continue;
    }
    if (o.kind === "matched") {
      if (ctx.halted || !ctx.budget.tryStartRow("new")) {
        continue;
      }
      startJournalize(ctx, row, o.transaction);
    } else if (o.kind === "review") {
      const n = o.candidates.length;
      const reason = o.reason === "contested" ? "（他の経費の行と同じ明細を取り合っています）" : "";
      const written = writeIfCurrent(
        ports,
        row.receipt_id,
        (cur) => cur.mf_sync_state === "WAITING_TRANSACTION" && !hasValue(cur.mf_journal_id),
        { mf_sync_state: "NEEDS_REVIEW", mf_sync_error: `候補 ${n} 件${reason}` },
      );
      if (written !== null) {
        postBestEffort(
          ports,
          `⚠️ ${row.receipt_id}（${row.date} ${numberText(row.amount)}円 ${row.partner}）: 連携明細の候補が ${n} 件あり、自動では決められません${reason}。\n` +
            `${candidateLines(o.candidates)}\n正しい明細 ID を経費台帳の MF明細ID 列に書いてください。`,
        );
      }
    } else if (isNoCandidateNoticeDue(row.date, today) && claimOnceNotice(ports, `nocand/${row.receipt_id}`)) {
      const kind = serviceKindOf(row.payment_method) as ServiceKind;
      const unset = services.some((s) => s.kind === kind) ? "" : `（${kind === "card" ? "MF_CARD_ACCOUNT_IDS" : "MF_BANK_ACCOUNT_IDS"} が未設定です）`;
      postBestEffort(
        ports,
        `⚠️ ${row.receipt_id}（${row.date} ${numberText(row.amount)}円 ${row.partner}）: 日付から ${NO_CANDIDATE_NOTICE_DAYS} 日たっても、一致する連携明細が見つかりません${unset}。` +
          "支払方法の誤り・金額違い・外貨換算の可能性があります。",
      );
    }
  }
}

/**
 * ③ 連携カード・口座の明細との照合（`MF_MATCH_ENABLED` が有効で、`MF_CARD_ACCOUNT_IDS`／`MF_BANK_ACCOUNT_IDS` の
 * どちらかがあるときだけ）。順番: 明細の取得 → 明細ルールの適用（経費の照合より前）→ 人が記入した `MF明細ID` の検証 →
 * 照合（一対一だけ確定）。実装設計 §6.5・§6.6。
 *
 * 取得期間は「待ち行（と人が明細 ID を書いた行）の日付の最小値 − 3 日」と「今日 − {@link MF_RULE_LOOKBACK_DAYS} 日」の
 * 古い方から今日まで（ただし開業日より前には遡らない）。明細ルールは待ち行が無くても適用するため。
 */
function matchStep(ctx: SyncCtx, startDate: string): void {
  const { ports } = ctx;
  if (!isMatchEnabled(ports.props)) {
    return;
  }
  const services = configuredServices(ports);
  if (services.length === 0) {
    return;
  }
  const rules = loadRules(ctx);
  if (rules === null) {
    return;
  }

  const rows0 = snapshotRows(ports);
  const byId0 = indexLedgerRows(rows0);
  const dates = rows0
    .filter((r) => isWaitingForTransaction(r, byId0) || isHumanTransactionRow(r, startDate))
    .map((r) => r.date);
  const today = businessDateOf(ports.clock.nowMs());
  let from = shiftDate(today, -MF_RULE_LOOKBACK_DAYS);
  if (dates.length > 0) {
    const earliest = shiftDate(dates.reduce((a, b) => (a < b ? a : b)), -FETCH_DAYS_BEFORE_ROW);
    if (earliest < from) {
      from = earliest;
    }
  }
  if (from < startDate) {
    from = startDate;
  }

  let txs: MfTransaction[];
  try {
    txs = fetchTransactions(ctx, services, from, today, { unjournalizedExpense: true, startDate, useDeadline: true });
  } catch (e) {
    if (e instanceof MfApiError) {
      // 連携サービス ID の設定誤りなど。毎時の失敗にならないよう 1 日 1 回 DM して、この実行の ③ を止める。
      console.error(`journalSync: GET /transactions rejected (${errorText(e)})`);
      if (claimDailyNotice(ports, "journal_txfetch")) {
        dmOperatorBestEffort(
          ports,
          `⚠️ 連携明細の取得を MF が拒否しました（${errorText(e)}）。MF_CARD_ACCOUNT_IDS・MF_BANK_ACCOUNT_IDS の値（runbook 04 §I）を確認してください。`,
        );
      }
      return;
    }
    throw e;
  }

  // 1. 明細ルール（経費の照合より前）。
  const ruled = applyRules(ctx, txs, rules, rows0, startDate);

  // 2. 人が記入した MF明細ID の検証（ルールの保留で行の状態が変わるため、読み直す）。
  const rows1 = snapshotRows(ports);
  humanTransactionStep(ctx, rows1, txs, startDate);

  // 3. 照合（ルールに当たった明細は候補にしない）。
  const rows2 = snapshotRows(ports);
  matchOutcomesStep(
    ctx,
    rows2,
    txs.filter((t) => !ruled.has(transactionKey(t.id))),
    services,
  );
}

/**
 * 新規: 空・`PENDING` の判定（② と ③ のどちらかが有効なとき）→ ② 現金・立替の作成（`MF_JOURNAL_ENABLED`）→
 * ③ 連携明細との照合（`MF_MATCH_ENABLED`）。
 */
function newStep(ctx: SyncCtx, startDate: string): void {
  classifyStep(ctx, startDate);
  if (isJournalEnabled(ctx.ports.props)) {
    createStep(ctx);
  }
  matchStep(ctx, startDate);
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

function runSync(ports: AppPorts, deadline: RunDeadline): void {
  const startDateRaw = ports.props.get("MF_SYNC_START_DATE");
  const startDate = startDateRaw === null || startDateRaw === "" ? null : startDateRaw;
  const ctx: SyncCtx = {
    ports,
    client: makeMfAccountingClient(ports),
    budget: new RunBudget(deadline),
    deadline,
    startDate,
    halted: false,
    accountsFetched: false,
  };
  let queue: MaintenanceQueue | null = null;
  try {
    // 仕訳が無い状態の取消は MF を呼ばずに `REVERSED` にする（予算を使わない）。
    reverseWithoutJournalStep(ctx);
    // 維持作業（回収・取消・取り込み）: 最初は 10 行まで。残りの予算は新規に残す。
    queue = buildMaintenanceQueue(ports, startDate);
    runMaintenanceQueue(ctx, queue);
    detectChangeStep(ctx);
    // 新規作成は ② が `MF_JOURNAL_ENABLED`、③ が `MF_MATCH_ENABLED` を要る（§9）。`MF_SYNC_START_DATE` 未設定なら同期しない。
    if ((isJournalEnabled(ports.props) || isMatchEnabled(ports.props)) && startDate !== null) {
      newStep(ctx, startDate);
    }
    // 新規が予算を余らせたら、維持作業の続きに回す（レビュー M3）。
    ctx.budget.openMaintenance();
    runMaintenanceQueue(ctx, queue);
  } catch (e) {
    if (e instanceof RunDeadlineExceededError) {
      // 期限切れで検索を打ち切った。状態は変えず、次回のトリガーが続きを処理する。
      return;
    }
    if (e instanceof ConfigMissingError) {
      // 設定不備は時間では直らない。通知して止める（毎時の通知を避けるため 1 日 1 回）。
      console.error(`journalSync: config missing (${e.propertyKey})`);
      if (claimDailyNotice(ports, `journal_config/${e.propertyKey}`)) {
        dmOperatorBestEffort(ports, `⚠️ 経費の仕訳連携を止めました（${e.propertyKey}）。${e.message}`);
      }
      return;
    }
    throw e;
  } finally {
    // 例外で終わった場合も、最後に手を付けた行までを巡回位置として保存する（同じ行が毎回先頭を塞がないため）。
    if (queue !== null) {
      saveCursor(ports, queue);
    }
  }
}

/**
 * 経費同期（実装設計 §6.3「1 回の実行で処理する順番」）。`trigMfSync`/`trigMfSyncSoon` の ⑤ から呼ぶ。
 * `MF_ENABLED` が無効なら何もしない（HTTP 0 件）。lease `mf_sync`（10 分）を取れなければ何もしない
 * （別の実行が処理中。§6.8）。MF の例外（`MfTransientError` 等）は呼び出し元（トリガー）へ伝播させ、
 * `notifyMfFailure(ports, "journal", err)` に任せる。
 *
 * `deadline` は `trigMfSync` の開始時刻を基準にした絶対期限（省略時はこの呼び出しの開始時刻から 4 分）。
 */
export function syncExpenses(ports: AppPorts, deadline: RunDeadline = new RunDeadline(ports.clock)): void {
  if (!isMfEnabled(ports.props)) {
    return;
  }
  withLease(ports, MF_SYNC_LEASE_KEY, LEASE_TTL_MS, () => runSync(ports, deadline));
}

// ---------------------------------------------------------------------------
// 週次の報告（仕訳部分。実装設計 §6.6）
// ---------------------------------------------------------------------------

const REPORT_LIST_MAX = 10;

/** 週次報告用の最小の同期コンテキスト（予算・期限は使わない）。 */
function weeklyCtx(ports: AppPorts, startDate: string | null): SyncCtx {
  const deadline = new RunDeadline(ports.clock);
  return {
    ports,
    client: makeMfAccountingClient(ports),
    budget: new RunBudget(deadline),
    deadline,
    startDate,
    halted: false,
    accountsFetched: false,
  };
}

/** 私用として処理した仕訳（`tags` に `kadobo-rule`）を、摘要（`私用: {ルール名}`）ごとに数える。 */
function summarizeRuleJournals(journals: readonly Record<string, unknown>[]): { remark: string; count: number; total: number; latest: string }[] {
  const byRemark = new Map<string, { remark: string; count: number; total: number; latest: string }>();
  for (const j of journals) {
    if (!journalHasTag(j, RULE_TAG)) {
      continue;
    }
    const single = singleBranchOf(j);
    const b = Array.isArray(j.branches) ? (j.branches[0] as Record<string, unknown> | undefined) : undefined;
    const remark = typeof b?.remark === "string" && b.remark !== "" ? b.remark : "(摘要なし)";
    const entry = byRemark.get(remark) ?? { remark, count: 0, total: 0, latest: "" };
    entry.count++;
    entry.total += single === null ? 0 : single.debitValue;
    const date = typeof j.transaction_date === "string" ? j.transaction_date : "";
    if (date > entry.latest) {
      entry.latest = date;
    }
    byRemark.set(remark, entry);
  }
  return [...byRemark.values()].sort((a, b) => (a.remark < b.remark ? -1 : a.remark > b.remark ? 1 : 0));
}

/**
 * 週次報告の仕訳部分（実装設計 §6.6）。`trigWeeklyOrphanCheck` の末尾から呼ぶ。
 * - 二重作成の疑い: `MF_SYNC_START_DATE` 以降の仕訳（暦年ごと・366 日以内に分割して取得）で、同じ証憑 ID の
 *   タグを持つものが 2 件以上
 * - 人の判断待ち: `NEEDS_REVIEW`・`UNKNOWN` の行の件数
 * - （`MF_MATCH_ENABLED` が有効なとき）③ の報告:
 *   - 未登録の支出: 未仕訳・`EXPENSE`・`date >= MF_SYNC_START_DATE`・7 日以上前・使用中でない・明細ルールに当たらない明細
 *   - 私用として処理した明細: ルールごとの件数・合計・最新の日付
 *   - 無効なルール: 不備（内容が空など）・私用の勘定科目が MF で引けない行（`有効` が FALSE の行は意図して止めているので出さない）
 * 報告することが無ければ投稿しない。`MF_ENABLED` が無効なら何もしない。
 */
export function weeklyJournalReport(ports: AppPorts): void {
  if (!isMfEnabled(ports.props)) {
    return;
  }
  const rows = snapshotRows(ports);
  const receiptIds = new Set(rows.map((r) => r.receipt_id));

  const duplicates: ReturnType<typeof findDuplicateReceiptTags> = [];
  let ruleJournals: ReturnType<typeof summarizeRuleJournals> = [];
  const startDateRaw = ports.props.get("MF_SYNC_START_DATE");
  const startDate = startDateRaw !== null && startDateRaw !== "" ? startDateRaw : null;
  const ctx = weeklyCtx(ports, startDate);
  if (startDate !== null) {
    const client = ctx.client;
    const today = businessDateOf(ports.clock.nowMs());
    const journals: Record<string, unknown>[] = [];
    for (const range of splitRangeByCalendarYear(startDate, today)) {
      for (let page = 1; page <= SEARCH_MAX_PAGES; page++) {
        const res = client.request("get", "/journals", {
          start_date: range.start,
          end_date: range.end,
          page: String(page),
          per_page: String(SEARCH_PER_PAGE),
        });
        const list = extractJournalList(res);
        journals.push(...list);
        const totalPages = totalPagesOf(res);
        if (totalPages !== null ? page >= totalPages : list.length < SEARCH_PER_PAGE) {
          break;
        }
      }
    }
    duplicates.push(...findDuplicateReceiptTags(journals, receiptIds));
    ruleJournals = summarizeRuleJournals(journals);
  }

  const needsReview = rows.filter((r) => r.mf_sync_state === "NEEDS_REVIEW").map((r) => r.receipt_id);
  const unknown = rows.filter((r) => r.mf_sync_state === "UNKNOWN").map((r) => r.receipt_id);

  const sections: string[] = [];
  if (duplicates.length > 0) {
    sections.push(
      `⚠️ MF の仕訳の二重作成の疑い（${duplicates.length} 件）\n` +
        duplicates
          .slice(0, REPORT_LIST_MAX)
          .map((d) => `・${d.receiptId}: 同じ証憑 ID のタグの仕訳が ${d.journalIds.length} 件。MF で不要な方を削除してください`)
          .join("\n"),
    );
  }
  if (needsReview.length > 0 || unknown.length > 0) {
    const ids = [...needsReview, ...unknown].slice(0, REPORT_LIST_MAX).join("、");
    sections.push(
      `⚠️ MF 連携で人の判断待ち: NEEDS_REVIEW ${needsReview.length} 件 ／ UNKNOWN ${unknown.length} 件\n` +
        `・${ids}${needsReview.length + unknown.length > REPORT_LIST_MAX ? " ほか" : ""}（経費台帳の MF連携状態・MF連携エラーを確認してください）`,
    );
  }
  if (startDate !== null && isMatchEnabled(ports.props)) {
    sections.push(...weeklyMatchSections(ctx, rows, startDate, ruleJournals));
  }
  if (sections.length === 0) {
    return;
  }
  postBestEffort(ports, [`📋 MF 仕訳 週次報告（${businessDateOf(ports.clock.nowMs())}）`, ...sections].join("\n\n"));
}

/** ③ の週次報告の節（未登録の支出・私用として処理した明細・無効なルール）。 */
function weeklyMatchSections(
  ctx: SyncCtx,
  rows: readonly ExpenseLedgerRow[],
  startDate: string,
  ruleJournals: ReturnType<typeof summarizeRuleJournals>,
): string[] {
  const { ports } = ctx;
  const sections: string[] = [];
  let rules: MfTransactionRule[] | null = null;
  try {
    rules = ports.lock.withLock(() => ports.sheets.getMfTransactionRules());
  } catch (e) {
    sections.push(`⚠️ MF明細ルール シートを読めないため、未登録の支出の報告と無効なルールの確認を省略しました（${errorText(e)}）。`);
  }

  // 未登録の支出（ルールに当たらない明細だけ）。
  const services = configuredServices(ports);
  if (rules !== null && services.length > 0) {
    const today = businessDateOf(ports.clock.nowMs());
    const until = shiftDate(today, -UNREGISTERED_AFTER_DAYS);
    try {
      const used = usedTransactionKeys(rows);
      const list = fetchTransactions(ctx, services, startDate, until, {
        unjournalizedExpense: true,
        startDate,
        useDeadline: false,
      })
        .filter((t) => t.date <= until && !used.has(transactionKey(t.id)) && classifyTransaction(t, rules, t.service) === null)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1));
      if (list.length > 0) {
        sections.push(
          `⚠️ 未登録の支出（${UNREGISTERED_AFTER_DAYS} 日以上前の未仕訳・${list.length} 件）\n` +
            list
              .slice(0, REPORT_LIST_MAX)
              .map((t) => `・${txLabel(t)}（${KIND_LABEL[t.service]}）`)
              .join("\n") +
            (list.length > REPORT_LIST_MAX ? `\n・ほか ${list.length - REPORT_LIST_MAX} 件` : "") +
            "\n/keihi で証憑を登録するか、私用なら MF で 事業主貸 として仕訳してください。",
        );
      }
    } catch (e) {
      if (!(e instanceof MfApiError)) {
        throw e;
      }
      sections.push(
        `⚠️ 連携明細の取得を MF が拒否したため、未登録の支出を確認できません（${errorText(e)}）。MF_CARD_ACCOUNT_IDS・MF_BANK_ACCOUNT_IDS を確認してください。`,
      );
    }
  }

  // 私用として処理した明細（ルールごと）。
  if (ruleJournals.length > 0) {
    sections.push(
      "📋 私用として処理した明細\n" +
        ruleJournals
          .slice(0, REPORT_LIST_MAX)
          .map((r) => `・${r.remark}: ${r.count} 件（合計 ${numberText(r.total)} 円、最新 ${r.latest === "" ? "不明" : r.latest}）`)
          .join("\n"),
    );
  }

  // 無効なルール。
  if (rules !== null) {
    const lines: string[] = [];
    rules.forEach((rule, i) => {
      // `有効` が FALSE の行は意図して止めているので報告しない（不備だけを出す）。
      const defects = ruleDefects(rule);
      if (defects.length > 0) {
        lines.push(`・${i + 2} 行目「${rule.name === "" ? "(名前なし)" : rule.name}」: ${defects.join("、")}`);
      }
    });
    const privateRules = rules.filter((r) => isRuleUsable(r) && r.action === RULE_ACTION_PRIVATE);
    if (privateRules.length > 0) {
      const accounts = loadAccountMap(ctx, [...new Set(privateRules.map((r) => r.account.trim()))]);
      for (const rule of privateRules) {
        if (accounts[rule.account.trim()] === undefined) {
          lines.push(`・「${rule.name}」: 勘定科目「${rule.account}」が MF で名前完全一致の 1 件に決まりません`);
        }
      }
    }
    if (lines.length > 0) {
      sections.push(`⚠️ 無効な明細ルール（${lines.length} 件）\n${lines.slice(0, REPORT_LIST_MAX).join("\n")}`);
    }
  }
  return sections;
}
