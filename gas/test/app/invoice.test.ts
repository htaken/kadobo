/**
 * `app/invoice.ts` のテスト（実装設計 MF連携 §5.5, §5.7, §11.2 WP-M3 受入条件）。
 * `FakeHttp` で MF の応答を模擬する。実際の MF・Slack には一切アクセスしない。
 */
import { describe, expect, it } from "vitest";
import { ensureInvoiceCreated, trackBillingStatus, warnMismatchDaily, weeklyInvoiceKeepalive } from "../../src/app/invoice";
import { RunDeadline } from "../../src/app/mf/deadline";
import { MF_INVOICE_TOKENS_KEY } from "../../src/app/mf/invoiceClient";
import type { MonthlyBillRow } from "../../src/app/ports";
import { makeFakePorts, type FakePorts } from "./fakes";

const OFFICE_URL = "https://invoice.moneyforward.com/api/v3/office";
const CREATE_URL = "https://invoice.moneyforward.com/api/v3/invoice_template_billings";

function seedTokens(ports: FakePorts): void {
  ports.secrets.set(
    MF_INVOICE_TOKENS_KEY,
    JSON.stringify({ access_token: "AT1", refresh_token: "RT1", refreshed_at: 1000, generation: 1 }),
  );
}

function enableInvoice(ports: FakePorts): void {
  ports.props.set("MF_ENABLED", "true");
  ports.props.set("MF_INVOICE_ENABLED", "true");
  seedTokens(ports);
}

function seedDepartment(ports: FakePorts): void {
  ports.props.set("MF_DEPARTMENT_ID", "DEPT-1");
}

function seedUnitPrice(ports: FakePorts): void {
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

/** `LOCKED` かつ `invoice_state: PENDING`（報酬 288,000円・消費税 28,800円・源泉 0円・差引 316,800円）。 */
function billRow(overrides: Partial<MonthlyBillRow> = {}): MonthlyBillRow {
  return {
    client: "A社",
    month: "2026-10",
    worked_minutes: 9600,
    hours: 160,
    unit_price: 1800,
    amount: 288000,
    tax_amount: 28800,
    withholding_amount: 0,
    net_amount: 316800,
    state: "LOCKED",
    mf_invoice_id: null,
    locked_at: Date.parse("2026-11-01T00:00:00+09:00"),
    note: null,
    updated_at: Date.parse("2026-11-01T00:00:00+09:00"),
    invoice_state: "PENDING",
    invoice_error: null,
    invoice_attempted_at: null,
    close_card_ts: null,
    ...overrides,
  };
}

function setupPorts(overrides: Partial<MonthlyBillRow> = {}): FakePorts {
  const ports = makeFakePorts(Date.parse("2026-11-05T10:00:00+09:00"));
  ports.props.set("SLACK_CHANNEL_ID", "C1");
  ports.props.set("SLACK_USER_ID", "U1");
  enableInvoice(ports);
  seedDepartment(ports);
  seedUnitPrice(ports);
  ports.sheets.monthlyBills.set("A社|2026-10", billRow(overrides));
  return ports;
}

/** `GET /billings` の実際の応答形（MF の OpenAPI 定義で確認済み）: `{ data, pagination }`。 */
function queueSearch(ports: FakePorts, rows: Record<string, unknown>[], page = 1, totalPages = 1): void {
  ports.http.queueResponse({
    status: 200,
    body: JSON.stringify({
      data: rows,
      pagination: { total_count: rows.length, total_pages: totalPages, per_page: 100, current_page: page },
    }),
  });
}

function queueCreate(ports: FakePorts, id: string): void {
  ports.http.queueResponse({ status: 201, body: JSON.stringify({ id }) });
}

function queueDetail(ports: FakePorts, detail: Record<string, unknown>): void {
  ports.http.queueResponse({ status: 200, body: JSON.stringify(detail) });
}

function matchingDetail(): Record<string, unknown> {
  return { subtotal_price: "288000", excise_price: "28800", total_price: "316800" };
}

// ---------------------------------------------------------------------------
// ensureInvoiceCreated
// ---------------------------------------------------------------------------

describe("ensureInvoiceCreated — フラグ・対象外", () => {
  it("MF_ENABLED/MF_INVOICE_ENABLED が無効なら HTTP 0 件", () => {
    const ports = makeFakePorts(Date.parse("2026-11-05T10:00:00+09:00"));
    ports.sheets.monthlyBills.set("A社|2026-10", billRow());
    // フラグは既定で無効。

    ensureInvoiceCreated(ports);

    expect(ports.http.calls).toHaveLength(0);
  });

  it("invoice_state: MANUAL の月は作らない（フラグが有効でも）", () => {
    const ports = setupPorts({ invoice_state: "MANUAL" });

    ensureInvoiceCreated(ports);

    expect(ports.http.calls).toHaveLength(0);
  });

  it("lease 取得中は何もしない（別の実行が処理中）", () => {
    const ports = setupPorts();
    ports.sheets.setInternalValue("lease", "mf_invoice/A社:2026-10", String(ports.clock.nowMs() + 5 * 60 * 1000));

    ensureInvoiceCreated(ports);

    expect(ports.http.calls).toHaveLength(0);
  });
});

describe("ensureInvoiceCreated — 正常作成・照合", () => {
  it("正常作成 → 一致 → MF_CREATED/CREATED、MF 画面 URL 付きで通知する", () => {
    const ports = setupPorts();
    queueSearch(ports, []);
    queueCreate(ports, "INV1");
    queueDetail(ports, matchingDetail());

    ensureInvoiceCreated(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.state).toBe("MF_CREATED");
    expect(bill.invoice_state).toBe("CREATED");
    expect(bill.mf_invoice_id).toBe("INV1");
    expect(bill.invoice_error).toBeNull();
    expect(ports.http.calls.some((c) => c.url === CREATE_URL)).toBe(true);
    expect(ports.slack.posted.some((p) => p.text.includes("✅") && p.text.includes("https://invoice.moneyforward.com/billings/INV1"))).toBe(
      true,
    );
  });

  it("不一致（源泉 0 を含む）→ MF_CREATED/MISMATCH、送付しないでくださいと通知する", () => {
    const ports = setupPorts();
    queueSearch(ports, []);
    queueCreate(ports, "INV1");
    queueDetail(ports, { subtotal_price: "288000", excise_price: "28800", total_price: "316900" }); // 100円ずれる

    ensureInvoiceCreated(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.state).toBe("MF_CREATED");
    expect(bill.invoice_state).toBe("MISMATCH");
    expect(bill.invoice_error).not.toBeNull();
    expect(ports.slack.posted.some((p) => p.text.includes("⚠️") && p.text.includes("送付しないでください"))).toBe(true);
  });
});

describe("ensureInvoiceCreated — 検索による回収（冪等）", () => {
  it("ID 保存前に落ちた（シート書込みで例外）→ 次回 document_number 検索で回収して POST しない", () => {
    const ports = setupPorts();
    queueSearch(ports, []);
    queueCreate(ports, "INV1");

    let writeCount = 0;
    const original = ports.sheets.updateMonthlyBillColumns.bind(ports.sheets);
    ports.sheets.updateMonthlyBillColumns = (client, month, patch) => {
      writeCount++;
      if (writeCount === 2) {
        // 1 回目 = invoice_attempted_at、2 回目 = mf_invoice_id の保存（ここで落ちる）。
        throw new Error("SHEET_WRITE_FAILED");
      }
      original(client, month, patch);
    };

    expect(() => ensureInvoiceCreated(ports)).toThrow("SHEET_WRITE_FAILED");

    const afterCrash = ports.sheets.monthlyBills.get("A社|2026-10")!;
    expect(afterCrash.mf_invoice_id).toBeNull();
    expect(afterCrash.invoice_state).toBe("PENDING");
    expect(afterCrash.invoice_attempted_at).not.toBeNull();
    expect(ports.http.calls.filter((c) => c.method === "post")).toHaveLength(1); // POST は 1 回だけ発生済み

    // 復旧: 書込みを元に戻し、次回は検索で見つける。
    ports.sheets.updateMonthlyBillColumns = original;
    queueSearch(ports, [{ id: "INV1", billing_number: "KD-202610" }]);
    queueDetail(ports, matchingDetail());

    ensureInvoiceCreated(ports);

    const after = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(after.mf_invoice_id).toBe("INV1");
    expect(after.state).toBe("MF_CREATED");
    expect(after.invoice_state).toBe("CREATED");
    expect(ports.http.calls.filter((c) => c.method === "post")).toHaveLength(1); // 2 回目は POST しない
  });
});

describe("ensureInvoiceCreated — GET /billings のページング（実装設計 §5.5）", () => {
  it("pagination.total_pages=2: 2 ページ目まで取得して打ち切る", () => {
    const ports = setupPorts({ mf_invoice_id: null });
    // 1 ページ目には目的の billing_number が無く、2 ページ目に見つかるケース。
    ports.http.queueResponse({
      status: 200,
      body: JSON.stringify({
        data: [{ id: "OTHER", billing_number: "KD-202609" }],
        pagination: { total_count: 2, total_pages: 2, per_page: 100, current_page: 1 },
      }),
    });
    ports.http.queueResponse({
      status: 200,
      body: JSON.stringify({
        data: [{ id: "INV1", billing_number: "KD-202610" }],
        pagination: { total_count: 2, total_pages: 2, per_page: 100, current_page: 2 },
      }),
    });
    queueDetail(ports, matchingDetail());

    ensureInvoiceCreated(ports);

    const searchCalls = ports.http.calls.filter((c) => c.url.includes("/billings?document_number="));
    expect(searchCalls).toHaveLength(2);
    // `per_page=100` にも `page=1` が部分文字列として含まれるため、`&page=` クエリそのものを見る。
    expect(searchCalls[0]!.url).toContain("&page=1&per_page=");
    expect(searchCalls[1]!.url).toContain("&page=2&per_page=");
    // 3 ページ目は要求しない（current_page(2) >= total_pages(2) で打ち切る）。
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.mf_invoice_id).toBe("INV1");
  });

  it("pagination.total_pages=1: 1 回だけ取得する", () => {
    const ports = setupPorts();
    queueSearch(ports, [{ id: "INV1", billing_number: "KD-202610" }], 1, 1);
    queueDetail(ports, matchingDetail());

    ensureInvoiceCreated(ports);

    const searchCalls = ports.http.calls.filter((c) => c.url.includes("/billings?document_number="));
    expect(searchCalls).toHaveLength(1);
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.mf_invoice_id).toBe("INV1");
  });

  it("pagination が無い応答: 配列件数が per_page ちょうどなら次ページへ、未満なら打ち切る（フォールバック）", () => {
    const ports = setupPorts();
    // 1 ページ目: per_page(100) ちょうどの 100 件（目的の billing_number は含まない）。
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ id: `X${i}`, billing_number: `KD-999${i}` }));
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ billings: fullPage }) });
    // 2 ページ目: 1 件のみ（per_page 未満なので打ち切り）。pagination フィールドは無い。
    ports.http.queueResponse({
      status: 200,
      body: JSON.stringify({ billings: [{ id: "INV1", billing_number: "KD-202610" }] }),
    });
    queueDetail(ports, matchingDetail());

    ensureInvoiceCreated(ports);

    const searchCalls = ports.http.calls.filter((c) => c.url.includes("/billings?document_number="));
    expect(searchCalls).toHaveLength(2);
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.mf_invoice_id).toBe("INV1");
  });
});

describe("ensureInvoiceCreated — POST の結果不明（UNKNOWN）", () => {
  it("POST が 5xx → UNKNOWN、次回以降 POST しない", () => {
    const ports = setupPorts();
    queueSearch(ports, []);
    ports.http.queueResponse({ status: 500 });

    ensureInvoiceCreated(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.invoice_state).toBe("UNKNOWN");
    expect(bill.mf_invoice_id).toBeNull();
    expect(bill.state).toBe("LOCKED");
    expect(ports.http.calls.filter((c) => c.method === "post")).toHaveLength(1);

    // 次回: 検索のみ（0 件）、POST は送らない。
    queueSearch(ports, []);
    ensureInvoiceCreated(ports);

    expect(ports.http.calls.filter((c) => c.method === "post")).toHaveLength(1); // 増えない
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.invoice_state).toBe("UNKNOWN");
  });

  it("POST が通信失敗 → UNKNOWN", () => {
    const ports = setupPorts();
    queueSearch(ports, []);
    ports.http.queueNetworkError();

    ensureInvoiceCreated(ports);

    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.invoice_state).toBe("UNKNOWN");
  });

  it("UNKNOWN で検索に出てきたら回収する（POST しない）", () => {
    const ports = setupPorts({
      invoice_state: "UNKNOWN",
      invoice_attempted_at: Date.parse("2026-11-05T09:00:00+09:00"), // 1 時間前
    });
    queueSearch(ports, [{ id: "INV1", billing_number: "KD-202610" }]);
    queueDetail(ports, matchingDetail());

    ensureInvoiceCreated(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.mf_invoice_id).toBe("INV1");
    expect(bill.state).toBe("MF_CREATED");
    expect(bill.invoice_state).toBe("CREATED");
    expect(ports.http.calls.some((c) => c.method === "post")).toBe(false);
  });

  it("UNKNOWN のまま 24 時間経過しても見つからなければ 1 回だけ依頼する（2 回目は出ない）", () => {
    const ports = setupPorts({
      invoice_state: "UNKNOWN",
      invoice_attempted_at: Date.parse("2026-11-04T09:00:00+09:00"), // 25 時間前（now=2026-11-05T10:00 JST）
    });
    queueSearch(ports, []);

    ensureInvoiceCreated(ports);
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.posted[0]!.text).toContain("invoice_state を PENDING に戻してください");

    queueSearch(ports, []);
    ensureInvoiceCreated(ports);
    expect(ports.slack.posted).toHaveLength(1); // 2 回目は出ない
  });

  it("24 時間未満なら依頼しない", () => {
    const ports = setupPorts({
      invoice_state: "UNKNOWN",
      invoice_attempted_at: Date.parse("2026-11-05T09:00:00+09:00"), // 1 時間前
    });
    queueSearch(ports, []);

    ensureInvoiceCreated(ports);

    expect(ports.slack.posted).toHaveLength(0);
  });
});

describe("ensureInvoiceCreated — 業務エラー", () => {
  it("検索 2 件以上 → ERROR（作らない）", () => {
    const ports = setupPorts();
    queueSearch(ports, [
      { id: "INV1", billing_number: "KD-202610" },
      { id: "INV2", billing_number: "KD-202610" },
    ]);

    ensureInvoiceCreated(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.invoice_state).toBe("ERROR");
    expect(bill.state).toBe("LOCKED"); // 作られていないので凍結状態は進めない
    expect(bill.invoice_error).toContain("重複");
    expect(ports.http.calls.some((c) => c.method === "post")).toBe(false);
    expect(ports.slack.posted.some((p) => p.text.includes("重複"))).toBe(true);
  });

  it("POST が 400 → ERROR", () => {
    const ports = setupPorts();
    queueSearch(ports, []);
    ports.http.queueResponse({
      status: 400,
      body: JSON.stringify({ errors: [{ code: "invalid_param", message: "department_id is invalid" }] }),
    });

    ensureInvoiceCreated(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.invoice_state).toBe("ERROR");
    expect(bill.state).toBe("LOCKED");
    expect(bill.invoice_error).toContain("status=400");
  });

  it("MF_DEPARTMENT_ID 未設定 → ERROR、運用者へ DM する", () => {
    const ports = setupPorts();
    ports.props.set("MF_DEPARTMENT_ID", "");
    queueSearch(ports, []);

    ensureInvoiceCreated(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.invoice_state).toBe("ERROR");
    expect(bill.invoice_error).toContain("MF_DEPARTMENT_ID");
    expect(ports.http.calls.some((c) => c.method === "post")).toBe(false);
    expect(ports.slack.dms.some((d) => d.text.includes("MF_DEPARTMENT_ID"))).toBe(true);
  });
});

describe("ensureInvoiceCreated — 一時障害", () => {
  it("POST が 429（Retry-After 超過）→ MfTransientError → PENDING のまま", () => {
    const ports = setupPorts();
    queueSearch(ports, []);
    ports.http.queueResponse({ status: 429, headers: { "retry-after": "999" } });

    ensureInvoiceCreated(ports);

    const bill = ports.sheets.getMonthlyBill("A社", "2026-10")!;
    expect(bill.invoice_state).toBe("PENDING");
    expect(bill.state).toBe("LOCKED");
    expect(bill.mf_invoice_id).toBeNull();
    expect(bill.invoice_attempted_at).not.toBeNull(); // 試行時刻は POST 前に保存済み
  });
});

describe("ensureInvoiceCreated — 読み直した行が LOCKED でなくなっていたら書かない", () => {
  it("GET /billings/{id} での照合中に他の実行が状態を進めていたら、書かずに終える", () => {
    const ports = setupPorts({ mf_invoice_id: "INV1" });
    queueDetail(ports, matchingDetail());

    let readCount = 0;
    const original = ports.sheets.getMonthlyBill.bind(ports.sheets);
    ports.sheets.getMonthlyBill = (client, month) => {
      readCount++;
      const row = original(client, month);
      if (readCount === 1 || row === null) {
        return row;
      }
      return { ...row, state: "MF_CREATED" }; // 2 回目以降は既に進んでいたことにする
    };

    let writeCalls = 0;
    const originalUpdate = ports.sheets.updateMonthlyBillColumns.bind(ports.sheets);
    ports.sheets.updateMonthlyBillColumns = (client, month, patch) => {
      writeCalls++;
      originalUpdate(client, month, patch);
    };

    expect(() => ensureInvoiceCreated(ports)).not.toThrow();
    expect(writeCalls).toBe(0);
    expect(ports.slack.posted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// trackBillingStatus（実装設計 §5.7）
// ---------------------------------------------------------------------------

function trackedBill(overrides: Partial<MonthlyBillRow> = {}): FakePorts {
  const ports = makeFakePorts(Date.parse("2026-11-10T10:00:00+09:00"));
  ports.props.set("SLACK_CHANNEL_ID", "C1");
  enableInvoice(ports);
  ports.sheets.monthlyBills.set(
    "A社|2026-10",
    billRow({ state: "MF_CREATED", invoice_state: "CREATED", mf_invoice_id: "INV1", ...overrides }),
  );
  return ports;
}

describe("trackBillingStatus", () => {
  it("MF_CREATED → SENT（email_status: sent）", () => {
    const ports = trackedBill();
    queueDetail(ports, { email_status: "sent" });

    trackBillingStatus(ports);

    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.state).toBe("SENT");
    expect(ports.slack.posted.some((p) => p.text.includes("📤"))).toBe(true);
  });

  it("MF_CREATED → PAID（送付を経ずに入金済み）", () => {
    const ports = trackedBill();
    queueDetail(ports, { payment_status: "2" });

    trackBillingStatus(ports);

    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.state).toBe("PAID");
    expect(ports.slack.posted.some((p) => p.text.includes("💰"))).toBe(true);
  });

  it("SENT → PAID", () => {
    const ports = trackedBill({ state: "SENT" });
    queueDetail(ports, { payment_status: "2" });

    trackBillingStatus(ports);

    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.state).toBe("PAID");
  });

  it("変化が無ければ state 列を書かず、通知もしない", () => {
    const ports = trackedBill();
    queueDetail(ports, {});

    let writeCalls = 0;
    const original = ports.sheets.updateMonthlyBillColumns.bind(ports.sheets);
    ports.sheets.updateMonthlyBillColumns = (client, month, patch) => {
      writeCalls++;
      original(client, month, patch);
    };

    trackBillingStatus(ports);

    expect(writeCalls).toBe(0);
    expect(ports.slack.posted).toHaveLength(0);
  });

  it("日本語ラベル（送付済み）でも SENT に遷移する", () => {
    const ports = trackedBill();
    queueDetail(ports, { email_status: "送付済み" });

    trackBillingStatus(ports);

    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.state).toBe("SENT");
  });

  it("payment_status が数値 2 でも PAID に遷移する", () => {
    const ports = trackedBill();
    queueDetail(ports, { payment_status: 2 });

    trackBillingStatus(ports);

    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.state).toBe("PAID");
  });

  it("フラグ無効なら HTTP 0 件", () => {
    const ports = trackedBill();
    ports.props.set("MF_INVOICE_ENABLED", "false");
    queueDetail(ports, { email_status: "sent" });

    trackBillingStatus(ports);

    expect(ports.http.calls).toHaveLength(0);
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")!.state).toBe("MF_CREATED");
  });
});

// ---------------------------------------------------------------------------
// warnMismatchDaily（実装設計 §5.5）
// ---------------------------------------------------------------------------

describe("warnMismatchDaily", () => {
  it("同じ日に 2 回呼んでも 1 回だけ警告する", () => {
    const ports = makeFakePorts(Date.parse("2026-11-10T10:00:00+09:00"));
    ports.props.set("SLACK_CHANNEL_ID", "C1");
    enableInvoice(ports);
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      billRow({ state: "MF_CREATED", invoice_state: "MISMATCH", mf_invoice_id: "INV1", invoice_error: "報酬額: MF288018 / シート288000" }),
    );

    warnMismatchDaily(ports);
    warnMismatchDaily(ports);

    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.posted[0]!.text).toContain("送付しないでください");
  });

  it("日が変わればもう 1 回警告する", () => {
    const ports = makeFakePorts(Date.parse("2026-11-10T10:00:00+09:00"));
    ports.props.set("SLACK_CHANNEL_ID", "C1");
    enableInvoice(ports);
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      billRow({ state: "MF_CREATED", invoice_state: "MISMATCH", mf_invoice_id: "INV1", invoice_error: "差額あり" }),
    );

    warnMismatchDaily(ports);
    ports.clock.currentMs = Date.parse("2026-11-11T10:00:00+09:00");
    warnMismatchDaily(ports);

    expect(ports.slack.posted).toHaveLength(2);
  });

  it("フラグ無効なら警告しない", () => {
    const ports = makeFakePorts(Date.parse("2026-11-10T10:00:00+09:00"));
    ports.props.set("SLACK_CHANNEL_ID", "C1");
    ports.sheets.monthlyBills.set(
      "A社|2026-10",
      billRow({ state: "MF_CREATED", invoice_state: "MISMATCH", mf_invoice_id: "INV1" }),
    );

    warnMismatchDaily(ports);

    expect(ports.slack.posted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// weeklyInvoiceKeepalive（実装設計 §4.2）
// ---------------------------------------------------------------------------

describe("weeklyInvoiceKeepalive", () => {
  it("GET /office を 1 回呼ぶ", () => {
    const ports = makeFakePorts();
    enableInvoice(ports);
    ports.http.queueResponse({ status: 200, body: JSON.stringify({ name: "サンプル商店" }) });

    weeklyInvoiceKeepalive(ports);

    expect(ports.http.calls).toHaveLength(1);
    expect(ports.http.calls[0]!.url).toBe(OFFICE_URL);
    expect(ports.http.calls[0]!.method).toBe("get");
  });

  it("フラグ無効なら呼ばない", () => {
    const ports = makeFakePorts();

    weeklyInvoiceKeepalive(ports);

    expect(ports.http.calls).toHaveLength(0);
  });
});

describe("絶対期限（実装設計 §6.8、レビュー M4）", () => {
  it("期限切れの実行は、月ごとの処理に手を付けない（HTTP 0 件・状態は変わらない）", () => {
    const ports = setupPorts();
    const deadline = new RunDeadline(ports.clock, 4 * 60 * 1000);
    ports.clock.currentMs += 5 * 60 * 1000;

    ensureInvoiceCreated(ports, deadline);

    expect(ports.http.calls).toHaveLength(0);
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.invoice_state).toBe("PENDING");
  });

  it("請求書の検索ループ（ページ取得）の途中で期限切れ: 結果を『見つからない』と読まず POST せず、状態は変えない", () => {
    const ports = setupPorts();
    const deadline = new RunDeadline(ports.clock, 4 * 60 * 1000);
    // 1 ページ目の取得に 5 分かかったことにする。総ページ数は 3（2 ページ目以降がある）。
    ports.http.fetch = (req) => {
      ports.http.calls.push(req);
      ports.clock.currentMs += 5 * 60 * 1000;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ data: [], pagination: { total_count: 0, total_pages: 3, per_page: 100, current_page: 1 } }),
      };
    };

    expect(() => ensureInvoiceCreated(ports, deadline)).not.toThrow();

    expect(ports.http.calls.filter((c) => c.method === "get" && c.url.includes("/billings"))).toHaveLength(1);
    expect(ports.http.calls.some((c) => c.method === "post")).toBe(false);
    expect(ports.sheets.getMonthlyBill("A社", "2026-10")?.invoice_state).toBe("PENDING");
    // lease は解放されている（次回すぐ続きを処理できる）。
    expect(ports.sheets.getInternalValue("lease", "mf_invoice/A社:2026-10")).toBe("0");
  });

  it("trackBillingStatus も期限切れなら何もしない", () => {
    const ports = trackedBill();
    const deadline = new RunDeadline(ports.clock, 4 * 60 * 1000);
    ports.clock.currentMs += 5 * 60 * 1000;

    trackBillingStatus(ports, deadline);

    expect(ports.http.calls).toHaveLength(0);
  });
});
