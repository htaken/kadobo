/**
 * `redrawCardForBusinessDate`/`pushCard`（`gas/src/app/cardHelpers.ts`）の直接テスト。
 *
 * 独立レビュー（Codex）で判明した本番不具合の回帰テスト:
 * Slack ボタン押下時に届く `req.message_ts`（いま押されたカードの正確な ts）を
 * `preferredMessageTs` として渡すことで、内部シートのカード ts（Sheets の型変換で
 * 桁落ちする等して壊れ得る）に依存せず確実に対象カードを更新できること、
 * 更新成功時に内部シートの ts が自己修復されること、`message_not_found`/
 * `cant_update_message` のときは新規投稿にフォールバックして内部シートの ts を
 * 張り替えること、を検証する。
 */
import { describe, expect, it } from "vitest";
import { redrawCardForBusinessDate } from "../../src/app/cardHelpers";
import { makeFakePorts } from "./fakes";

const CHANNEL = "C1";
const BUSINESS_DATE = "2026-09-01";
const KEY = `${CHANNEL}:${BUSINESS_DATE}`;

describe("redrawCardForBusinessDate — preferredMessageTs 優先", () => {
  it("内部シートに ts が無くても preferredMessageTs があれば chat.update をその ts に対して呼ぶ（postMessage しない）", () => {
    const ports = makeFakePorts();

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports, {
      preferredMessageTs: "1756260000.000100",
    });

    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.slack.updated).toHaveLength(1);
    expect(ports.slack.updated[0]?.ts).toBe("1756260000.000100");
  });

  it("内部シートの ts と preferredMessageTs が異なる（壊れている）場合でも preferredMessageTs を使う", () => {
    const ports = makeFakePorts();
    // 内部シートに「壊れた」ts が入っている想定（Sheets の型変換等で桁落ちした値）。
    ports.sheets.setInternalValue("card", KEY, "1756260000.0001"); // 末尾ゼロが消えた壊れた値

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports, {
      preferredMessageTs: "1756260000.000100",
    });

    expect(ports.slack.updated).toHaveLength(1);
    expect(ports.slack.updated[0]?.ts).toBe("1756260000.000100");
  });

  it("preferredMessageTs 未指定なら従来どおり内部シートの ts を使う", () => {
    const ports = makeFakePorts();
    ports.sheets.setInternalValue("card", KEY, "1756260000.000200");

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports);

    expect(ports.slack.updated).toHaveLength(1);
    expect(ports.slack.updated[0]?.ts).toBe("1756260000.000200");
  });

  it("preferredMessageTs も内部シートの ts も無ければ postMessage して内部シートへ登録する", () => {
    const ports = makeFakePorts();

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports);

    expect(ports.slack.updated).toHaveLength(0);
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.sheets.getInternalValue("card", KEY)).toBe(ports.slack.nextPostTs);
  });
});

describe("redrawCardForBusinessDate — 自己修復（chat.update 成功時に内部シートを upsert）", () => {
  it("更新成功後、内部シートの値が preferredMessageTs に upsert される（未保存だった場合）", () => {
    const ports = makeFakePorts();
    expect(ports.sheets.getInternalValue("card", KEY)).toBeNull();

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports, {
      preferredMessageTs: "1756260000.000100",
    });

    expect(ports.sheets.getInternalValue("card", KEY)).toBe("1756260000.000100");
  });

  it("更新成功後、内部シートの壊れた値が preferredMessageTs で上書きされる（既存値と異なる場合）", () => {
    const ports = makeFakePorts();
    ports.sheets.setInternalValue("card", KEY, "1756260000.0001"); // 壊れた値

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports, {
      preferredMessageTs: "1756260000.000100",
    });

    expect(ports.sheets.getInternalValue("card", KEY)).toBe("1756260000.000100");
  });
});

describe("redrawCardForBusinessDate — chat.update 失敗時のフォールバック", () => {
  it("message_not_found のときは postMessage にフォールバックし、内部シートの ts が新しい ts に張り替わる", () => {
    const ports = makeFakePorts();
    ports.sheets.setInternalValue("card", KEY, "1756260000.0001"); // 壊れた値
    ports.slack.failNextUpdate = true;
    ports.slack.failNextUpdateError = "slack_api_error:chat.update:message_not_found";

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports, {
      preferredMessageTs: "1756260000.000100",
    });

    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.sheets.getInternalValue("card", KEY)).toBe(ports.slack.nextPostTs);
  });

  it("cant_update_message のときも postMessage にフォールバックする", () => {
    const ports = makeFakePorts();
    ports.slack.failNextUpdate = true;
    ports.slack.failNextUpdateError = "slack_api_error:chat.update:cant_update_message";

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports, {
      preferredMessageTs: "1756260000.000100",
    });

    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.sheets.getInternalValue("card", KEY)).toBe(ports.slack.nextPostTs);
  });

  it("message_not_found 以外のエラー（例: invalid_blocks）はフォールバックせず、握りつぶして例外も投げない", () => {
    const ports = makeFakePorts();
    ports.slack.failNextUpdate = true;
    ports.slack.failNextUpdateError = "slack_api_error:chat.update:invalid_blocks";

    expect(() =>
      redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports, {
        preferredMessageTs: "1756260000.000100",
      }),
    ).not.toThrow();

    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.sheets.getInternalValue("card", KEY)).toBeNull(); // 内部シートは書き換わらない
  });

  it("preferredMessageTs 未指定・内部シートの ts のみでも message_not_found で postMessage にフォールバックする", () => {
    const ports = makeFakePorts();
    ports.sheets.setInternalValue("card", KEY, "1756260000.0001"); // 壊れた値
    ports.slack.failNextUpdate = true;
    ports.slack.failNextUpdateError = "slack_api_error:chat.update:message_not_found";

    redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports);

    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.sheets.getInternalValue("card", KEY)).toBe(ports.slack.nextPostTs);
  });

  it("postMessage 失敗時も例外を投げない（次回再描画での修復に任せる）", () => {
    const ports = makeFakePorts();

    ports.slack.failNextPostMessage = true;

    expect(() => redrawCardForBusinessDate(BUSINESS_DATE, CHANNEL, ports)).not.toThrow();
    expect(ports.sheets.getInternalValue("card", KEY)).toBeNull();
  });
});
