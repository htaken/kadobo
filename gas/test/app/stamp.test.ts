import { buttonIdempotencyKey } from "@kadobo/shared/ids";
import { formatJst } from "@kadobo/shared/time";
import type { GasRequest } from "@kadobo/shared/protocol";
import { describe, expect, it } from "vitest";
import { handleStamp } from "../../src/app/stamp";
import type { MonthlyBillRow, RawLogRow } from "../../src/app/ports";
import { makeFakePorts } from "./fakes";

function frozenBillRow(overrides: Partial<MonthlyBillRow> = {}): MonthlyBillRow {
  return {
    client: "A社",
    month: "2026-09",
    worked_minutes: 6000,
    hours: 100,
    unit_price: 1800,
    amount: 180000,
    tax_amount: 18000,
    withholding_amount: 0,
    net_amount: 198000,
    state: "LOCKED",
    mf_invoice_id: null,
    locked_at: Date.parse("2026-09-05T00:00:00+09:00"),
    note: null,
    updated_at: Date.parse("2026-09-05T00:00:00+09:00"),
    invoice_state: "MANUAL",
    invoice_error: null,
    invoice_attempted_at: null,
    close_card_ts: null,
    ...overrides,
  };
}

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

  it("生ログ追記後・再計算前に落ちた再送でも、重複分岐で日次・月次を計算し直す", () => {
    const ports = makeFakePorts();
    const req = makeStampRequest();

    // 「生ログ 1 行の追記までは成功したが、その直後の再計算で落ちた」状態を再現する。
    // 従来はこの再送が再描画だけで ok を返し、日次・月次が欠けたまま D1 が done になっていた。
    ports.sheets.rawLog.push({
      event_id: "E_SEED",
      idempotency_key: req.idempotency_key,
      business_date: "2026-09-01",
      event_type: "START",
      occurred_at: req.occurred_at_ms,
      occurred_at_jst: formatJst(req.occurred_at_ms),
      received_at: req.received_at_ms,
      processed_at: req.received_at_ms,
      source: "button",
      session_no: 1,
      memo: "",
      correction_of: null,
      old_value: null,
      new_value: null,
      reason: "",
    });
    expect(ports.sheets.dailySummaries.size).toBe(0);
    expect(ports.sheets.monthlyBills.size).toBe(0);

    const result = handleStamp({ ...req, source: "retry" }, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "DUPLICATE" });
    expect(ports.sheets.rawLog).toHaveLength(1); // 追記されない（冪等）
    expect(ports.sheets.dailySummaries.get("2026-09-01")?.status).toBe("進行中");
    expect(ports.sheets.monthlyBills.size).toBe(1);
    expect(ports.slack.updated).toHaveLength(1);
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

describe("handleStamp — 締めた月への遅延打刻の通知（実装設計 MF連携 §5.8）", () => {
  it("凍結済み月への打刻: 生ログには追記され、月次行は変わらず、DM と late_stamp が記録される", () => {
    const ports = makeFakePorts();
    ports.sheets.monthlyBills.set("A社|2026-09", frozenBillRow());
    const req = makeStampRequest();

    const result = handleStamp(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    // 生ログへの追記はこれまでどおり行われる。
    expect(ports.sheets.rawLog).toHaveLength(1);
    // 日次再計算は行われる。
    expect(ports.sheets.getDailySummary("2026-09-01")).not.toBeNull();
    // 月次行は isMonthFrozen により変わらない（凍結前の値のまま）。
    const bill = ports.sheets.getMonthlyBill("A社", "2026-09");
    expect(bill?.state).toBe("LOCKED");
    expect(bill?.worked_minutes).toBe(6000);
    // DM で通知される。
    expect(ports.slack.dms).toHaveLength(1);
    expect(ports.slack.dms[0]?.userId).toBe("U1");
    expect(ports.slack.dms[0]?.text).toContain("2026-09");
    expect(ports.slack.dms[0]?.text).toContain("翌月調整");
    // 内部シート late_stamp/<event_id> に記録される。
    const eventId = ports.sheets.rawLog[0]!.event_id;
    expect(ports.sheets.getInternalValue("late_stamp", eventId)).toBe("2026-09-01");
  });

  it("凍結されていない月（OPEN）への打刻は通知しない", () => {
    const ports = makeFakePorts();
    const req = makeStampRequest();

    const result = handleStamp(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.slack.dms).toHaveLength(0);
    expect(ports.sheets.getInternalRows("late_stamp")).toHaveLength(0);
  });

  it("REVIEWING の月への打刻も通知しない（凍結は LOCKED 以降のみ）", () => {
    const ports = makeFakePorts();
    ports.sheets.monthlyBills.set("A社|2026-09", frozenBillRow({ state: "REVIEWING", invoice_state: "" }));
    const req = makeStampRequest();

    handleStamp(req, ports);

    expect(ports.slack.dms).toHaveLength(0);
  });

  it("再送（重複押下）で二重に DM しない: 1 回目で記録された late_stamp を 2 回目はそのまま使う", () => {
    const ports = makeFakePorts();
    ports.sheets.monthlyBills.set("A社|2026-09", frozenBillRow());
    const req = makeStampRequest();

    handleStamp(req, ports);
    expect(ports.slack.dms).toHaveLength(1);

    // 2 回目（同じ idempotency_key）は重複分岐に入るが、DM は再送しない。
    const second = handleStamp(req, ports);
    expect(second).toEqual({ ok: true, applied: false, reason: "DUPLICATE" });
    expect(ports.slack.dms).toHaveLength(1);
  });

  it("締め前に追記 → 締め → 同じ idempotency_key の再送: DUPLICATE 経路では DM しない（誤報防止）", () => {
    const ports = makeFakePorts();
    const req = makeStampRequest();

    // 1 回目: まだ OPEN のときに新規追記される（この時点では締め後ではないので通知は無い）。
    const first = handleStamp(req, ports);
    expect(first).toEqual({ ok: true, applied: true });
    expect(ports.sheets.rawLog).toHaveLength(1);
    expect(ports.slack.dms).toHaveLength(0);

    // 締める: この打刻はすでに追記済み（＝締めた金額に含まれている）。
    ports.sheets.updateMonthlyBillColumns("A社", "2026-09", { state: "LOCKED", invoice_state: "MANUAL" });

    // 2 回目（同じ idempotency_key の再送）: 重複分岐に入る。生ログは追記されないが、
    // 再計算・カード再描画はやり直す。この打刻は締めより前に届いていたので「遅れて届いた」
    // わけではなく、DM してはいけない（誤報防止。今回のレビュー指摘）。
    const second = handleStamp(req, ports);
    expect(second).toEqual({ ok: true, applied: false, reason: "DUPLICATE" });
    expect(ports.sheets.rawLog).toHaveLength(1); // 追記は増えない
    expect(ports.slack.dms).toHaveLength(0); // DM は出ない
    expect(ports.sheets.getInternalRows("late_stamp")).toHaveLength(0);
  });

  it("MF_CREATED 以降（LOCKED だけでなく）も凍結として扱う", () => {
    const ports = makeFakePorts();
    ports.sheets.monthlyBills.set(
      "A社|2026-09",
      frozenBillRow({ state: "MF_CREATED", invoice_state: "CREATED" }),
    );
    const req = makeStampRequest();

    handleStamp(req, ports);

    expect(ports.slack.dms).toHaveLength(1);
    const bill = ports.sheets.getMonthlyBill("A社", "2026-09");
    expect(bill?.state).toBe("MF_CREATED");
  });
});
