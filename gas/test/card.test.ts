import { describe, expect, it } from "vitest";
import {
  renderCard,
  renderCorrectionModal,
  renderLoadingModal,
  renderStatusLine,
  type RenderCardInput,
} from "../src/core/card";
import type { LoggedEvent } from "../src/core/state";
import type { SessionSummary } from "../src/core/aggregate";

interface Block {
  block_id?: string;
  type: string;
  elements?: Array<{ action_id?: string; text?: { text?: string } }>;
  [key: string]: unknown;
}

function blockIds(blocks: object[]): (string | undefined)[] {
  return (blocks as Block[]).map((b) => b.block_id);
}

function actionIds(blocks: object[]): string[] {
  const actions = (blocks as Block[]).find((b) => b.block_id === "actions");
  return (actions?.elements ?? []).map((e) => e.action_id!).filter(Boolean);
}

const SESSION_1: SessionSummary = {
  session_no: 1,
  start_at: Date.parse("2026-09-01T09:02:00+09:00"),
  end_at: Date.parse("2026-09-01T12:00:00+09:00"),
  break_seconds: 30 * 60,
  worked_seconds: 12480,
};

const SESSION_2_OPEN: SessionSummary = {
  session_no: 2,
  start_at: Date.parse("2026-09-01T13:00:00+09:00"),
  end_at: null,
  break_seconds: 0,
  worked_seconds: null,
};

function baseInput(overrides: Partial<RenderCardInput> = {}): RenderCardInput {
  return {
    business_date: "2026-09-01",
    state: "WORKING",
    sessions: [SESSION_1],
    totalSeconds: 12480,
    totalStatus: "ok",
    ...overrides,
  };
}

describe("renderCard — block_id 構造（実装設計 §2.2）", () => {
  it("通常時は header/sessions/total/actions の 4 ブロック（warning・status 無し）", () => {
    const blocks = renderCard(baseInput());
    expect(blockIds(blocks)).toEqual(["header", "sessions", "total", "actions"]);
  });

  it("warning を渡すと warning ブロックが header の直後に入る", () => {
    const blocks = renderCard(
      baseInput({ warning: { text: "前日が稼働中のままです", business_date: "2026-08-31" } }),
    );
    expect(blockIds(blocks)).toEqual(["header", "warning", "sessions", "total", "actions"]);
  });

  it("statusLine を渡すと status ブロック（context）が末尾に入る", () => {
    const blocks = renderCard(baseInput({ statusLine: "✅ 開始 09:02 記録済み" }));
    expect(blockIds(blocks)).toEqual(["header", "sessions", "total", "actions", "status"]);
    const statusBlock = (blocks as Block[]).find((b) => b.block_id === "status")!;
    expect(statusBlock.type).toBe("context");
  });

  it("header は業務日・曜日・状態ラベルを含む", () => {
    const blocks = renderCard(baseInput({ business_date: "2026-09-01", state: "WORKING" }));
    const header = (blocks as Block[]).find((b) => b.block_id === "header")! as unknown as {
      text: { text: string };
    };
    expect(header.text.text).toContain("2026-09-01");
    expect(header.text.text).toContain("（火）"); // 2026-09-01 は火曜日
    expect(header.text.text).toContain("稼働中");
  });

  it("total は要修正時（totalStatus='needs_fix'）に⚠️要修正を表示する", () => {
    const blocks = renderCard(baseInput({ totalStatus: "needs_fix", totalSeconds: 0 }));
    const total = (blocks as Block[]).find((b) => b.block_id === "total")! as unknown as {
      text: { text: string };
    };
    expect(total.text.text).toBe("本日累計 ⚠️ 要修正");
  });

  it("total は進行中時（totalStatus='in_progress'）に完了分の時間＋（計測中）を表示する", () => {
    const blocks = renderCard(baseInput({ totalStatus: "in_progress", totalSeconds: 3600 }));
    const total = (blocks as Block[]).find((b) => b.block_id === "total")! as unknown as {
      text: { text: string };
    };
    expect(total.text.text).toBe("本日累計 1h 0m（計測中）");
  });

  it("total は進行中で完了セッションが無いとき「本日累計 0h 0m（計測中）」を表示する（要修正ではない）", () => {
    const blocks = renderCard(baseInput({ totalStatus: "in_progress", totalSeconds: 0, sessions: [] }));
    const total = (blocks as Block[]).find((b) => b.block_id === "total")! as unknown as {
      text: { text: string };
    };
    expect(total.text.text).toBe("本日累計 0h 0m（計測中）");
    expect(total.text.text).not.toContain("要修正");
  });

  it("total は通常時（totalStatus='ok'）に⚠️要修正を含まず合計時間のみ表示する", () => {
    const blocks = renderCard(baseInput({ totalStatus: "ok", totalSeconds: 12480 }));
    const total = (blocks as Block[]).find((b) => b.block_id === "total")! as unknown as {
      text: { text: string };
    };
    expect(total.text.text).toBe("本日累計 3h 28m");
  });

  it("sessions ブロックに進行中セッションが `–` で表示される", () => {
    const blocks = renderCard(baseInput({ sessions: [SESSION_1, SESSION_2_OPEN], state: "WORKING" }));
    const sessions = (blocks as Block[]).find((b) => b.block_id === "sessions")! as unknown as {
      text: { text: string };
    };
    expect(sessions.text.text).toContain("#1 09:02 – 12:00（休憩 0:30）");
    expect(sessions.text.text).toContain("#2 13:00 –");
  });
});

describe("renderCard — 状態ごとの有効ボタン（実装設計 §2.3）", () => {
  it("IDLE: [開始] のみ", () => {
    const blocks = renderCard(baseInput({ state: "IDLE", sessions: [], totalSeconds: 0 }));
    expect(actionIds(blocks)).toEqual(["kado_start"]);
  });

  it("WORKING: [休憩][終了][修正]", () => {
    const blocks = renderCard(baseInput({ state: "WORKING" }));
    expect(actionIds(blocks)).toEqual(["kado_break_start", "kado_end", "kado_correct"]);
  });

  it("ON_BREAK: [再開][終了][修正]", () => {
    const blocks = renderCard(baseInput({ state: "ON_BREAK" }));
    expect(actionIds(blocks)).toEqual(["kado_break_end", "kado_end", "kado_correct"]);
  });

  it("CLOSED: [再開][修正]", () => {
    const blocks = renderCard(baseInput({ state: "CLOSED" }));
    expect(actionIds(blocks)).toEqual(["kado_start", "kado_correct"]);
  });

  it("warning ブロックには前日日付を value に持つ kado_correct のアクセサリーボタンが付く", () => {
    const blocks = renderCard(
      baseInput({ warning: { text: "前日が稼働中のままです", business_date: "2026-08-31" } }),
    );
    const warning = (blocks as Block[]).find((b) => b.block_id === "warning")! as unknown as {
      accessory: { action_id: string; value: string };
    };
    expect(warning.accessory.action_id).toBe("kado_correct");
    expect(warning.accessory.value).toBe("2026-08-31");
  });

  it("actions ブロックの value は当日の business_date（前日ではない）", () => {
    const blocks = renderCard(
      baseInput({
        business_date: "2026-09-01",
        state: "WORKING",
        warning: { text: "前日が稼働中のままです", business_date: "2026-08-31" },
      }),
    );
    const actions = (blocks as Block[]).find((b) => b.block_id === "actions")! as unknown as {
      elements: Array<{ value: string }>;
    };
    for (const el of actions.elements) {
      expect(el.value).toBe("2026-09-01");
    }
  });
});

describe("renderStatusLine — 3 文言（実装設計 §2.2）", () => {
  it("processing: ⏳ {ラベル} {HH:mm} 記録中…", () => {
    const text = renderStatusLine({
      kind: "processing",
      label: "開始",
      occurredAtMs: Date.parse("2026-09-01T09:02:00+09:00"),
    });
    expect(text).toBe("⏳ 開始 09:02 記録中…");
  });

  it("pending: ⚠️ 記録待ち（自動再試行中）", () => {
    expect(renderStatusLine({ kind: "pending" })).toBe("⚠️ 記録待ち（自動再試行中）");
  });

  it("done: ✅ {ラベル} {HH:mm} 記録済み", () => {
    const text = renderStatusLine({
      kind: "done",
      label: "開始",
      occurredAtMs: Date.parse("2026-09-01T09:02:00+09:00"),
    });
    expect(text).toBe("✅ 開始 09:02 記録済み");
  });
});

describe("renderLoadingModal — 実装設計 §2.4", () => {
  it("callback_id・title・private_metadata・submit 無しの section 1 個", () => {
    const modal = renderLoadingModal({
      channel_id: "C1",
      message_ts: "1756260000.000100",
      business_date: "2026-09-01",
    }) as {
      type: string;
      callback_id: string;
      title: { text: string };
      private_metadata: string;
      blocks: Array<{ text: { text: string } }>;
      submit?: unknown;
    };

    expect(modal.type).toBe("modal");
    expect(modal.callback_id).toBe("kado_correction");
    expect(modal.title.text).toBe("稼働記録の修正");
    expect(JSON.parse(modal.private_metadata)).toEqual({
      channel_id: "C1",
      message_ts: "1756260000.000100",
      business_date: "2026-09-01",
    });
    expect(modal.blocks).toHaveLength(1);
    expect(modal.blocks[0]!.text.text).toBe("⏳ 読み込み中…");
    expect(modal.submit).toBeUndefined();
  });
});

describe("renderCorrectionModal — 実装設計 §2.4", () => {
  function e(event_id: string, event_type: LoggedEvent["event_type"], occurred_at: number): LoggedEvent {
    return { event_id, event_type, occurred_at };
  }

  it("target_select の選択肢に当日のイベントが並ぶ（稼働中なら add_end も追加）", () => {
    const events: LoggedEvent[] = [
      e("E1", "START", Date.parse("2026-09-01T09:00:00+09:00")),
      e("E2", "BREAK_START", Date.parse("2026-09-01T12:00:00+09:00")),
    ];
    const modal = renderCorrectionModal(events, "2026-09-01") as {
      blocks: Array<{
        block_id: string;
        element: { action_id: string; options?: Array<{ value: string; text: { text: string } }>; initial_date?: string };
      }>;
    };

    const targetBlock = modal.blocks.find((b) => b.block_id === "target")!;
    const values = targetBlock.element.options!.map((o) => o.value);
    expect(values).toEqual(["E1", "E2", "add_end"]);
    expect(targetBlock.element.options![0]!.text.text).toBe("開始 09:00");

    const dateBlock = modal.blocks.find((b) => b.block_id === "date")!;
    expect(dateBlock.element.initial_date).toBe("2026-09-01");
  });

  it("確定（CLOSED）状態では add_end を追加しない", () => {
    const events: LoggedEvent[] = [
      e("E1", "START", Date.parse("2026-09-01T09:00:00+09:00")),
      e("E2", "END", Date.parse("2026-09-01T12:00:00+09:00")),
    ];
    const modal = renderCorrectionModal(events, "2026-09-01") as {
      blocks: Array<{ block_id: string; element: { options?: Array<{ value: string }> } }>;
    };
    const targetBlock = modal.blocks.find((b) => b.block_id === "target")!;
    const values = targetBlock.element.options!.map((o) => o.value);
    expect(values).toEqual(["E1", "E2"]);
  });

  it("未稼働（IDLE、イベント無し）でも add_end を追加しない", () => {
    const modal = renderCorrectionModal([], "2026-09-01") as {
      blocks: Array<{ block_id: string; element: { options?: Array<{ value: string }> } }>;
    };
    const targetBlock = modal.blocks.find((b) => b.block_id === "target")!;
    expect(targetBlock.element.options).toEqual([]);
  });

  it("reason ブロックは plain_text_input・max_length 200", () => {
    const modal = renderCorrectionModal([], "2026-09-01") as {
      blocks: Array<{ block_id: string; element: { type: string; max_length?: number } }>;
    };
    const reasonBlock = modal.blocks.find((b) => b.block_id === "reason")!;
    expect(reasonBlock.element.type).toBe("plain_text_input");
    expect(reasonBlock.element.max_length).toBe(200);
  });

  it("time ブロックは初期値なし（timepicker に initial_time を設定しない）", () => {
    const modal = renderCorrectionModal([], "2026-09-01") as {
      blocks: Array<{ block_id: string; element: Record<string, unknown> }>;
    };
    const timeBlock = modal.blocks.find((b) => b.block_id === "time")!;
    expect(timeBlock.element.type).toBe("timepicker");
    expect(timeBlock.element.initial_time).toBeUndefined();
  });
});
