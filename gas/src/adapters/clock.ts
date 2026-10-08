/** `ClockPort` の GAS 実装。 */
import type { ClockPort } from "../app/ports";

export class ClockAdapter implements ClockPort {
  nowMs(): number {
    return Date.now();
  }

  nowSec(): number {
    return Math.floor(Date.now() / 1000);
  }

  /** `Utilities.sleep`（実装設計 MF連携 §4.1）。 */
  sleep(ms: number): void {
    Utilities.sleep(ms);
  }
}
