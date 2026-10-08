/**
 * `core/base64.ts` の `base64EncodeUtf8`（実装設計 MF連携 §4.2）。
 * 期待値は `printf '%s' "<input>" | base64`（Node の Buffer ではなく OS の `base64` コマンド）で
 * 別途作成した固定ベクタ（GAS ランタイムに `Utilities.base64Encode` 以外の依存を作らないため）。
 */
import { describe, expect, it } from "vitest";
import { base64EncodeUtf8 } from "../../../src/core/base64";

describe("base64EncodeUtf8", () => {
  it.each([
    ["", ""],
    ["f", "Zg=="],
    ["fo", "Zm8="],
    ["foo", "Zm9v"],
    ["foob", "Zm9vYg=="],
    ["fooba", "Zm9vYmE="],
    ["foobar", "Zm9vYmFy"],
    ["client_id_123:s3cr3t!@#", "Y2xpZW50X2lkXzEyMzpzM2NyM3QhQCM="],
    ["日本語テスト", "5pel5pys6Kqe44OG44K544OI"],
  ])("%s -> %s", (input, expected) => {
    expect(base64EncodeUtf8(input)).toBe(expected);
  });

});
