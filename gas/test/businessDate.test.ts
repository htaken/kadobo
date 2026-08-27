import { describe, expect, it } from "vitest";
import { resolveBusinessDate, type RecentDay } from "../src/core/businessDate";
import type { LoggedEvent } from "../src/core/state";

function ev(
  event_id: string,
  event_type: LoggedEvent["event_type"],
  occurred_at: number,
): LoggedEvent {
  return { event_id, event_type, occurred_at };
}

describe("resolveBusinessDate", () => {
  it("前日データが無ければ occurred_at の JST 日付", () => {
    expect(resolveBusinessDate(Date.parse("2026-09-01T03:00:00+09:00"), [])).toBe(
      "2026-09-01",
    );
  });

  it("跨日: 前日 22:00 開始で未終了なら、翌日 01:30 の END は前日の業務日に帰属", () => {
    const recentDays: RecentDay[] = [
      {
        business_date: "2026-09-01",
        events: [ev("E1", "START", Date.parse("2026-09-01T22:00:00+09:00"))],
      },
    ];
    const occurredAt = Date.parse("2026-09-02T01:30:00+09:00");
    expect(resolveBusinessDate(occurredAt, recentDays)).toBe("2026-09-01");
  });

  it("前日が確定（CLOSED）なら跨日にならず当日日付", () => {
    const recentDays: RecentDay[] = [
      {
        business_date: "2026-09-01",
        events: [
          ev("E1", "START", Date.parse("2026-09-01T09:00:00+09:00")),
          ev("E2", "END", Date.parse("2026-09-01T18:00:00+09:00")),
        ],
      },
    ];
    const occurredAt = Date.parse("2026-09-02T09:00:00+09:00");
    expect(resolveBusinessDate(occurredAt, recentDays)).toBe("2026-09-02");
  });
});
