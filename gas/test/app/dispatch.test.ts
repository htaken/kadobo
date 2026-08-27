import { createHmac } from "node:crypto";
import { buttonIdempotencyKey } from "@kadobo/shared/ids";
import { ENVELOPE_VERSION, envelopeSigningString, type GasRequest } from "@kadobo/shared/protocol";
import { describe, expect, it } from "vitest";
import { dispatch, handlePostBody } from "../../src/app/dispatch";
import { makeFakePorts } from "./fakes";

const SECRET = "test-shared-secret-DO-NOT-USE-IN-PROD";

function hmacHex(key: string, msg: string): string {
  return createHmac("sha256", key).update(msg, "utf8").digest("hex");
}

function buildEnvelope(payloadObj: unknown, opts: { ts?: number; nonce?: string; secret?: string } = {}) {
  const payload = JSON.stringify(payloadObj);
  const ts = opts.ts ?? 1756260000;
  const nonce = opts.nonce ?? "0123456789abcdef0123456789abcdef";
  const secret = opts.secret ?? SECRET;
  const sig = hmacHex(secret, envelopeSigningString(ts, nonce, payload));
  return { v: ENVELOPE_VERSION, ts, nonce, payload, sig };
}

function makeStampPayload(): Extract<GasRequest, { kind: "stamp" }> {
  const messageTs = "1756260000.000100";
  const actionTs = "1756260120.000100";
  return {
    kind: "stamp",
    idempotency_key: buttonIdempotencyKey({
      user_id: "U1",
      message_ts: messageTs,
      action_id: "kado_start",
      action_ts: actionTs,
    }),
    user_id: "U1",
    channel_id: "C1",
    message_ts: messageTs,
    action_id: "kado_start",
    occurred_at_ms: Date.parse("2026-09-01T09:02:00+09:00"),
    received_at_ms: Date.parse("2026-09-01T09:02:00+09:00") + 400,
    source: "button",
  };
}

function readyPorts() {
  // envelope の既定 ts（1756260000 秒）と一致させ、窓判定が常に通るようにする。
  const ports = makeFakePorts(1756260000 * 1000);
  ports.props.set("GAS_SHARED_SECRET", SECRET);
  return ports;
}

describe("handlePostBody — 本文が JSON でない", () => {
  it("MALFORMED_BODY, retryable:false", () => {
    const ports = readyPorts();
    const result = handlePostBody("{not json", ports);
    expect(result).toEqual({ ok: false, error: "MALFORMED_BODY", retryable: false });
  });
});

describe("dispatch — 封筒不正", () => {
  it("署名不一致は UNAUTHORIZED, retryable:false", () => {
    const ports = readyPorts();
    const envelope = buildEnvelope(makeStampPayload(), { secret: "wrong-secret" });
    const result = dispatch(envelope, ports);
    expect(result).toEqual({ ok: false, error: "UNAUTHORIZED", retryable: false });
  });

  it("窓外（古い ts）は UNAUTHORIZED", () => {
    const ports = readyPorts();
    const envelope = buildEnvelope(makeStampPayload(), { ts: 1756260000 - 301 });
    const result = dispatch(envelope, ports);
    expect(result).toEqual({ ok: false, error: "UNAUTHORIZED", retryable: false });
  });
});

describe("dispatch — payload の型不正", () => {
  it("GasRequest の形をしていなければ BAD_REQUEST, retryable:false", () => {
    const ports = readyPorts();
    const envelope = buildEnvelope({ kind: "stamp", user_id: "U1" }); // 必須フィールド欠落
    const result = dispatch(envelope, ports);
    expect(result).toEqual({ ok: false, error: "BAD_REQUEST", retryable: false });
  });

  it("kind が未知の値なら BAD_REQUEST", () => {
    const ports = readyPorts();
    const envelope = buildEnvelope({ kind: "unknown_kind" });
    const result = dispatch(envelope, ports);
    expect(result).toEqual({ ok: false, error: "BAD_REQUEST", retryable: false });
  });
});

describe("dispatch — 正常系ディスパッチ", () => {
  it("stamp を実際に処理する（生ログ追記まで確認）", () => {
    const ports = readyPorts();
    const envelope = buildEnvelope(makeStampPayload());

    const result = dispatch(envelope, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.rawLog).toHaveLength(1);
    expect(ports.sheets.rawLog[0]?.event_type).toBe("START");
  });

  it("同じ nonce の再送は REPLAY として UNAUTHORIZED になる", () => {
    const ports = readyPorts();
    const envelope = buildEnvelope(makeStampPayload());
    dispatch(envelope, ports);
    const second = dispatch(envelope, ports);
    expect(second).toEqual({ ok: false, error: "UNAUTHORIZED", retryable: false });
  });
});

describe("dispatch — LockService 取得不可", () => {
  it("LOCK_TIMEOUT, retryable:true", () => {
    const ports = readyPorts();
    ports.lock.throwTimeoutOnce = true;
    const envelope = buildEnvelope(makeStampPayload());

    const result = dispatch(envelope, ports);

    expect(result).toEqual({ ok: false, error: "LOCK_TIMEOUT", retryable: true });
  });
});

describe("dispatch — 一時エラー", () => {
  it("Sheets 等の例外は retryable:true", () => {
    const ports = readyPorts();
    ports.sheets.findRawLogByIdempotencyKey = () => {
      throw new Error("sheets_temporary_error");
    };
    const envelope = buildEnvelope(makeStampPayload());

    const result = dispatch(envelope, ports);

    expect(result).toEqual({ ok: false, error: "sheets_temporary_error", retryable: true });
  });
});
