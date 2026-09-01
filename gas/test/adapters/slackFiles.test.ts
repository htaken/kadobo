/**
 * `gas/src/adapters/slackFiles.ts`（`SlackFilesAdapter`）のテスト
 * （実装設計 経費フェーズ §5.5 の SSRF 対策、§3.2 の HTTP ステータス分類表）。
 *
 * `UrlFetchApp` をフェイクに差し替えて本番の `SlackFilesAdapter` をそのままテストする
 * （`test/adapters/slack.test.ts` と同じ方針）。§3.2（コーディネーターレビュー反映版）は
 * 404→`SlackFileNotFoundError` / 401・403→`SlackFileForbiddenError` /
 * 429・5xx・通信失敗・3xx 等その他の未分類コード→`SlackFileFetchError`（`retryable:true`。
 * 429 は `Retry-After` をメッセージに含める） / 🔄 429 を除く未分類の 4xx（例: 400・410）→
 * `SlackFileUnavailableError`（`retryable:false`）の 4 分類を定義しており、「その他 4xx を
 * 一律再試行」にしないことを明示的に求めている（初版レビューの指摘）。恒久的な 4xx を
 * retryable にすると Cron 再送（回数上限なし）が無限に続き行が永久に pending のまま残るため、
 * 未分類の 4xx は非再試行、3xx・5xx・通信失敗は再試行、という HTTP セマンティクスに沿った
 * 分類を明示的に検証する。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlackFilesAdapter } from "../../src/adapters/slackFiles";
import {
  SlackFileFetchError,
  SlackFileForbiddenError,
  SlackFileNotFoundError,
  SlackFileUnavailableError,
} from "../../src/app/ports";
import { FakeProps } from "../app/fakes";
import { installFakeUrlFetchApp, type FakeUrlFetchApp } from "./fakeUrlFetchApp";

const ALLOWED_URL = "https://files.slack.com/files-pri/T000-F000/receipt.jpg";

describe("SlackFilesAdapter#download", () => {
  let fake: FakeUrlFetchApp;
  let restore: () => void;
  let adapter: SlackFilesAdapter;

  beforeEach(() => {
    const installed = installFakeUrlFetchApp();
    fake = installed.fake;
    restore = installed.restore;
    const props = new FakeProps();
    props.set("SLACK_BOT_TOKEN", "xoxb-test-token");
    adapter = new SlackFilesAdapter(props);
  });

  afterEach(() => {
    restore();
  });

  it("200 のとき Authorization: Bearer 付きで GET し、bytes/contentType を返す", () => {
    fake.queueResponse({}, 200, { bytes: [0xff, 0xd8, 0xff, 0xe0], contentType: "image/jpeg" });

    const result = adapter.download(ALLOWED_URL);

    expect(result).toEqual({ bytes: [0xff, 0xd8, 0xff, 0xe0], contentType: "image/jpeg" });
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0]!;
    expect(call.url).toBe(ALLOWED_URL);
    expect(call.params.headers).toEqual({ Authorization: "Bearer xoxb-test-token" });
    expect(call.params.muteHttpExceptions).toBe(true);
  });

  it("GAS の符号付き byte array（-128〜127）を符号なし（0〜255）へ正規化して返す", () => {
    // 実機の Blob#getBytes() は 200 を Java の signed byte 表現 -56 として返しうる。
    fake.queueResponse({}, 200, { bytes: [-1, -56, 0, 127], contentType: "application/pdf" });

    const result = adapter.download(ALLOWED_URL);

    expect(result.bytes).toEqual([255, 200, 0, 127]);
  });

  it("Content-Type が無ければ既定値（application/octet-stream）を返す", () => {
    fake.queueResponse({}, 200, { bytes: [1, 2, 3] });

    const result = adapter.download(ALLOWED_URL);

    expect(result.contentType).toBe("application/octet-stream");
  });

  it("ホストが SLACK_FILE_ALLOWED_HOSTS 以外の url_private は GET せず SlackFileForbiddenError（SSRF 対策）", () => {
    expect(() => adapter.download("https://evil.example.com/x")).toThrow(SlackFileForbiddenError);
    expect(fake.calls).toHaveLength(0); // ネットワークへ一切出ていない。
  });

  it("http（https でない）url_private も GET せず SlackFileForbiddenError", () => {
    expect(() => adapter.download("http://files.slack.com/x")).toThrow(SlackFileForbiddenError);
    expect(fake.calls).toHaveLength(0);
  });

  it("404 は SlackFileNotFoundError（retryable:false）", () => {
    fake.queueResponse({ error: "not_found" }, 404);
    expect(() => adapter.download(ALLOWED_URL)).toThrow(SlackFileNotFoundError);
  });

  it("401 は SlackFileForbiddenError（retryable:false）", () => {
    fake.queueResponse({}, 401);
    expect(() => adapter.download(ALLOWED_URL)).toThrow(SlackFileForbiddenError);
  });

  it("403 は SlackFileForbiddenError（retryable:false）", () => {
    fake.queueResponse({}, 403);
    expect(() => adapter.download(ALLOWED_URL)).toThrow(SlackFileForbiddenError);
  });

  it("429 は SlackFileFetchError（retryable:true）で Retry-After をメッセージに含める", () => {
    fake.queueResponse({}, 429, { headers: { "Retry-After": "30" } });

    let caught: unknown;
    try {
      adapter.download(ALLOWED_URL);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SlackFileFetchError);
    expect((caught as Error).message).toContain("retry_after=30");
  });

  it("429 で Retry-After ヘッダーが無くても SlackFileFetchError（retryable:true）", () => {
    fake.queueResponse({}, 429);
    expect(() => adapter.download(ALLOWED_URL)).toThrow(SlackFileFetchError);
  });

  it("5xx（例: 503）は SlackFileFetchError（retryable:true）", () => {
    fake.queueResponse({}, 503);
    expect(() => adapter.download(ALLOWED_URL)).toThrow(SlackFileFetchError);
  });

  it("3xx（例: 302、想定外のコード）は SlackFileFetchError（retryable:true）", () => {
    // followRedirects の既定は true なので実運用ではまず起こらないが、契約に無い未分類コードの
    // うち 4xx 以外は「再試行すればいつか成功しうる」側に倒す方針を明示的に確認する。
    fake.queueResponse({}, 302);
    expect(() => adapter.download(ALLOWED_URL)).toThrow(SlackFileFetchError);
  });

  it("429 を除く未分類の 4xx（例: 400）は SlackFileUnavailableError（retryable:false）に分類する。NotFound/Forbidden/Fetch には誤分類しない", () => {
    fake.queueResponse({}, 400);

    let caught: unknown;
    try {
      adapter.download(ALLOWED_URL);
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(SlackFileUnavailableError);
    expect(caught).not.toBeInstanceOf(SlackFileFetchError);
    expect(caught).not.toBeInstanceOf(SlackFileNotFoundError);
    expect(caught).not.toBeInstanceOf(SlackFileForbiddenError);
  });

  it("429 を除く未分類の 4xx（例: 410）も SlackFileUnavailableError（retryable:false）", () => {
    // Cron 再送に回数上限が無いため、恒久的な 4xx（例: リンク切れの 410 Gone）を retryable に
    // すると無限に再送され続け、行が永久に pending のまま残ってしまう（コーディネーターレビュー
    // の指摘。実装設計 経費フェーズ §3.2 改訂）。
    fake.queueResponse({}, 410);
    expect(() => adapter.download(ALLOWED_URL)).toThrow(SlackFileUnavailableError);
  });

  it("通信失敗（fetch 自体が例外を投げる）は SlackFileFetchError（retryable:true）", () => {
    fake.fetch = () => {
      throw new Error("network down");
    };
    expect(() => adapter.download(ALLOWED_URL)).toThrow(SlackFileFetchError);
  });

  it("SLACK_BOT_TOKEN が未設定なら例外を投げる（GET 自体を行わない）", () => {
    const propsWithoutToken = new FakeProps();
    const adapterWithoutToken = new SlackFilesAdapter(propsWithoutToken);

    expect(() => adapterWithoutToken.download(ALLOWED_URL)).toThrow(/missing_slack_bot_token/);
    expect(fake.calls).toHaveLength(0);
  });

  it("例外メッセージにトークンを含めない", () => {
    fake.queueResponse({}, 500);
    try {
      adapter.download(ALLOWED_URL);
    } catch (e) {
      expect((e as Error).message).not.toContain("xoxb-test-token");
    }
  });
});
