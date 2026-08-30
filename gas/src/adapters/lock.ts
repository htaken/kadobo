/**
 * `LockPort` の GAS 実装（実装設計 §4.2, §7.5）。`LockService.getScriptLock()`、
 * 待機は {@link GAS_LOCK_WAIT_MS}（10 秒）。
 *
 * 待機時間は Worker 側の {@link GAS_TIMEOUT_MS}（25 秒）より十分短くしてある。同値だと
 * 「ロック待ちで詰まったリクエスト」が処理へ進む前に Worker がタイムアウトし、適用済みか
 * 未適用か判別できない結果だけが残る（`shared/src/protocol.ts` の該当コメント参照）。
 *
 * 取得できなければ {@link LockTimeoutError} を投げる（`dispatch.ts` が `LOCK_TIMEOUT` に変換する）。
 */
import { GAS_LOCK_WAIT_MS } from "@kadobo/shared/protocol";
import { LockTimeoutError, type LockPort } from "../app/ports";

export class LockAdapter implements LockPort {
  withLock<T>(fn: () => T): T {
    const lock = LockService.getScriptLock();
    const acquired = lock.tryLock(GAS_LOCK_WAIT_MS);
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
