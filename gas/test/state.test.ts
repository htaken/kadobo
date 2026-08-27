import { describe, expect, it } from "vitest";
import { replay, transition, type EventType, type LoggedEvent, type State } from "../src/core/state";

const STATES: State[] = ["IDLE", "WORKING", "ON_BREAK", "CLOSED"];
const EVENT_TYPES: EventType[] = ["START", "BREAK_START", "BREAK_END", "END"];

// 実装設計 §7.2 の遷移表そのまま。
const EXPECTED: Record<State, Record<EventType, State | null>> = {
  IDLE: { START: "WORKING", BREAK_START: null, BREAK_END: null, END: null },
  WORKING: { START: null, BREAK_START: "ON_BREAK", BREAK_END: null, END: "CLOSED" },
  ON_BREAK: { START: null, BREAK_START: null, BREAK_END: "WORKING", END: "CLOSED" },
  CLOSED: { START: "WORKING", BREAK_START: null, BREAK_END: null, END: null },
};

describe("transition (実装設計 §7.2 遷移表 全セル)", () => {
  for (const state of STATES) {
    for (const eventType of EVENT_TYPES) {
      const expected = EXPECTED[state][eventType];
      it(`${state} + ${eventType} -> ${expected ?? "null (不正遷移)"}`, () => {
        expect(transition(state, eventType)).toBe(expected);
      });
    }
  }
});

function ev(event_id: string, event_type: LoggedEvent["event_type"], occurred_at: number): LoggedEvent {
  return { event_id, event_type, occurred_at };
}

describe("replay", () => {
  it("空配列は IDLE, sessionNo=0", () => {
    expect(replay([])).toEqual({ state: "IDLE", sessionNo: 0 });
  });

  it("START のみで WORKING, sessionNo=1", () => {
    expect(replay([ev("E1", "START", 1000)])).toEqual({ state: "WORKING", sessionNo: 1 });
  });

  it("START -> BREAK_START -> BREAK_END -> END で CLOSED, sessionNo=1", () => {
    const events = [
      ev("E1", "START", 1000),
      ev("E2", "BREAK_START", 2000),
      ev("E3", "BREAK_END", 3000),
      ev("E4", "END", 4000),
    ];
    expect(replay(events)).toEqual({ state: "CLOSED", sessionNo: 1 });
  });

  it("2 セッション目（確定→再開）で sessionNo=2", () => {
    const events = [
      ev("E1", "START", 1000),
      ev("E2", "END", 2000),
      ev("E3", "START", 3000),
    ];
    expect(replay(events)).toEqual({ state: "WORKING", sessionNo: 2 });
  });

  it("休憩中に終了しても CLOSED, sessionNo=1", () => {
    const events = [
      ev("E1", "START", 1000),
      ev("E2", "BREAK_START", 2000),
      ev("E3", "END", 3000),
    ];
    expect(replay(events)).toEqual({ state: "CLOSED", sessionNo: 1 });
  });

  it("occurred_at の昇順で再生する（入力順が乱れていてもソートする）", () => {
    const events = [
      ev("E2", "END", 4000),
      ev("E1", "START", 1000),
    ];
    expect(replay(events)).toEqual({ state: "CLOSED", sessionNo: 1 });
  });

  it("入力配列を破壊しない", () => {
    const events = [ev("E2", "END", 4000), ev("E1", "START", 1000)];
    const copy = events.map((e) => ({ ...e }));
    replay(events);
    expect(events).toEqual(copy);
  });

  it("不正遷移（例: 2 回連続 START）はスキップして続行する", () => {
    const events = [
      ev("E1", "START", 1000),
      ev("E2", "START", 2000), // WORKING では START は不正 -> スキップ
      ev("E3", "END", 3000),
    ];
    expect(replay(events)).toEqual({ state: "CLOSED", sessionNo: 1 });
  });
});
