/**
 * §9 のフラグ表（実装設計 MF連携）。既定はすべて無効（fail closed）。値が文字列 `"true"`
 * のときだけ有効になる（他の値・未設定はすべて無効として扱う）。
 */
import type { PropsPort } from "../ports";

function isTrue(props: PropsPort, key: string): boolean {
  return props.get(key) === "true";
}

/** `MF_ENABLED`: MF への呼び出しすべてを止める全体スイッチ。障害時はまずこれを `false` にする。 */
export function isMfEnabled(props: PropsPort): boolean {
  return isTrue(props, "MF_ENABLED");
}

/** `MF_INVOICE_ENABLED`: 請求書の作成・追跡・週次の疎通。`MF_ENABLED` も有効な場合だけ真。 */
export function isInvoiceEnabled(props: PropsPort): boolean {
  return isMfEnabled(props) && isTrue(props, "MF_INVOICE_ENABLED");
}

/** `MF_JOURNAL_ENABLED`: ② 現金・立替の新規作成。`MF_ENABLED` も有効な場合だけ真。 */
export function isJournalEnabled(props: PropsPort): boolean {
  return isMfEnabled(props) && isTrue(props, "MF_JOURNAL_ENABLED");
}

/** `MF_MATCH_ENABLED`: ③ 明細との照合・新規作成・明細ルールによる私用仕訳・未登録支出の報告。 */
export function isMatchEnabled(props: PropsPort): boolean {
  return isMfEnabled(props) && isTrue(props, "MF_MATCH_ENABLED");
}
