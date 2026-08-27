import { describe, expect, it } from "vitest";
import { applyCorrections } from "../src/core/correction";
import type { LoggedEvent } from "../src/core/state";

function ev(event_id: string, event_type: LoggedEvent["event_type"], occurred_at: number): LoggedEvent {
  return { event_id, event_type, occurred_at };
}

function correction(
  event_id: string,
  correction_of: string,
  occurred_at: number,
  new_value: number,
): LoggedEvent {
  return { event_id, event_type: "CORRECTION", occurred_at, correction_of, new_value };
}

describe("applyCorrections", () => {
  it("CORRECTION が無ければそのまま返す（値は変わらない）", () => {
    const events = [ev("E1", "START", 1000), ev("E2", "END", 2000)];
    const result = applyCorrections(events);
    expect(result).toEqual(events);
  });

  it("対象イベントの occurred_at を new_value に置換する", () => {
    const end = ev("E2", "END", ts("12:00"));
    const events = [ev("E1", "START", ts("09:00")), end, correction("C1", "E2", ts("12:05"), ts("12:30"))];
    const result = applyCorrections(events);
    const correctedEnd = result.find((e) => e.event_id === "E2")!;
    expect(correctedEnd.occurred_at).toBe(ts("12:30"));
  });

  it("元イベント列（入力配列・入力オブジェクト）は変更しない", () => {
    const end = ev("E2", "END", ts("12:00"));
    const events = [ev("E1", "START", ts("09:00")), end, correction("C1", "E2", ts("12:05"), ts("12:30"))];
    applyCorrections(events);
    expect(end.occurred_at).toBe(ts("12:00"));
    expect(events[1]!.occurred_at).toBe(ts("12:00"));
  });

  it("複数回の CORRECTION は、CORRECTION 自身の occurred_at が最新のものが有効（最新勝ち）", () => {
    const end = ev("E2", "END", ts("12:00"));
    const events = [
      ev("E1", "START", ts("09:00")),
      end,
      correction("C1", "E2", ts("12:05"), ts("12:15")),
      correction("C2", "E2", ts("13:00"), ts("12:30")), // 一番あとに行われた訂正
    ];
    const result = applyCorrections(events);
    expect(result.find((e) => e.event_id === "E2")!.occurred_at).toBe(ts("12:30"));
  });

  it("CORRECTION の occurred_at が入力順と逆でも最新のものが勝つ", () => {
    const end = ev("E2", "END", ts("12:00"));
    const events = [
      ev("E1", "START", ts("09:00")),
      end,
      correction("C2", "E2", ts("13:00"), ts("12:30")), // 先に登場するが時刻は新しい
      correction("C1", "E2", ts("12:05"), ts("12:15")), // あとに登場するが時刻は古い
    ];
    const result = applyCorrections(events);
    expect(result.find((e) => e.event_id === "E2")!.occurred_at).toBe(ts("12:30"));
  });

  it("CORRECTION 行自体は出力にそのまま含める", () => {
    const events = [ev("E1", "START", ts("09:00")), correction("C1", "E1", ts("10:00"), ts("09:05"))];
    const result = applyCorrections(events);
    expect(result.some((e) => e.event_id === "C1" && e.event_type === "CORRECTION")).toBe(true);
  });

  it("対象が別イベントの CORRECTION は影響しない", () => {
    const events = [
      ev("E1", "START", ts("09:00")),
      ev("E2", "END", ts("12:00")),
      correction("C1", "E1", ts("10:00"), ts("09:05")),
    ];
    const result = applyCorrections(events);
    expect(result.find((e) => e.event_id === "E2")!.occurred_at).toBe(ts("12:00"));
  });
});

function ts(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return Date.UTC(2026, 8, 1, (h as number) - 9, m as number); // JST -> UTC ms（2026-09-01 固定）
}
