/**
 * `MfInvoiceClient`/`MfAccountingClient` 共通の HTTP 応答分類（実装設計 MF連携 §4.2, §4.3）。
 * 429・5xx・通信失敗・その他 4xx の分類ロジックを一本化し、2 つのクライアントで食い違いが
 * 出ないようにする。401 の再試行判断（トークン更新の要否）はクライアントごとに違う（請求書は
 * リフレッシュトークン、会計は JWT 再交換）ため、ここには含めない。
 */
import type { HttpPort } from "../ports";
import { MfApiError, MfOutcomeUnknownError, MfTransientError, parseMfApiErrorBody } from "./errors";

export type HttpMethod = "get" | "post" | "put" | "delete";

export interface HttpResult {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** `HttpPort.fetch` の結果。通信失敗（例外）は `network_failure` としてここで吸収する。 */
export type FetchOutcome = { kind: "response"; value: HttpResult } | { kind: "network_failure" };

/** 429 の `Retry-After` がこれ以下（秒）なら 1 回だけ待って再試行する（実装設計 §4.2, §4.3）。 */
export const RETRY_AFTER_MAX_SEC = 10;

/** `HttpPort.fetch` を呼び、通信失敗（例外）を `FetchOutcome` に写像する。 */
export function attemptFetch(
  http: HttpPort,
  req: {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    payload?: string;
    contentType?: string;
  },
): FetchOutcome {
  try {
    const value = http.fetch(req);
    return { kind: "response", value };
  } catch {
    return { kind: "network_failure" };
  }
}

/** レスポンスヘッダ（小文字キー）から `retry-after`（秒）を数値で読む。無い・数値でなければ `null`。 */
export function parseRetryAfterSec(headers: Record<string, string>): number | null {
  const raw = headers["retry-after"];
  if (raw === undefined) {
    return null;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * 401・429 の再試行判断がすべて終わった後の最終分類（実装設計 §4.2 手順 4〜5, §4.3）。
 * - 通信失敗・5xx → `create` なら {@link MfOutcomeUnknownError}、そうでなければ {@link MfTransientError}
 * - 2xx → JSON をパースして返す（本文が空なら `undefined`）
 * - それ以外の 4xx → {@link MfApiError}（本文の `errors[].code`/`message` を短く添える）
 *
 * ここに渡す `outcome` は呼び出し側で 401・429 の再試行を尽くした後のものである前提
 * （401・429 がここに残っていた場合も、契約が想定しない状態として 4xx 分類にフォールバックする）。
 */
export function classifyFinalOutcome(outcome: FetchOutcome, create: boolean): unknown {
  if (outcome.kind === "network_failure") {
    throw create ? new MfOutcomeUnknownError("MF_NETWORK_FAILURE") : new MfTransientError("MF_NETWORK_FAILURE");
  }
  const res = outcome.value;
  if (res.status >= 200 && res.status < 300) {
    if (res.body === "") {
      return undefined;
    }
    try {
      return JSON.parse(res.body);
    } catch {
      return undefined;
    }
  }
  if (res.status >= 500) {
    throw create ? new MfOutcomeUnknownError(`MF_5XX:${res.status}`) : new MfTransientError(`MF_5XX:${res.status}`);
  }
  const parsed = parseMfApiErrorBody(res.body);
  throw new MfApiError(res.status, parsed?.code, parsed?.message);
}
