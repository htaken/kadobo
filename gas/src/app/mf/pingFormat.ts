/**
 * `mfInvoicePing`/`mfAccountingPing`（`entry.ts`）が Logger に出す文字列を組み立てる純関数
 * （実装設計 MF連携 §7 最後の箇条書き）。**トークン・API キーは一切扱わない**——ここに渡すのは
 * MF の応答 JSON（パース済み）だけで、認証情報はそもそもこの関数に渡らない。事業者名・
 * 事業者番号・件数だけを取り出すことで、「Logger 出力にトークンが含まれない」ことを構造的に
 * 保証する。
 *
 * 応答の正確な形（`office` 直下か、`{office: {...}}` にラップされているか等）は設計書に
 * サンプルが無いため未確定。よくある形（トップレベル／`office`/`offices`/`accessible_offices`/
 * `accounts` キーでラップ、または配列そのもの）を広く受け止める防御的な実装にしてある。
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

/** `GET /accessible_offices` の応答から `office_code` の一覧を取り出す。 */
export function extractOfficeCodes(res: unknown): string[] {
  const r = asRecord(res);
  const raw = Array.isArray(r.offices)
    ? r.offices
    : Array.isArray(r.accessible_offices)
      ? r.accessible_offices
      : Array.isArray(res)
        ? res
        : [];
  return (raw as unknown[]).map((o) => {
    const code = asRecord(o).office_code;
    return typeof code === "string" ? code : "?";
  });
}

/** `GET /accounts` の応答から件数を数える。 */
export function extractAccountCount(res: unknown): number {
  const r = asRecord(res);
  const raw = Array.isArray(r.accounts) ? r.accounts : Array.isArray(res) ? res : [];
  return (raw as unknown[]).length;
}
