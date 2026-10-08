import { describe, expect, it } from "vitest";
import {
  trigEveningCheck,
  trigMfSync,
  trigMfSyncSoon,
  trigMonthly,
  trigMorningCard,
  trigWeeklyOrphanCheck,
} from "../../src/app/triggers";
import { MF_INVOICE_TOKENS_KEY } from "../../src/app/mf/invoiceClient";
import {
  LockTimeoutError,
  type DailySummaryRow,
  type ExpenseLedgerRow,
  type MonthlyBillRow,
  type RawLogRow,
} from "../../src/app/ports";
import { makeFakePorts } from "./fakes";
import { accountingCallsOf, installFakeMfAccounting } from "./mf/fakeMfAccounting";

function seedInvoiceTokens(ports: ReturnType<typeof makeFakePorts>): void {
  ports.secrets.set(
    MF_INVOICE_TOKENS_KEY,
    JSON.stringify({ access_token: "AT1", refresh_token: "RT1", refreshed_at: 1000, generation: 1 }),
  );
}

function seedUnitPrice(ports: ReturnType<typeof makeFakePorts>): void {
  ports.sheets.unitPrices.push({
    client: "A社",
    unit_price: 1800,
    tax_category: "課税",
    tax_inclusive: false,
    tax_display: "区分記載",
    rounding: "切捨",
    withholding: "なし",
    valid_from: "2026-01-01",
    valid_to: null,
  });
}

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
    payment_method: "",
    mf_transaction_id: null,
    mf_sync_state: "",
    mf_sync_error: null,
    mf_sync_updated_at: null,
    mf_sync_attempted_at: null,
    mf_sync_input: "",
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

  it("再集計（日次ループ＋月次）はスクリプトロックの中で行う（実装設計 MF連携 §5.2, B1）", () => {
    const ports = makeFakePorts(Date.parse("2026-09-01T06:30:00+09:00"));
    setupChannel(ports);
    ports.lock.throwTimeoutOnce = true;

    // ロックが取れなければ例外が伝播する（＝再集計が実際にロックの中で行われている証拠）。
    // 既存の `trigMonthly` は try/catch していないため、このまま呼び出し元へ抜ける。
    expect(() => trigMonthly(ports)).toThrow(LockTimeoutError);
  });

  it("集計後に evaluateMonthClose を呼ぶ（実装設計 MF連携 §5.2, §7）", () => {
    const ports = makeFakePorts(Date.parse("2026-09-01T06:30:00+09:00")); // 前月 = 2026-08
    setupChannel(ports);
    ports.props.set("MF_BILLING_START_MONTH", "2026-08");
    seedUnitPrice(ports);
    // 要修正な日が無い、正常な1セッション（3時間）。
    ports.sheets.rawLog.push(startRow("2026-08-11", Date.parse("2026-08-11T09:00:00+09:00")));
    ports.sheets.rawLog.push(
      startRow("2026-08-11", Date.parse("2026-08-11T12:00:00+09:00"), {
        event_id: "E-2026-08-11-end",
        event_type: "END",
      }),
    );

    trigMonthly(ports);

    // 既存の月次集計通知 ＋ 締め確認カードで計 2 件投稿される。
    expect(ports.slack.posted).toHaveLength(2);
    const bill = ports.sheets.getMonthlyBill("A社", "2026-08");
    expect(bill?.state).toBe("REVIEWING");
    expect(bill?.close_card_ts).not.toBeNull();
    expect(ports.http.calls).toHaveLength(0); // MF は一切呼ばない
  });
});

describe("trigMfSync（実装設計 MF連携 §7）", () => {
  it("evaluateMonthClose を呼ぶ（MF は呼ばない）", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    ports.props.set("MF_BILLING_START_MONTH", "2026-10");
    seedUnitPrice(ports);

    trigMfSync(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10");
    expect(bill?.state).toBe("REVIEWING");
    expect(ports.http.calls).toHaveLength(0);
  });

  it("evaluateMonthClose が例外を投げても trigMfSync 自体は例外を投げない（独立した try/catch）", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    ports.props.set("MF_BILLING_START_MONTH", "2026-10");
    ports.sheets.getMonthlyBill = () => {
      throw new Error("boom");
    };

    expect(() => trigMfSync(ports)).not.toThrow();
  });

  it("フラグ有効: ensureInvoiceCreated・trackBillingStatus・warnMismatchDaily を呼ぶ（実装設計 MF連携 §5.5, §5.7, §7）", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_INVOICE_ENABLED", "true");
    seedInvoiceTokens(ports);

    // MISMATCH の月（warnMismatchDaily が毎回拾う）。
    const mismatchBill: MonthlyBillRow = {
      client: "A社",
      month: "2026-08",
      worked_minutes: 0,
      hours: 0,
      unit_price: 0,
      amount: 0,
      tax_amount: 0,
      withholding_amount: 0,
      net_amount: 0,
      state: "MF_CREATED",
      mf_invoice_id: "INV1",
      locked_at: 1,
      note: null,
      updated_at: 1,
      invoice_state: "MISMATCH",
      invoice_error: "差額あり",
      invoice_attempted_at: null,
      close_card_ts: null,
    };
    ports.sheets.monthlyBills.set("A社|2026-08", mismatchBill);

    trigMfSync(ports);

    // trackBillingStatus が GET /billings/{id} を呼ぶ（既定応答は変化なしなので state は変わらない）。
    expect(ports.http.calls.some((c) => c.url.includes("/billings/INV1"))).toBe(true);
    // warnMismatchDaily が MISMATCH の月を警告する。
    expect(ports.slack.posted.some((p) => p.text.includes("送付しないでください"))).toBe(true);
  });

  it("ensureInvoiceCreated が例外を投げても trackBillingStatus・warnMismatchDaily は実行される（各ステップが独立）", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_INVOICE_ENABLED", "true");
    seedInvoiceTokens(ports);

    const mismatchBill: MonthlyBillRow = {
      client: "A社",
      month: "2026-08",
      worked_minutes: 0,
      hours: 0,
      unit_price: 0,
      amount: 0,
      tax_amount: 0,
      withholding_amount: 0,
      net_amount: 0,
      state: "MF_CREATED",
      mf_invoice_id: "INV1",
      locked_at: 1,
      note: null,
      updated_at: 1,
      invoice_state: "MISMATCH",
      invoice_error: "差額あり",
      invoice_attempted_at: null,
      close_card_ts: null,
    };
    ports.sheets.monthlyBills.set("A社|2026-08", mismatchBill);

    // `listMonthlyBills` は ensureInvoiceCreated・trackBillingStatus・warnMismatchDaily の
    // それぞれから 1 回ずつ呼ばれる。1 回目（ensureInvoiceCreated）だけ例外を投げる。
    let calls = 0;
    const original = ports.sheets.listMonthlyBills.bind(ports.sheets);
    ports.sheets.listMonthlyBills = () => {
      calls++;
      if (calls === 1) {
        throw new Error("boom");
      }
      return original();
    };

    expect(() => trigMfSync(ports)).not.toThrow();
    // ensureInvoiceCreated は失敗したが、warnMismatchDaily は実行され警告が投稿されている。
    expect(ports.slack.posted.some((p) => p.text.includes("送付しないでください"))).toBe(true);
  });
});

describe("trigMfSyncSoon（実装設計 MF連携 §5.3, §7）", () => {
  it("最初に自分と同名のトリガーを削除してから trigMfSync と同じ処理を行う", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    ports.props.set("MF_BILLING_START_MONTH", "2026-10");
    seedUnitPrice(ports);
    ports.scheduler.pending.add("trigMfSyncSoon");

    trigMfSyncSoon(ports);

    expect(ports.scheduler.clearCalls).toEqual(["trigMfSyncSoon"]);
    expect(ports.scheduler.hasPending("trigMfSyncSoon")).toBe(false);
    const bill = ports.sheets.getMonthlyBill("A社", "2026-10");
    expect(bill?.state).toBe("REVIEWING");
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

describe("trigWeeklyOrphanCheck — weeklyInvoiceKeepalive（実装設計 MF連携 §4.2, §7）", () => {
  it("フラグ有効: 末尾で GET /office を 1 回呼ぶ", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_INVOICE_ENABLED", "true");
    seedInvoiceTokens(ports);

    trigWeeklyOrphanCheck(ports);

    expect(ports.http.calls).toHaveLength(1);
    expect(ports.http.calls[0]!.url).toBe("https://invoice.moneyforward.com/api/v3/office");
  });

  it("フラグ無効なら呼ばない", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);

    trigWeeklyOrphanCheck(ports);

    expect(ports.http.calls).toHaveLength(0);
  });

  it("weeklyInvoiceKeepalive が例外を投げても trigWeeklyOrphanCheck 自体は例外を投げない", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_INVOICE_ENABLED", "true");
    // トークン未設定 -> MfReauthRequiredError が投げられる。

    expect(() => trigWeeklyOrphanCheck(ports)).not.toThrow();
  });
});

// 経費同期（WP-M4。実装設計 MF連携 §6, §7）

function journalReadyRow(id: string, o: Partial<ExpenseLedgerRow> = {}): ExpenseLedgerRow {
  return {
    receipt_id: id,
    receipt_type: "paper",
    date: "2026-11-10",
    amount: 800,
    partner: "○○商店",
    category: "通信費",
    memo: "",
    drive_link: "https://drive.example.test/x",
    file_hash: "h",
    mime_type: "image/jpeg",
    size: 1,
    input_at: 1,
    state: "COMPLETED",
    mf_journal_id: null,
    idempotency_key: `K-${id}`,
    slack_file_id: "F",
    drive_file_id: "D",
    original_file_name: "a.jpg",
    last_error: null,
    state_updated_at: 1,
    tax_category: "",
    business_use_ratio: 100,
    correction_of_receipt_id: null,
    correction_reason: null,
    payment_method: "cash",
    mf_transaction_id: null,
    mf_sync_state: "",
    mf_sync_error: null,
    mf_sync_updated_at: null,
    mf_sync_attempted_at: null,
    mf_sync_input: "",
    ...o,
  };
}

describe("trigMfSync ⑤ 経費同期（実装設計 MF連携 §7）", () => {
  it("フラグ有効: 経費台帳の現金の行を仕訳にする（trigMfSyncSoon からも同じ）", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    const api = installFakeMfAccounting(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_JOURNAL_ENABLED", "true");
    ports.props.set("MF_SYNC_START_DATE", "2026-10-01");
    ports.sheets.appendExpense(journalReadyRow("R-1"));
    ports.sheets.appendExpense(journalReadyRow("R-2"));

    trigMfSync(ports);
    expect(api.journals.map((j) => j.tags)).toEqual([["R-1"], ["R-2"]]);
    expect(ports.sheets.getExpenseByReceiptId("R-1")?.mf_sync_state).toBe("SYNCED");

    ports.sheets.appendExpense(journalReadyRow("R-3"));
    trigMfSyncSoon(ports);
    expect(ports.sheets.getExpenseByReceiptId("R-3")?.mf_sync_state).toBe("SYNCED");
  });

  it("全フラグ無効なら HTTP 0 件", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    installFakeMfAccounting(ports);
    ports.props.set("MF_SYNC_START_DATE", "2026-10-01");
    ports.sheets.appendExpense(journalReadyRow("R-1"));

    trigMfSync(ports);

    expect(ports.http.calls).toHaveLength(0);
  });

  it("syncExpenses の MfTransientError は投げず、`mf_fail/journal` に数え、6 回連続で「一時障害が続いています」を DM する", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_JOURNAL_ENABLED", "true");
    ports.props.set("MF_SYNC_START_DATE", "2026-10-01");
    ports.props.set("SLACK_USER_ID", "U1");
    ports.props.set("MF_ACCOUNTING_API_KEY", "k");
    ports.props.set("MF_OFFICE_CODE", "1234-5678");
    ports.http.defaultResponse = { status: 503, headers: {}, body: "" }; // JWT 交換が 5xx → MfTransientError
    ports.sheets.appendExpense(journalReadyRow("R-1"));

    for (let i = 0; i < 6; i++) {
      expect(() => trigMfSync(ports)).not.toThrow();
    }

    expect(ports.sheets.getInternalValue("mf_fail", "journal")).toBe("6");
    expect(ports.slack.dms.filter((d) => d.text.includes("一時障害が続いています") && d.text.includes("journal"))).toHaveLength(1);
    // 請求書側のカウンタ（invoice）とは別。
    expect(ports.sheets.getInternalValue("mf_fail", "invoice")).toBeNull();
  });

  it("会計 API が 403: 行は変えず、API キーの有効性・権限の確認を依頼する DM が出る（24 時間に 1 回）", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    const api = installFakeMfAccounting(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_JOURNAL_ENABLED", "true");
    ports.props.set("MF_SYNC_START_DATE", "2026-10-01");
    ports.props.set("SLACK_USER_ID", "U1");
    api.forbidAll = true;
    ports.sheets.appendExpense(journalReadyRow("R-1", { mf_sync_state: "CREATING", mf_sync_attempted_at: 1 }));

    expect(() => trigMfSync(ports)).not.toThrow();
    trigMfSync(ports);

    expect(ports.sheets.getExpenseByReceiptId("R-1")?.mf_sync_state).toBe("CREATING");
    const dms = ports.slack.dms.filter((d) => d.text.includes("MF_ACCOUNTING_API_KEY") && d.text.includes("権限"));
    expect(dms).toHaveLength(1);
    expect(dms[0]!.text).toContain("journal");
  });

  it("syncExpenses が成功すれば `mf_fail/journal` の連続回数をリセットする", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    installFakeMfAccounting(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_JOURNAL_ENABLED", "true");
    ports.props.set("MF_SYNC_START_DATE", "2026-10-01");
    ports.sheets.setInternalValue("mf_fail", "journal", "3");

    trigMfSync(ports);

    expect(ports.sheets.getInternalValue("mf_fail", "journal")).toBe("0");
  });

  it("経費同期が例外を投げても ①〜④ は先に実行されている（各ステップが独立）", () => {
    const ports = makeFakePorts(Date.parse("2026-11-15T06:00:00+09:00"));
    setupChannel(ports);
    ports.props.set("MF_BILLING_START_MONTH", "2026-10");
    seedUnitPrice(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.sheets.getAllExpenses = () => {
      throw new Error("boom");
    };

    expect(() => trigMfSync(ports)).not.toThrow();
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.state).toBe("REVIEWING");
  });
});

describe("trigWeeklyOrphanCheck — 週次報告の仕訳部分（実装設計 MF連携 §6.6）", () => {
  it("末尾で二重作成の疑い（同じ証憑 ID のタグの仕訳が 2 件以上）と、人の判断待ちの件数を報告する", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    const api = installFakeMfAccounting(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_SYNC_START_DATE", "2026-08-01");
    ports.sheets.appendExpense(journalReadyRow("R-1", { date: "2026-08-20", mf_sync_state: "SYNCED" }));
    ports.sheets.appendExpense(journalReadyRow("R-2", { date: "2026-08-21", mf_sync_state: "NEEDS_REVIEW" }));
    api.plantJournal({ transaction_date: "2026-08-20", tags: ["R-1"] });
    api.plantJournal({ transaction_date: "2026-08-20", tags: ["R-1"] });

    trigWeeklyOrphanCheck(ports);

    const text = ports.slack.posted.map((p) => p.text).join("\n");
    expect(text).toContain("二重作成の疑い");
    expect(text).toContain("R-1");
    expect(text).toContain("NEEDS_REVIEW 1 件");
    expect(accountingCallsOf(ports).filter((c) => c === "GET /journals").length).toBeGreaterThan(0);
  });

  it("仕訳部分が例外を投げても trigWeeklyOrphanCheck 自体は例外を投げない（独立した try/catch）。`mf_fail/journal` に数える", () => {
    const ports = makeFakePorts(WEEKLY_NOW);
    setupChannel(ports);
    ports.props.set("MF_ENABLED", "true");
    ports.props.set("MF_SYNC_START_DATE", "2026-08-01");
    ports.props.set("MF_ACCOUNTING_API_KEY", "k");
    ports.props.set("MF_OFFICE_CODE", "1234-5678");
    ports.http.defaultResponse = { status: 503, headers: {}, body: "" };

    expect(() => trigWeeklyOrphanCheck(ports)).not.toThrow();
    expect(ports.sheets.getInternalValue("mf_fail", "journal")).toBe("1");
  });
});
