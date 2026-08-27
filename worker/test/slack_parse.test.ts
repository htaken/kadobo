/**
 * Slack ペイロードのパーステスト（実装設計 §6.1, §2.3, §2.4）。ハーネス不要のユニットテスト。
 */
import { describe, expect, it } from "vitest";
import {
  getStateValue,
  isStampActionId,
  parseInteractivityPayload,
  parseSlashCommand,
} from "../src/slack/parse";

function formEncode(fields: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    params.set(k, v);
  }
  return params.toString();
}

describe("parseInteractivityPayload", () => {
  it("block_actions をパースできる", () => {
    const payload = {
      type: "block_actions",
      user: { id: "U1" },
      channel: { id: "C1" },
      message: { ts: "1756260000.000100", text: "fallback", blocks: [{ block_id: "status" }] },
      actions: [{ action_id: "kado_start", action_ts: "1756260000.123456", value: "2026-09-01" }],
      trigger_id: "T1",
      response_url: "https://hooks.slack.test/x",
    };
    const body = formEncode({ payload: JSON.stringify(payload) });
    const parsed = parseInteractivityPayload(body);
    expect(parsed?.type).toBe("block_actions");
    if (parsed?.type === "block_actions") {
      expect(parsed.actions[0]?.action_id).toBe("kado_start");
      expect(parsed.user.id).toBe("U1");
    }
  });

  it("view_submission をパースできる", () => {
    const payload = {
      type: "view_submission",
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "kado_correction",
        private_metadata: JSON.stringify({ channel_id: "C1", message_ts: "1.1", business_date: "2026-09-01" }),
        state: {
          values: {
            target: { target_select: { type: "static_select", selected_option: { value: "add_end" } } },
            reason: { reason_input: { type: "plain_text_input", value: "押し忘れ" } },
          },
        },
      },
    };
    const body = formEncode({ payload: JSON.stringify(payload) });
    const parsed = parseInteractivityPayload(body);
    expect(parsed?.type).toBe("view_submission");
    if (parsed?.type === "view_submission") {
      expect(getStateValue(parsed.view.state.values, "target", "target_select")?.selected_option?.value).toBe(
        "add_end",
      );
      expect(getStateValue(parsed.view.state.values, "date", "date_pick")).toBeUndefined();
    }
  });

  it("payload フィールドが無ければ null", () => {
    expect(parseInteractivityPayload(formEncode({ foo: "bar" }))).toBeNull();
  });

  it("payload が JSON として不正なら null", () => {
    const body = "payload=" + encodeURIComponent("{not json");
    expect(parseInteractivityPayload(body)).toBeNull();
  });

  it("未知の type なら null", () => {
    const body = formEncode({ payload: JSON.stringify({ type: "shortcut" }) });
    expect(parseInteractivityPayload(body)).toBeNull();
  });
});

describe("parseSlashCommand", () => {
  it("/kado status をパースできる", () => {
    const body = formEncode({
      command: "/kado",
      text: "status",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "T1",
      response_url: "https://hooks.slack.test/x",
    });
    const parsed = parseSlashCommand(body);
    expect(parsed).toEqual({
      command: "/kado",
      text: "status",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "T1",
      response_url: "https://hooks.slack.test/x",
    });
  });

  it("text が無ければ空文字として扱う", () => {
    const body = formEncode({
      command: "/kado",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "T1",
      response_url: "https://hooks.slack.test/x",
    });
    const parsed = parseSlashCommand(body);
    expect(parsed?.text).toBe("");
  });

  it("必須フィールドが欠ければ null", () => {
    const body = formEncode({ command: "/kado" });
    expect(parseSlashCommand(body)).toBeNull();
  });
});

describe("isStampActionId", () => {
  it("stamp 系 4 種は true", () => {
    for (const id of ["kado_start", "kado_break_start", "kado_break_end", "kado_end"]) {
      expect(isStampActionId(id)).toBe(true);
    }
  });
  it("kado_correct は false", () => {
    expect(isStampActionId("kado_correct")).toBe(false);
  });
});
