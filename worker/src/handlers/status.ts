/**
 * `POST /internal/status`（実装設計 §3.4）。GAS 22 時台トリガーが呼ぶ。
 *
 * 本文は §3.1 の封筒（`payload = JSON({kind:'status'})`）。封筒検証後、
 * `{ ok:true, pending, rejected_24h, oldest_pending_at_ms }` を返す。
 */
import type { Env } from "../env";
import { verifyIncomingEnvelope } from "../gas";
import * as journal from "../journal";

const REJECTED_WINDOW_MS = 24 * 3600 * 1000;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export async function handleInternalStatus(env: Env, rawBody: string): Promise<Response> {
  const verified = await verifyIncomingEnvelope(env.DB, env.GAS_SHARED_SECRET, rawBody);
  if (!verified.ok) {
    // 検証失敗の理由（署名・nonce 等）はログに出さない。
    return new Response("Unauthorized", { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(verified.payload ?? "");
  } catch {
    return jsonResponse({ ok: false, error: "invalid_payload", retryable: false }, 400);
  }
  if (typeof payload !== "object" || payload === null || (payload as { kind?: unknown }).kind !== "status") {
    return jsonResponse({ ok: false, error: "invalid_payload", retryable: false }, 400);
  }

  const [pending, rejected24h, oldestPendingAtMs] = await Promise.all([
    journal.countPending(env.DB),
    journal.countRejectedSince(env.DB, Date.now() - REJECTED_WINDOW_MS),
    journal.oldestPendingCreatedAt(env.DB),
  ]);

  return jsonResponse({
    ok: true,
    pending,
    rejected_24h: rejected24h,
    oldest_pending_at_ms: oldestPendingAtMs,
  });
}
