/**
 * 経費の仕訳連携（実装設計 MF連携 §6.1〜§6.4, §6.7, §6.8）。WP-M4 の範囲は ② 現金・立替
 * （`POST /journals`）と、取消（`DELETE /journals/{id}`）・手入力の取り込み・変更検出。
 * ③ 連携明細との照合（`linked_card`/`linked_bank`。§6.5）は WP-M5 で、ここでは
 * `WAITING_TRANSACTION` にするところまでしか行わない（`JOURNALIZING` の行は触らない）。
 *
 * {@link syncExpenses} は §6.3「1 回の実行で処理する順番」どおりに進む:
 * 1. 回収（`CREATING`・`UNKNOWN` は `tags` の検索、`REVERSING` は `DELETE` のやり直し）
 * 2. 取消（`CORRECTED`/`VOID` → §6.7）
 * 3. 手入力の取り込み（B7）
 * 4. 変更検出
 * 5. 新規（`MF_JOURNAL_ENABLED` が有効なときだけ）
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
 * そのまま入れる。パスに置くときは `pathWithId`（`accountingClient.ts`）に集約する（実機の S-M5 で、
 * そのまま置くと 400 になったため。方式は同関数の JSDoc 参照）。
 *
 * **フラグ（§9）**: 全体は `MF_ENABLED`。新規作成（5）だけ `MF_JOURNAL_ENABLED` も要る。回収・取消・
 * 取り込み・変更検出は `MF_ENABLED` だけで動く（作りかけを放置しないため）。
 */
import { businessDateOf } from "@kadobo/shared/time";
import {
  CASH_CREDITOR_ACCOUNT_NAME,
  IMPORTABLE_STATES,
  JOURNAL_ACCOUNT_NAMES,
  NO_JOURNAL_STATES,
  buildJournalRequestBody,
  canTransition,
  creationDateFromInput,
  debitAccountNameOf,
  decideSyncTarget,
  extractJournalItem,
  extractJournalList,
  findDuplicateReceiptTags,
  hasInputChanged,
  initialStateFor,
  isCancelledExpenseState,
  journalHasTag,
  journalIdOf,
  splitRangeByCalendarYear,
  summarizeSyncInput,
  totalPagesOf,
} from "../core/journalSync";
import { makeMfAccountingClient, pathWithId, type MfAccountingClient } from "./mf/accountingClient";
import { MF_RUN_DEADLINE_MS, RunDeadline, RunDeadlineExceededError } from "./mf/deadline";
import { MfApiError, MfOutcomeUnknownError, isMfNotFound } from "./mf/errors";
import { isJournalEnabled, isMfEnabled } from "./mf/flags";
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
 * 科目名 → ID。`GET /accounts?available=true` の結果を `TtlCachePort` に 6 時間置く（§6.4）。
 * `names` のどれかが（名前完全一致・有効な科目として）1 件に決まらなければ {@link ConfigMissingError}
 * （勝手に別科目へ寄せない）。
 */
function resolveAccountIds(ctx: SyncCtx, names: readonly string[]): Record<string, string> {
  const { ports, client } = ctx;
  const cachedRaw = ports.ttlCache.get(MF_ACCOUNTS_CACHE_KEY);
  if (cachedRaw !== null) {
    try {
      const cached = JSON.parse(cachedRaw) as Record<string, string>;
      if (names.every((n) => typeof cached[n] === "string" && cached[n] !== "")) {
        return cached;
      }
    } catch {
      // 壊れたキャッシュは捨てて取り直す。
    }
  }
  const res = client.request("get", "/accounts", { available: "true" });
  const map: Record<string, string> = {};
  for (const l of lookupAccountsByName(res, JOURNAL_ACCOUNT_NAMES)) {
    if (l.status === "one" && l.matches[0] !== undefined) {
      map[l.name] = l.matches[0].id;
    }
  }
  ports.ttlCache.put(MF_ACCOUNTS_CACHE_KEY, JSON.stringify(map), ACCOUNTS_CACHE_TTL_SEC);
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

/** 取消に伴う仕訳の削除を行い、`REVERSED` にして 1 行通知する（`REVERSING` から呼ぶ。実装設計 §6.7）。 */
function finishReversal(ctx: SyncCtx, row: ExpenseLedgerRow): void {
  const { ports, client } = ctx;
  const id = row.mf_journal_id;
  if (!hasValue(id)) {
    writeIfCurrent(ports, row.receipt_id, (cur) => cur.mf_sync_state === "REVERSING", {
      mf_sync_state: "ERROR",
      mf_sync_error: "取消中ですが MF仕訳ID がありません",
    });
    return;
  }
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

/** 維持作業の対象か（回収・削除のやり直し・取消・取り込みのどれかが要る行）。 */
function isMaintenanceCandidate(row: ExpenseLedgerRow): boolean {
  return (
    row.mf_sync_state === "CREATING" ||
    row.mf_sync_state === "UNKNOWN" ||
    row.mf_sync_state === "REVERSING" ||
    cancelledRowHasJournal(row) ||
    isImportCandidate(row)
  );
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
  if (row.mf_sync_state === "REVERSING") {
    finishReversal(ctx, row);
    return;
  }
  if (cancelledRowHasJournal(row)) {
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

function buildMaintenanceQueue(ports: AppPorts): MaintenanceQueue {
  const rows = snapshotRows(ports);
  const cursor = ports.lock.withLock(() => ports.sheets.getInternalValue(CURSOR_KIND, CURSOR_KEY));
  const cursorIdx = cursor === null || cursor === "" ? -1 : rows.findIndex((r) => r.receipt_id === cursor);
  const ordered = [...rows.slice(cursorIdx + 1), ...rows.slice(0, cursorIdx + 1)];
  return { ids: ordered.filter(isMaintenanceCandidate).map((r) => r.receipt_id), pos: 0, lastStarted: null };
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

function newStep(ctx: SyncCtx, startDate: string): void {
  classifyStep(ctx, startDate);
  createStep(ctx);
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
  };
  let queue: MaintenanceQueue | null = null;
  try {
    // 仕訳が無い状態の取消は MF を呼ばずに `REVERSED` にする（予算を使わない）。
    reverseWithoutJournalStep(ctx);
    // 維持作業（回収・取消・取り込み）: 最初は 10 行まで。残りの予算は新規に残す。
    queue = buildMaintenanceQueue(ports);
    runMaintenanceQueue(ctx, queue);
    detectChangeStep(ctx);
    // 新規作成だけ `MF_JOURNAL_ENABLED` が要る（§9）。`MF_SYNC_START_DATE` 未設定なら同期しない（§9）。
    if (isJournalEnabled(ports.props) && startDate !== null) {
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

/**
 * 週次報告の仕訳部分（実装設計 §6.6）。`trigWeeklyOrphanCheck` の末尾から呼ぶ。
 * - 二重作成の疑い: `MF_SYNC_START_DATE` 以降の仕訳（暦年ごと・366 日以内に分割して取得）で、同じ証憑 ID の
 *   タグを持つものが 2 件以上
 * - 人の判断待ち: `NEEDS_REVIEW`・`UNKNOWN` の行の件数
 * 報告することが無ければ投稿しない。`MF_ENABLED` が無効なら何もしない。
 */
export function weeklyJournalReport(ports: AppPorts): void {
  if (!isMfEnabled(ports.props)) {
    return;
  }
  const rows = snapshotRows(ports);
  const receiptIds = new Set(rows.map((r) => r.receipt_id));

  const duplicates: ReturnType<typeof findDuplicateReceiptTags> = [];
  const startDate = ports.props.get("MF_SYNC_START_DATE");
  if (startDate !== null && startDate !== "") {
    const client = makeMfAccountingClient(ports);
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
  if (sections.length === 0) {
    return;
  }
  postBestEffort(ports, [`📋 MF 仕訳 週次報告（${businessDateOf(ports.clock.nowMs())}）`, ...sections].join("\n\n"));
}

