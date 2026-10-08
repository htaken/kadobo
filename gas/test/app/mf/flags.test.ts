/**
 * `app/mf/flags.ts` の真理値表（実装設計 MF連携 §9）。既定はすべて無効（fail closed）、
 * `"true"` という文字列以外（未設定・`"1"`・`"TRUE"` 等）はすべて無効として扱う。
 */
import { describe, expect, it } from "vitest";
import { isInvoiceEnabled, isJournalEnabled, isMatchEnabled, isMfEnabled } from "../../../src/app/mf/flags";
import { FakeProps } from "../fakes";

describe("app/mf/flags", () => {
  it("既定（未設定）ではすべて無効", () => {
    const props = new FakeProps();
    expect(isMfEnabled(props)).toBe(false);
    expect(isInvoiceEnabled(props)).toBe(false);
    expect(isJournalEnabled(props)).toBe(false);
    expect(isMatchEnabled(props)).toBe(false);
  });

  it("MF_ENABLED が有効でも、個別フラグが無効ならそれぞれ無効", () => {
    const props = new FakeProps();
    props.set("MF_ENABLED", "true");
    expect(isMfEnabled(props)).toBe(true);
    expect(isInvoiceEnabled(props)).toBe(false);
    expect(isJournalEnabled(props)).toBe(false);
    expect(isMatchEnabled(props)).toBe(false);
  });

  it("MF_ENABLED が無効なら、個別フラグが true でも全体無効に従う", () => {
    const props = new FakeProps();
    props.set("MF_INVOICE_ENABLED", "true");
    props.set("MF_JOURNAL_ENABLED", "true");
    props.set("MF_MATCH_ENABLED", "true");
    expect(isMfEnabled(props)).toBe(false);
    expect(isInvoiceEnabled(props)).toBe(false);
    expect(isJournalEnabled(props)).toBe(false);
    expect(isMatchEnabled(props)).toBe(false);
  });

  it("MF_ENABLED と個別フラグが両方 true のときだけそれぞれ有効になる", () => {
    const props = new FakeProps();
    props.set("MF_ENABLED", "true");
    props.set("MF_INVOICE_ENABLED", "true");
    props.set("MF_JOURNAL_ENABLED", "true");
    props.set("MF_MATCH_ENABLED", "true");
    expect(isInvoiceEnabled(props)).toBe(true);
    expect(isJournalEnabled(props)).toBe(true);
    expect(isMatchEnabled(props)).toBe(true);
  });

  it.each(["1", "TRUE", "True", " true", "true "])(
    "%s のような値は有効と判定しない（文字列 \"true\" 完全一致のみ有効）",
    (value) => {
      const props = new FakeProps();
      props.set("MF_ENABLED", value);
      expect(isMfEnabled(props)).toBe(false);
    },
  );
});
