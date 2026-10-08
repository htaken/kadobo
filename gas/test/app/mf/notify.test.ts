/**
 * `app/mf/notify.ts`（実装設計 MF連携 §4.4）。
 */
import { describe, expect, it } from "vitest";
import { MfAuthError, MfReauthRequiredError, MfTransientError, MfApiError } from "../../../src/app/mf/errors";
import {
  notifyMfFailure,
  notifyMfFailureUnlocked,
  notifyMfSuccess,
  notifyMfSuccessUnlocked,
} from "../../../src/app/mf/notify";
import { ConfigMissingError, LockTimeoutError } from "../../../src/app/ports";
import { makeFakePorts } from "../fakes";

const TARGET = "invoice";

describe("app/mf/notify", () => {
  describe("再認可の通知（service: invoice）", () => {
    it("SLACK_USER_ID 宛に DM する", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      notifyMfFailure(ports, TARGET, new MfReauthRequiredError("boom", "invoice"));
      expect(ports.slack.dms).toHaveLength(1);
      expect(ports.slack.dms[0]!.userId).toBe("U1");
      expect(ports.slack.dms[0]!.text).toContain("再認可");
    });

    it("MfAuthError（service: invoice）も同じ再認可通知になる", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      notifyMfFailure(ports, TARGET, new MfAuthError("boom", "invoice"));
      expect(ports.slack.dms).toHaveLength(1);
      expect(ports.slack.dms[0]!.text).toContain("再認可");
    });

    it("24 時間以内の再通知は抑止する", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      notifyMfFailure(ports, TARGET, new MfReauthRequiredError("boom", "invoice"));
      expect(ports.slack.dms).toHaveLength(1);

      ports.clock.currentMs += 23 * 60 * 60 * 1000;
      notifyMfFailure(ports, TARGET, new MfReauthRequiredError("boom", "invoice"));
      expect(ports.slack.dms).toHaveLength(1); // 増えない
    });

    it("24 時間経過後は再通知する", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      notifyMfFailure(ports, TARGET, new MfReauthRequiredError("boom", "invoice"));
      expect(ports.slack.dms).toHaveLength(1);

      ports.clock.currentMs += 24 * 60 * 60 * 1000 + 1;
      notifyMfFailure(ports, TARGET, new MfReauthRequiredError("boom", "invoice"));
      expect(ports.slack.dms).toHaveLength(2);
    });

    it("SLACK_USER_ID 未設定なら DM せず、例外も投げない", () => {
      const ports = makeFakePorts();
      expect(() => notifyMfFailure(ports, TARGET, new MfReauthRequiredError("boom", "invoice"))).not.toThrow();
      expect(ports.slack.dms).toHaveLength(0);
    });

    it("DM の送信自体が失敗してもベストエフォートで握りつぶす", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      const originalDm = ports.slack.dm.bind(ports.slack);
      ports.slack.dm = () => {
        throw new Error("slack down");
      };
      expect(() => notifyMfFailure(ports, TARGET, new MfReauthRequiredError("boom", "invoice"))).not.toThrow();
      ports.slack.dm = originalDm;
    });
  });

  describe("会計 API の認証エラー（service: accounting）", () => {
    it("再認可ではなく API キー確認を促す文言になる", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      notifyMfFailure(ports, "accounting", new MfAuthError("boom", "accounting"));
      expect(ports.slack.dms).toHaveLength(1);
      expect(ports.slack.dms[0]!.text).toContain("MF_ACCOUNTING_API_KEY");
      expect(ports.slack.dms[0]!.text).not.toContain("再認可");
    });

    it("MfReauthRequiredError（service: accounting）も同じ文言になる", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      notifyMfFailure(ports, "accounting", new MfReauthRequiredError("boom", "accounting"));
      expect(ports.slack.dms[0]!.text).toContain("MF_ACCOUNTING_API_KEY");
    });

    it("invoice の抑止（mf_notice/reauth）と accounting の抑止（mf_notice/apikey）は独立している", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      notifyMfFailure(ports, "invoice", new MfReauthRequiredError("boom", "invoice"));
      notifyMfFailure(ports, "accounting", new MfAuthError("boom", "accounting"));
      // 両方通知される（片方の抑止がもう片方に影響しない）。
      expect(ports.slack.dms).toHaveLength(2);

      // invoice 側だけ 24 時間以内に再度失敗しても抑止される。
      notifyMfFailure(ports, "invoice", new MfReauthRequiredError("boom", "invoice"));
      expect(ports.slack.dms).toHaveLength(2);
      // accounting 側は初回同様まだ 24 時間経っていないので抑止される。
      notifyMfFailure(ports, "accounting", new MfAuthError("boom", "accounting"));
      expect(ports.slack.dms).toHaveLength(2);
    });
  });

  describe("一時障害の通知（MfTransientError）", () => {
    it("5 回連続までは通知しない", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      for (let i = 0; i < 5; i++) {
        notifyMfFailure(ports, TARGET, new MfTransientError("boom"));
      }
      expect(ports.slack.dms).toHaveLength(0);
    });

    it("6 回連続で 1 回だけ通知する", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      for (let i = 0; i < 6; i++) {
        notifyMfFailure(ports, TARGET, new MfTransientError("boom"));
      }
      expect(ports.slack.dms).toHaveLength(1);
      expect(ports.slack.dms[0]!.text).toContain("一時障害");
      // 再認可の通知とは文言を分ける。
      expect(ports.slack.dms[0]!.text).not.toContain("再認可");
    });

    it("7 回目以降は連投しない（6 回目のみ）", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      for (let i = 0; i < 9; i++) {
        notifyMfFailure(ports, TARGET, new MfTransientError("boom"));
      }
      expect(ports.slack.dms).toHaveLength(1);
    });

    it("対象（target）ごとにカウンタが独立している", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      for (let i = 0; i < 5; i++) {
        notifyMfFailure(ports, "invoice", new MfTransientError("boom"));
      }
      notifyMfFailure(ports, "accounting", new MfTransientError("boom"));
      expect(ports.slack.dms).toHaveLength(0);
    });

    it("成功で通知するとカウンタがリセットされ、また 6 回必要になる", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      for (let i = 0; i < 5; i++) {
        notifyMfFailure(ports, TARGET, new MfTransientError("boom"));
      }
      notifyMfSuccess(ports, TARGET);
      for (let i = 0; i < 5; i++) {
        notifyMfFailure(ports, TARGET, new MfTransientError("boom"));
      }
      expect(ports.slack.dms).toHaveLength(0); // まだ 5 回分なので通知しない
      notifyMfFailure(ports, TARGET, new MfTransientError("boom"));
      expect(ports.slack.dms).toHaveLength(1); // リセット後の 6 回目
    });
  });

  it("MfApiError・ConfigMissingError は通知しない（呼び出し側が個別に扱う）", () => {
    const ports = makeFakePorts();
    ports.props.set("SLACK_USER_ID", "U1");
    notifyMfFailure(ports, TARGET, new MfApiError(400, "invalid", "bad request"));
    notifyMfFailure(ports, TARGET, new ConfigMissingError("MF_CLIENT_ID", "missing"));
    expect(ports.slack.dms).toHaveLength(0);
  });

  describe("ロック（実装設計 §0。内部シートの read-modify-write を排他する）", () => {
    it("notifyMfFailure は内部シートの読み書きをロックの中で行う（FakeLock で検証）", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      let sawLocked = false;
      const originalWithLock = ports.lock.withLock.bind(ports.lock);
      ports.lock.withLock = <T>(fn: () => T): T =>
        originalWithLock(() => {
          sawLocked = true;
          return fn();
        });

      notifyMfFailure(ports, TARGET, new MfTransientError("boom"));

      expect(sawLocked).toBe(true);
    });

    it("notifyMfSuccess も内部シートの読み書きをロックの中で行う", () => {
      const ports = makeFakePorts();
      let sawLocked = false;
      const originalWithLock = ports.lock.withLock.bind(ports.lock);
      ports.lock.withLock = <T>(fn: () => T): T =>
        originalWithLock(() => {
          sawLocked = true;
          return fn();
        });

      notifyMfSuccess(ports, TARGET);

      expect(sawLocked).toBe(true);
    });

    it("DM 送信はロックの外で行う（ロック保持中に slack.dm が呼ばれない）", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      let dmCalledWhileLocked = false;
      const originalWithLock = ports.lock.withLock.bind(ports.lock);
      let locked = false;
      ports.lock.withLock = <T>(fn: () => T): T => {
        locked = true;
        try {
          return originalWithLock(fn);
        } finally {
          locked = false;
        }
      };
      const originalDm = ports.slack.dm.bind(ports.slack);
      ports.slack.dm = (userId, text) => {
        if (locked) {
          dmCalledWhileLocked = true;
        }
        return originalDm(userId, text);
      };

      notifyMfFailure(ports, TARGET, new MfReauthRequiredError("boom", "invoice"));

      expect(dmCalledWhileLocked).toBe(false);
      expect(ports.slack.dms).toHaveLength(1);
    });

    it("notifyMfFailureUnlocked はロックを取らない（呼び出し側がロック内にいても入れ子で失敗しない）", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      // FakeLock は withLock の再入で LockTimeoutError を投げる（gas/test/app/fakes.ts）。
      // notifyMfFailureUnlocked はロックを取らないため、既にロック内でも安全に呼べるはず。
      const result = ports.lock.withLock(() => {
        notifyMfFailureUnlocked(ports, TARGET, new MfTransientError("boom"));
        return "inner-ok";
      });
      expect(result).toBe("inner-ok");
    });

    it("notifyMfFailure をロック内から呼ぶと入れ子になり LockTimeoutError になる（Unlocked 版を使うべき理由の確認）", () => {
      const ports = makeFakePorts();
      expect(() =>
        ports.lock.withLock(() => {
          notifyMfFailure(ports, TARGET, new MfTransientError("boom"));
        }),
      ).toThrow(LockTimeoutError);
    });

    it("notifyMfSuccessUnlocked はロックを取らない", () => {
      const ports = makeFakePorts();
      const result = ports.lock.withLock(() => {
        notifyMfSuccessUnlocked(ports, TARGET);
        return "inner-ok";
      });
      expect(result).toBe("inner-ok");
    });

    it("notifyMfFailureUnlocked も 6 回目のカウンタ通知・24 時間抑止の判定は変わらない", () => {
      const ports = makeFakePorts();
      ports.props.set("SLACK_USER_ID", "U1");
      for (let i = 0; i < 6; i++) {
        notifyMfFailureUnlocked(ports, TARGET, new MfTransientError("boom"));
      }
      expect(ports.slack.dms).toHaveLength(1);
      expect(ports.slack.dms[0]!.text).toContain("一時障害");
    });
  });
});
