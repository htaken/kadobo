import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyEnvelope, type VerifyEnvelopeIo } from "../src/core/envelope";
import { envelopeSigningString } from "@kadobo/shared/protocol";
import vectors from "../../shared/test/vectors/envelope.json";

/**
 * GAS 相当の HMAC（`Utilities.computeHmacSha256Signature`）をテストでは Node の `crypto` で
 * 実装して注入する（実装設計 §7.4 に明記された許可）。`crypto` は core 内では使わない。
 */
function hmacHex(key: string, msg: string): string {
  return createHmac("sha256", key).update(msg, "utf8").digest("hex");
}

function makeIo(overrides: Partial<VerifyEnvelopeIo> = {}): VerifyEnvelopeIo & {
  seen: Set<string>;
} {
  const seen = new Set<string>();
  return {
    secret: vectors.secret,
    nowSec: 0,
    hmacHex,
    nonceSeen: (n) => seen.has(n),
    markNonce: (n) => seen.add(n),
    seen,
    ...overrides,
  };
}

describe("契約テスト: shared/test/vectors/envelope.json の sig が Node crypto の HMAC-SHA256 と一致する", () => {
  for (const v of vectors.vectors) {
    it(`${v.name}`, () => {
      expect(hmacHex(vectors.secret, envelopeSigningString(v.ts, v.nonce, v.payload))).toBe(
        v.sig,
      );
      // signing_string 自体もベクタの記述どおりであることを確認する。
      expect(envelopeSigningString(v.ts, v.nonce, v.payload)).toBe(v.signing_string);
    });
  }
});

describe("verifyEnvelope — 契約ベクタを受理する（payload が有効な JSON のもの）", () => {
  const acceptableVectorNames = ["stamp_start", "command_status", "status_probe", "unicode_payload"];

  for (const name of acceptableVectorNames) {
    const v = vectors.vectors.find((x) => x.name === name)!;
    it(`${name} を受理し、payload を JSON.parse した値を返す`, () => {
      const io = makeIo({ nowSec: v.ts });
      const result = verifyEnvelope(
        { v: 1, ts: v.ts, nonce: v.nonce, payload: v.payload, sig: v.sig },
        io,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload).toEqual(JSON.parse(v.payload));
      }
      // 署名が正しい要求なので nonce が消費されている。
      expect(io.seen.has(v.nonce)).toBe(true);
    });
  }

  it("empty_payload ベクタ: 署名検証までは通るが、payload が空文字で JSON として不正なため拒否する", () => {
    const v = vectors.vectors.find((x) => x.name === "empty_payload")!;
    const io = makeIo({ nowSec: v.ts });
    const result = verifyEnvelope(
      { v: 1, ts: v.ts, nonce: v.nonce, payload: v.payload, sig: v.sig },
      io,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("BAD_PAYLOAD_JSON");
    }
    // 署名は正しかったので nonce は消費されている（署名検証自体は通過した証拠）。
    expect(io.seen.has(v.nonce)).toBe(true);
  });
});

describe("verifyEnvelope — 検証順序・拒否ケース", () => {
  const v = vectors.vectors.find((x) => x.name === "stamp_start")!;
  const validBody = { v: 1, ts: v.ts, nonce: v.nonce, payload: v.payload, sig: v.sig };

  it("v !== 1 は拒否（BAD_VERSION）", () => {
    const io = makeIo({ nowSec: v.ts });
    const result = verifyEnvelope({ ...validBody, v: 2 }, io);
    expect(result).toEqual({ ok: false, reason: "BAD_VERSION" });
    expect(io.seen.size).toBe(0);
  });

  it("窓外（|now - ts| > 300）は拒否（WINDOW）。nonce は消費されない", () => {
    const io = makeIo({ nowSec: v.ts + 301 });
    const result = verifyEnvelope(validBody, io);
    expect(result).toEqual({ ok: false, reason: "WINDOW" });
    expect(io.seen.size).toBe(0);
  });

  it("窓の境界（ちょうど 300 秒）は受理される", () => {
    const io = makeIo({ nowSec: v.ts + 300 });
    const result = verifyEnvelope(validBody, io);
    expect(result.ok).toBe(true);
  });

  it("署名不一致は拒否（BAD_SIGNATURE）。nonce は消費されない", () => {
    const io = makeIo({ nowSec: v.ts });
    const tampered = { ...validBody, sig: `00${v.sig.slice(2)}` };
    const result = verifyEnvelope(tampered, io);
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
    expect(io.seen.size).toBe(0);
  });

  it("payload 改ざんは署名不一致として拒否される", () => {
    const io = makeIo({ nowSec: v.ts });
    const tampered = { ...validBody, payload: v.payload.replace("kado_start", "kado_end") };
    const result = verifyEnvelope(tampered, io);
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });

  it("nonce 再利用は拒否（REPLAY）。2 回目は署名検証を通過しても拒否される", () => {
    const io = makeIo({ nowSec: v.ts });
    const first = verifyEnvelope(validBody, io);
    expect(first.ok).toBe(true);
    const second = verifyEnvelope(validBody, io);
    expect(second).toEqual({ ok: false, reason: "REPLAY" });
  });

  it("署名が正しい要求だけ nonce を消費する（不正な要求の後でも同じ nonce の正しい要求は受理される）", () => {
    const io = makeIo({ nowSec: v.ts });
    const tampered = { ...validBody, sig: `00${v.sig.slice(2)}` };
    const bad = verifyEnvelope(tampered, io);
    expect(bad.ok).toBe(false);
    expect(io.seen.has(v.nonce)).toBe(false);
    const good = verifyEnvelope(validBody, io);
    expect(good.ok).toBe(true);
  });

  it("形の不正な body は拒否される（MALFORMED）", () => {
    const io = makeIo({ nowSec: v.ts });
    expect(verifyEnvelope(null, io)).toEqual({ ok: false, reason: "MALFORMED" });
    expect(verifyEnvelope({ v: 1, ts: v.ts }, io)).toEqual({ ok: false, reason: "MALFORMED" });
  });

  it("定時間比較: 長さが異なる sig でも安全に拒否される", () => {
    const io = makeIo({ nowSec: v.ts });
    const result = verifyEnvelope({ ...validBody, sig: "ab" }, io);
    expect(result).toEqual({ ok: false, reason: "BAD_SIGNATURE" });
  });
});
