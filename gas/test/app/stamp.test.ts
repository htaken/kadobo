import { buttonIdempotencyKey } from "@kadobo/shared/ids";
import type { GasRequest } from "@kadobo/shared/protocol";
import { describe, expect, it } from "vitest";
import { handleStamp } from "../../src/app/stamp";
import type { RawLogRow } from "../../src/app/ports";
import { makeFakePorts } from "./fakes";

type StampRequest = Extract<GasRequest, { kind: "stamp" }>;

function makeStampRequest(overrides: Partial<StampRequest> = {}): StampRequest {
  const messageTs = "1756260000.000100";
  const actionTs = "1756260120.000100"; // 2026-09-01T09:02:00+09:00 相当
  const actionId = overrides.action_id ?? "kado_start";
  const base: StampRequest = {
    kind: "stamp",
    idempotency_key: buttonIdempotencyKey({
      user_id: "U1",
      message_ts: messageTs,
      action_id: actionId,
      action_ts: actionTs,
    }),
    user_id: "U1",
    channel_id: "C1",
    message_ts: messageTs,
    action_id: actionId,
    occurred_at_ms: Date.parse("2026-09-01T09:02:00+09:00"),
    received_at_ms: Date.parse("2026-09-01T09:02:00+09:00") + 400,
    source: "button",
  };
  return { ...base, ...overrides };
}

describe("handleStamp — 正常系", () => {
  it("IDLE から START: 生ログ追記 + 日次更新 + カード更新（req.message_ts を preferredMessageTs として chat.update）", () => {
    const ports = makeFakePorts();
    const req = makeStampRequest();

    const result = handleStamp(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.rawLog).toHaveLength(1);
    const row = ports.sheets.rawLog[0] as RawLogRow;
    expect(row.event_type).toBe("START");
    expect(row.business_date).toBe("2026-09-01");
    expect(row.session_no).toBe(1);
    expect(row.idempotency_key).toBe(req.idempotency_key);

    const daily = ports.sheets.dailySummaries.get("2026-09-01");
    expect(daily?.status).toBe("進行中");

    // req.message_ts（押されたカードの実際の ts）が優先されるため、内部シートに ts が
    // 無くても chat.update が使われる（自己修復: 直後に内部シートへも書き戻される）。
    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.slack.updated).toHaveLength(1);
    expect(ports.slack.updated[0]?.ts).toBe(req.message_ts);
    expect(ports.sheets.getInternalValue("card", "C1:2026-09-01")).toBe(req.message_ts);
  });

  it("2 回目のイベント（BREAK_START）も同じカード（message_ts）を chat.update する", () => {
    const ports = makeFakePorts();
    handleStamp(makeStampRequest(), ports);

    const breakReq = makeStampRequest({
      action_id: "kado_break_start",
      occurred_at_ms: Date.parse("2026-09-01T10:00:00+09:00"),
      received_at_ms: Date.parse("2026-09-01T10:00:00+09:00") + 400,
    });
    const result = handleStamp(breakReq, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.rawLog).toHaveLength(2);
    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.slack.updated).toHaveLength(2); // 両方とも message_ts への update
  });
});

describe("handleStamp — 重複", () => {
  it("同じ idempotency_key の再送は applied:false, reason:DUPLICATE。カードは再描画される", () => {
    const ports = makeFakePorts();
    const req = makeStampRequest();
    handleStamp(req, ports);
    expect(ports.sheets.rawLog).toHaveLength(1);
    expect(ports.slack.updated).toHaveLength(1);
    expect(ports.slack.posted).toHaveLength(0);

    const retryReq: StampRequest = { ...req, source: "retry" };
    const result = handleStamp(retryReq, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "DUPLICATE" });
    expect(ports.sheets.rawLog).toHaveLength(1); // 追記されない
    // カード再描画（前回 Slack 更新失敗の修復）: preferredMessageTs があるので update が呼ばれる。
    expect(ports.slack.updated).toHaveLength(2);
  });
});

describe("handleStamp — 不正遷移", () => {
  it("IDLE への BREAK_START は記録せず applied:false, reason:INVALID_TRANSITION。response_url へ ephemeral", () => {
    const ports = makeFakePorts();
    const req = makeStampRequest({
      action_id: "kado_break_start",
      response_url: "https://hooks.slack.test/xxx",
    });

    const result = handleStamp(req, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "INVALID_TRANSITION" });
    expect(ports.sheets.rawLog).toHaveLength(0); // 追記されない
    expect(ports.slack.ephemeral).toHaveLength(1);
    expect(ports.slack.ephemeral[0]?.responseUrl).toBe("https://hooks.slack.test/xxx");
    // カードは再描画される（req.message_ts への chat.update）。
    expect(ports.slack.updated).toHaveLength(1);
    expect(ports.slack.posted).toHaveLength(0);
  });

  it("response_url が無ければ ephemeral は送らないが、カードは再描画する", () => {
    const ports = makeFakePorts();
    const req = makeStampRequest({ action_id: "kado_end" }); // IDLE への END も不正

    const result = handleStamp(req, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "INVALID_TRANSITION" });
    expect(ports.slack.ephemeral).toHaveLength(0);
    expect(ports.slack.updated).toHaveLength(1);
    expect(ports.slack.posted).toHaveLength(0);
  });
});

describe("handleStamp — Slack 更新失敗時の応答", () => {
  it("生ログ追記後に chat.update が message_not_found で失敗したら postMessage にフォールバックし、内部シートの ts が張り替わる", () => {
    const ports = makeFakePorts();
    ports.slack.failNextUpdate = true;
    ports.slack.failNextUpdateError = "slack_api_error:chat.update:message_not_found";
    const req = makeStampRequest();

    const result = handleStamp(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.rawLog).toHaveLength(1); // 記録は成功している
    expect(ports.slack.posted).toHaveLength(1); // フォールバックで新規投稿
    expect(ports.sheets.getInternalValue("card", "C1:2026-09-01")).toBe(ports.slack.nextPostTs); // 新しい ts に張り替わる
  });

  it("生ログ追記後に chat.update が message_not_found 以外で失敗しても applied:true を返す（フォールバックしない）", () => {
    const ports = makeFakePorts();
    ports.slack.failNextUpdate = true; // 既定エラー（message_not_found を含まない）
    const req = makeStampRequest();

    const result = handleStamp(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.rawLog).toHaveLength(1); // 記録は成功している
    expect(ports.slack.posted).toHaveLength(0); // フォールバックしない
    expect(ports.sheets.getInternalValue("card", "C1:2026-09-01")).toBeNull(); // カード ts は保存されない
  });
});
