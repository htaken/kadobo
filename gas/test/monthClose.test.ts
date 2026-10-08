/**
 * `core/monthClose.ts` の状態機械テスト（実装設計 MF連携 §5.1, §11.2 WP-M2 受入条件）。
 * 状態遷移表の全セルを網羅する。
 */
import { describe, expect, it } from "vitest";
import {
  isMonthFrozen,
  nextStateOnBillingStatus,
  nextStateOnEvaluate,
  type MonthCloseState,
} from "../src/core/monthClose";

const ALL_STATES: MonthCloseState[] = ["OPEN", "REVIEWING", "LOCKED", "MF_CREATED", "SENT", "PAID", "VOID"];

describe("isMonthFrozen", () => {
  it.each([
    ["OPEN", false],
    ["REVIEWING", false],
    ["LOCKED", true],
    ["MF_CREATED", true],
    ["SENT", true],
    ["PAID", true],
    ["VOID", true],
  ] as const)("%s -> %s", (state, expected) => {
    expect(isMonthFrozen(state)).toBe(expected);
  });

  it("未知の文字列は凍結扱いしない（fail open ではなく単に false）", () => {
    expect(isMonthFrozen("")).toBe(false);
    expect(isMonthFrozen("SOMETHING_ELSE")).toBe(false);
  });
});

describe("nextStateOnEvaluate — 状態遷移表の全セル", () => {
  it.each([
    ["OPEN", false, "REVIEWING"],
    ["OPEN", true, "OPEN"],
    ["REVIEWING", false, "REVIEWING"],
    ["REVIEWING", true, "OPEN"],
    ["LOCKED", false, "LOCKED"],
    ["LOCKED", true, "LOCKED"],
    ["MF_CREATED", false, "MF_CREATED"],
    ["MF_CREATED", true, "MF_CREATED"],
    ["SENT", false, "SENT"],
    ["SENT", true, "SENT"],
    ["PAID", false, "PAID"],
    ["PAID", true, "PAID"],
    ["VOID", false, "VOID"],
    ["VOID", true, "VOID"],
  ] as const)("state=%s hasBlockers=%s -> %s", (state, hasBlockers, expected) => {
    expect(nextStateOnEvaluate(state, hasBlockers)).toBe(expected);
  });
});

describe("nextStateOnBillingStatus — 状態遷移表の全セル", () => {
  const combos: { sent: boolean; paid: boolean }[] = [
    { sent: false, paid: false },
    { sent: true, paid: false },
    { sent: false, paid: true },
    { sent: true, paid: true },
  ];

  it.each([
    ["MF_CREATED", { sent: false, paid: false }, "MF_CREATED"],
    ["MF_CREATED", { sent: true, paid: false }, "SENT"],
    ["MF_CREATED", { sent: false, paid: true }, "PAID"],
    ["MF_CREATED", { sent: true, paid: true }, "PAID"],
    ["SENT", { sent: false, paid: false }, "SENT"],
    ["SENT", { sent: true, paid: false }, "SENT"],
    ["SENT", { sent: false, paid: true }, "PAID"],
    ["SENT", { sent: true, paid: true }, "PAID"],
  ] as const)("state=%s %o -> %s", (state, billing, expected) => {
    expect(nextStateOnBillingStatus(state, billing)).toBe(expected);
  });

  // 送付・入金の対象にならない状態（OPEN/REVIEWING/LOCKED/PAID/VOID）はどの組合せでも変わらない。
  const untouchedStates: MonthCloseState[] = ["OPEN", "REVIEWING", "LOCKED", "PAID", "VOID"];
  for (const state of untouchedStates) {
    for (const billing of combos) {
      it(`state=${state} sent=${billing.sent} paid=${billing.paid} は変わらない`, () => {
        expect(nextStateOnBillingStatus(state, billing)).toBe(state);
      });
    }
  }

  it("ALL_STATES を網羅していることの自己チェック", () => {
    expect(ALL_STATES).toHaveLength(7);
  });
});
