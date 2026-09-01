/**
 * 封筒検証後の `payload`（`unknown`）を {@link GasRequest} として型検証する（実装設計 §7.5）。
 *
 * `@kadobo/shared/protocol` は `GasRequest` の型定義のみを提供し、受信側の実行時検証は
 * 提供しない（Worker が送信側のため）。この検証は GAS（受信側）である WP3 の責務。
 *
 * 🔄 `expense_submit`（実装設計 経費フェーズ §4.5）: 追加するまで `dispatch.ts` の
 * `case "expense_submit"` は到達不能で、本番で `/keihi` から送信すると `BAD_REQUEST` が
 * 返っていた。`file` オブジェクトも Cron 再送で壊れたペイロードが来る経路があるため、
 * 各フィールドの型まで検証する。
 */
import { isExpenseCategory, isReceiptType } from "@kadobo/shared/expense";
import type {
  CommandText,
  ExpenseSubmitFile,
  GasRequest,
  StampActionId,
} from "@kadobo/shared/protocol";

const STAMP_ACTION_IDS: readonly StampActionId[] = [
  "kado_start",
  "kado_break_start",
  "kado_break_end",
  "kado_end",
];

const COMMAND_TEXTS: readonly CommandText[] = ["", "status"];

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** `expense_submit` の `file`（実装設計 経費フェーズ §3.1 `ExpenseSubmitFile`）の型検証。 */
function isExpenseSubmitFile(v: unknown): v is ExpenseSubmitFile {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const f = v as Record<string, unknown>;
  return (
    isStr(f.id) &&
    isStr(f.name) &&
    isStr(f.mimetype) &&
    isStr(f.filetype) &&
    isFiniteNum(f.size) &&
    isStr(f.url_private)
  );
}

export function isGasRequest(x: unknown): x is GasRequest {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const o = x as Record<string, unknown>;

  switch (o.kind) {
    case "stamp":
      return (
        isStr(o.idempotency_key) &&
        isStr(o.user_id) &&
        isStr(o.channel_id) &&
        isStr(o.message_ts) &&
        isStr(o.action_id) &&
        (STAMP_ACTION_IDS as readonly string[]).includes(o.action_id) &&
        isFiniteNum(o.occurred_at_ms) &&
        isFiniteNum(o.received_at_ms) &&
        (o.source === "button" || o.source === "retry") &&
        (o.response_url === undefined || isStr(o.response_url))
      );
    case "open_correction":
      return (
        isStr(o.idempotency_key) &&
        isStr(o.user_id) &&
        isStr(o.channel_id) &&
        isStr(o.message_ts) &&
        isStr(o.view_id) &&
        isStr(o.business_date) &&
        isFiniteNum(o.received_at_ms) &&
        o.source === "button"
      );
    case "correction_submit":
      return (
        isStr(o.idempotency_key) &&
        isStr(o.user_id) &&
        isStr(o.view_id) &&
        isStr(o.channel_id) &&
        isStr(o.message_ts) &&
        isStr(o.business_date) &&
        isStr(o.target) &&
        isStr(o.new_date) &&
        isStr(o.new_time) &&
        isStr(o.reason) &&
        isFiniteNum(o.received_at_ms) &&
        (o.source === "modal" || o.source === "retry")
      );
    case "command":
      return (
        isStr(o.idempotency_key) &&
        isStr(o.user_id) &&
        isStr(o.channel_id) &&
        isStr(o.text) &&
        (COMMAND_TEXTS as readonly string[]).includes(o.text) &&
        isStr(o.response_url) &&
        isFiniteNum(o.received_at_ms) &&
        (o.source === "command" || o.source === "retry")
      );
    case "expense_submit":
      return (
        isStr(o.idempotency_key) &&
        isStr(o.user_id) &&
        isStr(o.view_id) &&
        isStr(o.channel_id) &&
        isReceiptType(o.receipt_type) &&
        isStr(o.date) &&
        isFiniteNum(o.amount) &&
        isExpenseCategory(o.category) &&
        isStr(o.partner) &&
        isStr(o.memo) &&
        isExpenseSubmitFile(o.file) &&
        isFiniteNum(o.received_at_ms) &&
        (o.source === "modal" || o.source === "retry")
      );
    default:
      return false;
  }
}
