/**
 * 修正（`CORRECTION`）の適用（実装設計 §4.1.4, §7.3 手順1）。純関数のみ。
 */

import type { LoggedEvent } from "./state";

/**
 * `CORRECTION` 行を対象イベントの `occurred_at` に反映した新しい配列を返す（実装設計 §7.3 手順1）。
 *
 * - 対象は `correction_of` で指す `event_id`。同一対象に複数の `CORRECTION` がある場合、
 *   `CORRECTION` 自身の `occurred_at`（＝訂正操作を行った時刻）が最も新しいものが有効
 *   （最新勝ち）。`occurred_at` が同値の場合は入力配列内で後に現れたものを採用する
 * - `CORRECTION` 行自体はそのまま出力に含める（除外は呼び出し側 `isStampEvent` の責務）
 * - 入力配列・入力オブジェクトは変更しない（新しい配列・新しいオブジェクトを返す）
 */
export function applyCorrections(events: LoggedEvent[]): LoggedEvent[] {
  const latestCorrectionByTarget = new Map<string, LoggedEvent>();
  for (const event of events) {
    if (event.event_type !== "CORRECTION" || event.correction_of === undefined) {
      continue;
    }
    const target = event.correction_of;
    const current = latestCorrectionByTarget.get(target);
    if (current === undefined || event.occurred_at >= current.occurred_at) {
      latestCorrectionByTarget.set(target, event);
    }
  }

  return events.map((event) => {
    if (event.event_type === "CORRECTION") {
      return event;
    }
    const correction = latestCorrectionByTarget.get(event.event_id);
    if (correction === undefined || correction.new_value === undefined) {
      return event;
    }
    return { ...event, occurred_at: correction.new_value };
  });
}
