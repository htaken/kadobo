import { describe, expect, it } from "vitest";
import { CORE_VERSION } from "../src/core/index";

describe("gas/src/core smoke test", () => {
  it("CORE_VERSION が定義されている（Node 上で core/ を実行できることの確認）", () => {
    expect(CORE_VERSION).toBe(1);
  });
});
