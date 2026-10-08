/**
 * lease（実装設計 MF連携 §5.5, §6.8, §8）。内部シート（`kind="lease"`）に有効期限（epoch ms）を
 * 保存し、複数実行の同時処理を防ぐ。取得・解放は短いスクリプトロック（`LockPort`）の中で行う。
 * MF の呼び出しは lease の外（ロックの外）で行うこと（実装設計 §0）。
 */
import type { AppPorts } from "../ports";

const LEASE_KIND = "lease";
/** 未取得・解放済みを表す番兵値（`nowMs` より必ず小さい）。 */
const RELEASED = "0";

/**
 * `key` の lease を `ttlMs` の間だけ取得する。既存の lease がまだ有効期限内なら `false`
 * （別の実行が処理中）。期限切れ、または未取得・解放済みなら取得して `true` を返す
 * （期限切れの lease は奪ってよい。実装設計 §5.5）。
 */
export function acquireLease(ports: AppPorts, key: string, ttlMs: number): boolean {
  return ports.lock.withLock(() => {
    const current = ports.sheets.getInternalValue(LEASE_KIND, key);
    const nowMs = ports.clock.nowMs();
    if (current !== null) {
      const expiresAt = parseInt(current, 10);
      if (Number.isFinite(expiresAt) && expiresAt > nowMs) {
        return false;
      }
    }
    ports.sheets.setInternalValue(LEASE_KIND, key, String(nowMs + ttlMs));
    return true;
  });
}

/** `key` の lease を解放する（期限を過去に書き戻し、以後は誰でも取得できるようにする）。 */
export function releaseLease(ports: AppPorts, key: string): void {
  ports.lock.withLock(() => {
    ports.sheets.setInternalValue(LEASE_KIND, key, RELEASED);
  });
}

/**
 * `key` の lease を取得できたときだけ `fn` を実行し（lease 取得・解放それぞれの短いロックの
 * 外で実行するため、MF 呼び出し等の重い I/O を安全に行える）、終了後（成功・失敗を問わず）
 * 解放する。取得できなければ `fn` を呼ばずに `null` を返す（実装設計 §5.5「取れなければ何もしない」）。
 */
export function withLease<T>(ports: AppPorts, key: string, ttlMs: number, fn: () => T): T | null {
  if (!acquireLease(ports, key, ttlMs)) {
    return null;
  }
  try {
    return fn();
  } finally {
    releaseLease(ports, key);
  }
}
