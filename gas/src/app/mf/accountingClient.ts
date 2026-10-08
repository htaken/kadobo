/**
 * 会計 API v3（API キー）のクライアント（実装設計 MF連携 §4.3）。
 *
 * `MF_ACCOUNTING_API_KEY`・`MF_OFFICE_CODE` を読む。ただし `GET /accessible_offices` は
 * `office_code` 不要なので、`MF_OFFICE_CODE` が未設定でも呼べる。
 *
 * JWT は `POST /auth/exchange`（`Authorization: Bearer <APIキー>`）で取得し、
 * `TtlCachePort` のキー `mf_acc_jwt` に 3000 秒（`expires_in` 3600 より短く）保存する。
 * 401 → キャッシュを消して再交換し、1 回だけ再試行する。403（権限不足。API キーの権限は設計書 §9）は
 * 行・対象ごとの業務エラーではなく設定不備なので {@link MfAuthError}（`service: "accounting"`）にする
 * （呼び出し側は対象の状態を変えずに上へ投げ、`notifyMfFailure` が API キーの有効性・権限の確認を依頼する）。
 *
 * 3 回/秒のレート制限に対応するため、同じインスタンス内では直前のリクエストから 350ms
 * 空ける（`clock.sleep`）。別インスタンス（別の実行）間の制御はしない（429 からの復旧で吸収する）。
 */
import { ConfigMissingError, type AppPorts } from "../ports";
import { MfAuthError, MfTransientError } from "./errors";
import {
  RETRY_AFTER_MAX_SEC,
  attemptFetch,
  classifyFinalOutcome,
  parseRetryAfterSec,
  type FetchOutcome,
  type HttpMethod,
} from "./httpOutcome";

const ACCOUNTING_BASE = "https://api-accounting.moneyforward.com/api/v3";
const AUTH_EXCHANGE_URL = "https://api.biz.moneyforward.com/auth/exchange";
const ACCESSIBLE_OFFICES_PATH = "/accessible_offices";

/** JWT キャッシュのキー（`TtlCachePort`。実装設計 §4.3）。プレフィックス `mf:` はアダプタ側が付与する。 */
export const MF_ACCOUNTING_JWT_CACHE_KEY = "mf_acc_jwt";
const JWT_CACHE_TTL_SEC = 3000;

/** 同一インスタンス内での最小リクエスト間隔（実装設計 §4.3「3 回/秒」への対応）。 */
const MIN_INTERVAL_MS = 350;

export type MfAccountingClientPorts = Pick<AppPorts, "http" | "ttlCache" | "clock" | "props">;

function requireApiKey(ports: MfAccountingClientPorts): string {
  const v = ports.props.get("MF_ACCOUNTING_API_KEY");
  if (v === null || v === "") {
    throw new ConfigMissingError(
      "MF_ACCOUNTING_API_KEY",
      "MF_ACCOUNTING_API_KEY が未設定です（実装設計 MF連携 §4.3）。",
    );
  }
  return v;
}

function requireOfficeCode(ports: MfAccountingClientPorts): string {
  const v = ports.props.get("MF_OFFICE_CODE");
  if (v === null || v === "") {
    throw new ConfigMissingError("MF_OFFICE_CODE", "MF_OFFICE_CODE が未設定です（実装設計 MF連携 §4.3）。");
  }
  return v;
}

function parseJwtResponse(body: string): string {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new MfTransientError("MF_ACCOUNTING_JWT_EXCHANGE_MALFORMED_RESPONSE");
  }
  const t = json as { access_token?: unknown };
  if (typeof t.access_token !== "string") {
    throw new MfTransientError("MF_ACCOUNTING_JWT_EXCHANGE_MALFORMED_RESPONSE");
  }
  return t.access_token;
}

function buildUrl(path: string, query: Record<string, string | string[]>, officeCode: string | null): string {
  const params: string[] = [];
  if (officeCode !== null) {
    params.push(`office_code=${encodeURIComponent(officeCode)}`);
  }
  for (const [key, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      params.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
    }
  }
  const qs = params.join("&");
  return `${ACCOUNTING_BASE}${path}${qs === "" ? "" : `?${qs}`}`;
}

export class MfAccountingClient {
  /** 直前のリクエスト送信時刻（UTC epoch ms）。インスタンス生成直後は `null`（間隔を空けない）。 */
  private lastRequestAtMs: number | null = null;

  constructor(private readonly ports: MfAccountingClientPorts) {}

  /**
   * 実装設計 §4.3「使うエンドポイント」。`query` は `key=value` を繰り返す形で組み立てる
   * （`key[]=` ではない）。`path` が `/accessible_offices` 以外なら `office_code` クエリを付ける。
   */
  request(
    method: HttpMethod,
    path: string,
    query: Record<string, string | string[]> = {},
    body?: unknown,
    opts: { create?: boolean } = {},
  ): unknown {
    const create = opts.create === true;
    const apiKey = requireApiKey(this.ports);
    const officeCode = path === ACCESSIBLE_OFFICES_PATH ? null : requireOfficeCode(this.ports);
    const url = buildUrl(path, query, officeCode);

    let jwt = this.getOrExchangeJwt(apiKey);
    let outcome = this.attempt(method, url, body, jwt);

    if (outcome.kind === "response" && outcome.value.status === 401) {
      this.ports.ttlCache.remove(MF_ACCOUNTING_JWT_CACHE_KEY);
      jwt = this.exchangeJwt(apiKey);
      outcome = this.attempt(method, url, body, jwt);
      if (outcome.kind === "response" && outcome.value.status === 401) {
        throw new MfAuthError("MF_ACCOUNTING_AUTH_FAILED_AFTER_REEXCHANGE", "accounting");
      }
    }

    if (outcome.kind === "response" && outcome.value.status === 429) {
      const retryAfterSec = parseRetryAfterSec(outcome.value.headers);
      if (retryAfterSec !== null && retryAfterSec <= RETRY_AFTER_MAX_SEC) {
        this.ports.clock.sleep(retryAfterSec * 1000);
        outcome = this.attempt(method, url, body, jwt);
        if (outcome.kind === "response" && outcome.value.status === 429) {
          throw new MfTransientError("MF_ACCOUNTING_429_RETRY_EXHAUSTED");
        }
      } else {
        throw new MfTransientError("MF_ACCOUNTING_429_RETRY_AFTER_TOO_LONG");
      }
    }

    if (outcome.kind === "response" && outcome.value.status === 403) {
      throw new MfAuthError("MF_ACCOUNTING_FORBIDDEN", "accounting");
    }

    return classifyFinalOutcome(outcome, create);
  }

  private throttle(): void {
    if (this.lastRequestAtMs !== null) {
      const elapsed = this.ports.clock.nowMs() - this.lastRequestAtMs;
      if (elapsed < MIN_INTERVAL_MS) {
        this.ports.clock.sleep(MIN_INTERVAL_MS - elapsed);
      }
    }
  }

  private markRequest(): void {
    this.lastRequestAtMs = this.ports.clock.nowMs();
  }

  private attempt(method: HttpMethod, url: string, body: unknown, jwt: string): FetchOutcome {
    this.throttle();
    const headers: Record<string, string> = { authorization: `Bearer ${jwt}` };
    const outcome =
      body === undefined
        ? attemptFetch(this.ports.http, { method, url, headers })
        : attemptFetch(this.ports.http, {
            method,
            url,
            headers,
            payload: JSON.stringify(body),
            contentType: "application/json",
          });
    this.markRequest();
    return outcome;
  }

  private getOrExchangeJwt(apiKey: string): string {
    const cached = this.ports.ttlCache.get(MF_ACCOUNTING_JWT_CACHE_KEY);
    if (cached !== null) {
      return cached;
    }
    return this.exchangeJwt(apiKey);
  }

  private exchangeJwt(apiKey: string): string {
    this.throttle();
    const outcome = attemptFetch(this.ports.http, {
      method: "post",
      url: AUTH_EXCHANGE_URL,
      headers: { authorization: `Bearer ${apiKey}` },
    });
    this.markRequest();

    if (outcome.kind === "network_failure") {
      throw new MfTransientError("MF_ACCOUNTING_JWT_EXCHANGE_NETWORK_FAILURE");
    }
    const res = outcome.value;
    if (res.status === 429 || res.status >= 500) {
      throw new MfTransientError(`MF_ACCOUNTING_JWT_EXCHANGE_FAILED:${res.status}`);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new MfAuthError(`MF_ACCOUNTING_JWT_EXCHANGE_FAILED:${res.status}`, "accounting");
    }
    const jwt = parseJwtResponse(res.body);
    this.ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, jwt, JWT_CACHE_TTL_SEC);
    return jwt;
  }
}

export function makeMfAccountingClient(ports: MfAccountingClientPorts): MfAccountingClient {
  return new MfAccountingClient(ports);
}
