/**
 * `UrlFetchApp` の最小フェイク（`gas/src/adapters/slack.ts` のテスト専用）。
 *
 * `SlackAdapter`/`postToResponseUrl` は GAS のグローバル `UrlFetchApp.fetch` を直接呼ぶため、
 * Node/Vitest 上で動かすにはこのグローバルを差し替える必要がある
 * （`./fakeSpreadsheetApp.ts` の `installFakeSpreadsheetApp` と同じパターン）。
 *
 * 各 `fetch` 呼び出しを `calls` に記録し、`queueResponse` で積んだレスポンスを順番に返す
 * （キューが空なら既定で `{ ok: true }` / HTTP 200 を返す）。
 */

export interface FakeFetchParams {
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  payload?: string;
  muteHttpExceptions?: boolean;
}

export interface FakeFetchCall {
  url: string;
  params: FakeFetchParams;
}

/** `queueResponse` の追加オプション（`slackFiles.ts` のバイナリ取得・ヘッダー検証テスト用）。 */
export interface FakeFetchResponseOptions {
  /** `res.getHeaders()` が返すヘッダー（`slackFiles.ts` は `Retry-After` を読む）。 */
  headers?: Record<string, string>;
  /** `res.getBlob().getBytes()` が返すバイト列（`slackFiles.ts` のダウンロード内容）。 */
  bytes?: number[];
  /** `res.getBlob().getContentType()` が返す Content-Type。 */
  contentType?: string;
}

interface QueuedResponse extends FakeFetchResponseOptions {
  code: number;
  body: unknown;
}

export class FakeUrlFetchApp {
  calls: FakeFetchCall[] = [];
  private queue: QueuedResponse[] = [];

  /** 次回以降の `fetch` 呼び出しが返すレスポンスを 1 件積む（FIFO）。 */
  queueResponse(body: unknown, code = 200, options?: FakeFetchResponseOptions): void {
    this.queue.push({ code, body, ...options });
  }

  fetch(
    url: string,
    params?: FakeFetchParams,
  ): {
    getContentText(): string;
    getResponseCode(): number;
    getHeaders(): object;
    getBlob(): { getBytes(): number[]; getContentType(): string | null };
  } {
    this.calls.push({ url, params: params ?? {} });
    const next = this.queue.shift() ?? { code: 200, body: { ok: true } };
    return {
      getContentText: () => JSON.stringify(next.body),
      getResponseCode: () => next.code,
      getHeaders: () => next.headers ?? {},
      getBlob: () => ({
        getBytes: () => next.bytes ?? [],
        getContentType: () => next.contentType ?? null,
      }),
    };
  }
}

/** `globalThis.UrlFetchApp` にフェイクをインストールする。`restore()` で元に戻す。 */
export function installFakeUrlFetchApp(): { fake: FakeUrlFetchApp; restore: () => void } {
  const fake = new FakeUrlFetchApp();
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const previous = globalRecord.UrlFetchApp;
  globalRecord.UrlFetchApp = fake;
  return {
    fake,
    restore: () => {
      globalRecord.UrlFetchApp = previous;
    },
  };
}
