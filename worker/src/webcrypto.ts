/**
 * WebCrypto ユーティリティ（実装設計 §3.1, §6.1）。
 *
 * Worker ランタイム（workerd）・Node（Vitest, `environment: "node"`）の両方で
 * `crypto.subtle` / `crypto.getRandomValues` がグローバルに利用できる前提で実装する。
 */

const HEX_CHARS = "0123456789abcdef";

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number;
    hex += HEX_CHARS[(b >> 4) & 0xf];
    hex += HEX_CHARS[b & 0xf];
  }
  return hex;
}

/** `n` バイトの暗号学的乱数を返す。ULID の乱数部（`shared/src/ids.ts`）に注入する。 */
export function randomBytes(n: number): Uint8Array {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return arr;
}

/** `n` バイトの暗号学的乱数を hex 文字列（`2n` 文字）で返す。封筒の `nonce`（16 バイト）に使う。 */
export function randomHex(byteLen: number): string {
  return bytesToHex(randomBytes(byteLen));
}

/** `hex(HMAC-SHA256(secret, message))`（小文字）。Slack 署名検証・封筒署名の双方で使う。 */
export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(sigBuf));
}

/** `hex(SHA-256(message))`（小文字）。モーダル送信の冪等キー（`shared/src/ids.ts` の `modalIdempotencyKey`）に使う。 */
export async function sha256Hex(message: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(message));
  return bytesToHex(new Uint8Array(digest));
}
