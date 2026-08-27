import { describe, expect, it } from "vitest";
import {
  businessDateOf,
  formatHm,
  formatJst,
  jstToMs,
  slackTsToMs,
  toJst,
} from "../src/time";

describe("slackTsToMs", () => {
  it("マイクロ秒6桁の action_ts を ms に変換する（実装設計 §4.1）", () => {
    expect(slackTsToMs("1756260000.123456")).toBe(1756260000123);
  });

  it("小数部が無い場合は ms=0 として扱う", () => {
    expect(slackTsToMs("1756260000")).toBe(1756260000000);
  });

  it("小数部が1桁の場合は右側を0埋めして解釈する（.5 → 500ms）", () => {
    expect(slackTsToMs("1756260000.5")).toBe(1756260000500);
  });

  it("小数部が2桁の場合も右側を0埋めして解釈する（.12 → 120ms）", () => {
    expect(slackTsToMs("1756260000.12")).toBe(1756260000120);
  });

  it("小数部が3桁ちょうどの場合はそのまま", () => {
    expect(slackTsToMs("1756260000.007")).toBe(1756260000007);
  });

  it("小数部が4桁以上の場合は先頭3桁のみ使う（切り捨て）", () => {
    expect(slackTsToMs("1756260000.999999")).toBe(1756260000999);
  });

  it("秒=0 でも計算できる", () => {
    expect(slackTsToMs("0.000001")).toBe(0);
  });
});

describe("toJst / businessDateOf（JST 変換・業務日）", () => {
  it("UTC 15:00 は JST 翌日 00:00（日跨ぎ）", () => {
    // 2026-08-31T15:00:00Z = 2026-09-01T00:00:00+09:00
    const ms = Date.UTC(2026, 7, 31, 15, 0, 0);
    const t = toJst(ms);
    expect(t).toEqual({
      year: 2026,
      month: 9,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
      weekday: 2, // 2026-09-01 は火曜日
    });
    expect(businessDateOf(ms)).toBe("2026-09-01");
  });

  it("UTC 14:59:59 は JST 同日 23:59:59（日跨ぎ直前）", () => {
    const ms = Date.UTC(2026, 7, 31, 14, 59, 59);
    expect(businessDateOf(ms)).toBe("2026-08-31");
    expect(toJst(ms).hour).toBe(23);
    expect(toJst(ms).minute).toBe(59);
  });

  it("月・日をまたぐ年末年始も正しい", () => {
    // 2025-12-31T15:00:00Z = 2026-01-01T00:00:00+09:00
    const ms = Date.UTC(2025, 11, 31, 15, 0, 0);
    expect(businessDateOf(ms)).toBe("2026-01-01");
  });
});

describe("formatJst / formatHm", () => {
  it("YYYY-MM-DD HH:mm:ss 形式", () => {
    const ms = Date.UTC(2026, 7, 31, 0, 2, 30); // JST 09:02:30
    expect(formatJst(ms)).toBe("2026-08-31 09:02:30");
  });

  it("HH:mm 形式（秒は含まない）", () => {
    const ms = Date.UTC(2026, 7, 31, 0, 2, 30);
    expect(formatHm(ms)).toBe("09:02");
  });

  it("1桁の時・分・秒は0埋めする", () => {
    const ms = Date.UTC(2026, 0, 1, 0, 5, 9); // JST 09:05:09
    expect(formatJst(ms)).toBe("2026-01-01 09:05:09");
  });
});

describe("jstToMs", () => {
  it("YYYY-MM-DD と HH:mm から ms を復元する（往復一致）", () => {
    const ms = jstToMs("2026-09-01", "00:00");
    expect(ms).toBe(Date.UTC(2026, 7, 31, 15, 0, 0));
    expect(businessDateOf(ms)).toBe("2026-09-01");
  });

  it("formatJst の date/time 部分から作った ms が元の ms（秒0）と一致する", () => {
    const original = Date.UTC(2026, 7, 31, 0, 2, 0); // JST 09:02:00
    const date = businessDateOf(original);
    const time = formatHm(original);
    expect(jstToMs(date, time)).toBe(original);
  });
});
