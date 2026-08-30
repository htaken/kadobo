/**
 * `sendToGas` の GAS 応答→journal status マッピングテスト（実装設計 §3.3）。
 *
 * GAS は `fetch` をスタブ関数に差し替えることでフェイクする（ハーネス不要のユニットテスト）。
 * §3.3 の表の全行を再現する:
 *   HTTP≠200／非JSON／ok無し／タイムアウト／ネットワーク例外 → pending
 *   ok:true（applied問わず）                                    → done
 *   ok:false, retryable:true                                    → pending
 *   ok:false, retryable:false                                   → rejected
 */
import { describe, expect, it } from "vitest";
import { GAS_TIMEOUT_MS } from "@kadobo/shared/protocol";
import { buildEnvelope, sendToGas } from "../src/gas";

const ENV = { GAS_URL: "https://gas.example.test/exec", GAS_SHARED_SECRET: "test-gas-secret" };

const SAMPLE_REQUEST = {
  kind: "command" as const,
  idempotency_key: "U1:T1",
  user_id: "U1",
  channel_id: "C1",
  text: "" as const,
  response_url: "https://hooks.slack.test/x",
  received_at_ms: 1756260000000,
  source: "command" as const,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("sendToGas: 実装設計 §3.3 のマッピング", () => {
  it("ok:true → done", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async () => jsonResponse({ ok: true, applied: true }),
    });
    expect(outcome).toEqual({ status: "done" });
  });

  it("ok:true, applied:false（重複等） → done", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async () => jsonResponse({ ok: true, applied: false, reason: "DUPLICATE" }),
    });
    expect(outcome).toEqual({ status: "done" });
  });

  it("ok:false, retryable:true → pending", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async () => jsonResponse({ ok: false, error: "LOCK_TIMEOUT", retryable: true }),
    });
    expect(outcome).toEqual({ status: "pending", error: "LOCK_TIMEOUT" });
  });

  it("ok:false, retryable:false → rejected", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async () => jsonResponse({ ok: false, error: "SCHEMA_ERROR", retryable: false }),
    });
    expect(outcome).toEqual({ status: "rejected", error: "SCHEMA_ERROR" });
  });

  it("HTTP≠200 → pending", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async () => jsonResponse({ ok: true, applied: true }, 500),
    });
    expect(outcome.status).toBe("pending");
    if (outcome.status === "pending") {
      expect(outcome.error).toBe("http_500");
    }
  });

  it("HTML 200（非 JSON）→ pending", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async () =>
        new Response("<html><body>Authorization required</body></html>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        }),
    });
    expect(outcome.status).toBe("pending");
    if (outcome.status === "pending") {
      expect(outcome.error).toBe("non_json_response");
    }
  });

  it("JSON だが ok フィールドが無い → pending", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async () => jsonResponse({ status: "success" }),
    });
    expect(outcome.status).toBe("pending");
    if (outcome.status === "pending") {
      expect(outcome.error).toBe("invalid_response_shape");
    }
  });

  it("タイムアウト（20s）→ pending（テストでは timeoutMs を短縮して検証）", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      timeoutMs: 20, // 本番は GAS_TIMEOUT_MS=20000。テストのみ短縮する。
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    expect(outcome).toEqual({ status: "pending", error: "timeout" });
  });

  it("ネットワーク例外 → pending", async () => {
    const outcome = await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(outcome).toEqual({ status: "pending", error: "getaddrinfo ENOTFOUND" });
  });

  it("既定のタイムアウトは shared の GAS_TIMEOUT_MS(25000) と一致する", () => {
    expect(GAS_TIMEOUT_MS).toBe(25000);
  });

  it("GAS_URL への POST は redirect:'follow' を指定する（GAS の /exec は 302 を返すため）", async () => {
    let capturedInit: RequestInit | undefined;
    await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async (_input, init) => {
        capturedInit = init;
        return jsonResponse({ ok: true, applied: true });
      },
    });
    expect(capturedInit?.redirect).toBe("follow");
  });

  it("送信する封筒の payload は JSON.stringify(request) と一致し、sig は shared の HMAC 実装で検証できる", async () => {
    let sentBody: string | undefined;
    await sendToGas(ENV, SAMPLE_REQUEST, {
      fetchImpl: async (_input, init) => {
        sentBody = init?.body as string;
        return jsonResponse({ ok: true, applied: true });
      },
    });
    expect(sentBody).toBeDefined();
    const envelope = JSON.parse(sentBody as string);
    expect(envelope.payload).toBe(JSON.stringify(SAMPLE_REQUEST));
    expect(envelope.v).toBe(1);
    expect(typeof envelope.nonce).toBe("string");
    expect(envelope.nonce).toHaveLength(32);
  });
});

describe("buildEnvelope", () => {
  it("nowSec/nonceHex を注入して決定的な封筒を作れる（shared のベクタ status_probe と一致）", async () => {
    const envelope = await buildEnvelope("test-shared-secret-DO-NOT-USE-IN-PROD", '{"kind":"status"}', {
      nowSec: () => 1756260100,
      nonceHex: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    });
    expect(envelope).toEqual({
      v: 1,
      ts: 1756260100,
      nonce: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
      payload: '{"kind":"status"}',
      sig: "db81eeba0e6a1c8036c7bb7c5b60e887aada230abd2f820175d384e38e7d2b37",
    });
  });
});
