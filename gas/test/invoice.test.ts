/**
 * `core/invoice.ts` のテスト（実装設計 MF連携 §5.4〜§5.7, §11.2）。
 * `dueDateOf` は WP-M2、`buildInvoiceRequest`/`renderDailyNote`/`compareAmounts`/
 * `normalizeBillingStatus` は WP-M3 の受入条件。
 */
import { describe, expect, it } from "vitest";
import type { UnitPriceRow } from "../src/core/aggregate";
import {
  DEFAULT_EXTRA_HOLIDAYS,
  buildInvoiceRequest,
  compareAmounts,
  dueDateOf,
  invoiceBillingNumberOf,
  normalizeBillingStatus,
  renderDailyNote,
  type DailyNoteRow,
} from "../src/core/invoice";

const noHoliday = () => false;

describe("dueDateOf", () => {
  it("通常月（休日に当たらない）: 翌月末そのまま。10月分 -> 11/30（月）", () => {
    expect(dueDateOf("2026-10", noHoliday)).toBe("2026-11-30");
  });

  it("11月分: 支払日 12/31 が既定の MF_EXTRA_HOLIDAYS に当たる -> 前営業日 12/30（水）", () => {
    expect(dueDateOf("2026-11", noHoliday)).toBe("2026-12-30");
  });

  it("11月分: 12/30 も休日扱いなら更に前（12/29・火）に戻る", () => {
    const isHoliday = (d: string) => d === "2026-12-30";
    expect(dueDateOf("2026-11", isHoliday)).toBe("2026-12-29");
  });

  it("月末が日曜日: 12月分 -> 翌月末 2027-01-31（日）は休日カレンダーに当たらなくても土日なので、" +
    "土曜（01-30）も飛ばして金曜 2027-01-29 まで戻る", () => {
    expect(dueDateOf("2026-12", noHoliday)).toBe("2027-01-29");
  });

  it("月末が祝日カレンダーに当たる場合も前営業日へ戻る", () => {
    // 2026-09-30（水）を祝日カレンダー上の休日として扱う。
    const isHoliday = (d: string) => d === "2026-09-30";
    expect(dueDateOf("2026-08", isHoliday)).toBe("2026-09-29");
  });

  it("MF_EXTRA_HOLIDAYS を明示的に渡すと既定値を使わない", () => {
    // 既定なら 12/31 が休日扱いだが、空配列を渡すと平日の 12/31（木）がそのまま使われる。
    expect(dueDateOf("2026-11", noHoliday, [])).toBe("2026-12-31");
  });

  it("DEFAULT_EXTRA_HOLIDAYS の既定値は '12-31,01-02,01-03'", () => {
    expect(DEFAULT_EXTRA_HOLIDAYS).toEqual(["12-31", "01-02", "01-03"]);
  });
});

// ---------------------------------------------------------------------------
// invoiceBillingNumberOf（実装設計 §5.4, WP-M3）
// ---------------------------------------------------------------------------

describe("invoiceBillingNumberOf", () => {
  it("YYYY-MM -> KD-YYYYMM", () => {
    expect(invoiceBillingNumberOf("2026-10")).toBe("KD-202610");
    expect(invoiceBillingNumberOf("2027-01")).toBe("KD-202701");
  });
});

// ---------------------------------------------------------------------------
// renderDailyNote（実装設計 §5.4, WP-M3）
// ---------------------------------------------------------------------------

function noteRow(overrides: Partial<DailyNoteRow> = {}): DailyNoteRow {
  return {
    business_date: "2026-10-05",
    weekday: "月",
    status: "OK",
    worked_minutes: 480,
    ...overrides,
  };
}

describe("renderDailyNote", () => {
  it("OK 行を日付順に MM/DD(曜) H:MM で並べ、末尾に合計を付ける（順不同で渡しても並べ替える）", () => {
    const note = renderDailyNote([
      noteRow({ business_date: "2026-10-06", weekday: "火", worked_minutes: 510 }), // 8:30
      noteRow({ business_date: "2026-10-05", weekday: "月", worked_minutes: 480 }), // 8:00
    ]);
    expect(note).toBe("10/05(月) 8:00\n10/06(火) 8:30\n合計 16.5 時間（990 分）");
  });

  it("OK 以外の行（要修正・進行中）は除外する", () => {
    const note = renderDailyNote([
      noteRow({ business_date: "2026-10-05", weekday: "月", worked_minutes: 480 }),
      noteRow({ business_date: "2026-10-06", weekday: "火", status: "要修正", worked_minutes: null }),
      noteRow({ business_date: "2026-10-07", weekday: "水", status: "進行中", worked_minutes: null }),
    ]);
    expect(note).toBe("10/05(月) 8:00\n合計 8 時間（480 分）");
  });

  it("0 件: 合計行だけを返す", () => {
    expect(renderDailyNote([])).toBe("合計 0 時間（0 分）");
  });

  it("2000 字を超えたら切り詰め、全体で 2000 字以内に収める", () => {
    const rows: DailyNoteRow[] = Array.from({ length: 200 }, (_, i) => {
      const d = new Date(Date.UTC(2026, 0, 1 + i));
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, "0");
      const day = String(d.getUTCDate()).padStart(2, "0");
      return noteRow({ business_date: `${y}-${m}-${day}`, weekday: "月", worked_minutes: 480 });
    });
    const note = renderDailyNote(rows);
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(note.length).toBe(2000);
    expect(note.endsWith("（以下省略。日別明細は別添）")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildInvoiceRequest（実装設計 §5.4, WP-M3）
// ---------------------------------------------------------------------------

function unitRow(overrides: Partial<UnitPriceRow> = {}): UnitPriceRow {
  return {
    client: "A社",
    unit_price: 1800,
    tax_category: "課税",
    tax_inclusive: false,
    tax_display: "区分記載",
    rounding: "切捨",
    withholding: "10.21%",
    valid_from: "2026-01-01",
    valid_to: null,
    ...overrides,
  };
}

describe("buildInvoiceRequest", () => {
  it("設計書 §5.4 の表どおりの項目を組み立てる（課税・源泉あり）", () => {
    const req = buildInvoiceRequest(
      { client: "A社", month: "2026-10", hours: 160.25 },
      unitRow(),
      [],
      { department_id: "DEPT-1", due_date: "2026-11-30" },
    );

    expect(req.department_id).toBe("DEPT-1");
    expect(req.billing_number).toBe("KD-202610");
    expect(req.billing_date).toBe("2026-10-31");
    expect(req.sales_date).toBe("2026-10-31");
    expect(req.due_date).toBe("2026-11-30");
    expect(req.title).toBe("10月分 業務委託料");
    expect(req.items).toHaveLength(1);
    expect(req.items[0]).toEqual({
      name: "2026年10月分 業務委託料",
      detail: "稼働 160.25 時間",
      unit: "時間",
      quantity: 160.25,
      price: 1800,
      excise: "ten_percent",
      is_deduct_withholding_tax: true,
    });
    expect(req.note).toBe("合計 0 時間（0 分）");
    expect(req.memo).toBe("kadobo client=A社 month=2026-10");
  });

  it("不課税: excise は untaxable", () => {
    const req = buildInvoiceRequest(
      { client: "A社", month: "2026-10", hours: 100 },
      unitRow({ tax_category: "不課税" }),
      [],
      { department_id: "DEPT-1", due_date: "2026-11-30" },
    );
    expect(req.items[0]?.excise).toBe("untaxable");
  });

  it("源泉なし: is_deduct_withholding_tax は false", () => {
    const req = buildInvoiceRequest(
      { client: "A社", month: "2026-10", hours: 100 },
      unitRow({ withholding: "なし" }),
      [],
      { department_id: "DEPT-1", due_date: "2026-11-30" },
    );
    expect(req.items[0]?.is_deduct_withholding_tax).toBe(false);
  });

  it("note は renderDailyNote の結果そのもの", () => {
    const req = buildInvoiceRequest(
      { client: "A社", month: "2026-10", hours: 8 },
      unitRow(),
      [noteRow({ business_date: "2026-10-05", weekday: "月", worked_minutes: 480 })],
      { department_id: "DEPT-1", due_date: "2026-11-30" },
    );
    expect(req.note).toBe(renderDailyNote([noteRow({ business_date: "2026-10-05", weekday: "月", worked_minutes: 480 })]));
  });

  it("11 月分: due_date は dueDateOf('2026-11', ...) の結果（12/31 が休日 -> 12/30）をそのまま使う", () => {
    const dueDate = dueDateOf("2026-11", () => false); // 既定の MF_EXTRA_HOLIDAYS が効く
    expect(dueDate).toBe("2026-12-30");
    const req = buildInvoiceRequest(
      { client: "A社", month: "2026-11", hours: 150 },
      unitRow(),
      [],
      { department_id: "DEPT-1", due_date: dueDate },
    );
    expect(req.billing_number).toBe("KD-202611");
    expect(req.billing_date).toBe("2026-11-30");
    expect(req.due_date).toBe("2026-12-30");
  });
});

// ---------------------------------------------------------------------------
// compareAmounts（実装設計 §5.5 手順3, WP-M3）
// ---------------------------------------------------------------------------

interface CompareBill {
  amount: number;
  tax_amount: number;
  withholding_amount: number;
  net_amount: number;
}

function compareBill(overrides: Partial<CompareBill> = {}): CompareBill {
  return { amount: 288000, tax_amount: 28800, withholding_amount: 0, net_amount: 316800, ...overrides };
}

describe("compareAmounts", () => {
  it("一致: deduct_price 無し（源泉 0）", () => {
    const result = compareAmounts(compareBill(), {
      subtotal_price: "288000",
      excise_price: "28800",
      total_price: "316800",
    });
    expect(result).toEqual({ match: true, summary: "" });
  });

  it("一致: deduct_price が空文字でも 0 として扱う", () => {
    const result = compareAmounts(compareBill(), {
      subtotal_price: "288000",
      excise_price: "28800",
      total_price: "316800",
      deduct_price: "",
    });
    expect(result.match).toBe(true);
  });

  it("報酬額のみ不一致", () => {
    const result = compareAmounts(compareBill(), {
      subtotal_price: "288018",
      excise_price: "28800",
      total_price: "316800",
    });
    expect(result.match).toBe(false);
    expect(result.summary).toContain("報酬額");
    expect(result.summary).not.toContain("消費税相当額");
  });

  it("消費税相当額のみ不一致", () => {
    const result = compareAmounts(compareBill(), {
      subtotal_price: "288000",
      excise_price: "28801",
      total_price: "316800",
    });
    expect(result.match).toBe(false);
    expect(result.summary).toContain("消費税相当額");
    expect(result.summary).not.toContain("報酬額");
  });

  it("税込額・差引入金予定額が不一致（total_price がずれる）", () => {
    const result = compareAmounts(compareBill(), {
      subtotal_price: "288000",
      excise_price: "28800",
      total_price: "316900",
    });
    expect(result.match).toBe(false);
    expect(result.summary).toContain("税込額");
    expect(result.summary).toContain("差引入金予定額");
  });

  it("源泉徴収額が不一致（deduct_price あり）", () => {
    const result = compareAmounts(compareBill({ withholding_amount: 2000, net_amount: 314800 }), {
      subtotal_price: "288000",
      excise_price: "28800",
      total_price: "316800",
      deduct_price: "1000",
    });
    expect(result.match).toBe(false);
    expect(result.summary).toContain("源泉徴収額");
  });

  it("数値でない文字列は不一致扱い", () => {
    const result = compareAmounts(compareBill(), {
      subtotal_price: "abc",
      excise_price: "28800",
      total_price: "316800",
    });
    expect(result.match).toBe(false);
    expect(result.summary).toContain("報酬額");
    expect(result.summary).toContain("(数値でない)");
  });
});

// ---------------------------------------------------------------------------
// normalizeBillingStatus（実装設計 §3.1, §5.7, WP-M3）
// ---------------------------------------------------------------------------

describe("normalizeBillingStatus", () => {
  it.each([
    ["sent", true],
    ["already_read", true],
    ["送付済み", true],
    ["受領済み", true],
    ["draft", false],
  ] as const)("email_status=%s -> sent=%s", (emailStatus, expected) => {
    expect(normalizeBillingStatus({ email_status: emailStatus }).sent).toBe(expected);
  });

  it.each([
    ["sent", true],
    ["郵送済み", true],
    ["unposted", false],
  ] as const)("posting_status=%s -> sent=%s", (postingStatus, expected) => {
    expect(normalizeBillingStatus({ posting_status: postingStatus }).sent).toBe(expected);
  });

  it.each([
    ["2", true],
    ["入金済み", true],
    ["1", false],
    ["0", false],
  ] as const)("payment_status=%s（文字列） -> paid=%s", (paymentStatus, expected) => {
    expect(normalizeBillingStatus({ payment_status: paymentStatus }).paid).toBe(expected);
  });

  it("payment_status が数値 2 でも paid=true", () => {
    expect(normalizeBillingStatus({ payment_status: 2 }).paid).toBe(true);
  });

  it("payment_status が数値 1 は paid=false", () => {
    expect(normalizeBillingStatus({ payment_status: 1 }).paid).toBe(false);
  });

  it("何も無ければ sent=false, paid=false", () => {
    expect(normalizeBillingStatus({})).toEqual({ sent: false, paid: false });
  });

  it("送付済み・入金済みが同時に立つ", () => {
    expect(normalizeBillingStatus({ email_status: "sent", payment_status: "2" })).toEqual({
      sent: true,
      paid: true,
    });
  });
});
