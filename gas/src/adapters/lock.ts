/**
 * `LockPort` の GAS 実装（実装設計 §4.2, §7.5）。`LockService.getScriptLock()`、待機 20 秒。
 * 取得できなければ {@link LockTimeoutError} を投げる（`dispatch.ts` が `LOCK_TIMEOUT` に変換する）。
 */
import { LockTimeoutError, type LockPort } from "../app/ports";

const LOCK_WAIT_MS = 20000;

export class LockAdapter implements LockPort {
  withLock<T>(fn: () => T): T {
    const lock = LockService.getScriptLock();
    const acquired = lock.tryLock(LOCK_WAIT_MS);
    if (!acquired) {
      throw new LockTimeoutError();
    }
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }
}
