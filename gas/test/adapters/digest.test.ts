/**
 * `gas/src/adapters/digest.ts`（`DigestAdapter`）のテスト（実装設計 経費フェーズ §5.9）。
 *
 * `Utilities.computeDigest`/`Utilities.DigestAlgorithm` の最小フェイクを用意し、Node の
 * `crypto` で計算した本物の SHA-256 を「GAS の符号付き byte array（-128〜127）」に変換して
 * 返すことで実機の挙動（signed byte）を模倣する。既知の SHA-256 テストベクタ（空配列・"abc"）で
 * `DigestAdapter` の hex 化・符号正規化が正しいことを検証する
 * （ベクタは Node の `crypto` で実測した値。手で書き写す事故を避けるため）。
 */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DigestAdapter } from "../../src/adapters/digest";

/** 0〜255 の配列を GAS の signed byte（-128〜127）表現へ変換する（テスト専用）。 */
function toSignedBytes(bytes: number[]): number[] {
  return bytes.map((b) => (b > 127 ? b - 256 : b));
}

/**
 * `globalThis.Utilities` にフェイクをインストールする。`computeDigest` は実際に Node の
 * `crypto` で SHA-256 を計算し、実機と同じ signed byte 配列（-128〜127）で返す
 * （`DigestAdapter` 側の符号正規化ロジックをそのまま検証できるようにするため）。
 */
function installFakeUtilities(): { restore: () => void } {
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const previous = globalRecord.Utilities;
  const fake = {
    DigestAlgorithm: { SHA_256: "SHA_256" },
    computeDigest: (_algorithm: string, value: number[]): number[] => {
      // digest.ts は 0〜255（符号なし）の配列を渡す前提だが、念のため符号付きが混ざっていても
      // 同じビットパターンになるよう正規化してから計算する。
      const normalized = value.map((b) => (b < 0 ? b + 256 : b));
      const digestBytes = Array.from(createHash("sha256").update(Uint8Array.from(normalized)).digest());
      return toSignedBytes(digestBytes);
    },
  };
  globalRecord.Utilities = fake;
  return {
    restore: () => {
      globalRecord.Utilities = previous;
    },
  };
}

describe("DigestAdapter#sha256Hex", () => {
  let restore: () => void;
  let adapter: DigestAdapter;

  beforeEach(() => {
    restore = installFakeUtilities().restore;
    adapter = new DigestAdapter();
  });

  afterEach(() => {
    restore();
  });

  it("空配列の SHA-256 と一致する（既知のテストベクタ）", () => {
    expect(adapter.sha256Hex([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("'abc' の UTF-8 バイト列の SHA-256 と一致する（既知のテストベクタ）", () => {
    const bytes = [0x61, 0x62, 0x63]; // "abc" の UTF-8 バイト列
    expect(adapter.sha256Hex(bytes)).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("128 以上の値（符号付きだと負になる範囲）を含むバイト列でも正しく計算する", () => {
    // 実機の computeDigest 出力は signed byte（-128〜127）で返る。入力側にも 128〜255 の値
    // （JPEG の先頭バイト等）を含む配列を渡し、DigestAdapter が正しく hex 化できることを確認する。
    const bytes = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46];
    expect(adapter.sha256Hex(bytes)).toBe("45ae705277879f7f01d778f7c95a065bb0c06ab9936cf24307f375211fee13d1");
  });

  it("同じバイト列は同じハッシュ、異なるバイト列は異なるハッシュになる", () => {
    const a = adapter.sha256Hex([1, 2, 3]);
    const b = adapter.sha256Hex([1, 2, 3]);
    const c = adapter.sha256Hex([1, 2, 4]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("戻り値は 64 桁の小文字 16 進文字列", () => {
    const hex = adapter.sha256Hex([9, 9, 9]);
    expect(hex).toMatch(/^[0-9a-f]{64}$/);
  });
});
