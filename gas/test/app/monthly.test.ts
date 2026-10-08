/**
 * `recomputeMonthly` の列指定書込みテスト（実装設計 MF連携 §0, §5.1, §11.2 WP-M2 受入条件）。
 *
 * 受入条件「集計が状態列を書かない」: 締め（`LOCKED`）後に `recomputeMonthly` が動いても
 * `state`・`invoice_*`・`close_card_ts` が変わらないことを、フェイクの Sheets で列単位に検証する。
 */
import { describe, expect, it } from "vitest";
import { recomputeMonthly } from "../../src/app/monthly";
import type { MonthlyBillRow } from "../../src/app/ports";
import { makeFakePorts } from "./fakes";

function seedUnitPrice(ports: ReturnType<typeof makeFakePorts>): void {
  ports.sheets.unitPrices.push({
    client: "A社",
    unit_price: 3000,
    tax_category: "課税",
    tax_inclusive: false,
    tax_display: "区分記載",
    rounding: "切捨",
    withholding: "なし",
    valid_from: "2026-01-01",
    valid_to: null,
  });
}

function seedWorkedDay(ports: ReturnType<typeof makeFakePorts>, date: string, minutes: number): void {
  ports.sheets.upsertDailySummary({
    business_date: date,
    weekday: "月",
    session_count: 1,
    first_start_jst: null,
    last_end_jst: null,
    break_seconds: 0,
    worked_seconds: minutes * 60,
    worked_minutes: minutes,
    status: "OK",
    correction_count: 0,
    note: null,
    updated_at: Date.now(),
  });
}

describe("recomputeMonthly — 行が無いとき", () => {
  it("新規作成する（state:OPEN, invoice_state:'' 等の既定値）", () => {
    const ports = makeFakePorts();
    seedUnitPrice(ports);
    seedWorkedDay(ports, "2026-08-10", 180);

    recomputeMonthly("A社", "2026-08", ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-08");
    expect(bill).not.toBeNull();
    expect(bill?.worked_minutes).toBe(180);
    expect(bill?.state).toBe("OPEN");
    expect(bill?.mf_invoice_id).toBeNull();
    expect(bill?.locked_at).toBeNull();
    expect(bill?.invoice_state).toBe("");
    expect(bill?.invoice_error).toBeNull();
    expect(bill?.invoice_attempted_at).toBeNull();
    expect(bill?.close_card_ts).toBeNull();
  });
});

describe("recomputeMonthly — 既存行がある（未凍結）とき", () => {
  it("数値列・note・updated_at だけを書く。state・invoice_* 等の列には触れない", () => {
    const ports = makeFakePorts();
    seedUnitPrice(ports);
    seedWorkedDay(ports, "2026-08-10", 180);

    const seeded: MonthlyBillRow = {
      client: "A社",
      month: "2026-08",
      worked_minutes: 0,
      hours: 0,
      unit_price: 0,
      amount: 0,
      tax_amount: 0,
      withholding_amount: 0,
      net_amount: 0,
      state: "REVIEWING",
      mf_invoice_id: "SENTINEL-ID",
      locked_at: 999,
      note: "古いメモ",
      updated_at: 1,
      invoice_state: "",
      invoice_error: "古いエラー",
      invoice_attempted_at: 12345,
      close_card_ts: "1700000000.000100",
    };
    ports.sheets.monthlyBills.set("A社|2026-08", seeded);

    recomputeMonthly("A社", "2026-08", ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-08")!;
    // 数値列は再計算された値に更新される。
    expect(bill.worked_minutes).toBe(180);
    expect(bill.hours).toBe(3);
    expect(bill.amount).toBe(9000);
    expect(bill.note).toBeNull(); // 単価エラーが無いので note はクリアされる
    // state・請求書列・close_card_ts はどれ一つ触れられていない（元の値のまま）。
    expect(bill.state).toBe("REVIEWING");
    expect(bill.mf_invoice_id).toBe("SENTINEL-ID");
    expect(bill.locked_at).toBe(999);
    expect(bill.invoice_state).toBe("");
    expect(bill.invoice_error).toBe("古いエラー");
    expect(bill.invoice_attempted_at).toBe(12345);
    expect(bill.close_card_ts).toBe("1700000000.000100");
    // 列指定の書込み: ポートに渡した patch のキーが数値列・note・updated_at だけ（状態・請求書の列を含まない）。
    const allowed = new Set([
      "worked_minutes", "hours", "unit_price", "amount", "tax_amount", "withholding_amount", "net_amount", "note", "updated_at",
    ]);
    expect(ports.sheets.monthlyPatchKeys).toHaveLength(1);
    for (const k of ports.sheets.monthlyPatchKeys[0]!) {
      expect(allowed.has(k)).toBe(true);
    }
  });

  it("単価エラー時も note だけを書き、状態列には触れない", () => {
    const ports = makeFakePorts();
    seedWorkedDay(ports, "2026-08-10", 180);
    // 単価マスタが無い（NOT_FOUND エラー）。

    const seeded: MonthlyBillRow = {
      client: "A社",
      month: "2026-08",
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
      close_card_ts: null,
    };
    ports.sheets.monthlyBills.set("A社|2026-08", seeded);

    recomputeMonthly("A社", "2026-08", ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-08")!;
    expect(bill.note).toBe("単価マスタ: 該当なし");
    expect(bill.state).toBe("REVIEWING"); // 状態列は変わらない
    const stateKeys = ["state", "mf_invoice_id", "locked_at", "invoice_state", "invoice_error", "invoice_attempted_at", "close_card_ts"];
    for (const k of ports.sheets.monthlyPatchKeys.flat()) {
      expect(stateKeys).not.toContain(k);
    }
  });
});

describe("recomputeMonthly — 凍結済み（LOCKED 以降）は何もしない", () => {
  function frozenRow(state: string): MonthlyBillRow {
    return {
      client: "A社",
      month: "2026-08",
      worked_minutes: 111,
      hours: 1.85,
      unit_price: 3000,
      amount: 5550,
      tax_amount: 555,
      withholding_amount: 0,
      net_amount: 6105,
      state,
      mf_invoice_id: "INV-1",
      locked_at: 1000,
      note: null,
      updated_at: 1000,
      invoice_state: "PENDING",
      invoice_error: null,
      invoice_attempted_at: null,
      close_card_ts: "1700000000.000100",
    };
  }

  it.each(["LOCKED", "MF_CREATED", "SENT", "PAID", "VOID"])(
    "state=%s: 数値列すら書き換えない（recomputeMonthly が丸ごと no-op）",
    (state) => {
      const ports = makeFakePorts();
      seedUnitPrice(ports);
      // 凍結月にも新しい打刻が来ていた場合を想定し、あえて別の値を日次に入れておく。
      seedWorkedDay(ports, "2026-08-10", 9999);
      ports.sheets.monthlyBills.set("A社|2026-08", frozenRow(state));

      // updateMonthlyBillColumns/upsertMonthlyBill が万一呼ばれたら例外にして検出する。
      ports.sheets.updateMonthlyBillColumns = () => {
        throw new Error("must not be called on frozen month");
      };
      ports.sheets.upsertMonthlyBill = () => {
        throw new Error("must not be called on frozen month");
      };

      expect(() => recomputeMonthly("A社", "2026-08", ports)).not.toThrow();

      const bill = ports.sheets.getMonthlyBill("A社", "2026-08")!;
      expect(bill.worked_minutes).toBe(111); // 元のまま
      expect(bill.state).toBe(state);
      expect(bill.invoice_state).toBe("PENDING");
      expect(bill.close_card_ts).toBe("1700000000.000100");
    },
  );
});
