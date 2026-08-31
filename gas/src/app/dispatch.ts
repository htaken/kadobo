/**
 * `doPost` のディスパッチ本体（実装設計 §7.5）。GAS グローバル（`ContentService` 等）に
 * 一切依存しないため、Node の Vitest でポートをフェイクに差し替えてテストできる。
 * `entry.ts` はこのファイルの {@link handlePostBody} を呼ぶだけの薄いラッパになる。
 */
import type { GasRequest, GasResponse } from "@kadobo/shared/protocol";
import { verifyEnvelope, type VerifyEnvelopeIo } from "../core/envelope";
import { handleCommand } from "./command";
import { handleCorrectionSubmit, handleOpenCorrection } from "./correction";
import { LockTimeoutError, type AppPorts } from "./ports";
import { handleStamp } from "./stamp";
import { isGasRequest } from "./validateRequest";

/**
 * 生の POST 本文（文字列）を受け取り、JSON parse → {@link dispatch} を行う。
 * 本文が有効な JSON でない場合は `{ok:false, error:'MALFORMED_BODY', retryable:false}`。
 */
export function handlePostBody(rawBody: string, ports: AppPorts): GasResponse {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "MALFORMED_BODY", retryable: false };
  }
  return dispatch(body, ports);
}

/**
 * 封筒検証 → `GasRequest` 型検証 → `LockService` 下でのディスパッチ（実装設計 §7.5）。
 *
 * - 封筒検証失敗 → `{ok:false, error:'UNAUTHORIZED', retryable:false}`
 * - `GasRequest` の型検証失敗 → `{ok:false, error:'BAD_REQUEST', retryable:false}`
 * - ロック取得不可 → `{ok:false, error:'LOCK_TIMEOUT', retryable:true}`
 * - その他の例外（Sheets の一時エラー等）→ `{ok:false, error:message, retryable:true}`
 *
 * 「生ログ追記後の Slack 更新失敗は `applied:true`」は各ユースケース
 * （`stamp.ts`/`correction.ts`）側でカード再描画の例外を握りつぶすことで満たしている。
 */
export function dispatch(body: unknown, ports: AppPorts): GasResponse {
  const secret = ports.props.get("GAS_SHARED_SECRET") ?? "";
  const io: VerifyEnvelopeIo = {
    secret,
    nowSec: ports.clock.nowSec(),
    hmacHex: (key, msg) => ports.hmac.hmacHex(key, msg),
    nonceSeen: (n) => ports.cache.nonceSeen(n),
    markNonce: (n) => ports.cache.markNonce(n),
  };

  const verified = verifyEnvelope(body, io);
  if (!verified.ok) {
    return { ok: false, error: "UNAUTHORIZED", retryable: false };
  }

  if (!isGasRequest(verified.payload)) {
    return { ok: false, error: "BAD_REQUEST", retryable: false };
  }
  const req = verified.payload;

  try {
    return ports.lock.withLock(() => routeRequest(req, ports));
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      return { ok: false, error: "LOCK_TIMEOUT", retryable: true };
    }
    return { ok: false, error: errorMessage(err), retryable: true };
  }
}

function routeRequest(req: GasRequest, ports: AppPorts): GasResponse {
  switch (req.kind) {
    case "stamp":
      return handleStamp(req, ports);
    case "open_correction":
      return handleOpenCorrection(req, ports);
    case "correction_submit":
      return handleCorrectionSubmit(req, ports);
    case "command":
      return handleCommand(req, ports);
    case "expense_submit":
      // WP8b（`handleExpenseSubmit`）で置き換える。それまでは明示的に未実装を返す。
      // Worker 側の `/keihi` は WP6 まで定型 ephemeral のままなので、この分岐へは到達しない。
      return { ok: false, error: "NOT_IMPLEMENTED", retryable: false };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
