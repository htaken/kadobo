/**
 * Worker ↔ GAS 封筒検証（実装設計 §3.1, §7.4）。純関数のみ。
 * HMAC 計算・nonce 確認等の I/O は呼び出し側から注入する。`crypto` は core 内で使わない。
 */

import {
  ENVELOPE_VERSION,
  constantTimeEqual,
  envelopeSigningString,
} from "@kadobo/shared/protocol";

/** {@link verifyEnvelope} が必要とする I/O（HMAC 計算・nonce 確認・記録）。 */
export interface VerifyEnvelopeIo {
  secret: string;
  /** 検証時刻（UNIX 秒）。 */
  nowSec: number;
  /** `hex(HMAC-SHA256(key, msg))`（Worker=WebCrypto、GAS=`Utilities.computeHmacSha256Signature`）。 */
  hmacHex: (key: string, msg: string) => string;
  /** nonce が既に使用済みかどうか。 */
  nonceSeen: (nonce: string) => boolean;
  /** nonce を使用済みとして記録する。署名が正しい要求に対してのみ呼ばれる。 */
  markNonce: (nonce: string) => void;
}

export type VerifyEnvelopeResult =
  | { ok: true; payload: unknown }
  | { ok: false; reason: string };

interface RawEnvelope {
  v: unknown;
  ts: unknown;
  nonce: unknown;
  payload: unknown;
  sig: unknown;
}

function hasEnvelopeShape(
  body: unknown,
): body is RawEnvelope & { v: number; ts: number; nonce: string; payload: string; sig: string } {
  if (typeof body !== "object" || body === null) {
    return false;
  }
  const o = body as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    typeof o.ts === "number" &&
    typeof o.nonce === "string" &&
    typeof o.payload === "string" &&
    typeof o.sig === "string"
  );
}

/**
 * 封筒を検証する（実装設計 §3.1, §7.4）。
 *
 * 検証順序: (1) `v === 1` → (2) `|now - ts| <= 300` → (4) 署名一致（定時間比較）→
 * (3) nonce 未使用（実装設計 §3.1 の番号どおり、署名が正しい要求だけ nonce を消費する）。
 *
 * 受理時は署名検証後に `payload`（JSON 文字列）を `JSON.parse` して返す（実装設計 §3.1:
 * 「受信側は署名検証後に JSON.parse する」）。`payload` の JSON 形式が不正な場合は拒否する
 * （空文字列等、有効な JSON でない `payload` は本番のリクエストとしては起こり得ない想定。
 * `shared/test/vectors/envelope.json` の `empty_payload` ベクタは HMAC 計算自体の契約テスト
 * 用であり、本関数での受理は想定しない。詳細は最終報告の「未決事項」を参照）。
 */
export function verifyEnvelope(
  body: unknown,
  io: VerifyEnvelopeIo,
): VerifyEnvelopeResult {
  if (!hasEnvelopeShape(body)) {
    return { ok: false, reason: "MALFORMED" };
  }

  if (body.v !== ENVELOPE_VERSION) {
    return { ok: false, reason: "BAD_VERSION" };
  }

  if (Math.abs(io.nowSec - body.ts) > 300) {
    return { ok: false, reason: "WINDOW" };
  }

  const expectedSig = io.hmacHex(
    io.secret,
    envelopeSigningString(body.ts, body.nonce, body.payload),
  );
  if (!constantTimeEqual(expectedSig, body.sig)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  if (io.nonceSeen(body.nonce)) {
    return { ok: false, reason: "REPLAY" };
  }
  io.markNonce(body.nonce);

  let payload: unknown;
  try {
    payload = JSON.parse(body.payload);
  } catch {
    return { ok: false, reason: "BAD_PAYLOAD_JSON" };
  }

  return { ok: true, payload };
}
