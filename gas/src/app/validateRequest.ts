/**
 * 封筒検証後の `payload`（`unknown`）を {@link GasRequest} として型検証する（実装設計 §7.5）。
 *
 * `@kadobo/shared/protocol` は `GasRequest` の型定義のみを提供し、受信側の実行時検証は
 * 提供しない（Worker が送信側のため）。この検証は GAS（受信側）である WP3 の責務。
 */
import type { CommandText, GasRequest, StampActionId } from "@kadobo/shared/protocol";

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
    default:
      return false;
  }
}
