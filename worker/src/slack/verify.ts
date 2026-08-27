/**
 * Slack リクエスト署名検証（実装設計 §6.1, 要件定義 §5.2, §3.2）。
 *
 * `v0=hex(HMAC-SHA256(signing_secret, "v0:" + ts + ":" + body))` を定時間比較する。
 * raw body（デコード・再シリアライズ前の文字列）に対して行うこと。
 */
import { constantTimeEqual } from "@kadobo/shared/protocol";
import { hmacSha256Hex } from "../webcrypto";

/** Slack の `X-Slack-Request-Timestamp` の許容窓（秒）。実装設計 §6.1 / 要件定義 §5.2 の「±5分」。 */
export const SLACK_TIMESTAMP_WINDOW_SEC = 300;

export interface VerifySlackSignatureInput {
  /** Slack アプリの Signing Secret。 */
  signingSecret: string;
  /** raw body（`request.text()` で読んだ文字列。デコード・再シリアライズしない）。 */
  body: string;
  /** `X-Slack-Request-Timestamp` ヘッダの値。 */
  timestampHeader: string | null;
  /** `X-Slack-Signature` ヘッダの値（`v0=...` 形式）。 */
  signatureHeader: string | null;
  /** 現在時刻（UNIX 秒）。テストで固定できるよう呼び出し側から渡す。 */
  nowSec: number;
}

/**
 * Slack リクエスト署名を検証する。
 * 失敗理由（タイムスタンプ欠落／窓外／署名不一致）は呼び出し側に区別を返さない
 * （401 として扱い、詳細は `console.warn` にも出さない。body・署名はログに出さない）。
 */
export async function verifySlackSignature(input: VerifySlackSignatureInput): Promise<boolean> {
  const { signingSecret, body, timestampHeader, signatureHeader, nowSec } = input;
  if (!timestampHeader || !signatureHeader) {
    return false;
  }
  if (!/^-?\d+$/.test(timestampHeader)) {
    return false;
  }
  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) {
    return false;
  }
  if (Math.abs(nowSec - ts) > SLACK_TIMESTAMP_WINDOW_SEC) {
    return false;
  }
  const base = `v0:${timestampHeader}:${body}`;
  const hex = await hmacSha256Hex(signingSecret, base);
  const computed = `v0=${hex}`;
  return constantTimeEqual(computed, signatureHeader);
}
