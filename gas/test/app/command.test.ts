import type { GasRequest } from "@kadobo/shared/protocol";
import { describe, expect, it } from "vitest";
import { handleCommand } from "../../src/app/command";
import type { DailySummaryRow } from "../../src/app/ports";
import { makeFakePorts } from "./fakes";

type CommandRequest = Extract<GasRequest, { kind: "command" }>;

// makeFakePorts の既定時刻は 2026-09-01T12:00 JST（火曜日）。
const TODAY = "2026-09-01";

function makeCommandRequest(overrides: Partial<CommandRequest> = {}): CommandRequest {
  return {
    kind: "command",
    idempotency_key: "U1:T1",
    user_id: "U1",
    channel_id: "C1",
    text: "",
    response_url: "https://hooks.slack.test/xxx",
    received_at_ms: Date.now(),
    source: "command",
    ...overrides,
  };
}

describe("handleCommand — ''（当日カード・再投稿）", () => {
  it("内部 card ts が無ければ（初回）delete を呼ばず postMessage のみで ts を保存する", () => {
    const ports = makeFakePorts();
    const result = handleCommand(makeCommandRequest({ text: "" }), ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.slack.deleted).toHaveLength(0);
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.updated).toHaveLength(0);
    expect(ports.sheets.getInternalValue("card", `C1:${TODAY}`)).toBe(ports.slack.nextPostTs);
  });

  it("既存 ts があれば chat.update ではなく、その ts を削除してから新規 postMessage する（再投稿）", () => {
    const ports = makeFakePorts();
    ports.sheets.setInternalValue("card", `C1:${TODAY}`, "1756260000.000999");

    const result = handleCommand(makeCommandRequest({ text: "" }), ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.slack.updated).toHaveLength(0);
    expect(ports.slack.deleted).toEqual([{ channel: "C1", ts: "1756260000.000999" }]);
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.sheets.getInternalValue("card", `C1:${TODAY}`)).toBe(ports.slack.nextPostTs);
  });

  it("deleteMessage が失敗（message_not_found 相当）しても全体は成功し、新カードが投稿される", () => {
    const ports = makeFakePorts();
    ports.sheets.setInternalValue("card", `C1:${TODAY}`, "1756260000.000999");
    ports.slack.failNextDelete = true;

    const result = handleCommand(makeCommandRequest({ text: "" }), ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.sheets.getInternalValue("card", `C1:${TODAY}`)).toBe(ports.slack.nextPostTs);
  });

  it("実行後に response_url へ replace_original 相当の ephemeral 解決を送る（⏳ 処理中… の解決）", () => {
    const ports = makeFakePorts();

    handleCommand(makeCommandRequest({ text: "" }), ports);

    expect(ports.slack.ephemeral).toHaveLength(1);
    expect(ports.slack.ephemeral[0]?.responseUrl).toBe("https://hooks.slack.test/xxx");
    expect(ports.slack.ephemeral[0]?.text).toContain("表示しました");
  });
});

describe("handleCommand — status", () => {
  it("今週・今月の累計を response_url へ ephemeral 表示する", () => {
    const ports = makeFakePorts();
    const mon: DailySummaryRow = {
      business_date: "2026-08-31", // 月曜（今週）
      weekday: "月",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: 7200,
      worked_minutes: 120, // 2h
      status: "OK",
      correction_count: 0,
      note: null,
      updated_at: Date.now(),
    };
    const tue: DailySummaryRow = {
      ...mon,
      business_date: "2026-09-01", // 火曜（今週・今月）
      worked_minutes: 180, // 3h
    };
    ports.sheets.upsertDailySummary(mon);
    ports.sheets.upsertDailySummary(tue);

    const result = handleCommand(makeCommandRequest({ text: "status" }), ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.slack.updated).toHaveLength(0);
    expect(ports.slack.ephemeral).toHaveLength(1);
    const call = ports.slack.ephemeral[0];
    expect(call?.responseUrl).toBe("https://hooks.slack.test/xxx");
    // 今週(8/31+9/1) = 120+180 = 300分 = 5h0m。今月(9/1のみ) = 180分 = 3h0m。
    expect(call?.text).toContain("5h 0m");
    expect(call?.text).toContain("3h 0m");
  });
});
