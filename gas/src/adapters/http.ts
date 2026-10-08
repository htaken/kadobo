/**
 * `HttpPort` の GAS 実装（実装設計 MF連携 §4.1）。`UrlFetchApp.fetch`、`muteHttpExceptions: true`。
 * 通信失敗（DNS 不可・タイムアウト等、レスポンス自体を得られない例外）はそのまま投げる
 * （呼び出し側の `app/mf/*Client.ts` が `MfTransientError`/`MfOutcomeUnknownError` に分類する）。
 * レスポンスヘッダのキーは小文字化して返す（`HttpPort` の契約。`Retry-After` 等の大小文字表記が
 * サーバ依存のため、呼び出し側は常に小文字キーで読めるようにする）。
 */
import type { HttpPort } from "../app/ports";

function lowercaseHeaders(headers: object): Record<string, string> {
  const record = headers as Record<string, unknown>;
  const result: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    const v = record[key];
    result[key.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
  }
  return result;
}

export class HttpAdapter implements HttpPort {
  fetch(req: {
    method: "get" | "post" | "put" | "delete";
    url: string;
    headers?: Record<string, string>;
    payload?: string;
    contentType?: string;
  }): { status: number; headers: Record<string, string>; body: string } {
    const options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions = {
      method: req.method,
      muteHttpExceptions: true,
    };
    if (req.headers !== undefined) {
      options.headers = req.headers;
    }
    if (req.payload !== undefined) {
      options.payload = req.payload;
    }
    if (req.contentType !== undefined) {
      options.contentType = req.contentType;
    }
    const res = UrlFetchApp.fetch(req.url, options);
    return {
      status: res.getResponseCode(),
      headers: lowercaseHeaders(res.getHeaders()),
      body: res.getContentText(),
    };
  }
}
