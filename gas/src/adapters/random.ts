/**
 * `RandomPort` の GAS 実装（実装設計 §4.3）。`Utilities.getUuid()`（32 hex 文字 = 16 バイト）を
 * 乱数源として使う。ULID の乱数部は 10 バイトなので 1 回の UUID で足りるが、`n` が大きい場合は
 * 必要な回数だけ UUID を生成する。
 */
import type { RandomPort } from "../app/ports";

export class RandomAdapter implements RandomPort {
  randomBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const hex = Utilities.getUuid().replace(/-/g, "");
      for (let i = 0; i + 1 < hex.length && filled < n; i += 2) {
        bytes[filled] = parseInt(hex.slice(i, i + 2), 16);
        filled++;
      }
    }
    return bytes;
  }
}
