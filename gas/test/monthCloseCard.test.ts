/**
 * `core/card.ts` の月次締め確認カード（`renderMonthCloseCard` 等）のテスト
 * （実装設計 MF連携 §5.2, §5.3, §11.2 WP-M2 受入条件）。
 */
import { describe, expect, it } from "vitest";
import {
  renderMonthCloseBlockedCard,
  renderMonthCloseCard,
  renderMonthCloseInvoiceStatusCard,
  renderMonthCloseLockedCard,
  type MonthCloseCardInput,
} from "../src/core/card";

interface Block {
  block_id?: string;
  type: string;
  text?: { text?: string };
  elements?: Array<{ action_id?: string; value?: string; text?: { text?: string } }>;
  [key: string]: unknown;
}

function actionsBlock(blocks: object[]): Block | undefined {
  return (blocks as Block[]).find((b) => b.block_id === "actions");
}

function baseInput(overrides: Partial<MonthCloseCardInput> = {}): MonthCloseCardInput {
  return {
    client: "A社",
    month: "2026-10",
    hours: 160.25,
    unit_price: 1800,
    amount: 288450,
    tax_amount: 28845,
    withholding_amount: 0,
    net_amount: 317295,
    due_date: "2026-11-30",
    invoiceEnabled: true,
    ...overrides,
  };
}

describe("renderMonthCloseCard", () => {
  it("設計書 §5.2 の見た目どおりの文言を含む", () => {
    const blocks = renderMonthCloseCard(baseInput());
    const text = JSON.stringify(blocks);
    expect(text).toContain("2026年10月分の締め確認（A社）");
    expect(text).toContain("160.25 時間");
    expect(text).toContain("1,800 円");
    expect(text).toContain("288,450円");
    expect(text).toContain("28,845円");
    expect(text).toContain("0円");
    expect(text).toContain("317,295円");
    expect(text).toContain("2026-11-30（月）");
  });

  it("action_id: kado_month_close、value に {client,month,net_amount} の JSON を持つ", () => {
    const blocks = renderMonthCloseCard(baseInput());
    const actions = actionsBlock(blocks);
    expect(actions).toBeDefined();
    const el = actions?.elements?.[0];
    expect(el?.action_id).toBe("kado_month_close");
    expect(JSON.parse(el?.value ?? "{}")).toEqual({ client: "A社", month: "2026-10", net_amount: 317295 });
  });

  it("MF_INVOICE_ENABLED 有効: ボタン文言は「締めて請求書を作成」", () => {
    const blocks = renderMonthCloseCard(baseInput({ invoiceEnabled: true }));
    const el = actionsBlock(blocks)?.elements?.[0];
    expect(el?.text?.text).toBe("締めて請求書を作成");
  });

  it("MF_INVOICE_ENABLED 無効: ボタン文言は「締める（請求書は手動で作成）」", () => {
    const blocks = renderMonthCloseCard(baseInput({ invoiceEnabled: false }));
    const el = actionsBlock(blocks)?.elements?.[0];
    expect(el?.text?.text).toBe("締める（請求書は手動で作成）");
  });

  it("amountChanged: true で「金額が変わりました」の警告ブロックを追加する", () => {
    const withWarning = renderMonthCloseCard(baseInput({ amountChanged: true }));
    const withoutWarning = renderMonthCloseCard(baseInput({ amountChanged: false }));
    expect(JSON.stringify(withWarning)).toContain("金額が変わりました");
    expect(JSON.stringify(withoutWarning)).not.toContain("金額が変わりました");
    // 金額が変わっても押し直せるよう、ボタンは残っている。
    expect(actionsBlock(withWarning)?.elements?.[0]?.action_id).toBe("kado_month_close");
  });
});

describe("renderMonthCloseBlockedCard", () => {
  it("要修正ありの文言を含み、ボタンは無い", () => {
    const blocks = renderMonthCloseBlockedCard({ client: "A社", month: "2026-10" });
    const text = JSON.stringify(blocks);
    expect(text).toContain("要修正があります");
    expect(actionsBlock(blocks)).toBeUndefined();
  });
});

describe("renderMonthCloseLockedCard", () => {
  it("invoiceState: PENDING は「請求書を作成しています…」", () => {
    const blocks = renderMonthCloseLockedCard({ client: "A社", month: "2026-10", invoiceState: "PENDING" });
    expect(JSON.stringify(blocks)).toContain("🔒 締めました。請求書を作成しています…");
  });

  it("invoiceState: MANUAL は「請求書は手動で作成してください」", () => {
    const blocks = renderMonthCloseLockedCard({ client: "A社", month: "2026-10", invoiceState: "MANUAL" });
    expect(JSON.stringify(blocks)).toContain("🔒 締めました。請求書は手動で作成してください。");
  });

  it("ボタンは無い（締め済みのため）", () => {
    const blocks = renderMonthCloseLockedCard({ client: "A社", month: "2026-10", invoiceState: "PENDING" });
    expect(actionsBlock(blocks)).toBeUndefined();
  });
});

describe("renderMonthCloseInvoiceStatusCard（実装設計 MF連携 §5.5, §5.7, WP-M3）", () => {
  it("state: MF_CREATED, invoiceState: CREATED は「作成しました（未送付）」", () => {
    const blocks = renderMonthCloseInvoiceStatusCard({
      client: "A社",
      month: "2026-10",
      state: "MF_CREATED",
      invoiceState: "CREATED",
    });
    const text = JSON.stringify(blocks);
    expect(text).toContain("✅");
    expect(text).toContain("未送付");
    expect(text).toContain("2026年10月分の締め確認（A社）");
    expect(actionsBlock(blocks)).toBeUndefined();
  });

  it("state: MF_CREATED, invoiceState: MISMATCH は「送付しないでください」", () => {
    const blocks = renderMonthCloseInvoiceStatusCard({
      client: "A社",
      month: "2026-10",
      state: "MF_CREATED",
      invoiceState: "MISMATCH",
    });
    expect(JSON.stringify(blocks)).toContain("送付しないでください");
  });

  it("state: MF_CREATED, invoiceState: UNKNOWN は「確認できません」", () => {
    const blocks = renderMonthCloseInvoiceStatusCard({
      client: "A社",
      month: "2026-10",
      state: "MF_CREATED",
      invoiceState: "UNKNOWN",
    });
    expect(JSON.stringify(blocks)).toContain("確認できません");
  });

  it("state: MF_CREATED, invoiceState: ERROR は「エラーが発生しました」", () => {
    const blocks = renderMonthCloseInvoiceStatusCard({
      client: "A社",
      month: "2026-10",
      state: "MF_CREATED",
      invoiceState: "ERROR",
    });
    expect(JSON.stringify(blocks)).toContain("エラーが発生しました");
  });

  it("state: SENT は「送付済み」", () => {
    const blocks = renderMonthCloseInvoiceStatusCard({
      client: "A社",
      month: "2026-10",
      state: "SENT",
      invoiceState: "CREATED",
    });
    expect(JSON.stringify(blocks)).toContain("📤");
    expect(JSON.stringify(blocks)).toContain("送付済み");
  });

  it("state: PAID は「入金を確認しました」", () => {
    const blocks = renderMonthCloseInvoiceStatusCard({
      client: "A社",
      month: "2026-10",
      state: "PAID",
      invoiceState: "CREATED",
    });
    expect(JSON.stringify(blocks)).toContain("💰");
    expect(JSON.stringify(blocks)).toContain("入金を確認しました");
  });
});
