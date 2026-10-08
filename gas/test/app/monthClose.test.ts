/**
 * `app/monthClose.ts` のテスト（実装設計 MF連携 §5.2, §5.3, §11.2 WP-M2 受入条件）。
 */
import type { GasRequest } from "@kadobo/shared/protocol";
import { describe, expect, it } from "vitest";
import { evaluateMonthClose, handleMonthClose } from "../../src/app/monthClose";
import type { MonthlyBillRow } from "../../src/app/ports";
import { makeFakePorts } from "./fakes";

type MonthCloseRequest = Extract<GasRequest, { kind: "month_close" }>;

function seedUnitPrice(ports: ReturnType<typeof makeFakePorts>): void {
  ports.sheets.unitPrices.push({
    client: "A社",
    unit_price: 1800,
    tax_category: "課税",
    tax_inclusive: false,
    tax_display: "区分記載",
    rounding: "切捨",
    withholding: "なし",
    valid_from: "2026-01-01",
    valid_to: null,
  });
}

function setup(ports: ReturnType<typeof makeFakePorts>): void {
  ports.props.set("SLACK_CHANNEL_ID", "C1");
  ports.props.set("MF_BILLING_START_MONTH", "2026-10");
  seedUnitPrice(ports);
}

function blocksToText(blocks?: object[]): string {
  return JSON.stringify(blocks ?? []);
}

// ---------------------------------------------------------------------------
// evaluateMonthClose
// ---------------------------------------------------------------------------

describe("evaluateMonthClose — MF_BILLING_START_MONTH", () => {
  it("未設定なら何もしない", () => {
    const ports = makeFakePorts(Date.parse("2026-12-15T06:00:00+09:00"));
    ports.props.set("SLACK_CHANNEL_ID", "C1");
    seedUnitPrice(ports);

    evaluateMonthClose(ports);

    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.sheets.listMonthlyBills()).toHaveLength(0);
    expect(ports.http.calls).toHaveLength(0); // MF は一切呼ばない
  });

  it("MF_BILLING_START_MONTH より前の月は評価しない（既存行は変更しない）", () => {
    const ports = makeFakePorts(Date.parse("2026-12-15T06:00:00+09:00"));
    setup(ports);
    const before: MonthlyBillRow = {
      client: "A社",
      month: "2026-09",
      worked_minutes: 100,
      hours: 1.67,
      unit_price: 1800,
      amount: 3000,
      tax_amount: 300,
      withholding_amount: 0,
      net_amount: 3300,
      state: "OPEN",
      mf_invoice_id: null,
      locked_at: null,
      note: null,
      updated_at: 1,
      invoice_state: "",
      invoice_error: null,
      invoice_attempted_at: null,
      close_card_ts: null,
    };
    ports.sheets.monthlyBills.set("A社|2026-09", before);

    evaluateMonthClose(ports);

    const after = ports.sheets.getMonthlyBill("A社", "2026-09");
    expect(after).toEqual(before); // 一切触れられていない
    // 2026-09 分のカードは投稿されない（10月・11月分は対象なので投稿されうる）。
    expect(ports.slack.posted.some((p) => p.text.includes("2026-09"))).toBe(false);
  });

  it("当月は評価しない（当月より前が対象）", () => {
    const ports = makeFakePorts(Date.parse("2026-10-15T06:00:00+09:00")); // 当月 = 2026-10
    setup(ports);

    evaluateMonthClose(ports);

    expect(ports.sheets.getMonthlyBill("A社", "2026-10")).toBeNull();
    expect(ports.slack.posted).toHaveLength(0);
  });
});

describe("evaluateMonthClose — 締め忘れた過去月も評価する", () => {
  it("10 月が OPEN のまま 12 月になっても、10 月・11 月の両方を評価してカードを投稿する", () => {
    const ports = makeFakePorts(Date.parse("2026-12-15T06:00:00+09:00"));
    setup(ports);

    evaluateMonthClose(ports);

    const oct = ports.sheets.getMonthlyBill("A社", "2026-10");
    const nov = ports.sheets.getMonthlyBill("A社", "2026-11");
    expect(oct?.state).toBe("REVIEWING");
    expect(nov?.state).toBe("REVIEWING");
    expect(ports.sheets.getMonthlyBill("A社", "2026-12")).toBeNull(); // 当月は対象外
    expect(ports.slack.posted).toHaveLength(2); // 2 か月分、それぞれ 1 回ずつ投稿
    expect(oct?.close_card_ts).not.toBeNull();
    expect(nov?.close_card_ts).not.toBeNull();
  });
});

describe("evaluateMonthClose — blockers", () => {
  it("要修正な日次集計があると REVIEWING にならず、カードも投稿しない", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setup(ports);
    ports.sheets.upsertDailySummary({
      business_date: "2026-10-15",
      weekday: "木",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: null,
      worked_minutes: null,
      status: "要修正",
      correction_count: 0,
      note: "終了（END）が記録されていません",
      updated_at: Date.now(),
    });

    evaluateMonthClose(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10");
    expect(bill?.state).toBe("OPEN");
    expect(ports.slack.posted).toHaveLength(0);
  });
});

describe("evaluateMonthClose — カードは 1 回だけ投稿し、2 回目以降は描き直す", () => {
  it("OPEN→REVIEWING→OPEN→REVIEWING でも postMessage は 1 回、以後は chat.update", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setup(ports);

    // 1 回目: blockers 無し → REVIEWING になり、カードを 1 回投稿する。
    evaluateMonthClose(ports);
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.updated).toHaveLength(0);
    const ts = ports.sheets.getMonthlyBill("A社", "2026-10")?.close_card_ts;
    expect(ts).not.toBeNull();

    // 2 回目: 要修正を追加 → OPEN に戻る。カードは「要修正があります」に描き直す（投稿はしない）。
    ports.sheets.upsertDailySummary({
      business_date: "2026-10-15",
      weekday: "木",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: null,
      worked_minutes: null,
      status: "要修正",
      correction_count: 0,
      note: "終了（END）が記録されていません",
      updated_at: Date.now(),
    });
    evaluateMonthClose(ports);
    expect(ports.slack.posted).toHaveLength(1); // 新規投稿は増えない
    expect(ports.slack.updated).toHaveLength(1);
    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("要修正があります");
    expect(ports.slack.updated[0]?.ts).toBe(ts);
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.state).toBe("OPEN");

    // 3 回目: 要修正を解消 → 再び REVIEWING。同じカードを描き直す（新規投稿はしない）。
    ports.sheets.dailySummaries.set("2026-10-15", {
      business_date: "2026-10-15",
      weekday: "木",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: 3600,
      worked_minutes: 60,
      status: "OK",
      correction_count: 0,
      note: null,
      updated_at: Date.now(),
    });
    evaluateMonthClose(ports);
    expect(ports.slack.posted).toHaveLength(1); // 依然として新規投稿は 1 回のみ
    expect(ports.slack.updated).toHaveLength(2);
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.state).toBe("REVIEWING");
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.close_card_ts).toBe(ts); // 同じカードを使い続ける
  });
});

describe("evaluateMonthClose — 変化があったときだけ描き直す（コーディネーターレビュー指摘）", () => {
  it("state・表示数値のどちらも変わらなければ chat.update を呼ばない", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setup(ports);
    ports.sheets.upsertDailySummary({
      business_date: "2026-10-15",
      weekday: "木",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: 3600,
      worked_minutes: 60,
      status: "OK",
      correction_count: 0,
      note: null,
      updated_at: Date.now(),
    });

    // 1 回目: 新規投稿。
    evaluateMonthClose(ports);
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.updated).toHaveLength(0);
    const before = ports.sheets.getMonthlyBill("A社", "2026-10");

    // 2 回目・3 回目: 日次集計・単価とも変えずに再評価する（毎時のトリガーを模す）。
    // state（REVIEWING のまま）も表示数値もどちらも変わらないので chat.update は呼ばれない。
    evaluateMonthClose(ports);
    evaluateMonthClose(ports);

    expect(ports.slack.posted).toHaveLength(1); // 新規投稿は増えない
    expect(ports.slack.updated).toHaveLength(0); // 描き直しも起きない
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")).toEqual(before);
  });

  it("state は REVIEWING のままでも、表示数値（hours 等）が変われば描き直す", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setup(ports);
    ports.sheets.upsertDailySummary({
      business_date: "2026-10-15",
      weekday: "木",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: 3600,
      worked_minutes: 60,
      status: "OK",
      correction_count: 0,
      note: null,
      updated_at: Date.now(),
    });

    evaluateMonthClose(ports);
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.updated).toHaveLength(0);
    const hoursBefore = ports.sheets.getMonthlyBill("A社", "2026-10")?.hours;

    // 稼働時間が増える（state は blockers 無しのまま REVIEWING を維持する）。
    ports.sheets.upsertDailySummary({
      business_date: "2026-10-16",
      weekday: "金",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: 3600,
      worked_minutes: 60,
      status: "OK",
      correction_count: 0,
      note: null,
      updated_at: Date.now(),
    });

    evaluateMonthClose(ports);

    const after = ports.sheets.getMonthlyBill("A社", "2026-10");
    expect(after?.state).toBe("REVIEWING"); // state は変わっていない
    expect(after?.hours).not.toBe(hoursBefore); // 表示数値は変わった
    expect(ports.slack.posted).toHaveLength(1); // 新規投稿は増えない
    expect(ports.slack.updated).toHaveLength(1); // 数値が変わったので描き直す
  });

  it("表示数値が変わらなくても state が変われば描き直す（REVIEWING→OPEN、稼働 0h のまま）", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setup(ports);
    // 稼働時間ゼロのまま（要修正日は worked_minutes:null で合計に寄与しない）。

    // 1 回目: blockers 無し → REVIEWING。
    evaluateMonthClose(ports);
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.updated).toHaveLength(0);
    const hoursBefore = ports.sheets.getMonthlyBill("A社", "2026-10")?.hours;
    expect(hoursBefore).toBe(0);

    // 要修正日を追加（合計時間は 0 のまま変わらない）。state だけが REVIEWING→OPEN に変わる。
    ports.sheets.upsertDailySummary({
      business_date: "2026-10-15",
      weekday: "木",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: null,
      worked_minutes: null,
      status: "要修正",
      correction_count: 0,
      note: "終了（END）が記録されていません",
      updated_at: Date.now(),
    });

    evaluateMonthClose(ports);

    const after = ports.sheets.getMonthlyBill("A社", "2026-10");
    expect(after?.hours).toBe(hoursBefore); // 表示数値は変わっていない
    expect(after?.state).toBe("OPEN"); // state は変わった
    expect(ports.slack.updated).toHaveLength(1); // state の変化だけで描き直す
    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("要修正があります");
  });
});

// ---------------------------------------------------------------------------
// handleMonthClose
// ---------------------------------------------------------------------------

/**
 * `handleMonthClose` は必ず `recomputeMonthly` を再実行してから照合するため（実装設計 §5.3
 * 手順5）、このシードの数値列（`worked_minutes`〜`net_amount`）は呼び出し前に上書きされる。
 * このテストファイルではどの月にも日次集計を積んでいないため、再計算後は常に 0 になる
 * （`makeMonthCloseRequest` の既定 `shown_net_amount: 0` がこれと一致する）。
 */
function reviewingBill(overrides: Partial<MonthlyBillRow> = {}): MonthlyBillRow {
  return {
    client: "A社",
    month: "2026-10",
    worked_minutes: 0,
    hours: 0,
    unit_price: 0,
    amount: 0,
    tax_amount: 0,
    withholding_amount: 0,
    net_amount: 0,
    state: "REVIEWING",
    mf_invoice_id: null,
    locked_at: null,
    note: null,
    updated_at: 1,
    invoice_state: "",
    invoice_error: null,
    invoice_attempted_at: null,
    close_card_ts: "1756260000.000100",
    ...overrides,
  };
}

function makeMonthCloseRequest(overrides: Partial<MonthCloseRequest> = {}): MonthCloseRequest {
  return {
    kind: "month_close",
    idempotency_key: "U1:1756260000.000100:kado_month_close:1756260010.000100",
    user_id: "U1",
    channel_id: "C1",
    message_ts: "1756260000.000100",
    client: "A社",
    month: "2026-10",
    shown_net_amount: 0,
    received_at_ms: Date.now(),
    source: "button",
    ...overrides,
  };
}

function readyPorts(): ReturnType<typeof makeFakePorts> {
  const ports = makeFakePorts(Date.parse("2026-11-01T06:00:00+09:00"));
  ports.props.set("SLACK_CHANNEL_ID", "C1");
  seedUnitPrice(ports);
  return ports;
}

describe("handleMonthClose — DUPLICATE（凍結済み）", () => {
  it.each(["LOCKED", "MF_CREATED", "SENT", "PAID", "VOID"])("state=%s は DUPLICATE を返す", (state) => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set("A社|2026-10", reviewingBill({ state, invoice_state: "PENDING" }));

    const result = handleMonthClose(makeMonthCloseRequest(), ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "DUPLICATE" });
  });

  it("LOCKED のときはカードを現在の状態（締めました）で描き直す", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      reviewingBill({ state: "LOCKED", invoice_state: "PENDING" }),
    );

    handleMonthClose(makeMonthCloseRequest(), ports);

    expect(ports.slack.updated).toHaveLength(1);
    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("請求書を作成しています");
  });

  it("MF_CREATED（CREATED）のときはカードを「作成しました（未送付）」に描き直す（実装設計 MF連携 §5.5, WP-M3）", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      reviewingBill({ state: "MF_CREATED", invoice_state: "CREATED", mf_invoice_id: "INV1" }),
    );

    handleMonthClose(makeMonthCloseRequest(), ports);

    expect(ports.slack.updated).toHaveLength(1);
    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("未送付");
  });

  it("MF_CREATED（MISMATCH）のときはカードを「送付しないでください」に描き直す（WP-M3）", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      reviewingBill({ state: "MF_CREATED", invoice_state: "MISMATCH", mf_invoice_id: "INV1" }),
    );

    handleMonthClose(makeMonthCloseRequest(), ports);

    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("送付しないでください");
  });

  it("SENT のときはカードを「送付済み」に描き直す（WP-M3）", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      reviewingBill({ state: "SENT", invoice_state: "CREATED", mf_invoice_id: "INV1" }),
    );

    handleMonthClose(makeMonthCloseRequest(), ports);

    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("送付済み");
  });

  it("PAID のときはカードを「入金を確認しました」に描き直す（WP-M3）", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      reviewingBill({ state: "PAID", invoice_state: "CREATED", mf_invoice_id: "INV1" }),
    );

    handleMonthClose(makeMonthCloseRequest(), ports);

    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("入金を確認しました");
  });

  it("VOID のときはカードを描き直さない（人手のみ、実装設計 §5.1）", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set("A社|2026-10", reviewingBill({ state: "VOID" }));

    handleMonthClose(makeMonthCloseRequest(), ports);

    expect(ports.slack.updated).toHaveLength(0);
  });
});

describe("handleMonthClose — NOT_READY", () => {
  it("state=OPEN は NOT_READY", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set("A社|2026-10", reviewingBill({ state: "OPEN" }));

    const result = handleMonthClose(makeMonthCloseRequest(), ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "NOT_READY" });
  });

  it("月次行が存在しない（評価前）は NOT_READY", () => {
    const ports = readyPorts();

    const result = handleMonthClose(makeMonthCloseRequest(), ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "NOT_READY" });
  });
});

describe("handleMonthClose — STALE_CARD（古いカード）", () => {
  it("message_ts が close_card_ts と一致しなければ STALE_CARD で締めない", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      reviewingBill({ close_card_ts: "1756260000.999999" }),
    );

    const result = handleMonthClose(
      makeMonthCloseRequest({ message_ts: "1756260000.000100" }),
      ports,
    );

    expect(result).toEqual({ ok: true, applied: false, reason: "STALE_CARD" });
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.state).toBe("REVIEWING");
  });
});

describe("handleMonthClose — 金額が変わった", () => {
  it("net_amount !== shown_net_amount なら締めずに描き直す（AMOUNT_CHANGED）", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set("A社|2026-10", reviewingBill());

    const result = handleMonthClose(
      makeMonthCloseRequest({ shown_net_amount: 999999 }),
      ports,
    );

    expect(result).toEqual({ ok: true, applied: false, reason: "AMOUNT_CHANGED" });
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.state).toBe("REVIEWING");
    expect(ports.slack.updated).toHaveLength(1);
    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("金額が変わりました");
  });
});

describe("handleMonthClose — blockers があれば OPEN に戻す", () => {
  it("recomputeMonthly 後に要修正が見つかったら state=OPEN に戻し、描き直す", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set("A社|2026-10", reviewingBill());
    ports.sheets.upsertDailySummary({
      business_date: "2026-10-15",
      weekday: "木",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: null,
      worked_minutes: null,
      status: "要修正",
      correction_count: 0,
      note: "終了（END）が記録されていません",
      updated_at: Date.now(),
    });

    const result = handleMonthClose(makeMonthCloseRequest(), ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "BLOCKED" });
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.state).toBe("OPEN");
    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("要修正があります");
  });
});

describe("handleMonthClose — 成功（締める）", () => {
  it("MF_INVOICE_ENABLED 無効: invoice_state=MANUAL, scheduler は呼ばない", () => {
    const ports = readyPorts();
    ports.sheets.monthlyBills.set("A社|2026-10", reviewingBill());
    // MF_ENABLED/MF_INVOICE_ENABLED はどちらも未設定（既定で無効）。

    const result = handleMonthClose(makeMonthCloseRequest(), ports);

    expect(result).toEqual({ ok: true, applied: true });
    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.state).toBe("LOCKED");
    expect(bill.invoice_state).toBe("MANUAL");
    expect(bill.locked_at).not.toBeNull();
    expect(ports.scheduler.scheduleOnceCalls).toHaveLength(0);
    expect(ports.http.calls).toHaveLength(0); // MF はここでは呼ばない
    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("請求書は手動で作成してください");
  });

  it("MF_INVOICE_ENABLED 有効: invoice_state=PENDING, scheduleOnce を 1 回呼ぶ", () => {
    const ports = readyPorts();
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_INVOICE_ENABLED", "true");
    ports.sheets.monthlyBills.set("A社|2026-10", reviewingBill());

    const result = handleMonthClose(makeMonthCloseRequest(), ports);

    expect(result).toEqual({ ok: true, applied: true });
    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.state).toBe("LOCKED");
    expect(bill.invoice_state).toBe("PENDING");
    expect(ports.scheduler.scheduleOnceCalls).toEqual([{ handler: "trigMfSyncSoon", afterMs: 60000 }]);
    expect(blocksToText(ports.slack.updated[0]?.blocks)).toContain("請求書を作成しています");
  });

  it("既に trigMfSyncSoon が pending なら scheduleOnce を呼ばない", () => {
    const ports = readyPorts();
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_INVOICE_ENABLED", "true");
    ports.sheets.monthlyBills.set("A社|2026-10", reviewingBill());
    ports.sheets.monthlyBills.set(
      "A社|2026-11",
      reviewingBill({ month: "2026-11", close_card_ts: "1756260001.000100" }),
    );
    ports.scheduler.pending.add("trigMfSyncSoon"); // 既に他の締めで予約済み

    handleMonthClose(makeMonthCloseRequest(), ports);
    handleMonthClose(
      makeMonthCloseRequest({ month: "2026-11", message_ts: "1756260001.000100" }),
      ports,
    );

    expect(ports.scheduler.scheduleOnceCalls).toHaveLength(0);
  });
});
