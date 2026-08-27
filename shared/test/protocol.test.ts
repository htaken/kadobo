import { describe, expect, it } from "vitest";
import {
  ENVELOPE_VERSION,
  ENVELOPE_WINDOW_SEC,
  GAS_TIMEOUT_MS,
  JOURNAL_RETENTION_DAYS,
  RETRY_NOTIFY_AT,
  RETRY_NOTIFY_EVERY,
  constantTimeEqual,
  envelopeSigningString,
  isGasResponse,
} from "../src/protocol";

describe("constants", () => {
  it("matches 実装設計 §3.1, §5, §6.6 の値", () => {
    expect(ENVELOPE_VERSION).toBe(1);
    expect(ENVELOPE_WINDOW_SEC).toBe(300);
    expect(GAS_TIMEOUT_MS).toBe(20000);
    expect(RETRY_NOTIFY_AT).toBe(6);
    expect(RETRY_NOTIFY_EVERY).toBe(72);
    expect(JOURNAL_RETENTION_DAYS).toBe(30);
  });
});

describe("envelopeSigningString", () => {
  it("ts.nonce.payload の形式で結合する", () => {
    expect(envelopeSigningString(1756260000, "abc123", '{"kind":"command"}')).toBe(
      '1756260000.abc123.{"kind":"command"}',
    );
  });

  it("payload が空文字でも区切りドットは残る", () => {
    expect(envelopeSigningString(0, "n", "")).toBe("0.n.");
  });
});

describe("constantTimeEqual", () => {
  it("同一文字列は true", () => {
    expect(constantTimeEqual("abcdef0123456789", "abcdef0123456789")).toBe(true);
  });

  it("空文字同士は true", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("長さが同じでも内容が異なれば false", () => {
    expect(constantTimeEqual("abcdef0123456789", "abcdef0123456780")).toBe(false);
  });

  it("長さが異なれば false（先頭が一致していても）", () => {
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
    expect(constantTimeEqual("abcd", "abc")).toBe(false);
  });

  it("片方が空文字でも false", () => {
    expect(constantTimeEqual("", "a")).toBe(false);
  });
});

describe("isGasResponse", () => {
  it("ok:true, applied:boolean を受理する", () => {
    expect(isGasResponse({ ok: true, applied: true })).toBe(true);
    expect(isGasResponse({ ok: true, applied: false, reason: "DUPLICATE" })).toBe(true);
  });

  it("ok:false, error:string, retryable:boolean を受理する", () => {
    expect(isGasResponse({ ok: false, error: "LOCK_TIMEOUT", retryable: true })).toBe(true);
  });

  it("ok が無い・不正な形は拒否する", () => {
    expect(isGasResponse(null)).toBe(false);
    expect(isGasResponse(undefined)).toBe(false);
    expect(isGasResponse("ok")).toBe(false);
    expect(isGasResponse({})).toBe(false);
    expect(isGasResponse({ ok: "true" })).toBe(false);
    expect(isGasResponse({ ok: true })).toBe(false); // applied 欠落
    expect(isGasResponse({ ok: false, error: "x" })).toBe(false); // retryable 欠落
    expect(isGasResponse({ ok: false, retryable: true })).toBe(false); // error 欠落
  });

  it("GAS が返す HTML 断片など JSON.parse 前の文字列は object でないため拒否する", () => {
    expect(isGasResponse("<html>...</html>")).toBe(false);
  });
});
