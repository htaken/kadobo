import { formatJst, jstToMs } from "@kadobo/shared/time";
import type { GasRequest } from "@kadobo/shared/protocol";
import { describe, expect, it } from "vitest";
import { handleCorrectionSubmit, handleOpenCorrection } from "../../src/app/correction";
import type { MonthlyBillRow, RawLogRow } from "../../src/app/ports";
import { makeFakePorts } from "./fakes";

type CorrectionSubmitRequest = Extract<GasRequest, { kind: "correction_submit" }>;
type OpenCorrectionRequest = Extract<GasRequest, { kind: "open_correction" }>;

const BUSINESS_DATE = "2026-09-01";
const START_MS = Date.parse("2026-09-01T09:00:00+09:00");

function startRow(overrides: Partial<RawLogRow> = {}): RawLogRow {
  return {
    event_id: "E1",
    idempotency_key: "seed:E1",
    business_date: BUSINESS_DATE,
    event_type: "START",
    occurred_at: START_MS,
    occurred_at_jst: formatJst(START_MS),
    received_at: START_MS,
    processed_at: START_MS,
    source: "button",
    session_no: 1,
    memo: "",
    correction_of: null,
    old_value: null,
    new_value: null,
    reason: "",
    ...overrides,
  };
}

function makeSubmitRequest(overrides: Partial<CorrectionSubmitRequest> = {}): CorrectionSubmitRequest {
  return {
    kind: "correction_submit",
    idempotency_key: "U1:V1:hash1",
    user_id: "U1",
    view_id: "V1",
    channel_id: "C1",
    message_ts: "1756260000.000100",
    business_date: BUSINESS_DATE,
    target: "E1",
    new_date: "2026-09-01",
    new_time: "09:30",
    reason: "打刻忘れ",
    received_at_ms: Date.parse("2026-09-01T12:00:00+09:00"),
    source: "modal",
    ...overrides,
  };
}

describe("handleCorrectionSubmit — CORRECTION 追記", () => {
  it("対象イベントの occurred_at を変更する CORRECTION 行を追記し、再計算・カード再描画する", () => {
    const ports = makeFakePorts();
    ports.sheets.rawLog.push(startRow());

    const req = makeSubmitRequest();
    const result = handleCorrectionSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.rawLog).toHaveLength(2);
    const correction = ports.sheets.rawLog[1] as RawLogRow;
    expect(correction.event_type).toBe("CORRECTION");
    expect(correction.correction_of).toBe("E1");
    expect(correction.old_value).toBe(START_MS);
    expect(correction.new_value).toBe(jstToMs("2026-09-01", "09:30"));
    expect(correction.reason).toBe("打刻忘れ");

    expect(ports.sheets.dailySummaries.get(BUSINESS_DATE)).toBeDefined();
    // req.message_ts（押されたカードの実際の ts）が優先されるため、内部シートに ts が
    // 無くても chat.update が使われる（自己修復: 直後に内部シートへも書き戻される）。
    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.slack.updated).toHaveLength(1);
    expect(ports.slack.updated[0]?.ts).toBe(req.message_ts);
  });
});

describe("handleCorrectionSubmit — 押し忘れの終了追加（add_end）", () => {
  it("状態が WORKING のとき target:'add_end' で END 行を追記する", () => {
    const ports = makeFakePorts();
    ports.sheets.rawLog.push(startRow());

    const req = makeSubmitRequest({
      idempotency_key: "U1:V1:hash2",
      target: "add_end",
      new_date: "2026-09-01",
      new_time: "18:00",
    });
    const result = handleCorrectionSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.rawLog).toHaveLength(2);
    const endRow = ports.sheets.rawLog[1] as RawLogRow;
    expect(endRow.event_type).toBe("END");
    expect(endRow.memo).toBe("手入力（押し忘れ）");
    expect(endRow.source).toBe("modal");
    expect(endRow.session_no).toBe(1);
    expect(endRow.occurred_at).toBe(jstToMs("2026-09-01", "18:00"));
  });

  it("状態が IDLE/CLOSED のとき target:'add_end' は NOT_FOUND", () => {
    const ports = makeFakePorts();
    // START も END も無い（IDLE）。
    const req = makeSubmitRequest({ target: "add_end" });

    const result = handleCorrectionSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "NOT_FOUND" });
    expect(ports.sheets.rawLog).toHaveLength(0);
    expect(ports.slack.dms).toHaveLength(1);
  });
});

describe("handleCorrectionSubmit — LOCKED 月", () => {
  it("対象月次請求が LOCKED なら拒否し DM 通知する", () => {
    const ports = makeFakePorts();
    ports.sheets.rawLog.push(startRow());
    const bill: MonthlyBillRow = {
      client: "A社",
      month: "2026-09",
      worked_minutes: 0,
      hours: 0,
      unit_price: 0,
      amount: 0,
      tax_amount: 0,
      withholding_amount: 0,
      net_amount: 0,
      state: "LOCKED",
      mf_invoice_id: null,
      locked_at: Date.now(),
      note: null,
      updated_at: Date.now(),
    };
    ports.sheets.monthlyBills.set("A社|2026-09", bill);

    const req = makeSubmitRequest();
    const result = handleCorrectionSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "LOCKED_MONTH" });
    expect(ports.sheets.rawLog).toHaveLength(1); // 追記されない
    expect(ports.slack.dms).toHaveLength(1);
    expect(ports.slack.dms[0]?.userId).toBe("U1");
  });
});

describe("handleCorrectionSubmit — 対象が見つからない", () => {
  it("target の event_id が存在しなければ NOT_FOUND を返し、DM 通知する", () => {
    const ports = makeFakePorts();
    ports.sheets.rawLog.push(startRow());

    const req = makeSubmitRequest({ target: "NONEXISTENT" });
    const result = handleCorrectionSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "NOT_FOUND" });
    expect(ports.sheets.rawLog).toHaveLength(1);
    expect(ports.slack.dms).toHaveLength(1);
  });
});

describe("handleCorrectionSubmit — 重複", () => {
  it("同じ idempotency_key の再送は DUPLICATE。カードは再描画される", () => {
    const ports = makeFakePorts();
    ports.sheets.rawLog.push(startRow());
    const req = makeSubmitRequest();
    handleCorrectionSubmit(req, ports);
    expect(ports.sheets.rawLog).toHaveLength(2);

    const retry: CorrectionSubmitRequest = { ...req, source: "retry" };
    const result = handleCorrectionSubmit(retry, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "DUPLICATE" });
    expect(ports.sheets.rawLog).toHaveLength(2); // 追記されない
  });
});

describe("handleOpenCorrection", () => {
  it("当該業務日のイベントから本モーダルを生成し、private_metadata を付与して views.update する", () => {
    const ports = makeFakePorts();
    ports.sheets.rawLog.push(startRow());

    const req: OpenCorrectionRequest = {
      kind: "open_correction",
      idempotency_key: "U1:C1:kado_correct:123.456",
      user_id: "U1",
      channel_id: "C1",
      message_ts: "1756260000.000100",
      view_id: "V1",
      business_date: BUSINESS_DATE,
      received_at_ms: Date.now(),
      source: "button",
    };

    const result = handleOpenCorrection(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.slack.viewsUpdated).toHaveLength(1);
    const call = ports.slack.viewsUpdated[0];
    expect(call?.view_id).toBe("V1");
    const view = call?.view as { private_metadata: string; callback_id: string };
    expect(view.callback_id).toBe("kado_correction");
    expect(JSON.parse(view.private_metadata)).toEqual({
      channel_id: "C1",
      message_ts: "1756260000.000100",
      business_date: BUSINESS_DATE,
    });
  });
});
