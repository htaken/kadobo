/**
 * `app/mf/lease.ts`（実装設計 MF連携 §5.5, §6.8, §8）。
 */
import { describe, expect, it } from "vitest";
import { acquireLease, releaseLease, withLease } from "../../../src/app/mf/lease";
import { makeFakePorts } from "../fakes";

describe("app/mf/lease", () => {
  it("未取得の key は取得できる", () => {
    const ports = makeFakePorts();
    expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);
  });

  it("有効期限内は別の取得を拒否する", () => {
    const ports = makeFakePorts();
    expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);
    expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(false);
  });

  it("期限切れの lease は奪える", () => {
    const ports = makeFakePorts();
    expect(acquireLease(ports, "mf_sync", 1000)).toBe(true);
    ports.clock.currentMs += 1001;
    expect(acquireLease(ports, "mf_sync", 1000)).toBe(true);
  });

  it("解放後は別の取得ができる", () => {
    const ports = makeFakePorts();
    expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);
    releaseLease(ports, "mf_sync");
    expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);
  });

  it("key ごとに独立している", () => {
    const ports = makeFakePorts();
    expect(acquireLease(ports, "mf_invoice/A社:2026-10", 10 * 60 * 1000)).toBe(true);
    expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);
  });

  it("取得・解放は短いスクリプトロックの中で行う（FakeLock で検証）", () => {
    const ports = makeFakePorts();
    let sawLocked = false;
    const originalWithLock = ports.lock.withLock.bind(ports.lock);
    ports.lock.withLock = <T>(fn: () => T): T => {
      return originalWithLock(() => {
        sawLocked = true;
        return fn();
      });
    };
    acquireLease(ports, "mf_sync", 1000);
    expect(sawLocked).toBe(true);
  });

  describe("withLease", () => {
    it("取得できれば fn を実行し、終了後に解放する", () => {
      const ports = makeFakePorts();
      let ran = false;
      const result = withLease(ports, "mf_sync", 10 * 60 * 1000, () => {
        ran = true;
        return "ok";
      });
      expect(ran).toBe(true);
      expect(result).toBe("ok");
      // 解放されているので再取得できる。
      expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);
    });

    it("取得できなければ fn を呼ばずに null を返す", () => {
      const ports = makeFakePorts();
      expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);
      let ran = false;
      const result = withLease(ports, "mf_sync", 10 * 60 * 1000, () => {
        ran = true;
        return "ok";
      });
      expect(ran).toBe(false);
      expect(result).toBeNull();
    });

    it("fn が例外を投げても lease を解放する", () => {
      const ports = makeFakePorts();
      expect(() =>
        withLease(ports, "mf_sync", 10 * 60 * 1000, () => {
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);
    });

    it("fn は lease 取得・解放のロックの外で実行される（ネストした withLock は失敗しないことを確認）", () => {
      const ports = makeFakePorts();
      const result = withLease(ports, "mf_sync", 10 * 60 * 1000, () => {
        // fn の中で（MF 呼び出しのような重い処理の代わりに）別途 withLock を呼べる
        // ＝ acquireLease/releaseLease 自身のロックはすでに解放済みであることの証拠。
        return ports.lock.withLock(() => "inner-lock-ok");
      });
      expect(result).toBe("inner-lock-ok");
    });
  });
});
