/**
 * 生ログ行（`RawLogRow`）と core の `LoggedEvent` の変換（app 層）。
 */
import type { LoggedEvent } from "../core/state";
import type { RawLogRow } from "./ports";

/** `RawLogRow` を core が扱う最小フィールドの `LoggedEvent` に変換する。 */
export function toLoggedEvent(row: RawLogRow): LoggedEvent {
  return {
    event_id: row.event_id,
    event_type: row.event_type,
    occurred_at: row.occurred_at,
    correction_of: row.correction_of ?? undefined,
    new_value: row.new_value ?? undefined,
  };
}
