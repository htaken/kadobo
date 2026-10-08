/**
 * `TtlCachePort` の GAS 実装（実装設計 MF連携 §4.1, §4.3）。`CacheService.getScriptCache()`、
 * キーにプレフィックス `mf:` を付ける（nonce 用の `CacheAdapter` と名前空間を分けるため）。
 * プレフィックスはこのアダプタだけの実装詳細で、呼び出し側（`app/mf/*.ts`）は素のキー
 * （例 `mf_acc_jwt`）だけを扱う。
 */
import type { TtlCachePort } from "../app/ports";

const KEY_PREFIX = "mf:";

export class TtlCacheAdapter implements TtlCachePort {
  private cache(): GoogleAppsScript.Cache.Cache {
    return CacheService.getScriptCache();
  }

  get(key: string): string | null {
    return this.cache().get(`${KEY_PREFIX}${key}`);
  }

  put(key: string, value: string, ttlSec: number): void {
    this.cache().put(`${KEY_PREFIX}${key}`, value, ttlSec);
  }

  remove(key: string): void {
    this.cache().remove(`${KEY_PREFIX}${key}`);
  }
}
