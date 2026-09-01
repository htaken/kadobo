/**
 * `DigestPort` の GAS 実装（実装設計 経費フェーズ §5.9）。`Utilities.computeDigest(SHA_256, ...)`。
 *
 * 入力の `bytes: number[]` は `SlackFilesPort.download` が返す符号なし 0〜255 の配列を想定する。
 * GAS の `Utilities` は内部的に Java の signed byte（-128〜127）で byte 配列を扱うが、
 * 0〜255 の値をそのまま渡してもビットパターンは保持されるため正しいダイジェストが計算できる
 * （`hmac.ts` の `toUtf8Bytes`/`toHex` と同じ前提）。**出力側**（`computeDigest` が返す配列）は
 * 符号付きで返るため、`hmac.ts` と同じく `& 0xff` で符号なしへ正規化してから hex 化する。
 */
import type { DigestPort } from "../app/ports";

function toHex(bytes: GoogleAppsScript.Byte[]): string {
  let hex = "";
  for (const b of bytes) {
    hex += (b & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

export class DigestAdapter implements DigestPort {
  sha256Hex(bytes: number[]): string {
    const digestBytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
    return toHex(digestBytes);
  }
}
