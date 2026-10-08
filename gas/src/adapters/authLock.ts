/**
 * `AuthLockPort` の GAS 実装（実装設計 MF連携 §4.1）。`LockService.getUserLock()` を使う
 * （スクリプトロック `LockAdapter` とは別物。トークン更新の HTTP が長引いても打刻を待たせない）。
 * 待機は {@link AUTH_LOCK_WAIT_MS}（10 秒）。取得できなければ `MfTransientError` を投げる。
 */
import { MfTransientError } from "../app/mf/errors";
import type { AuthLockPort } from "../app/ports";

const AUTH_LOCK_WAIT_MS = 10_000;

export class AuthLockAdapter implements AuthLockPort {
  withAuthLock<T>(fn: () => T): T {
    const lock = LockService.getUserLock();
    const acquired = lock.tryLock(AUTH_LOCK_WAIT_MS);
    if (!acquired) {
      throw new MfTransientError("MF_AUTH_LOCK_TIMEOUT");
    }
    try {
      return fn();
    } finally {
      lock.releaseLock();
    }
  }
}
