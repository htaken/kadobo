/**
 * `mfInvoicePing`/`mfAccountingPing`（`entry.ts`）が Logger に出す文字列を組み立てる純関数
 * （実装設計 MF連携 §7 最後の箇条書き）。**トークン・API キーは一切扱わない**——ここに渡すのは
 * MF の応答 JSON（パース済み）だけで、認証情報はそもそもこの関数に渡らない。事業者名・
 * 事業者番号・件数だけを取り出すことで、「Logger 出力にトークンが含まれない」ことを構造的に
 * 保証する。
 *
 * 応答の正確な形（`office` 直下か、`{office: {...}}` にラップされているか等）は設計書に
 * サンプルが無いため未確定。よくある形（トップレベル／`office`/`offices`/`accessible_offices`/
 * `accounts`/`taxes` キーでラップ、または配列そのもの）を広く受け止める防御的な実装にしてある。
 * 会計 API v3 の OpenAPI で確認した形: `accessible_offices[].{name, code, type}`、
 * `accounts[].{id, name, available, tax_id, ...}`、`taxes[].{id, name, tax_rate, available, ...}`。
 */

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** `GET /office` の応答から事業者名だけを取り出す。見つからなければ固定文言を返す。 */
export function extractOfficeName(res: unknown): string {
  const r = asRecord(res);
  const nested = asRecord(r.office);
  const name = nested.name ?? r.name ?? r.company_name;
  return typeof name === "string" && name !== "" ? name : "(事業者名が見つかりません)";
}

/** `GET /accessible_offices` の 1 事業者。 */
export interface OfficeSummary {
  name: string;
  code: string;
  type: string;
}

/**
 * `GET /accessible_offices` の応答（`{ accessible_offices: [{ name, code, type, ... }] }`）から
 * 事業者の一覧を取り出す。事業者番号は `code`（会計 API v3 の OpenAPI）。後方互換で
 * `office_code` も読む。見つからない項目は `?` にする。
 */
export function extractOffices(res: unknown): OfficeSummary[] {
  const r = asRecord(res);
  const raw = Array.isArray(r.accessible_offices)
    ? r.accessible_offices
    : Array.isArray(r.offices)
      ? r.offices
      : Array.isArray(res)
        ? res
        : [];
  const str = (v: unknown): string => (typeof v === "string" && v !== "" ? v : "?");
  return (raw as unknown[]).map((o) => {
    const rec = asRecord(o);
    return { name: str(rec.name), code: str(rec.code ?? rec.office_code), type: str(rec.type) };
  });
}

/** 事業者 1 件を `name (code) type` の形にする。 */
export function formatOffice(o: OfficeSummary): string {
  return `${o.name} (${o.code}) ${o.type}`;
}

/** `GET /accounts` の応答から件数を数える。 */
export function extractAccountCount(res: unknown): number {
  const r = asRecord(res);
  const raw = Array.isArray(r.accounts) ? r.accounts : Array.isArray(res) ? res : [];
  return (raw as unknown[]).length;
}

/**
 * S-M3（実装設計 MF連携 §11.1）で名前完全一致を確かめる勘定科目名（§6.4 の科目の対応）。
 * WP-M4 で `core/journalSync.ts` の科目対応表へ移す。
 */
export const S_M3_ACCOUNT_NAMES: readonly string[] = [
  "通信費",
  "消耗品費",
  "旅費交通費",
  "新聞図書費",
  "会議費",
  "支払手数料",
  "雑費",
  "事業主借",
];

/** `GET /accounts` の 1 科目（必要な項目だけ）。 */
export interface AccountEntry {
  id: string;
  name: string;
  /** 既定の税区分 ID。無い（null）か未取得なら `null`。 */
  taxId: string | null;
  /** `available` が `false` のときだけ `false`。 */
  available: boolean;
}

function idToString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : typeof v === "number" ? String(v) : null;
}

function extractList(res: unknown, key: string): unknown[] {
  const r = asRecord(res);
  const raw = r[key];
  return Array.isArray(raw) ? raw : Array.isArray(res) ? res : [];
}

/** `GET /accounts` の応答（`{ accounts: [...] }`）から科目の一覧を取り出す。`id` か `name` が無い要素は除く。 */
export function extractAccounts(res: unknown): AccountEntry[] {
  const out: AccountEntry[] = [];
  for (const o of extractList(res, "accounts")) {
    const rec = asRecord(o);
    const id = idToString(rec.id);
    if (id === null || typeof rec.name !== "string") {
      continue;
    }
    out.push({ id, name: rec.name, taxId: idToString(rec.tax_id), available: rec.available !== false });
  }
  return out;
}

export type AccountLookupStatus = "one" | "none" | "multiple";

/** 科目名 1 つについての照合結果。 */
export interface AccountLookup {
  name: string;
  status: AccountLookupStatus;
  matches: AccountEntry[];
}

/**
 * `GET /accounts?available=true` の応答に対し、`names` の各名前が「名前完全一致で有効な科目」に
 * ちょうど 1 件・0 件・複数件のどれかを判定する。`available: false` の科目は（念のため）数えない。
 */
export function lookupAccountsByName(
  availableAccountsRes: unknown,
  names: readonly string[] = S_M3_ACCOUNT_NAMES,
): AccountLookup[] {
  const accounts = extractAccounts(availableAccountsRes).filter((a) => a.available);
  return names.map((name) => {
    const matches = accounts.filter((a) => a.name === name);
    const status: AccountLookupStatus = matches.length === 1 ? "one" : matches.length === 0 ? "none" : "multiple";
    return { name, status, matches };
  });
}

/** 有効な科目の件数と、無指定（全件）の件数を 1 行にする。 */
export function formatAccountCounts(availableAccountsRes: unknown, allAccountsRes: unknown): string {
  return (
    `MF accounting GET /accounts: 有効(available=true) ${extractAccountCount(availableAccountsRes)} 件` +
    ` / 無指定 ${extractAccountCount(allAccountsRes)} 件`
  );
}

/** 科目名 1 つの照合結果を 1 行にする。見つかった科目には `id` と `tax_id` を添える。 */
export function formatAccountLookup(l: AccountLookup): string {
  const detail = l.matches.map((m) => `id=${m.id} tax_id=${m.taxId ?? "なし"}`).join(" / ");
  switch (l.status) {
    case "one":
      return `S-M3 科目 ${l.name}: 1 件 OK ${detail}`;
    case "none":
      return `S-M3 科目 ${l.name}: 0 件 NG（有効な科目に名前完全一致なし）`;
    case "multiple":
      return `S-M3 科目 ${l.name}: ${l.matches.length} 件 NG（複数一致） ${detail}`;
  }
}

/** 見つかった科目（1 件以上）の `tax_id` を、重複なし・出現順で集める。 */
export function collectTaxIds(lookups: readonly AccountLookup[]): string[] {
  const ids: string[] = [];
  for (const l of lookups) {
    for (const m of l.matches) {
      if (m.taxId !== null && !ids.includes(m.taxId)) {
        ids.push(m.taxId);
      }
    }
  }
  return ids;
}

/** `GET /taxes` の 1 税区分。 */
export interface TaxEntry {
  id: string;
  name: string;
  taxRate: string;
  available: string;
}

function scalarToString(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "?";
}

/** `GET /taxes` の応答（`{ taxes: [...] }`）から税区分の一覧を取り出す。 */
export function extractTaxes(res: unknown): TaxEntry[] {
  const out: TaxEntry[] = [];
  for (const o of extractList(res, "taxes")) {
    const rec = asRecord(o);
    const id = idToString(rec.id);
    if (id === null) {
      continue;
    }
    out.push({
      id,
      name: scalarToString(rec.name),
      taxRate: scalarToString(rec.tax_rate),
      available: scalarToString(rec.available),
    });
  }
  return out;
}

/** `tax_id` 1 つについて、`GET /taxes` の応答と突き合わせた結果を 1 行にする。 */
export function formatTaxLine(taxId: string, taxesRes: unknown): string {
  const t = extractTaxes(taxesRes).find((x) => x.id === taxId);
  if (t === undefined) {
    return `S-M3 税区分 tax_id=${taxId}: /taxes に見つかりません`;
  }
  return `S-M3 税区分 tax_id=${taxId}: name=${t.name} tax_rate=${t.taxRate} available=${t.available}`;
}
