/**
 * `app/mf/accountingClient.ts`（実装設計 MF連携 §4.3）。WP-M1 の受入条件（§11.2 表）を
 * フェイク HTTP でテストする。実際の MF には一切アクセスしない。
 */
import { describe, expect, it } from "vitest";
import {
  MF_ACCOUNTING_JWT_CACHE_KEY,
  MfAccountingClient,
  pathWithId,
  type MfAccountingClientPorts,
} from "../../../src/app/mf/accountingClient";
import { MfApiError, MfAuthError, MfOutcomeUnknownError, MfTransientError } from "../../../src/app/mf/errors";
import { ConfigMissingError } from "../../../src/app/ports";
import { makeFakePorts, type FakePorts } from "../fakes";

const EXCHANGE_URL = "https://api.biz.moneyforward.com/auth/exchange";
const ACCOUNTS_URL_WITH_OFFICE = "https://api-accounting.moneyforward.com/api/v3/accounts?office_code=XXXX-YYYY";
const ACCESSIBLE_OFFICES_URL = "https://api-accounting.moneyforward.com/api/v3/accessible_offices";

function setup(ports: FakePorts): void {
  ports.props.set("MF_ACCOUNTING_API_KEY", "API_KEY_VALUE");
  ports.props.set("MF_OFFICE_CODE", "XXXX-YYYY");
}

function makeClient(ports: MfAccountingClientPorts): MfAccountingClient {
  return new MfAccountingClient(ports);
}

describe("MfAccountingClient.request", () => {
  it("JWT が未キャッシュなら /auth/exchange してから呼ぶ（office_code クエリを付ける）", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ access_token: "JWT1" }) });
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ accounts: [{}, {}] }) });

    const result = makeClient(ports).request("get", "/accounts");

    expect(result).toEqual({ accounts: [{}, {}] });
    expect(ports.http.calls).toHaveLength(2);
    expect(ports.http.calls[0]!.url).toBe(EXCHANGE_URL);
    expect(ports.http.calls[0]!.headers?.authorization).toBe("Bearer API_KEY_VALUE");
    expect(ports.http.calls[1]!.url).toBe(ACCOUNTS_URL_WITH_OFFICE);
    expect(ports.http.calls[1]!.headers?.authorization).toBe("Bearer JWT1");

    // 3000 秒でキャッシュされる（expires_in の 3600 より短く）。
    expect(ports.ttlCache.puts).toContainEqual({ key: MF_ACCOUNTING_JWT_CACHE_KEY, value: "JWT1", ttlSec: 3000 });
  });

  it("JWT がキャッシュ済みなら /auth/exchange を呼ばない", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "CACHED_JWT", 3000);
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ accounts: [] }) });

    makeClient(ports).request("get", "/accounts");

    expect(ports.http.calls).toHaveLength(1);
    expect(ports.http.calls[0]!.headers?.authorization).toBe("Bearer CACHED_JWT");
  });

  it("/accessible_offices には office_code クエリを付けない（MF_OFFICE_CODE 未設定でも呼べる）", () => {
    const ports = makeFakePorts();
    ports.props.set("MF_ACCOUNTING_API_KEY", "API_KEY_VALUE"); // office_code は設定しない
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "CACHED_JWT", 3000);
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ offices: [{ office_code: "AAAA-1111" }] }) });

    const result = makeClient(ports).request("get", "/accessible_offices");

    expect(result).toEqual({ offices: [{ office_code: "AAAA-1111" }] });
    expect(ports.http.calls[0]!.url).toBe(ACCESSIBLE_OFFICES_URL);
  });

  it("/accessible_offices 以外は MF_OFFICE_CODE 未設定だと ConfigMissingError", () => {
    const ports = makeFakePorts();
    ports.props.set("MF_ACCOUNTING_API_KEY", "API_KEY_VALUE");

    expect(() => makeClient(ports).request("get", "/accounts")).toThrow(ConfigMissingError);
    expect(ports.http.calls).toHaveLength(0);
  });

  it("MF_ACCOUNTING_API_KEY 未設定は ConfigMissingError", () => {
    const ports = makeFakePorts();
    ports.props.set("MF_OFFICE_CODE", "XXXX-YYYY");

    expect(() => makeClient(ports).request("get", "/accessible_offices")).toThrow(ConfigMissingError);
  });

  it("query は key=value を繰り返す形で組み立てる（key[]= ではない）", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
    ports.http.queueResponse({ status: 200, body: "{}" });

    makeClient(ports).request("get", "/journals", { transaction_ids: ["1", "2"], side: "EXPENSE" });

    const url = ports.http.calls[0]!.url;
    expect(url).toContain("office_code=XXXX-YYYY");
    expect(url).toContain("transaction_ids=1");
    expect(url).toContain("transaction_ids=2");
    expect(url).toContain("side=EXPENSE");
    expect(url).not.toContain("[]");
  });

  it("401 → JWT キャッシュを消して再交換し、1 回だけ再試行する", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "STALE_JWT", 3000);
    ports.http.queueResponse({ status: 401 });
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ access_token: "FRESH_JWT" }) }); // exchange
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ accounts: [] }) });

    const result = makeClient(ports).request("get", "/accounts");

    expect(result).toEqual({ accounts: [] });
    expect(ports.http.calls[0]!.headers?.authorization).toBe("Bearer STALE_JWT");
    expect(ports.http.calls[1]!.url).toBe(EXCHANGE_URL);
    expect(ports.http.calls[2]!.headers?.authorization).toBe("Bearer FRESH_JWT");
    expect(ports.ttlCache.get(MF_ACCOUNTING_JWT_CACHE_KEY)).toBe("FRESH_JWT");
  });

  it("再試行も 401 なら MfAuthError（service: accounting）", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "STALE_JWT", 3000);
    ports.http.queueResponse({ status: 401 });
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ access_token: "FRESH_JWT" }) });
    ports.http.queueResponse({ status: 401 });

    try {
      makeClient(ports).request("get", "/accounts");
      throw new Error("MfAuthError を期待した");
    } catch (e) {
      expect(e).toBeInstanceOf(MfAuthError);
      expect((e as MfAuthError).service).toBe("accounting");
    }
  });

  it("/auth/exchange 自体が 401/403 を返す（API キー無効） → MfAuthError（service: accounting。レビュー指摘）", () => {
    const ports = makeFakePorts();
    setup(ports);
    // JWT 未キャッシュ → 最初のリクエストで /auth/exchange を呼ぶ。
    ports.http.queueResponse({ status: 401 });

    try {
      makeClient(ports).request("get", "/accounts");
      throw new Error("MfAuthError を期待した");
    } catch (e) {
      expect(e).toBeInstanceOf(MfAuthError);
      expect(e).not.toBeInstanceOf(MfTransientError);
      expect((e as MfAuthError).service).toBe("accounting");
    }
  });

  it("403 は MfAuthError（service: accounting。権限不足は行ごとの業務エラーにしない）", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
    ports.http.queueResponse({
      status: 403,
      body: JSON.stringify({ errors: [{ code: "forbidden", message: "権限がありません" }] }),
    });

    try {
      makeClient(ports).request("get", "/accounts");
      throw new Error("MfAuthError を期待した");
    } catch (e) {
      expect(e).toBeInstanceOf(MfAuthError);
      expect((e as MfAuthError).service).toBe("accounting");
    }
  });

  it("429（Retry-After ≤10 秒）は 1 回だけ待って再試行する", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
    ports.http.queueResponse({ status: 429, headers: { "retry-after": "2" } });
    ports.http.queueResponse({ status: 200, body: "{}" });

    makeClient(ports).request("get", "/accounts");

    expect(ports.clock.sleeps).toContain(2000);
  });

  it("429（Retry-After >10 秒）は MfTransientError", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
    ports.http.queueResponse({ status: 429, headers: { "retry-after": "30" } });

    expect(() => makeClient(ports).request("get", "/accounts")).toThrow(MfTransientError);
  });

  describe("作成系（opts.create: true）の 5xx・通信失敗", () => {
    it("5xx → MfOutcomeUnknownError", () => {
      const ports = makeFakePorts();
      setup(ports);
      ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
      ports.http.queueResponse({ status: 500 });

      expect(() =>
        makeClient(ports).request("post", "/journals", {}, { journal: {} }, { create: true }),
      ).toThrow(MfOutcomeUnknownError);
    });

    it("通信失敗 → MfOutcomeUnknownError", () => {
      const ports = makeFakePorts();
      setup(ports);
      ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
      ports.http.queueNetworkError();

      expect(() =>
        makeClient(ports).request("post", "/journals", {}, { journal: {} }, { create: true }),
      ).toThrow(MfOutcomeUnknownError);
    });

    it("create:false の 5xx は MfTransientError", () => {
      const ports = makeFakePorts();
      setup(ports);
      ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
      ports.http.queueResponse({ status: 502 });

      expect(() => makeClient(ports).request("get", "/accounts")).toThrow(MfTransientError);
    });

    it("create:false の通信失敗は MfTransientError", () => {
      const ports = makeFakePorts();
      setup(ports);
      ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
      ports.http.queueNetworkError();

      expect(() => makeClient(ports).request("get", "/accounts")).toThrow(MfTransientError);
    });
  });
});

describe("MfAccountingClient: 350ms 間隔（実装設計 §4.3「3 回/秒」）", () => {
  it("同じインスタンスで連続してリクエストすると 350ms 未満の間隔なら sleep する", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000); // JWT 交換を避けて純粋に間隔だけ見る
    ports.http.queueResponse({ status: 200, body: "{}" });
    ports.http.queueResponse({ status: 200, body: "{}" });

    const client = makeClient(ports);
    client.request("get", "/accounts");
    client.request("get", "/accounts");

    expect(ports.clock.sleeps).toEqual([350]);
  });

  it("十分な時間が経過していれば sleep しない", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
    ports.http.queueResponse({ status: 200, body: "{}" });
    ports.http.queueResponse({ status: 200, body: "{}" });

    const client = makeClient(ports);
    client.request("get", "/accounts");
    ports.clock.currentMs += 1000; // 十分に間隔を空ける
    client.request("get", "/accounts");

    expect(ports.clock.sleeps).toEqual([]);
  });

  it("別インスタンスは間隔を共有しない（実装設計 §4.3「同じ実行の中では」）", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "JWT1", 3000);
    ports.http.queueResponse({ status: 200, body: "{}" });
    ports.http.queueResponse({ status: 200, body: "{}" });

    makeClient(ports).request("get", "/accounts");
    makeClient(ports).request("get", "/accounts"); // 新しいインスタンス

    expect(ports.clock.sleeps).toEqual([]);
  });
});

describe("MfAccountingClient: トークン・API キーのログ非漏洩（実装設計 §4.4）", () => {
  it("エラーメッセージに API キー・JWT を含まない", () => {
    const ports = makeFakePorts();
    setup(ports);
    ports.ttlCache.put(MF_ACCOUNTING_JWT_CACHE_KEY, "SECRET_JWT_VALUE", 3000);
    ports.http.queueResponse({
      status: 422,
      body: JSON.stringify({ errors: [{ code: "invalid", message: "不正な入力です" }] }),
    });

    try {
      makeClient(ports).request("get", "/accounts");
      throw new Error("MfApiError を期待した");
    } catch (e) {
      const err = e as Error;
      expect(err.message).not.toContain("API_KEY_VALUE");
      expect(err.message).not.toContain("SECRET_JWT_VALUE");
    }
  });
});

describe("pathWithId（ID をパスに置くときのエンコードを集約）", () => {
  it("MF が返したパーセントエンコード済みの ID に encodeURIComponent を 1 回かける（仮説 H1）", () => {
    expect(pathWithId("/journals", "qgmk%2B0le%3D")).toBe("/journals/qgmk%252B0le%253D");
    expect(pathWithId("/journals", "abc")).toBe("/journals/abc");
  });

  it("decodeURIComponent すると MF が返した ID に戻る（サーバーが 1 回デコードして比較する前提）", () => {
    const id = "tfAQxNx%2BSnC9teuXKMjdYNpEVoee%2F%2Bn%2B97E9vQmfAupTjPMQ0eZt3lRC7IeI%2FN1L";
    expect(decodeURIComponent(pathWithId("/journals", id).slice("/journals/".length))).toBe(id);
  });
});
