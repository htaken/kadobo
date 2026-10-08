/**
 * 請求書 API v3（OAuth）のクライアント（実装設計 MF連携 §4.2）。
 *
 * トークンは Script Property `MF_INVOICE_TOKENS` の 1 キーに JSON
 * `{access_token, refresh_token, refreshed_at, generation}` で持つ。複数キーの書込みは
 * 原子的と保証されないため（Google 公式ドキュメントに記載が無い）、1 キーにまとめて新旧が
 * 混ざらないようにする。
 *
 * `request()` は 401 → `refresh()` → 1 回だけ再試行、429 → `Retry-After`（≤10 秒）待って
 * 1 回だけ再試行、5xx・通信失敗は `create`（作成系 POST）なら {@link MfOutcomeUnknownError}、
 * そうでなければ {@link MfTransientError}、その他 4xx は {@link MfApiError} にする。
 *
 * `refresh()` は {@link AuthLockPort}（ユーザーロック）の中で読み直し、`generation` が
 * 呼び出し時と違えば「別の実行がすでに更新した」とみなしてトークンエンドポイントを呼ばない
 * （M1・M2。実装設計 §4.2 の `refresh(usedGeneration)` 擬似コードそのまま）。
 */
import { base64EncodeUtf8 } from "../../core/base64";
import { ConfigMissingError, type AppPorts } from "../ports";
import { MfAuthError, MfReauthRequiredError, MfTransientError } from "./errors";
import {
  RETRY_AFTER_MAX_SEC,
  attemptFetch,
  classifyFinalOutcome,
  parseRetryAfterSec,
  type HttpMethod,
} from "./httpOutcome";

const INVOICE_BASE = "https://invoice.moneyforward.com/api/v3";
const TOKEN_URL = "https://api.biz.moneyforward.com/token";

/** `MF_INVOICE_TOKENS` の Script Property キー（実装設計 §4.2）。 */
export const MF_INVOICE_TOKENS_KEY = "MF_INVOICE_TOKENS";

interface InvoiceTokens {
  access_token: string;
  refresh_token: string;
  /** UTC epoch ms。 */
  refreshed_at: number;
  generation: number;
}

export type MfInvoiceClientPorts = Pick<AppPorts, "http" | "secrets" | "authLock" | "clock" | "props">;

function parseTokens(raw: string | null): InvoiceTokens {
  if (raw === null) {
    throw new MfReauthRequiredError("MF_INVOICE_TOKENS_MISSING", "invoice");
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new MfReauthRequiredError("MF_INVOICE_TOKENS_INVALID_JSON", "invoice");
  }
  const t = json as Partial<InvoiceTokens>;
  if (
    typeof t.access_token !== "string" ||
    typeof t.refresh_token !== "string" ||
    typeof t.refreshed_at !== "number" ||
    typeof t.generation !== "number"
  ) {
    throw new MfReauthRequiredError("MF_INVOICE_TOKENS_INVALID_SHAPE", "invoice");
  }
  return { access_token: t.access_token, refresh_token: t.refresh_token, refreshed_at: t.refreshed_at, generation: t.generation };
}

function readTokens(ports: MfInvoiceClientPorts): InvoiceTokens {
  return parseTokens(ports.secrets.get(MF_INVOICE_TOKENS_KEY));
}

function requireClientCred(ports: MfInvoiceClientPorts, key: "MF_CLIENT_ID" | "MF_CLIENT_SECRET"): string {
  const v = ports.props.get(key);
  if (v === null || v === "") {
    throw new ConfigMissingError(
      key,
      `${key} が未設定です（実装設計 MF連携 §4.2）。MF のアプリポータルで発行した値を Script Property に設定してください。`,
    );
  }
  return v;
}

function isInvalidGrant(body: string): boolean {
  try {
    const json = JSON.parse(body) as { error?: unknown };
    return json.error === "invalid_grant";
  } catch {
    return false;
  }
}

function parseTokenEndpointResponse(body: string): { access_token: string; refresh_token: string } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MfTransientError("MF_TOKEN_REFRESH_MALFORMED_RESPONSE");
  }
  const t = json as { access_token?: unknown; refresh_token?: unknown };
  if (typeof t.access_token !== "string" || typeof t.refresh_token !== "string") {
    throw new MfTransientError("MF_TOKEN_REFRESH_MALFORMED_RESPONSE");
  }
  return { access_token: t.access_token, refresh_token: t.refresh_token };
}

/**
 * `refresh(usedGeneration)`（実装設計 §4.2）。401 を受けたときだけ呼ぶ。`AuthLockPort` の中で
 * 読み直し、`generation` が `usedGeneration` と違えば（＝別の実行がすでに更新した）
 * トークンエンドポイントを呼ばずにその `access_token` を返す。
 *
 * クラスの外にエクスポートしておくことで、「同じ旧トークンで 401 を受けた 2 つの呼び出しが
 * `/token` を 1 回しか呼ばない」という並行性の契約を、`request()` 経由の間接テストだけでなく
 * 直接の単体テストでも検証できるようにする。
 */
export function refreshInvoiceTokens(ports: MfInvoiceClientPorts, usedGeneration: number): string {
  return ports.authLock.withAuthLock(() => {
    const current = readTokens(ports);
    if (current.generation !== usedGeneration) {
      return current.access_token;
    }

    const clientId = requireClientCred(ports, "MF_CLIENT_ID");
    const clientSecret = requireClientCred(ports, "MF_CLIENT_SECRET");
    const basic = base64EncodeUtf8(`${clientId}:${clientSecret}`);
    const payload = `grant_type=refresh_token&refresh_token=${encodeURIComponent(current.refresh_token)}`;

    const outcome = attemptFetch(ports.http, {
      method: "post",
      url: TOKEN_URL,
      headers: { authorization: `Basic ${basic}` },
      payload,
      contentType: "application/x-www-form-urlencoded",
    });

    if (outcome.kind === "network_failure") {
      throw new MfTransientError("MF_TOKEN_REFRESH_NETWORK_FAILURE");
    }
    const res = outcome.value;
    if (res.status === 429 || res.status >= 500) {
      throw new MfTransientError(`MF_TOKEN_REFRESH_FAILED:${res.status}`);
    }
    if (res.status === 400 && isInvalidGrant(res.body)) {
      throw new MfReauthRequiredError("MF_TOKEN_REFRESH_INVALID_GRANT", "invoice");
    }
    if (res.status < 200 || res.status >= 300) {
      // レビュー指摘: 429・5xx・通信失敗（上記で処理済み）・invalid_grant（上記で処理済み）
      // 以外の非 2xx（401・403・400 の invalid_grant 以外 等）を `MfTransientError` にすると、
      // `invalid_client` のような時間経過では直らない認証・設定不備が毎時リトライされ続け、
      // 6 回目に notify.ts の「一時障害が続いています」という誤った通知が出てしまう。
      // ここはリフレッシュトークン自体は失われていないが、クライアント認証・設定の問題として
      // `MfAuthError` にする。
      throw new MfAuthError(`MF_TOKEN_REFRESH_FAILED:${res.status}`, "invoice");
    }

    const parsed = parseTokenEndpointResponse(res.body);
    const next: InvoiceTokens = {
      access_token: parsed.access_token,
      refresh_token: parsed.refresh_token,
      refreshed_at: ports.clock.nowMs(),
      generation: current.generation + 1,
    };
    const serialized = JSON.stringify(next);
    ports.secrets.set(MF_INVOICE_TOKENS_KEY, serialized);
    if (ports.secrets.get(MF_INVOICE_TOKENS_KEY) !== serialized) {
      // 読み直しが一致しない → もう 1 回 set して確認する（実装設計 §4.2）。
      ports.secrets.set(MF_INVOICE_TOKENS_KEY, serialized);
      if (ports.secrets.get(MF_INVOICE_TOKENS_KEY) !== serialized) {
        // それでも一致しない → 取得した新トークンは保存できず失われている。
        throw new MfReauthRequiredError("MF_TOKEN_SAVE_VERIFY_FAILED", "invoice");
      }
    }
    return next.access_token;
  });
}

export class MfInvoiceClient {
  constructor(private readonly ports: MfInvoiceClientPorts) {}

  /**
   * 実装設計 §4.2「呼び出し」。`opts.create` は作成系 POST（例: `/invoice_template_billings`）
   * で `true` を渡す（5xx・通信失敗の分類が変わる）。成功時は JSON をパースして返す。
   */
  request(method: HttpMethod, path: string, body?: unknown, opts: { create?: boolean } = {}): unknown {
    const create = opts.create === true;
    const tokens = readTokens(this.ports);
    const usedGeneration = tokens.generation;
    let accessToken = tokens.access_token;

    let outcome = attemptFetch(this.ports.http, this.buildRequest(method, path, body, accessToken));

    if (outcome.kind === "response" && outcome.value.status === 401) {
      accessToken = refreshInvoiceTokens(this.ports, usedGeneration);
      outcome = attemptFetch(this.ports.http, this.buildRequest(method, path, body, accessToken));
      if (outcome.kind === "response" && outcome.value.status === 401) {
        throw new MfAuthError("MF_INVOICE_AUTH_FAILED_AFTER_REFRESH", "invoice");
      }
    }

    if (outcome.kind === "response" && outcome.value.status === 429) {
      const retryAfterSec = parseRetryAfterSec(outcome.value.headers);
      if (retryAfterSec !== null && retryAfterSec <= RETRY_AFTER_MAX_SEC) {
        this.ports.clock.sleep(retryAfterSec * 1000);
        outcome = attemptFetch(this.ports.http, this.buildRequest(method, path, body, accessToken));
        if (outcome.kind === "response" && outcome.value.status === 429) {
          throw new MfTransientError("MF_INVOICE_429_RETRY_EXHAUSTED");
        }
      } else {
        throw new MfTransientError("MF_INVOICE_429_RETRY_AFTER_TOO_LONG");
      }
    }

    return classifyFinalOutcome(outcome, create);
  }

  private buildRequest(
    method: HttpMethod,
    path: string,
    body: unknown,
    accessToken: string,
  ): { method: HttpMethod; url: string; headers: Record<string, string>; payload?: string; contentType?: string } {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}` };
    if (body === undefined) {
      return { method, url: `${INVOICE_BASE}${path}`, headers };
    }
    return {
      method,
      url: `${INVOICE_BASE}${path}`,
      headers,
      payload: JSON.stringify(body),
      contentType: "application/json",
    };
  }
}

export function makeMfInvoiceClient(ports: MfInvoiceClientPorts): MfInvoiceClient {
  return new MfInvoiceClient(ports);
}
