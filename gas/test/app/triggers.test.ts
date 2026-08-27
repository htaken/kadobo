import { describe, expect, it } from "vitest";
import { trigEveningCheck, trigMonthly, trigMorningCard } from "../../src/app/triggers";
import type { DailySummaryRow, RawLogRow } from "../../src/app/ports";
import { makeFakePorts } from "./fakes";

function setupChannel(ports: ReturnType<typeof makeFakePorts>): void {
  ports.props.set("SLACK_CHANNEL_ID", "C1");
  ports.props.set("SLACK_USER_ID", "U1");
}

function startRow(businessDate: string, occurredAtMs: number, overrides: Partial<RawLogRow> = {}): RawLogRow {
  return {
    event_id: `E-${businessDate}`,
    idempotency_key: `seed:${businessDate}`,
    business_date: businessDate,
    event_type: "START",
    occurred_at: occurredAtMs,
    occurred_at_jst: "",
    received_at: occurredAtMs,
    processed_at: occurredAtMs,
    source: "button",
    session_no: 1,
    memo: "",
    correction_of: null,
    old_value: null,
    new_value: null,
    reason: "",
    ...overrides,
  };
}

describe("trigEveningCheck — 稼働中のまま", () => {
  it("当日が WORKING のままならメンション＋修正ボタン付きで通知する", () => {
    const ports = makeFakePorts(Date.parse("2026-09-01T22:00:00+09:00"));
    setupChannel(ports);
    ports.sheets.rawLog.push(startRow("2026-09-01", Date.parse("2026-09-01T09:00:00+09:00")));

    trigEveningCheck(ports);

    expect(ports.slack.posted).toHaveLength(1);
    const message = ports.slack.posted[0];
    expect(message?.text).toContain("2026-09-01");
    expect(message?.blocks?.some((b) => JSON.stringify(b).includes("kado_correct"))).toBe(true);
  });
});

describe("trigEveningCheck — pending > 0", () => {
  it("Worker の pending 残りがあれば通知する", () => {
    const ports = makeFakePorts(Date.parse("2026-09-01T22:00:00+09:00"));
    setupChannel(ports);
    ports.workerStatus.status = { pending: 3, rejected_24h: 0, oldest_pending_at_ms: null };

    trigEveningCheck(ports);

    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.posted[0]?.text).toContain("3 件");
  });
});

describe("trigEveningCheck — 過去7日の要修正一覧", () => {
  it("要修正の日次集計があれば一覧を通知する", () => {
    const ports = makeFakePorts(Date.parse("2026-09-01T22:00:00+09:00"));
    setupChannel(ports);
    const broken: DailySummaryRow = {
      business_date: "2026-08-28",
      weekday: "金",
      session_count: 1,
      first_start_jst: null,
      last_end_jst: null,
      break_seconds: 0,
      worked_seconds: null,
      worked_minutes: null,
      status: "要修正",
      correction_count: 0,
      note: "終了（END）が記録されていません",
      updated_at: Date.now(),
    };
    ports.sheets.upsertDailySummary(broken);

    trigEveningCheck(ports);

    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.posted[0]?.text).toContain("2026-08-28");
  });
});

describe("trigEveningCheck — 何も無ければ通知しない", () => {
  it("稼働中でなく、pending も要修正も無ければ何も投稿しない", () => {
    const ports = makeFakePorts(Date.parse("2026-09-01T22:00:00+09:00"));
    setupChannel(ports);

    trigEveningCheck(ports);

    expect(ports.slack.posted).toHaveLength(0);
  });
});

describe("trigMorningCard", () => {
  it("土曜日は投稿しない", () => {
    const ports = makeFakePorts(Date.parse("2026-09-05T07:30:00+09:00")); // 土曜
    setupChannel(ports);

    trigMorningCard(ports);

    expect(ports.slack.posted).toHaveLength(0);
  });

  it("祝日カレンダーに該当する日は投稿しない", () => {
    const ports = makeFakePorts(Date.parse("2026-09-02T07:30:00+09:00")); // 水曜だが祝日扱いにする
    setupChannel(ports);
    ports.calendar.holidays.add("2026-09-02");

    trigMorningCard(ports);

    expect(ports.slack.posted).toHaveLength(0);
  });

  it("平日は投稿する。前日が WORKING のままなら警告ブロックを含める", () => {
    const ports = makeFakePorts(Date.parse("2026-09-02T07:30:00+09:00")); // 水曜
    setupChannel(ports);
    ports.sheets.rawLog.push(startRow("2026-09-01", Date.parse("2026-09-01T09:00:00+09:00")));

    trigMorningCard(ports);

    expect(ports.slack.posted).toHaveLength(1);
    const blocks = ports.slack.posted[0]?.blocks ?? [];
    expect(blocks.some((b) => (b as { block_id?: string }).block_id === "warning")).toBe(true);
  });

  it("前日が確定していれば警告ブロックを含めない", () => {
    const ports = makeFakePorts(Date.parse("2026-09-02T07:30:00+09:00"));
    setupChannel(ports);
    ports.sheets.rawLog.push(startRow("2026-09-01", Date.parse("2026-09-01T09:00:00+09:00")));
    ports.sheets.rawLog.push(
      startRow("2026-09-01", Date.parse("2026-09-01T18:00:00+09:00"), {
        event_id: "E-end",
        event_type: "END",
      }),
    );

    trigMorningCard(ports);

    expect(ports.slack.posted).toHaveLength(1);
    const blocks = ports.slack.posted[0]?.blocks ?? [];
    expect(blocks.some((b) => (b as { block_id?: string }).block_id === "warning")).toBe(false);
  });
});

describe("trigMonthly", () => {
  it("前月の日次を再計算し、月次請求と要修正一覧を通知する", () => {
    const ports = makeFakePorts(Date.parse("2026-09-01T06:30:00+09:00"));
    setupChannel(ports);
    ports.sheets.unitPrices.push({
      client: "A社",
      unit_price: 3000,
      tax_category: "課税",
      tax_inclusive: false,
      tax_display: "区分記載",
      rounding: "切捨",
      withholding: "なし",
      valid_from: "2026-01-01",
      valid_to: null,
    });
    // 8/10 に START のみ（要修正: 終了が無い過去日）。
    ports.sheets.rawLog.push(startRow("2026-08-10", Date.parse("2026-08-10T09:00:00+09:00")));
    // 8/11 は正常な 1 セッション（3 時間）。
    ports.sheets.rawLog.push(startRow("2026-08-11", Date.parse("2026-08-11T09:00:00+09:00")));
    ports.sheets.rawLog.push(
      startRow("2026-08-11", Date.parse("2026-08-11T12:00:00+09:00"), {
        event_id: "E-2026-08-11-end",
        event_type: "END",
      }),
    );

    trigMonthly(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-08");
    expect(bill).not.toBeNull();
    expect(bill?.worked_minutes).toBe(180);

    const daily0810 = ports.sheets.getDailySummary("2026-08-10");
    expect(daily0810?.status).toBe("要修正");

    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.posted[0]?.text).toContain("2026-08");
    expect(ports.slack.posted[0]?.text).toContain("2026-08-10");
  });
});
