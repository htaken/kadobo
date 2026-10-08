import { describe, expect, it } from "vitest";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABELS, isPaymentMethod } from "../src/expense";

describe("支払方法（実装設計 MF連携 §10.2）", () => {
  it("PAYMENT_METHODS は linked_card・linked_bank・cash の順", () => {
    expect([...PAYMENT_METHODS]).toEqual(["linked_card", "linked_bank", "cash"]);
  });

  it("表示名は §2.3 の表どおり", () => {
    expect(PAYMENT_METHOD_LABELS).toEqual({
      linked_card: "連携カード",
      linked_bank: "連携口座から直接（振込・引落）",
      cash: "現金・その他（立替）",
    });
  });

  it("isPaymentMethod: 3 値だけ true。空文字・未知の値・文字列以外は false", () => {
    for (const m of PAYMENT_METHODS) {
      expect(isPaymentMethod(m)).toBe(true);
    }
    expect(isPaymentMethod("")).toBe(false);
    expect(isPaymentMethod("credit")).toBe(false);
    expect(isPaymentMethod(undefined)).toBe(false);
    expect(isPaymentMethod(1)).toBe(false);
  });
});
