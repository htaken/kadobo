/**
 * `CachePort` の GAS 実装（実装設計 §3.1, §4.2）。`CacheService.getScriptCache()`、
 * キー `nonce:<nonce>`、TTL 600 秒。
 */
import type { CachePort } from "../app/ports";

const NONCE_TTL_SEC = 600;

export class CacheAdapter implements CachePort {
  private cache(): GoogleAppsScript.Cache.Cache {
    return CacheService.getScriptCache();
  }

  nonceSeen(nonce: string): boolean {
    return this.cache().get(`nonce:${nonce}`) !== null;
  }

  markNonce(nonce: string): void {
    this.cache().put(`nonce:${nonce}`, "1", NONCE_TTL_SEC);
  }
}
