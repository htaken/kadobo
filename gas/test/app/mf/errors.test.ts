import { describe, expect, it } from "vitest";
import { MfApiError, MfAuthError, MfTransientError, isMfNotFound } from "../../../src/app/mf/errors";

describe("isMfNotFound（会計 API の「存在しない」判定。実機 S-M5: 存在しない ID は 400 invalid_request_path_parameter）", () => {
  it("404 は存在しない", () => {
    expect(isMfNotFound(new MfApiError(404))).toBe(true);
    expect(isMfNotFound(new MfApiError(404, "not_found", "x"))).toBe(true);
  });

  it("400 かつ code が invalid_request_path_parameter は存在しない", () => {
    expect(isMfNotFound(new MfApiError(400, "invalid_request_path_parameter", "The given id does not exist for this office."))).toBe(true);
  });

  it("400 でも別の code（または code なし）は存在しないではない", () => {
    expect(isMfNotFound(new MfApiError(400, "invalid_param", "bad"))).toBe(false);
    expect(isMfNotFound(new MfApiError(400))).toBe(false);
  });

  it("他の status（403・422・500 など）は存在しないではない。code が同じでも 400 以外は対象外", () => {
    for (const status of [401, 403, 422, 429, 500]) {
      expect(isMfNotFound(new MfApiError(status, "invalid_request_path_parameter"))).toBe(false);
    }
  });

  it("MfApiError 以外（認証・一時障害・一般の例外・値）は存在しないではない", () => {
    expect(isMfNotFound(new MfAuthError("x", "accounting"))).toBe(false);
    expect(isMfNotFound(new MfTransientError("x"))).toBe(false);
    expect(isMfNotFound(new Error("x"))).toBe(false);
    expect(isMfNotFound(null)).toBe(false);
    expect(isMfNotFound(undefined)).toBe(false);
  });
});
