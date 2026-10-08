/**
 * 依存無しの Base64 エンコード（実装設計 MF連携 §4.2）。`MfInvoiceClient.refresh` が
 * `Authorization: Basic base64(client_id:client_secret)` を組み立てるのに使う。
 *
 * `Utilities.base64Encode`（GAS）には依存しない（core 層は GAS グローバルに一切依存しない方針、
 * `core/index.ts` 冒頭コメント）。Node の `Buffer` にも依存しない（`gas/tsconfig.json` は
 * `@types/node` を含まない）。入力は UTF-8 としてエンコードする。
 */

const TABLE = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** 文字列を UTF-8 バイト列（0〜255 の配列）に変換する。サロゲートペアも扱う。 */
function utf8Bytes(input: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.codePointAt(i);
    if (code === undefined) {
      continue;
    }
    if (code > 0xffff) {
      i++; // サロゲートペアの後半を読み飛ばす（codePointAt が両方をまとめて返すため）。
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return bytes;
}

/** UTF-8 文字列を Base64（標準アルファベット、パディング `=` あり）にエンコードする。 */
export function base64EncodeUtf8(input: string): string {
  const bytes = utf8Bytes(input);
  let result = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    result += TABLE[b0 >> 2]!;
    result += TABLE[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)]!;
    result += b1 === undefined ? "=" : TABLE[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)]!;
    result += b2 === undefined ? "=" : TABLE[b2 & 0x3f]!;
  }
  return result;
}
