import { describe, expect, it } from "vitest";
import {
  buttonIdempotencyKey,
  commandIdempotencyKey,
  modalIdempotencyKey,
  ulid,
} from "../src/ids";

describe("buttonIdempotencyKey", () => {
  it("user_id:message_ts:action_id:action_ts を結合する（実装設計 §4.2）", () => {
    expect(
      buttonIdempotencyKey({
        user_id: "U123",
        message_ts: "1756259999.000100",
        action_id: "kado_start",
        action_ts: "1756260000.123456",
      }),
    ).toBe("U123:1756259999.000100:kado_start:1756260000.123456");
  });
});

describe("modalIdempotencyKey", () => {
  it("view_id:hash16 を結合する", () => {
    expect(modalIdempotencyKey("V123", "0123456789abcdef")).toBe(
      "V123:0123456789abcdef",
    );
  });
});

describe("commandIdempotencyKey", () => {
  it("user_id:trigger_id を結合する", () => {
    expect(commandIdempotencyKey("U123", "T999")).toBe("U123:T999");
  });
});

describe("ulid", () => {
  const zeroBytes = (n: number) => new Uint8Array(n);
  const ffBytes = (n: number) => new Uint8Array(n).fill(0xff);

  it("長さは 26 文字（時刻部10＋乱数部16）", () => {
    const id = ulid(1756260000123, zeroBytes);
    expect(id).toHaveLength(26);
  });

  it("Crockford Base32 の文字集合のみを使う（I, L, O, U を含まない）", () => {
    const id = ulid(1756260000123, ffBytes);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(id).not.toMatch(/[ILOU]/);
  });

  it("時刻部は ms=0 で全て '0'", () => {
    const id = ulid(0, zeroBytes);
    expect(id.slice(0, 10)).toBe("0000000000");
  });

  it("乱数部は全ビット1のとき全て 'Z'（Crockford の最大値記号）", () => {
    const id = ulid(0, ffBytes);
    expect(id.slice(10)).toBe("ZZZZZZZZZZZZZZZZ");
  });

  it("乱数源に渡す要求バイト数は 10（80 bit）", () => {
    let requested = -1;
    ulid(0, (n) => {
      requested = n;
      return new Uint8Array(n);
    });
    expect(requested).toBe(10);
  });

  it("時刻が異なれば先頭10文字（時刻部）が異なる", () => {
    const a = ulid(1756260000000, zeroBytes);
    const b = ulid(1756260000001, zeroBytes);
    expect(a.slice(0, 10)).not.toBe(b.slice(0, 10));
  });
});
