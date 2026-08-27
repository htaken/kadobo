/**
 * 冪等キー生成・ULID（実装設計 §4.2, §4.3）。
 * DOM/Node 固有 API・`crypto` に依存しない。乱数源は呼び出し側から注入する。
 */

/** ボタン（stamp / open_correction）の冪等キーの入力（実装設計 §4.2）。 */
export interface ButtonIdempotencyKeyInput {
  user_id: string;
  message_ts: string;
  action_id: string;
  /** Slack の `action_ts`（例 `"1756260000.123456"`）。 */
  action_ts: string;
}

/** `${user_id}:${message_ts}:${action_id}:${action_ts}`（実装設計 §4.2）。 */
export function buttonIdempotencyKey(
  input: ButtonIdempotencyKeyInput,
): string {
  return `${input.user_id}:${input.message_ts}:${input.action_id}:${input.action_ts}`;
}

/**
 * モーダル送信の冪等キー（実装設計 §4.2）。
 * `${view_id}:${sha256hex(JSON.stringify(view.state.values)).slice(0,16)}`。
 * ハッシュ計算自体は呼び出し側（Worker=WebCrypto、GAS=Utilities）が行い、
 * 先頭 16 文字の hex 文字列をここへ渡す。
 */
export function modalIdempotencyKey(
  viewId: string,
  stateValuesHashHex16: string,
): string {
  return `${viewId}:${stateValuesHashHex16}`;
}

/** `${user_id}:${trigger_id}`（実装設計 §4.2）。 */
export function commandIdempotencyKey(
  userId: string,
  triggerId: string,
): string {
  return `${userId}:${triggerId}`;
}

/** Crockford Base32（`I`, `L`, `O`, `U` を除く 32 文字）。ULID の文字集合。 */
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID の時刻部の長さ（文字数）。48 bit を 5 bit ずつ 10 文字で表す。 */
const TIME_LEN = 10;

/** ULID の乱数部の長さ（文字数）。80 bit を 5 bit ずつ 16 文字で表す。 */
const RANDOM_LEN = 16;

/** 乱数部で消費するバイト数（80 bit = 10 byte）。 */
const RANDOM_BYTES = 10;

function encodeTime(nowMs: number, len: number): string {
  let value = Math.floor(nowMs);
  let out = "";
  for (let i = 0; i < len; i++) {
    const mod = value % 32;
    out = CROCKFORD_ALPHABET[mod] + out;
    value = (value - mod) / 32;
  }
  return out;
}

function encodeRandom(bytes: Uint8Array, len: number): string {
  // bytes を 1 個のビット列とみなし、先頭から 5 bit ずつ切り出して符号化する。
  let bits = "";
  for (const b of bytes) {
    bits += b.toString(2).padStart(8, "0");
  }
  let out = "";
  for (let i = 0; i < len; i++) {
    const chunk = bits.slice(i * 5, i * 5 + 5).padEnd(5, "0");
    out += CROCKFORD_ALPHABET[parseInt(chunk, 2)];
  }
  return out;
}

/**
 * ULID を生成する（実装設計 §4.3）。10 文字の時刻部＋16 文字の乱数部＝26 文字。
 * 乱数源は注入する（Worker=`crypto.getRandomValues`、GAS=`Utilities.getUuid()` から得たバイト列）。
 * 同一 ms 内での単調増加は保証しない（要件上、不要）。
 */
export function ulid(
  nowMs: number,
  randomBytes: (n: number) => Uint8Array,
): string {
  const time = encodeTime(nowMs, TIME_LEN);
  const random = encodeRandom(randomBytes(RANDOM_BYTES), RANDOM_LEN);
  return time + random;
}
