/**
 * `gas/src/adapters/slack.ts`（`SlackAdapter`）のテスト。
 *
 * 対象は今回の UX 修正で追加・変更した 2 点:
 *   1. `postEphemeral` が `response_url` へ `replace_original: true` を含めて POST すること
 *      （スラッシュコマンドの「⏳ 処理中…」を結果で置き換えるため）。
 *   2. `deleteMessage` が `chat.delete` を呼び、`message_not_found`/`cant_delete_message` は
 *      握りつぶす（例外にしない）が、それ以外のエラーは例外として投げること。
 *
 * `UrlFetchApp` をフェイクに差し替えて本番の `SlackAdapter` をそのままテストする
 * （`test/adapters/sheets.test.ts` の `installFakeSpreadsheetApp` と同じ方針）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SlackAdapter } from "../../src/adapters/slack";
import { FakeProps } from "../app/fakes";
import { installFakeUrlFetchApp, type FakeUrlFetchApp } from "./fakeUrlFetchApp";

describe("SlackAdapter", () => {
  let fake: FakeUrlFetchApp;
  let restore: () => void;
  let adapter: SlackAdapter;

  beforeEach(() => {
    const installed = installFakeUrlFetchApp();
    fake = installed.fake;
    restore = installed.restore;
    const props = new FakeProps();
    props.set("SLACK_BOT_TOKEN", "xoxb-test-token");
    adapter = new SlackAdapter(props);
  });

  afterEach(() => {
    restore();
  });

  describe("postEphemeral", () => {
    it("response_url へ replace_original: true 付きで POST する（⏳ 処理中… を解決する）", () => {
      adapter.postEphemeral("https://hooks.slack.test/xxx", "✅ 本日の稼働カードを表示しました。");

      expect(fake.calls).toHaveLength(1);
      const call = fake.calls[0]!;
      expect(call.url).toBe("https://hooks.slack.test/xxx");
      expect(JSON.parse(call.params.payload ?? "{}")).toEqual({
        replace_original: true,
        response_type: "ephemeral",
        text: "✅ 本日の稼働カードを表示しました。",
      });
    });
  });

  describe("deleteMessage", () => {
    it("chat.delete を channel/ts で呼ぶ", () => {
      fake.queueResponse({ ok: true });

      adapter.deleteMessage({ channel: "C1", ts: "1756260000.000999" });

      expect(fake.calls).toHaveLength(1);
      const call = fake.calls[0]!;
      expect(call.url).toBe("https://slack.com/api/chat.delete");
      expect(JSON.parse(call.params.payload ?? "{}")).toEqual({ channel: "C1", ts: "1756260000.000999" });
    });

    it("message_not_found は例外にせず握りつぶす", () => {
      fake.queueResponse({ ok: false, error: "message_not_found" });

      expect(() => adapter.deleteMessage({ channel: "C1", ts: "1756260000.000999" })).not.toThrow();
    });

    it("cant_delete_message も例外にせず握りつぶす", () => {
      fake.queueResponse({ ok: false, error: "cant_delete_message" });

      expect(() => adapter.deleteMessage({ channel: "C1", ts: "1756260000.000999" })).not.toThrow();
    });

    it("それ以外のエラー（例: invalid_auth）は例外を投げる", () => {
      fake.queueResponse({ ok: false, error: "invalid_auth" });

      expect(() => adapter.deleteMessage({ channel: "C1", ts: "1756260000.000999" })).toThrow(/invalid_auth/);
    });
  });
});
