import { describe, expect, it } from "vitest";
import {
  trigEveningCheck,
  trigMonthly,
  trigMorningCard,
  trigWeeklyOrphanCheck,
} from "../../src/app/triggers";
import type { DailySummaryRow, ExpenseLedgerRow, RawLogRow } from "../../src/app/ports";
import { makeFakePorts } from "./fakes";

function setupChannel(ports: ReturnType<typeof makeFakePorts>): void {
  ports.props.set("SLACK_CHANNEL_ID", "C1");
  ports.props.set("SLACK_USER_ID", "U1");
}

/** 経費台帳 1 行のデフォルト値（実装設計 経費フェーズ §5.1）。テストごとに必要な列だけ上書きする。 */
function expenseRow(overrides: Partial<ExpenseLedgerRow> = {}): ExpenseLedgerRow {
  return {
    receipt_id: "R-20260901-001",
    receipt_type: "paper",
    date: "2026-09-01",
    amount: 1200,
    partner: "○○商店",
    category: "消耗品費",
    memo: "",
    drive_link: "",
    file_hash: "",
    mime_type: "",
    size: 0,
    input_at: Date.parse("2026-09-01T09:00:00+09:00"),
    state: "COMPLETED",
    mf_journal_id: null,
    idempotency_key: "V1:seed",
    slack_file_id: "F1",
    drive_file_id: "",
    original_file_name: "receipt.jpg",
    last_error: null,
    state_updated_at: Date.parse("2026-09-01T09:00:00+09:00"),
    tax_category: "",
    business_use_ratio: 100,
    correction_of_receipt_id: null,
    correction_reason: null,
    ...overrides,
  };
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

const WEEKLY_NOW = Date.parse("2026-09-07T07:30:00+09:00"); // 月曜 07 時台

describe("trigWeeklyOrphanCheck — ①停滞行", () => {
  it("COMPLETED/VOID/CORRECTED 以外の行を経過時間つきで報告する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.sheets.expenses.push(
      expenseRow({
        receipt_id: "R-20260901-001",
        state: "RECEIVED",
        state_updated_at: Date.parse("2026-09-01T09:00:00+09:00"), // 6 日前
      }),
    );

    trigWeeklyOrphanCheck(ports);

    expect(ports.slack.posted).toHaveLength(1);
    const text = ports.slack.posted[0]?.text ?? "";
    expect(text).toContain("停滞行");
    expect(text).toContain("R-20260901-001");
    expect(text).toContain("RECEIVED");
  });

  it("ERROR も停滞行として報告する（COMPLETED/VOID/CORRECTED だけが除外対象）", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.sheets.expenses.push(expenseRow({ receipt_id: "R-ERR", state: "ERROR" }));

    trigWeeklyOrphanCheck(ports);

    expect(ports.slack.posted[0]?.text).toContain("R-ERR");
  });
});

describe("trigWeeklyOrphanCheck — ②消えた証憑", () => {
  it("drive.getById が null を返す行を報告する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.sheets.expenses.push(
      expenseRow({ receipt_id: "R-GONE", drive_file_id: "not-planted", size: 100 }),
    );

    trigWeeklyOrphanCheck(ports);

    const text = ports.slack.posted[0]?.text ?? "";
    expect(text).toContain("消えた証憑");
    expect(text).toContain("R-GONE");
  });

  it("drive.getById が trashed:true を返す行を報告する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.drive.plantFile("経費証憑/紙/2026/09", "trashed.jpg", { id: "D-TRASHED", size: 100, trashed: true });
    ports.sheets.expenses.push(
      expenseRow({ receipt_id: "R-TRASHED", drive_file_id: "D-TRASHED", size: 100 }),
    );

    trigWeeklyOrphanCheck(ports);

    const text = ports.slack.posted[0]?.text ?? "";
    expect(text).toContain("消えた証憑");
    expect(text).toContain("R-TRASHED");
  });
});

describe("trigWeeklyOrphanCheck — ③サイズ不一致", () => {
  it("Drive 上の現在サイズが台帳と異なる行を報告する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.drive.plantFile("経費証憑/紙/2026/09", "resized.jpg", { id: "D-RESIZED", size: 999 });
    ports.sheets.expenses.push(
      expenseRow({ receipt_id: "R-RESIZED", drive_file_id: "D-RESIZED", size: 100 }),
    );

    trigWeeklyOrphanCheck(ports);

    const text = ports.slack.posted[0]?.text ?? "";
    expect(text).toContain("サイズ不一致");
    expect(text).toContain("R-RESIZED");
  });
});

describe("trigWeeklyOrphanCheck — ④通知漏れ", () => {
  it("COMPLETED かつ last_error が残っている行を報告する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.sheets.expenses.push(
      expenseRow({ receipt_id: "R-DMFAIL", state: "COMPLETED", last_error: "DM_FAILED:boom" }),
    );

    trigWeeklyOrphanCheck(ports);

    const text = ports.slack.posted[0]?.text ?? "";
    expect(text).toContain("通知漏れ");
    expect(text).toContain("R-DMFAIL");
    expect(text).toContain("DM_FAILED:boom");
  });
});

describe("trigWeeklyOrphanCheck — ⑤前回実行からの経過", () => {
  it("last_success_at が 8 日以上前なら報告する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    const eightDaysAgo = WEEKLY_NOW - 9 * 24 * 60 * 60 * 1000;
    ports.sheets.setInternalValue("expense_scan", "last_success_at", String(eightDaysAgo));

    trigWeeklyOrphanCheck(ports);

    const text = ports.slack.posted[0]?.text ?? "";
    expect(text).toContain("前回の正常完了");
  });

  it("last_success_at が 8 日未満なら報告しない", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    const sixDaysAgo = WEEKLY_NOW - 6 * 24 * 60 * 60 * 1000;
    ports.sheets.setInternalValue("expense_scan", "last_success_at", String(sixDaysAgo));

    trigWeeklyOrphanCheck(ports);

    expect(ports.slack.posted).toHaveLength(0);
  });
});

describe("trigWeeklyOrphanCheck — 0件なら投稿しない・last_success_at の更新", () => {
  it("異常が無ければ投稿せず、last_success_at だけ更新する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.sheets.expenses.push(expenseRow({ receipt_id: "R-OK", state: "COMPLETED" }));

    trigWeeklyOrphanCheck(ports);

    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.sheets.getInternalValue("expense_scan", "last_success_at")).toBe(String(WEEKLY_NOW));
  });

  it("異常を報告した場合でも last_success_at を更新する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.sheets.expenses.push(expenseRow({ receipt_id: "R-STALL", state: "RECEIVED" }));

    trigWeeklyOrphanCheck(ports);

    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.sheets.getInternalValue("expense_scan", "last_success_at")).toBe(String(WEEKLY_NOW));
  });
});

describe("trigWeeklyOrphanCheck — drive.getById の例外", () => {
  it("ある行で例外が起きても他の行の検出を継続する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    // 1 行目: drive.getById が例外を投げる（フェイクは 1 回限りで自動的にクリアされる）。
    ports.sheets.expenses.push(
      expenseRow({ receipt_id: "R-BOOM", drive_file_id: "D-BOOM", size: 100 }),
    );
    // 2 行目: 1 行目の例外を消費した後に評価されるため、通常どおりサイズ不一致を検出できる。
    ports.drive.plantFile("経費証憑/紙/2026/09", "ok.jpg", { id: "D-OK", size: 999 });
    ports.sheets.expenses.push(
      expenseRow({ receipt_id: "R-OK-AFTER", drive_file_id: "D-OK", size: 100 }),
    );
    ports.drive.nextGetByIdError = new Error("drive_api_error:boom");

    expect(() => trigWeeklyOrphanCheck(ports)).not.toThrow();

    const text = ports.slack.posted[0]?.text ?? "";
    expect(text).not.toContain("R-BOOM");
    expect(text).toContain("サイズ不一致");
    expect(text).toContain("R-OK-AFTER");
    // 例外があっても最後まで走査が完了したことの確認（正常完了として last_success_at を更新）。
    expect(ports.sheets.getInternalValue("expense_scan", "last_success_at")).toBe(String(WEEKLY_NOW));
  });
});

describe("trigWeeklyOrphanCheck — チャンネル未設定", () => {
  it("SLACK_CHANNEL_ID が無ければ何もしない（既存トリガーと同じ方針）", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    ports.sheets.expenses.push(expenseRow({ receipt_id: "R-STALL", state: "RECEIVED" }));

    trigWeeklyOrphanCheck(ports);

    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.sheets.getInternalValue("expense_scan", "last_success_at")).toBeNull();
  });
});
