import { describe, expect, it } from "vitest";
import {
  aggregateDay,
  aggregateMonth,
  selectUnitPrice,
  type DailySummary,
  type UnitPriceRow,
} from "../src/core/aggregate";
import type { LoggedEvent } from "../src/core/state";

/** JST の `YYYY-MM-DD` + `HH:mm[:ss]` を UTC epoch ms に変換する（テスト用。秒まで扱える）。 */
function ts(dateStr: string, hms: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  const parts = hms.split(":").map(Number);
  const h = parts[0] as number;
  const mi = parts[1] as number;
  const s = (parts[2] as number) ?? 0;
  return Date.UTC(y as number, (m as number) - 1, d as number, h - 9, mi, s);
}

let seq = 0;
function ev(event_type: LoggedEvent["event_type"], occurred_at: number): LoggedEvent {
  seq += 1;
  return { event_id: `E${seq}`, event_type, occurred_at };
}
function correction(
  correction_of: string,
  occurred_at: number,
  new_value: number,
): LoggedEvent {
  seq += 1;
  return { event_id: `C${seq}`, event_type: "CORRECTION", occurred_at, correction_of, new_value };
}

const DATE = "2026-09-01";

describe("aggregateDay — 実装設計 §7.3 テストベクタ", () => {
  it("ベクタ1: 09:02:30 開始 → 12:00:10 終了 → 10660 秒 → 177 分（切り捨て）", () => {
    const events = [ev("START", ts(DATE, "09:02:30")), ev("END", ts(DATE, "12:00:10"))];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("OK");
    expect(result.worked_seconds).toBe(10660);
    expect(result.worked_minutes).toBe(177);
    expect(result.session_count).toBe(1);
  });

  it("ベクタ2: 休憩を挟んで 8h30m", () => {
    const events = [
      ev("START", ts(DATE, "09:00")),
      ev("BREAK_START", ts(DATE, "12:00")),
      ev("BREAK_END", ts(DATE, "12:30")),
      ev("END", ts(DATE, "18:00")),
    ];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("OK");
    expect(result.worked_minutes).toBe(8 * 60 + 30);
    expect(result.break_seconds).toBe(30 * 60);
  });

  it("ベクタ3: 休憩中に終了 → 実効終了は直前の休憩開始 → 3h00m", () => {
    const events = [
      ev("START", ts(DATE, "09:00")),
      ev("BREAK_START", ts(DATE, "12:00")),
      ev("END", ts(DATE, "12:40")),
    ];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("OK");
    expect(result.worked_minutes).toBe(3 * 60);
    expect(result.sessions[0]!.end_at).toBe(ts(DATE, "12:00"));
  });

  it("ベクタ4: 同日 2 セッション → 5h30m、session_count=2", () => {
    const events = [
      ev("START", ts(DATE, "09:00")),
      ev("END", ts(DATE, "12:00")),
      ev("START", ts(DATE, "13:00")),
      ev("END", ts(DATE, "15:30")),
    ];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("OK");
    expect(result.session_count).toBe(2);
    expect(result.worked_minutes).toBe(5 * 60 + 30);
  });

  it("ベクタ5: 跨日 22:00 開始 → 翌 01:30 終了 → 開始日に 3h30m", () => {
    const nextDay = "2026-09-02";
    const events = [ev("START", ts(DATE, "22:00")), ev("END", ts(nextDay, "01:30"))];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("OK");
    expect(result.worked_minutes).toBe(3 * 60 + 30);
  });

  it("ベクタ5: 翌日側は 0（イベントが割り当たらない）", () => {
    const result = aggregateDay([], { isToday: false });
    expect(result.status).toBe("OK");
    expect(result.worked_minutes).toBe(0);
    expect(result.session_count).toBe(0);
  });

  it("ベクタ6: CORRECTION で 12:00 終了 → 12:30 に変更 → 変更後の値で集計、元行は不変", () => {
    const start = ev("START", ts(DATE, "09:00"));
    const end = ev("END", ts(DATE, "12:00"));
    const events = [start, end, correction(end.event_id, ts(DATE, "12:05"), ts(DATE, "12:30"))];
    const result = aggregateDay(events, { isToday: false });
    expect(result.worked_minutes).toBe(3 * 60 + 30);
    expect(result.correction_count).toBe(1);
    // 元イベント列（呼び出し側が渡した配列）は変更されない
    expect(end.occurred_at).toBe(ts(DATE, "12:00"));
    expect(events[1]!.occurred_at).toBe(ts(DATE, "12:00"));
  });

  it("ベクタ7: 2 回目の CORRECTION が有効（最新勝ち）", () => {
    const start = ev("START", ts(DATE, "09:00"));
    const end = ev("END", ts(DATE, "12:00"));
    const events = [
      start,
      end,
      correction(end.event_id, ts(DATE, "12:05"), ts(DATE, "12:30")),
      correction(end.event_id, ts(DATE, "13:00"), ts(DATE, "13:00")),
    ];
    const result = aggregateDay(events, { isToday: false });
    expect(result.worked_minutes).toBe(4 * 60);
    expect(result.correction_count).toBe(2);
  });

  it("ベクタ8: END 無し START（過去日）→ 要修正", () => {
    const events = [ev("START", ts(DATE, "09:00"))];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("要修正");
    expect(result.worked_seconds).toBeNull();
    expect(result.worked_minutes).toBeNull();
  });

  it("ベクタ8: END 無し START（当日）→ 進行中", () => {
    const events = [ev("START", ts(DATE, "09:00"))];
    const result = aggregateDay(events, { isToday: true });
    expect(result.status).toBe("進行中");
    expect(result.worked_seconds).toBeNull();
    expect(result.worked_minutes).toBeNull();
  });
});

describe("aggregateDay — ペアリング不能のその他パターン", () => {
  it("BREAK_END 単独（対応する BREAK_START が無い）→ 要修正", () => {
    const events = [ev("START", ts(DATE, "09:00")), ev("BREAK_END", ts(DATE, "10:00"))];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("要修正");
  });

  it("END 単独（対応する START が無い）→ 要修正", () => {
    const events = [ev("END", ts(DATE, "10:00"))];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("要修正");
  });

  it("訂正による並び替えで順序矛盾になった場合も要修正", () => {
    // BREAK_START を BREAK_END より後ろへ訂正 → 再生順が破綻する
    const start = ev("START", ts(DATE, "09:00"));
    const breakStart = ev("BREAK_START", ts(DATE, "10:00"));
    const breakEnd = ev("BREAK_END", ts(DATE, "10:30"));
    const end = ev("END", ts(DATE, "12:00"));
    const events = [
      start,
      breakStart,
      breakEnd,
      end,
      correction(breakStart.event_id, ts(DATE, "10:35"), ts(DATE, "10:45")),
    ];
    const result = aggregateDay(events, { isToday: false });
    expect(result.status).toBe("要修正");
  });
});

describe("aggregateDay — その他のフィールド", () => {
  it("first_start_jst / last_end_jst / correction_count を算出する", () => {
    const events = [
      ev("START", ts(DATE, "09:00")),
      ev("END", ts(DATE, "12:00")),
    ];
    const result = aggregateDay(events, { isToday: false });
    expect(result.first_start_jst).toBe(`${DATE} 09:00:00`);
    expect(result.last_end_jst).toBe(`${DATE} 12:00:00`);
    expect(result.correction_count).toBe(0);
  });

  it("イベントが 1 件も無い日は first_start_jst / last_end_jst が null", () => {
    const result = aggregateDay([], { isToday: false });
    expect(result.first_start_jst).toBeNull();
    expect(result.last_end_jst).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 月次
// ---------------------------------------------------------------------------

function stubDaily(workedMinutes: number | null): DailySummary {
  return {
    status: workedMinutes === null ? "要修正" : "OK",
    session_count: 1,
    first_start_jst: null,
    last_end_jst: null,
    break_seconds: 0,
    worked_seconds: workedMinutes === null ? null : workedMinutes * 60,
    worked_minutes: workedMinutes,
    correction_count: 0,
    sessions: [],
    note: null,
  };
}

function baseUnitPrice(overrides: Partial<UnitPriceRow> = {}): UnitPriceRow {
  return {
    client: "A社",
    unit_price: 1000,
    tax_category: "不課税",
    tax_inclusive: false,
    tax_display: "なし",
    rounding: "切捨",
    withholding: "なし",
    valid_from: "2026-01-01",
    valid_to: null,
    ...overrides,
  };
}

describe("aggregateMonth — 実装設計 §7.3 テストベクタ9", () => {
  it("ベクタ9: 日次 177 分 + 510 分 = 687 分 → 11.45h", () => {
    const result = aggregateMonth([stubDaily(177), stubDaily(510)], baseUnitPrice());
    expect(result.worked_minutes).toBe(687);
    expect(result.hours).toBeCloseTo(11.45, 10);
  });

  it("worked_minutes が null（要修正）の日は 0 として合算する", () => {
    const result = aggregateMonth([stubDaily(177), stubDaily(null)], baseUnitPrice());
    expect(result.worked_minutes).toBe(177);
  });
});

describe("aggregateMonth — 端数処理（切捨・四捨五入・切上）", () => {
  it("切捨: 3.17h × 333円 = 1055.61 → 1055", () => {
    const result = aggregateMonth(
      [stubDaily(190)],
      baseUnitPrice({ unit_price: 333, rounding: "切捨" }),
    );
    expect(result.hours).toBeCloseTo(3.17, 10);
    expect(result.amount).toBe(1055);
  });

  it("四捨五入: 1.5h × 823円 = 1234.5 → 1235", () => {
    const result = aggregateMonth(
      [stubDaily(90)],
      baseUnitPrice({ unit_price: 823, rounding: "四捨五入" }),
    );
    expect(result.hours).toBeCloseTo(1.5, 10);
    expect(result.amount).toBe(1235);
  });

  it("切上: 3.17h × 331円 = 1049.27 → 1050", () => {
    const result = aggregateMonth(
      [stubDaily(190)],
      baseUnitPrice({ unit_price: 331, rounding: "切上" }),
    );
    expect(result.hours).toBeCloseTo(3.17, 10);
    expect(result.amount).toBe(1050);
  });
});

describe("aggregateMonth — 税区分・源泉徴収", () => {
  it("不課税・源泉なし → tax_amount=0, withholding_amount=0, net=amount", () => {
    const result = aggregateMonth(
      [stubDaily(600)],
      baseUnitPrice({ unit_price: 5000, tax_category: "不課税", withholding: "なし" }),
    );
    expect(result.amount).toBe(50000);
    expect(result.tax_amount).toBe(0);
    expect(result.withholding_amount).toBe(0);
    expect(result.net_amount).toBe(50000);
  });

  it("課税・源泉10.21% → amount=50000, tax=5000, withholding=5105, net=49895", () => {
    const result = aggregateMonth(
      [stubDaily(600)],
      baseUnitPrice({
        unit_price: 5000,
        tax_category: "課税",
        withholding: "10.21%",
        rounding: "切捨",
      }),
    );
    expect(result.amount).toBe(50000);
    expect(result.tax_amount).toBe(5000);
    expect(result.withholding_amount).toBe(5105);
    expect(result.net_amount).toBe(49895);
  });
});

describe("selectUnitPrice", () => {
  const rows: UnitPriceRow[] = [
    baseUnitPrice({ valid_from: "2026-01-01", valid_to: "2026-08-31", unit_price: 3000 }),
    baseUnitPrice({ valid_from: "2026-09-01", valid_to: null, unit_price: 3500 }),
  ];

  it("業務日時点で有効な行を選ぶ", () => {
    const result = selectUnitPrice(rows, "2026-09-15");
    expect(result).not.toHaveProperty("error");
    expect((result as UnitPriceRow).unit_price).toBe(3500);
  });

  it("valid_to が null の行は無期限として扱う", () => {
    const result = selectUnitPrice(rows, "2030-01-01");
    expect((result as UnitPriceRow).unit_price).toBe(3500);
  });

  it("該当する行が無ければ NOT_FOUND エラー", () => {
    const result = selectUnitPrice(rows, "2020-01-01");
    expect(result).toEqual({ error: "NOT_FOUND" });
  });

  it("複数該当すれば MULTIPLE_MATCHES エラー", () => {
    const overlapping: UnitPriceRow[] = [
      baseUnitPrice({ valid_from: "2026-01-01", valid_to: "2026-12-31" }),
      baseUnitPrice({ valid_from: "2026-06-01", valid_to: "2026-12-31" }),
    ];
    const result = selectUnitPrice(overlapping, "2026-07-01");
    expect(result).toEqual({ error: "MULTIPLE_MATCHES" });
  });
});
