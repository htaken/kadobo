/**
 * テスト共通ユーティリティ（ハーネス非依存）。
 */

/** `ctx.waitUntil()` に積まれた Promise を記録し、`flush()` でまとめて待機できる `ExecutionContext` もどきを作る。 */
export function createTestCtx(): { ctx: ExecutionContext; flush: () => Promise<void> } {
  const tasks: Promise<unknown>[] = [];
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      tasks.push(promise);
    },
    passThroughOnException() {
      // noop
    },
  } as unknown as ExecutionContext;
  return {
    ctx,
    flush: async () => {
      await Promise.allSettled(tasks);
    },
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** テスト用の `Env`。`DB` は呼び出し側で harness の実バインディングを渡す。 */
export function makeEnv(db: D1Database): {
  DB: D1Database;
  SLACK_SIGNING_SECRET: string;
  SLACK_BOT_TOKEN: string;
  GAS_SHARED_SECRET: string;
  GAS_URL: string;
} {
  return {
    DB: db,
    SLACK_SIGNING_SECRET: "test-slack-signing-secret",
    SLACK_BOT_TOKEN: "xoxb-test-token",
    GAS_SHARED_SECRET: "test-gas-shared-secret",
    GAS_URL: "https://gas.example.test/exec",
  };
}

export interface RecordedCall {
  url: string;
  method: string;
  body: unknown;
}

/**
 * `fetch` の呼び出しを記録し、`router(url, init)` に委譲するスタブ。
 * Slack API・GAS・`response_url` の 3 種の送信先をテストごとに自由に振り分けられる。
 * `router` を渡さない呼び出しはデフォルトで Slack API に `{ok:true}`（`views.open` は `view.id` 付き）
 * を返す。
 */
export function createFetchStub(
  router?: (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined,
): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });

    const routed = router?.(url, init);
    if (routed) {
      return routed;
    }
    if (url.includes("slack.com/api")) {
      if (url.includes("/views.open")) {
        return jsonResponse({ ok: true, view: { id: "V_STUB" } });
      }
      return jsonResponse({ ok: true });
    }
    // 既定（GAS・response_url 等の未指定ルート）: 成功として扱う。
    return jsonResponse({ ok: true, applied: true });
  }) as typeof fetch;
  return { fetchImpl, calls };
}
