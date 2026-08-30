/**
 * Worker ↔ GAS プロトコル（実装設計 §3）。
 *
 * - 封筒生成（Worker → GAS）と GAS への POST・レスポンス判定（§3.1〜§3.3）
 * - 受信した封筒の検証（GAS → Worker `/internal/status`、§3.4）
 *
 * `fetchImpl` は既定でグローバル `fetch`。テストではスタブ関数を注入する
 * （実装設計の「GAS はフェイク（`fetch` をスタブ）で再現」に対応）。
 */
import {
  ENVELOPE_VERSION,
  ENVELOPE_WINDOW_SEC,
  GAS_TIMEOUT_MS,
  constantTimeEqual,
  envelopeSigningString,
  isGasResponse,
  type Envelope,
  type GasRequest,
} from "@kadobo/shared/protocol";
import type { Env } from "./env";
import type { AttemptOutcome } from "./journal";
import * as journal from "./journal";
import { hmacSha256Hex, randomHex } from "./webcrypto";

export interface BuildEnvelopeOptions {
  /** テスト用: 現在時刻（UNIX 秒）を固定する。既定は `Math.floor(Date.now() / 1000)`。 */
  nowSec?: () => number;
  /** テスト用: nonce を固定する。既定は 16 バイト乱数の hex。 */
  nonceHex?: () => string;
}

/** 封筒を生成する（実装設計 §3.1）。`payload` は文字列化済みでなければならない。 */
export async function buildEnvelope(
  secret: string,
  payload: string,
  opts: BuildEnvelopeOptions = {},
): Promise<Envelope> {
  const ts = (opts.nowSec ?? (() => Math.floor(Date.now() / 1000)))();
  const nonce = (opts.nonceHex ?? (() => randomHex(16)))();
  const sig = await hmacSha256Hex(secret, envelopeSigningString(ts, nonce, payload));
  return { v: ENVELOPE_VERSION, ts, nonce, payload, sig };
}

export interface SendToGasOptions extends BuildEnvelopeOptions {
  fetchImpl?: typeof fetch;
  /** テスト用: タイムアウト（ms）。既定は `GAS_TIMEOUT_MS`（25000）。 */
  timeoutMs?: number;
}

/**
 * GAS へ封筒を POST し、実装設計 §3.3 の表に従って結果を分類する。
 *
 * - HTTP≠200／本文が JSON でない／`ok` 無し／タイムアウト／ネットワーク例外 → `pending`
 * - `ok:true`（`applied` 問わず） → `done`
 * - `ok:false, retryable:true` → `pending`
 * - `ok:false, retryable:false` → `rejected`
 */
export async function sendToGas(
  env: Pick<Env, "GAS_URL" | "GAS_SHARED_SECRET">,
  request: GasRequest,
  opts: SendToGasOptions = {},
): Promise<AttemptOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? GAS_TIMEOUT_MS;
  const payload = JSON.stringify(request);
  const envelope = await buildEnvelope(env.GAS_SHARED_SECRET, payload, opts);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(env.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
      redirect: "follow",
      signal: controller.signal,
    });
    if (res.status !== 200) {
      return { status: "pending", error: `http_${res.status}` };
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return { status: "pending", error: "non_json_response" };
    }
    if (!isGasResponse(json)) {
      return { status: "pending", error: "invalid_response_shape" };
    }
    if (json.ok) {
      return { status: "done" };
    }
    if (json.retryable) {
      return { status: "pending", error: json.error };
    }
    return { status: "rejected", error: json.error };
  } catch (err) {
    if (controller.signal.aborted) {
      return { status: "pending", error: "timeout" };
    }
    return { status: "pending", error: err instanceof Error ? err.message : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

export interface VerifyIncomingEnvelopeResult {
  ok: boolean;
  /** 検証成功時: `JSON.parse` 前のペイロード文字列。 */
  payload?: string;
  reason?: string;
}

/**
 * GAS → Worker `/internal/status` で受け取った封筒を検証する（実装設計 §3.1, §3.4）。
 * 検証順序: (1) v===1 (2) |now-ts|<=300 (4) 署名を定時間比較 (3) nonce 未使用
 * （署名が正しい要求だけ nonce を消費する）。
 */
export async function verifyIncomingEnvelope(
  db: D1Database,
  secret: string,
  rawBody: string,
  opts: { nowSec?: number } = {},
): Promise<VerifyIncomingEnvelopeResult> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid_json" };
  }
  if (!isEnvelopeShape(parsed)) {
    return { ok: false, reason: "invalid_envelope" };
  }
  if (parsed.v !== 1) {
    return { ok: false, reason: "bad_version" };
  }
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - parsed.ts) > ENVELOPE_WINDOW_SEC) {
    return { ok: false, reason: "stale_timestamp" };
  }
  const expectedSig = await hmacSha256Hex(secret, envelopeSigningString(parsed.ts, parsed.nonce, parsed.payload));
  if (!constantTimeEqual(expectedSig, parsed.sig)) {
    return { ok: false, reason: "bad_signature" };
  }
  const seen = await journal.isNonceSeen(db, parsed.nonce);
  if (seen) {
    return { ok: false, reason: "nonce_reused" };
  }
  await journal.markNonceSeen(db, parsed.nonce, Date.now());
  return { ok: true, payload: parsed.payload };
}

function isEnvelopeShape(x: unknown): x is Envelope {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const o = x as Record<string, unknown>;
  return (
    typeof o.v === "number" &&
    typeof o.ts === "number" &&
    typeof o.nonce === "string" &&
    typeof o.payload === "string" &&
    typeof o.sig === "string"
  );
}
