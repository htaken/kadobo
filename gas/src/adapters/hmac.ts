/**
 * `HmacPort` の GAS 実装（実装設計 §3.1, §7.4）。`Utilities.computeHmacSha256Signature` を使い、
 * 結果の byte 配列（Apps Script は符号付き -128〜127 で返す）を符号なしに直してから hex 化する。
 * `key`/`msg` は `Utilities.newBlob(...).getBytes()` で明示的に UTF-8 バイト列へ変換してから渡す
 * （Worker の WebCrypto 実装と同じ結果になるようにするため。契約テストは
 * `shared/test/vectors/envelope.json` を参照。この GAS アダプタ自体は実 GAS ランタイムでしか
 * 実行できないため Node の Vitest では検証できない）。
 */
import type { HmacPort } from "../app/ports";

function toUtf8Bytes(s: string): GoogleAppsScript.Byte[] {
  return Utilities.newBlob(s).getBytes();
}

function toHex(bytes: GoogleAppsScript.Byte[]): string {
  let hex = "";
  for (const b of bytes) {
    hex += (b & 0xff).toString(16).padStart(2, "0");
  }
  return hex;
}

export class HmacAdapter implements HmacPort {
  hmacHex(key: string, msg: string): string {
    const sigBytes = Utilities.computeHmacSha256Signature(toUtf8Bytes(msg), toUtf8Bytes(key));
    return toHex(sigBytes);
  }
}
