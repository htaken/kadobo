/**
 * スパイク S-M4 の本体（実装設計 MF連携 §11.1）。`entry.ts` の `mfTransactionSpikeS4` から手動実行で呼ぶ。
 * **読み取り専用**: 呼ぶ HTTP は GET だけ（`/connected_accounts`・`/accounts`・`/transactions`）。シートには
 * 一切書かず、`MF_*_ENABLED` フラグも見ない。
 *
 * 実機の結果: `GET /transactions?connected_account_id=…` に、ID を `encodeURIComponent` で 1 回エンコードした値
 * （`%2B` → `%252B`）を置くと 400 `invalid_query_parameter_value` だった。そこで次の 2 段で動く。
 * - 探査: 連携サービスごとに `connected_account_id` の表記（1 回エンコード／返された文字列そのまま／デコード）を
 *   `per_page=10` で試し、結果を 1 行ずつ出す。最初に 200 になった表記を以後のサービスにも使う。
 * - 本取得: **絞り込みなし**（`connected_account_id` なし）で `per_page=500`・最大 3 ページを取り、手元で連携
 *   サービスごとに分けて出力する。探査の成否に関わらず行う。
 *
 * 目的（利用者が Logger を見て決めること）:
 * 1. `MF_CARD_ACCOUNT_IDS`／`MF_BANK_ACCOUNT_IDS` に入れる連携サービス ID（連携サービス・口座の一覧と科目名）
 * 2. カード明細の `date` が利用日か計上日か（連携サービスごとの `date` の最小・最大・件数と明細）
 * 3. `journalizing_status` の分布
 * 4. 明細ルール（NISA 積立・カード引落し）の「内容に含む文字列」（該当しそうな `content` の列挙）
 *
 * `is_manual: true` の連携サービスは出力の対象外（探査もしない）。範囲は今日 − 90 日〜今日、`order=desc`。
 * 出力は `log` だけで、API キー・JWT は扱わない。
 */
import { businessDateOf } from "@kadobo/shared/time";
import {
  makeMfAccountingClient,
  type MfAccountingClient,
  type MfAccountingClientPorts,
  type MfQueryValue,
} from "./accountingClient";
import { MfApiError } from "./errors";
import { extractAccounts } from "./pingFormat";

/** 明細を遡る日数。 */
export const S4_LOOKBACK_DAYS = 90;
/** 連携サービスごとに列挙する明細の最大件数。 */
export const S4_MAX_LISTED = 40;
/** 絞り込みなし取得の `per_page`。 */
export const S4_PER_PAGE = 500;
/** 絞り込みなし取得の最大ページ数。 */
export const S4_MAX_PAGES = 3;
/** `connected_account_id` の表記を探査するときの `per_page`。 */
export const S4_PROBE_PER_PAGE = 10;
/** 明細ルールの候補を探す文字列（大文字小文字・全角半角を無視して部分一致）。 */
export const S4_KEYWORDS: readonly string[] = ["NISA", "ニーサ", "積立", "つみたて", "カード", "引落"];

const DAY_MS = 24 * 60 * 60 * 1000;
const NONE_LABEL = "(なし)";

/** `GET /connected_accounts` の 1 口座。 */
export interface S4SubAccount {
  id: string;
  name: string;
  accountId: string | null;
}

/** `GET /connected_accounts` の 1 連携サービス。 */
export interface S4ConnectedAccount {
  id: string;
  name: string;
  isManual: boolean;
  accountId: string | null;
  subAccounts: S4SubAccount[];
}

/** `GET /transactions` の 1 明細（表示に使う項目だけ）。 */
export interface S4Transaction {
  date: string;
  value: string;
  side: string;
  journalizingStatus: string;
  /** `content` の原文。無ければ `null`。 */
  content: string | null;
  /** 連携サービス ID（応答のまま）。無ければ `null`。 */
  accountId: string | null;
  /** 口座 ID（応答のまま）。直接紐付きなら `null`。 */
  subAccountId: string | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
}

function show(v: string | null): string {
  return v === null ? NONE_LABEL : v;
}

/** `GET /connected_accounts` の応答から連携サービスの一覧を取り出す。`id` が無い要素は除く。 */
export function extractConnectedAccounts(res: unknown): S4ConnectedAccount[] {
  const raw = asRecord(res).connected_accounts;
  const out: S4ConnectedAccount[] = [];
  for (const o of Array.isArray(raw) ? (raw as unknown[]) : []) {
    const rec = asRecord(o);
    const id = str(rec.id);
    if (id === null) {
      continue;
    }
    const subsRaw = Array.isArray(rec.connected_sub_accounts) ? (rec.connected_sub_accounts as unknown[]) : [];
    const subAccounts: S4SubAccount[] = [];
    for (const s of subsRaw) {
      const sr = asRecord(s);
      const sid = str(sr.id);
      if (sid !== null) {
        subAccounts.push({ id: sid, name: show(str(sr.name)), accountId: str(sr.account_id) });
      }
    }
    out.push({
      id,
      name: show(str(rec.name)),
      isManual: rec.is_manual === true,
      accountId: str(rec.account_id),
      subAccounts,
    });
  }
  return out;
}

/** `GET /transactions` の応答から明細と `total_count` を取り出す。 */
export function extractTransactions(res: unknown): {
  items: S4Transaction[];
  totalCount: number | null;
  totalPages: number | null;
} {
  const r = asRecord(res);
  const raw = Array.isArray(r.transactions) ? (r.transactions as unknown[]) : [];
  const items = raw.map((o) => {
    const rec = asRecord(o);
    return {
      date: show(str(rec.date)),
      value: show(str(rec.value)),
      side: show(str(rec.side)),
      journalizingStatus: show(str(rec.journalizing_status)),
      content: typeof rec.content === "string" ? rec.content : null,
      accountId: str(rec.connected_account_id),
      subAccountId: str(rec.connected_sub_account_id),
    };
  });
  const meta = asRecord(r.metadata);
  return {
    items,
    totalCount: typeof meta.total_count === "number" ? meta.total_count : null,
    totalPages: typeof meta.total_pages === "number" ? meta.total_pages : null,
  };
}

/** 科目 ID を `<科目名>(<account_id>)` にする。ID が無ければ `(なし)`、名前が引けなければ `(科目名不明)`。 */
export function formatAccountRef(accountId: string | null, names: ReadonlyMap<string, string>): string {
  if (accountId === null) {
    return NONE_LABEL;
  }
  return `${names.get(accountId) ?? "(科目名不明)"}(${accountId})`;
}

/** 連携サービス 1 件の行。 */
export function formatConnectedAccountLine(c: S4ConnectedAccount, names: ReadonlyMap<string, string>): string {
  return `connected_account: id=${c.id} name=${c.name} is_manual=${String(c.isManual)} account=${formatAccountRef(c.accountId, names)}`;
}

/** 連携サービスの口座 1 件の行。 */
export function formatSubAccountLine(s: S4SubAccount, names: ReadonlyMap<string, string>): string {
  return `  sub_account: id=${s.id} name=${s.name} account=${formatAccountRef(s.accountId, names)}`;
}

/**
 * 明細 1 件を `date value side journalizing_status [口座名] content` の形にする（`content` はそのまま）。
 * 口座名 `subName` を渡さなければ `[…]` を付けない。
 */
export function formatTransactionLine(t: S4Transaction, subName?: string): string {
  const sub = subName === undefined ? "" : ` [${subName}]`;
  return `${t.date} ${t.value} ${t.side} ${t.journalizingStatus}${sub} ${t.content ?? NONE_LABEL}`;
}

/** `journalizing_status` の件数を `none=3 registered=5` の形にする。0 件なら `(明細なし)`。 */
export function summarizeStatuses(items: readonly S4Transaction[]): string {
  const counts = new Map<string, number>();
  for (const t of items) {
    counts.set(t.journalizingStatus, (counts.get(t.journalizingStatus) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return "(明細なし)";
  }
  return [...counts.entries()].map(([k, n]) => `${k}=${n}`).join(" ");
}

function normalizeForMatch(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/** `content` が {@link S4_KEYWORDS} のどれかを含むか（大文字小文字・全角半角を無視）。 */
export function matchesS4Keyword(content: string | null): boolean {
  if (content === null) {
    return false;
  }
  const norm = normalizeForMatch(content);
  return S4_KEYWORDS.some((k) => norm.includes(normalizeForMatch(k)));
}

function dateRangeLine(items: readonly S4Transaction[]): string {
  const dates = items.map((t) => t.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) {
    return `date の最小・最大: ${NONE_LABEL}（明細 ${items.length} 件）`;
  }
  const sorted = [...dates].sort();
  return `date の最小=${sorted[0]} 最大=${sorted[sorted.length - 1]}（取得した明細 ${items.length} 件）`;
}

function tryDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 連携サービス ID・口座 ID の突き合わせ用キー（エンコードの有無の違いを吸収する）。 */
function idKey(id: string): string {
  return tryDecode(id);
}

/** `connected_account_id` の表記の候補（探査の順）。 */
export interface S4IdForm {
  label: string;
  make: (id: string) => MfQueryValue;
}

export const S4_ID_FORMS: readonly S4IdForm[] = [
  { label: "(a) 1 回エンコード（従来）", make: (id) => id },
  { label: "(b) raw（返された文字列そのまま）", make: (id) => ({ raw: id }) },
  { label: "(c) raw（decodeURIComponent した文字列）", make: (id) => ({ raw: tryDecode(id) }) },
];

/** 探査 1 回。200 なら件数、`MfApiError` なら `status=… code=…`。それ以外の例外（認証・通信）は再スローする。 */
function probeTransactions(
  client: MfAccountingClient,
  form: S4IdForm,
  id: string,
  startDate: string,
  endDate: string,
): { ok: boolean; text: string } {
  try {
    const res = client.request("get", "/transactions", {
      connected_account_id: form.make(id),
      start_date: startDate,
      end_date: endDate,
      order: "desc",
      page: "1",
      per_page: String(S4_PROBE_PER_PAGE),
    });
    const { items, totalCount } = extractTransactions(res);
    return { ok: true, text: `200 件数=${items.length} total_count=${totalCount === null ? "?" : totalCount}` };
  } catch (e) {
    if (e instanceof MfApiError) {
      return { ok: false, text: `status=${e.status} code=${e.code ?? NONE_LABEL}` };
    }
    throw e;
  }
}

/** 連携サービスごとの出力（先頭 40 件・date の範囲・集計・キーワード抽出）。 */
function logServiceTransactions(
  c: S4ConnectedAccount,
  items: readonly S4Transaction[],
  subNameOf: (t: S4Transaction) => string,
  log: (line: string) => void,
): void {
  log(`S-M4 明細: connected_account id=${c.id} name=${c.name} 絞り込みなし取得のうち ${items.length} 件`);
  if (items.length === 0) {
    log("S-M4 明細 0 件");
    return;
  }
  const listed = items.slice(0, S4_MAX_LISTED);
  log(`S-M4 明細（date value side journalizing_status [口座名] content）先頭 ${listed.length} 件`);
  for (const t of listed) {
    log(formatTransactionLine(t, subNameOf(t)));
  }
  log(`S-M4 ${dateRangeLine(items)}`);
  log(`S-M4 journalizing_status 集計: ${summarizeStatuses(items)}`);
  const bySub = new Map<string, number>();
  for (const t of items) {
    const n = subNameOf(t);
    bySub.set(n, (bySub.get(n) ?? 0) + 1);
  }
  log(`S-M4 口座別の件数: ${[...bySub.entries()].map(([k, n]) => `[${k}]=${n}`).join(" ")}`);

  const hits = items.filter((t) => matchesS4Keyword(t.content));
  log(`S-M4 キーワード（${S4_KEYWORDS.join("・")}）を content に含む明細 ${hits.length} 件`);
  for (const t of hits) {
    log(`  ${formatTransactionLine(t, subNameOf(t))}`);
  }
}

/**
 * S-M4 を 1 回実行する。`log` には 1 行ずつ渡す（`Logger.log` を想定）。読み取り専用（GET だけ）。
 */
export function runTransactionSpikeS4(ports: MfAccountingClientPorts, log: (line: string) => void): void {
  const client = makeMfAccountingClient(ports);
  const nowMs = ports.clock.nowMs();
  const today = businessDateOf(nowMs);
  const startDate = businessDateOf(nowMs - S4_LOOKBACK_DAYS * DAY_MS);

  // 1. 連携サービスと口座、科目名
  const services = extractConnectedAccounts(client.request("get", "/connected_accounts"));
  const accountNames = new Map<string, string>();
  for (const a of extractAccounts(client.request("get", "/accounts", { available: "true" }))) {
    accountNames.set(a.id, a.name);
  }

  log(`S-M4 連携サービス ${services.length} 件（MF_CARD_ACCOUNT_IDS／MF_BANK_ACCOUNT_IDS には connected_account の id を入れる）`);
  if (services.length === 0) {
    log(`connected_account: ${NONE_LABEL}`);
  }
  const subNames = new Map<string, string>();
  for (const c of services) {
    log(formatConnectedAccountLine(c, accountNames));
    for (const s of c.subAccounts) {
      log(formatSubAccountLine(s, accountNames));
      subNames.set(idKey(s.id), s.name);
    }
  }
  const targets = services.filter((c) => !c.isManual);
  for (const c of services) {
    if (c.isManual) {
      log(`S-M4 connected_account id=${c.id} name=${c.name}: is_manual=true のため対象外`);
    }
  }
  if (targets.length === 0) {
    log("S-M4 明細を取得する連携サービス（is_manual=false）がありません。");
    return;
  }

  // 2. connected_account_id の表記の探査（最初のサービスは全表記を試し、最初に 200 になった表記を以後に使う）
  log(`S-M4 探査: GET /transactions?connected_account_id=… per_page=${S4_PROBE_PER_PAGE} ${startDate}〜${today}`);
  let working: S4IdForm | null = null;
  const first = targets[0] as S4ConnectedAccount;
  for (const form of S4_ID_FORMS) {
    const r = probeTransactions(client, form, first.id, startDate, today);
    log(`S-M4 探査 ${form.label} id=${first.id} name=${first.name}: ${r.text}`);
    if (r.ok && working === null) {
      working = form;
    }
  }
  if (working === null) {
    log("S-M4 探査: どの表記でも 200 にならなかった。以後の絞り込み取得は行わず、絞り込みなし取得だけを使う。");
  } else {
    log(`S-M4 探査: 200 になった最初の表記は ${working.label}。以後のサービスにも使う。`);
    for (const c of targets.slice(1)) {
      const r = probeTransactions(client, working, c.id, startDate, today);
      log(`S-M4 探査 ${working.label} id=${c.id} name=${c.name}: ${r.text}`);
    }
  }

  // 3. 絞り込みなし取得（探査の成否に関わらず行う）
  const all: S4Transaction[] = [];
  let totalCount: number | null = null;
  let totalPages: number | null = null;
  let fetchedPages = 0;
  for (let page = 1; page <= S4_MAX_PAGES; page++) {
    const res = client.request("get", "/transactions", {
      start_date: startDate,
      end_date: today,
      order: "desc",
      page: String(page),
      per_page: String(S4_PER_PAGE),
    });
    const r = extractTransactions(res);
    all.push(...r.items);
    totalCount = r.totalCount;
    totalPages = r.totalPages;
    fetchedPages = page;
    if (totalPages === null || page >= totalPages) {
      break;
    }
  }
  log(
    `S-M4 絞り込みなし取得・全体 total_count=${totalCount === null ? "?" : totalCount} total_pages=${totalPages === null ? "?" : totalPages} ` +
      `${startDate}〜${today} order=desc per_page=${S4_PER_PAGE} 取得 ${fetchedPages} ページ ${all.length} 件`,
  );
  if (totalPages !== null && totalPages > fetchedPages) {
    log(`S-M4 注意: total_pages=${totalPages} のうち ${fetchedPages} ページ目までしか取っていない（古い明細が含まれない）。`);
  }

  const byService = new Map<string, S4Transaction[]>();
  for (const t of all) {
    const k = idKey(t.accountId ?? NONE_LABEL);
    const arr = byService.get(k);
    if (arr === undefined) {
      byService.set(k, [t]);
    } else {
      arr.push(t);
    }
  }
  const subNameOf = (t: S4Transaction): string =>
    t.subAccountId === null ? "(直接)" : (subNames.get(idKey(t.subAccountId)) ?? "(口座名不明)");

  const targetItems: S4Transaction[] = [];
  for (const c of targets) {
    const items = byService.get(idKey(c.id)) ?? [];
    targetItems.push(...items);
    logServiceTransactions(c, items, subNameOf, log);
  }
  if (targets.length > 1) {
    log(`S-M4 journalizing_status 集計（is_manual=false の全連携サービス ${targetItems.length} 件）: ${summarizeStatuses(targetItems)}`);
  }
  const known = new Set(services.map((c) => idKey(c.id)));
  const other = all.filter((t) => !known.has(idKey(t.accountId ?? NONE_LABEL)));
  if (other.length > 0) {
    log(`S-M4 注意: 連携サービス一覧にない connected_account_id の明細が ${other.length} 件ある。`);
  }
  const manualCount = all.length - targetItems.length - other.length;
  if (manualCount > 0) {
    log(`S-M4 is_manual=true の連携サービスの明細 ${manualCount} 件は出力しない。`);
  }
}
