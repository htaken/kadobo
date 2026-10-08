/**
 * `app/journalSync.ts` の WP-M5（③ 連携カード・口座の明細との照合・明細ルール・`JOURNALIZING` の回収・
 * `PUT` による訂正取消・週次報告。実装設計 MF連携 §6.5〜§6.8, §11.2 WP-M5 受入条件）のテスト。
 * 会計 API は `mf/fakeMfAccounting.ts` の簡易フェイクサーバ（ID はパーセントエンコード済みの文字列。
 * クエリの ID は返された文字列そのままでないと 400、パスの ID は 1 回エンコード。S-M4・S-M5 の実測）。
 */
import { describe, expect, it } from "vitest";
import { syncExpenses, weeklyJournalReport } from "../../src/app/journalSync";
import { RunDeadline } from "../../src/app/mf/deadline";
import type { ExpenseLedgerRow } from "../../src/app/ports";
import type { MfTransactionRule } from "../../src/core/journalSync";
import { makeFakePorts, type FakePorts } from "./fakes";
import {
  BANK_SERVICE_ID,
  CARD_SERVICE_ID,
  accountIdOf,
  accountingCallsOf,
  installFakeMfAccounting,
  type FakeMfAccounting,
  type FakeTransaction,
} from "./mf/fakeMfAccounting";

const NOW = Date.parse("2026-10-20T12:00:00+09:00");
const START = "2026-10-01";

function expenseRow(id: string, o: Partial<ExpenseLedgerRow> = {}): ExpenseLedgerRow {
  return {
    receipt_id: id,
    receipt_type: "paper",
    date: "2026-10-10",
    amount: 1200,
    partner: "○○商店",
    category: "消耗品費",
    memo: "",
    drive_link: "https://drive.example.test/f1",
    file_hash: "h",
    mime_type: "image/jpeg",
    size: 10,
    input_at: NOW - 1_000_000,
    state: "COMPLETED",
    mf_journal_id: null,
    idempotency_key: `K-${id}`,
    slack_file_id: "F1",
    drive_file_id: "D1",
    original_file_name: "r.jpg",
    last_error: null,
    state_updated_at: NOW - 1_000_000,
    tax_category: "",
    business_use_ratio: 100,
    correction_of_receipt_id: null,
    correction_reason: null,
    payment_method: "linked_card",
    mf_transaction_id: null,
    mf_sync_state: "WAITING_TRANSACTION",
    mf_sync_error: null,
    mf_sync_updated_at: null,
    mf_sync_attempted_at: null,
    mf_sync_input: "",
    ...o,
  };
}

function nisaRule(o: Partial<MfTransactionRule> = {}): MfTransactionRule {
  return {
    name: "NISA クレカ積立",
    target: "card",
    content: "SBI証券投信積立",
    amount: 10000,
    action: "私用として仕訳",
    account: "事業主貸",
    enabled: true,
    ...o,
  };
}

function debitRule(o: Partial<MfTransactionRule> = {}): MfTransactionRule {
  return {
    name: "カード代金引落し",
    target: "bank",
    content: "ミツイスミトモカ",
    amount: null,
    action: "無視",
    account: "",
    enabled: true,
    ...o,
  };
}

interface Env {
  ports: FakePorts;
  api: FakeMfAccounting;
  lockViolations: string[];
}

function setup(flags: { mf?: boolean; match?: boolean; journal?: boolean; services?: "both" | "none" | "card" } = {}): Env {
  const ports = makeFakePorts(NOW);
  const api = installFakeMfAccounting(ports);
  if (flags.mf !== false) {
    ports.props.set("MF_ENABLED", "true");
  }
  if (flags.match !== false) {
    ports.props.set("MF_MATCH_ENABLED", "true");
  }
  if (flags.journal === true) {
    ports.props.set("MF_JOURNAL_ENABLED", "true");
  }
  ports.props.set("MF_SYNC_START_DATE", START);
  ports.props.set("SLACK_CHANNEL_ID", "C1");
  ports.props.set("SLACK_USER_ID", "U1");
  const services = flags.services ?? "both";
  if (services !== "none") {
    ports.props.set("MF_CARD_ACCOUNT_IDS", CARD_SERVICE_ID);
  }
  if (services === "both") {
    ports.props.set("MF_BANK_ACCOUNT_IDS", BANK_SERVICE_ID);
  }
  ports.sheets.mfRules = [];
  const lockViolations: string[] = [];
  api.onRequest = (req) => {
    if (ports.lock.held) {
      lockViolations.push(`HTTP ${req.method} ${req.url}`);
    }
  };
  const origPost = ports.slack.postMessage.bind(ports.slack);
  ports.slack.postMessage = (input) => {
    if (ports.lock.held) {
      lockViolations.push(`Slack ${input.text}`);
    }
    return origPost(input);
  };
  return { ports, api, lockViolations };
}

function add(ports: FakePorts, id: string, o: Partial<ExpenseLedgerRow> = {}): void {
  ports.sheets.appendExpense(expenseRow(id, o));
}

function get(ports: FakePorts, id: string): ExpenseLedgerRow {
  const r = ports.sheets.getExpenseByReceiptId(id);
  if (r === null) {
    throw new Error(`row not found: ${id}`);
  }
  return r;
}

function posted(ports: FakePorts): string[] {
  return ports.slack.posted.map((p) => p.text);
}

function journalizeCount(ports: FakePorts): number {
  return accountingCallsOf(ports).filter((c) => c === "POST /transactions/journalize").length;
}

function urls(ports: FakePorts, contains: string): string[] {
  return ports.http.calls.filter((c) => c.url.includes(contains)).map((c) => c.url);
}

function txOf(api: FakeMfAccounting, partial: Partial<FakeTransaction> = {}): FakeTransaction {
  return api.plantTransaction({ date: "2026-10-10", value: 1200, ...partial });
}

/** 明細から作った仕訳（連携明細の仕訳）を MF 側に置く。明細は仕訳済みにする。 */
function plantLinkedJournal(
  api: FakeMfAccounting,
  o: { tx?: Partial<FakeTransaction>; receiptId?: string; value?: number; date?: string } = {},
) {
  const value = o.value ?? 1200;
  const tx = api.plantTransaction({ date: o.date ?? "2026-10-10", value, journalizing_status: "registered", ...o.tx });
  const journal = api.plantJournal({
    transaction_date: o.date ?? "2026-10-10",
    tags: [o.receiptId ?? "R-1"],
    memo: "https://drive.example.test/f1",
    transaction_id: tx.id,
    branches: [
      {
        debitor: { account_id: accountIdOf("消耗品費"), value },
        creditor: { account_id: accountIdOf("未払金"), value },
        remark: `${o.receiptId ?? "R-1"} ○○商店`,
      },
    ],
  });
  return { tx, journal };
}

// ---------------------------------------------------------------------------

describe("フラグ・設定（§9）", () => {
  it("MF_ENABLED が無効なら HTTP 0 件（待ち行・JOURNALIZING・取消対象があっても）", () => {
    const { ports, api } = setup({ mf: false });
    ports.sheets.mfRules = [nisaRule()];
    txOf(api);
    add(ports, "R-1");
    add(ports, "R-2", { mf_sync_state: "JOURNALIZING", mf_transaction_id: "t%3D" });
    add(ports, "R-3", { state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: "j%3D", mf_transaction_id: "t2%3D" });

    syncExpenses(ports);
    weeklyJournalReport(ports);

    expect(ports.http.calls).toHaveLength(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
    expect(get(ports, "R-3").mf_sync_state).toBe("SYNCED");
  });

  it("MF_MATCH_ENABLED が無効（MF_JOURNAL_ENABLED だけ有効）なら ③ の新規は動かない。GET /transactions も呼ばない", () => {
    const { ports, api } = setup({ match: false, journal: true });
    ports.sheets.mfRules = [nisaRule()];
    txOf(api);
    txOf(api, { value: 10000, content: "SBI証券投信積立サービス" });
    add(ports, "R-1");

    syncExpenses(ports);

    expect(accountingCallsOf(ports).filter((c) => c.includes("/transactions"))).toEqual([]);
    expect(get(ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
  });

  it("MF_CARD_ACCOUNT_IDS・MF_BANK_ACCOUNT_IDS のどちらも無ければ ③ を実行しない（HTTP 0 件）", () => {
    const { ports, api } = setup({ services: "none" });
    ports.sheets.mfRules = [nisaRule()];
    txOf(api);
    add(ports, "R-1");

    syncExpenses(ports);

    expect(ports.http.calls).toHaveLength(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
  });

  it("MF_ENABLED だけ有効: 回収（JOURNALIZING）と PUT による取消は動き、ルール適用・照合・journalize は動かない", () => {
    const { ports, api } = setup({ match: false });
    ports.sheets.mfRules = [nisaRule()];
    txOf(api, { value: 10000, content: "SBI証券投信積立サービス" });
    txOf(api, { value: 777 });
    add(ports, "R-WAIT", { amount: 777 });
    // 回収: JOURNALIZING で MF に仕訳がある。
    const a = plantLinkedJournal(api, { receiptId: "R-A" });
    add(ports, "R-A", { mf_sync_state: "JOURNALIZING", mf_transaction_id: a.tx.id });
    // 取消: SYNCED の連携行が VOID。
    const b = plantLinkedJournal(api, { receiptId: "R-B", value: 500 });
    add(ports, "R-B", { amount: 500, state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: b.journal.id, mf_transaction_id: b.tx.id });

    syncExpenses(ports);

    expect(get(ports, "R-A")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: a.journal.id });
    expect(get(ports, "R-B").mf_sync_state).toBe("REVERSED");
    expect(api.putBodies).toHaveLength(1);
    expect(journalizeCount(ports)).toBe(0);
    expect(ports.http.calls.some((c) => c.url.includes("/transactions?"))).toBe(false);
    expect(get(ports, "R-WAIT").mf_sync_state).toBe("WAITING_TRANSACTION");
  });
});

describe("明細の取得（§6.5）", () => {
  it("連携サービスごとに GET /transactions。connected_account_id は raw（1 回エンコードしない）、side=EXPENSE・journalizing_statuses=none・order=desc・per_page=500", () => {
    const { ports, api } = setup();
    txOf(api, { connected_account_id: CARD_SERVICE_ID });
    add(ports, "R-1");

    syncExpenses(ports);

    const list = urls(ports, "/transactions?");
    expect(list).toHaveLength(2); // カード・口座
    for (const u of list) {
      expect(u).toContain("side=EXPENSE");
      expect(u).toContain("journalizing_statuses=none");
      expect(u).toContain("order=desc");
      expect(u).toContain("per_page=500");
      expect(u).not.toContain("%25"); // 1 回エンコードした形は 400 になる（S-M4）
    }
    expect(list.some((u) => u.includes(`connected_account_id=${CARD_SERVICE_ID}`))).toBe(true);
    expect(list.some((u) => u.includes(`connected_account_id=${BANK_SERVICE_ID}`))).toBe(true);
    // フェイクはエンコードされた値を 400 にする。400 になっていれば明細は取れず、照合も進まない。
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
  });

  it("フェイクは、1 回エンコードした connected_account_id を 400 にする（raw でなければ照合できない前提の確認）", () => {
    const { ports, api } = setup();
    txOf(api);
    const bad = `https://api-accounting.moneyforward.com/api/v3/transactions?office_code=1234-5678&connected_account_id=${encodeURIComponent(CARD_SERVICE_ID)}&start_date=2026-10-01&end_date=2026-10-20`;
    const res = ports.http.fetch({ method: "get", url: bad, headers: {} });
    expect(res.status).toBe(400);
  });

  it("期間は「待ち行の日付の最小値 − 3 日〜今日」。ただし開業日より前には遡らない", () => {
    const { ports } = setup();
    ports.sheets.mfRules = [];
    add(ports, "R-1", { date: "2026-10-15" });
    add(ports, "R-2", { date: "2026-10-02" });
    // 今日 − 45 日（09-05）は開業日より前、最小の待ち行 10-02 − 3 日 = 09-29 も開業日より前 → 開業日で切る。
    syncExpenses(ports);
    for (const u of urls(ports, "/transactions?")) {
      expect(u).toContain("start_date=2026-10-01");
      expect(u).toContain("end_date=2026-10-20");
    }
  });

  it("待ち行が新しいときは今日 − 45 日（明細ルールは待ち行が無くても適用する）まで遡る。開業日より後ならそのまま", () => {
    const { ports } = setup();
    ports.clock.currentMs = Date.parse("2026-12-20T12:00:00+09:00");
    add(ports, "R-1", { date: "2026-12-18" });
    syncExpenses(ports);
    for (const u of urls(ports, "/transactions?")) {
      expect(u).toContain("start_date=2026-11-05"); // 12-20 − 45 日
      expect(u).toContain("end_date=2026-12-20");
    }
    // 待ち行がもっと古ければ「その日 − 3 日」まで。
    const e2 = setup();
    e2.ports.clock.currentMs = Date.parse("2026-12-20T12:00:00+09:00");
    add(e2.ports, "R-1", { date: "2026-10-20" });
    syncExpenses(e2.ports);
    for (const u of urls(e2.ports, "/transactions?")) {
      expect(u).toContain("start_date=2026-10-17");
    }
  });

  it("366 日を超える期間は分割して呼ぶ（各区間の差は 366 日以内。連続していて抜けない）。開業日より前には遡らない", () => {
    const { ports, api } = setup();
    ports.clock.currentMs = Date.parse("2027-12-01T12:00:00+09:00");
    add(ports, "R-1", { date: "2026-10-05" });
    txOf(api, { date: "2026-10-06" }); // 古い明細も 2 区間目以前で取れる
    syncExpenses(ports);

    const card = urls(ports, `connected_account_id=${CARD_SERVICE_ID}`).map((u) => ({
      start: /start_date=([^&]*)/.exec(u)?.[1] as string,
      end: /end_date=([^&]*)/.exec(u)?.[1] as string,
    }));
    expect(card).toEqual([
      { start: "2026-10-02", end: "2027-10-03" },
      { start: "2027-10-04", end: "2027-12-01" },
    ]);
    for (const r of card) {
      expect((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000).toBeLessThanOrEqual(366);
      expect(r.start >= START).toBe(true);
    }
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED"); // 分割しても明細を見つけて照合できる
  });

  it("date < MF_SYNC_START_DATE の明細は捨てる（照合にも明細ルールにも使わない）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule({ amount: null })];
    txOf(api, { date: "2026-09-30", value: 1200 });
    txOf(api, { date: "2026-09-13", value: 10000, content: "SBI証券投信積立サービス" });
    add(ports, "R-1", { date: "2026-10-01" });

    syncExpenses(ports);

    expect(journalizeCount(ports)).toBe(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
  });

  it("連携サービス ID を MF が拒否（400）したら ③ をその実行で止め、運用者に 1 日 1 回 DM する（例外にしない）", () => {
    const { ports, api } = setup();
    api.knownServices.delete(CARD_SERVICE_ID);
    api.knownServices.delete(BANK_SERVICE_ID);
    add(ports, "R-1");

    expect(() => syncExpenses(ports)).not.toThrow();
    syncExpenses(ports);

    expect(ports.slack.dms).toHaveLength(1);
    expect(ports.slack.dms[0]!.text).toContain("MF_CARD_ACCOUNT_IDS");
    expect(get(ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
  });
});

describe("照合と journalize（§6.5）", () => {
  it("一対一なら確定: 本文（transaction_date は経費台帳の日付・remark・memo・tags・tax_id なし）、SYNCED・MF仕訳ID・MF明細ID・入力要約", () => {
    const { ports, api, lockViolations } = setup();
    const tx = txOf(api, { date: "2026-10-13" }); // 経費の日付 10-10 とは違う（カードの利用日 / 経費の取引日の差）
    add(ports, "R-1", { date: "2026-10-10", category: "通信費" });

    syncExpenses(ports);

    expect(api.journalizeBodies).toEqual([
      {
        transaction_id: tx.id,
        transaction_date: "2026-10-10",
        account_id: accountIdOf("通信費"),
        remark: "R-1 ○○商店",
        memo: "https://drive.example.test/f1",
        tags: ["R-1"],
      },
    ]);
    const payload = ports.http.calls.find((c) => c.url.includes("/transactions/journalize"))?.payload ?? "";
    expect(payload).not.toContain("tax_id");
    expect(payload).not.toContain("invoice_kind");
    const row = get(ports, "R-1");
    expect(row.mf_sync_state).toBe("SYNCED");
    expect(row.mf_transaction_id).toBe(tx.id);
    expect(row.mf_journal_id).toBe(api.journals[0]!.id);
    expect(row.mf_sync_input).toBe(`1200|2026-10-10|通信費|linked_card|${tx.id}`);
    expect(row.mf_sync_attempted_at).not.toBeNull();
    expect(row.mf_sync_attempted_at!).toBeGreaterThanOrEqual(NOW);
    expect(row.mf_sync_error).toBeNull();
    expect(lockViolations).toEqual([]);
    // 二度目の実行では何も作らない（明細は仕訳済み）。
    syncExpenses(ports);
    expect(journalizeCount(ports)).toBe(1);
  });

  it("MF明細ID・JOURNALIZING・試行時刻・入力要約を journalize の前に保存する（B3）", () => {
    const { ports, api } = setup();
    const tx = txOf(api);
    add(ports, "R-1");
    let atPost: ExpenseLedgerRow | null = null;
    const prev = api.onRequest;
    api.onRequest = (req) => {
      prev?.(req);
      if (req.url.includes("/transactions/journalize")) {
        atPost = get(ports, "R-1");
      }
    };

    syncExpenses(ports);

    expect(atPost).not.toBeNull();
    const snap = atPost as unknown as ExpenseLedgerRow;
    expect(snap.mf_sync_state).toBe("JOURNALIZING");
    expect(snap.mf_transaction_id).toBe(tx.id);
    expect(snap.mf_sync_attempted_at).not.toBeNull();
    expect(snap.mf_sync_input).toBe(`1200|2026-10-10|消耗品費|linked_card|${tx.id}`);
  });

  it("支払方法と連携サービスの対応: 口座の行は口座の明細だけ、カードの行はカードの明細だけを候補にする", () => {
    const { ports, api } = setup();
    txOf(api, { connected_account_id: CARD_SERVICE_ID, value: 1200 });
    add(ports, "R-B", { payment_method: "linked_bank" });

    syncExpenses(ports);
    expect(get(ports, "R-B").mf_sync_state).toBe("WAITING_TRANSACTION");
    expect(journalizeCount(ports)).toBe(0);

    const bankTx = txOf(api, { connected_account_id: BANK_SERVICE_ID, value: 1200 });
    syncExpenses(ports);
    expect(get(ports, "R-B")).toMatchObject({ mf_sync_state: "SYNCED", mf_transaction_id: bankTx.id });
  });

  it("候補が複数 → NEEDS_REVIEW。MF連携エラーに「候補 n 件」、Slack に候補（明細 ID・日付・内容・金額）を 1 回だけ出す", () => {
    const { ports, api } = setup();
    const t1 = txOf(api, { date: "2026-10-10", content: "店A" });
    const t2 = txOf(api, { date: "2026-10-12", content: "店B" });
    add(ports, "R-1");

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "NEEDS_REVIEW" });
    expect(get(ports, "R-1").mf_sync_error).toContain("候補 2 件");
    expect(journalizeCount(ports)).toBe(0);
    const msgs = posted(ports);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain(t1.id);
    expect(msgs[0]).toContain(t2.id);
    expect(msgs[0]).toContain("店A");
    expect(msgs[0]).toContain("2026-10-12");
    expect(msgs[0]).toContain("1,200円");
    expect(msgs[0]).toContain("MF明細ID");

    syncExpenses(ports);
    syncExpenses(ports);
    expect(posted(ports)).toHaveLength(1); // 通知は 1 回だけ
  });

  it("取り合い（2 行が同じ 1 件の明細を候補にする）→ 両方 NEEDS_REVIEW（候補 1 件）。どちらにも仕訳しない", () => {
    const { ports, api } = setup();
    txOf(api);
    add(ports, "R-1", { date: "2026-10-10" });
    add(ports, "R-2", { date: "2026-10-11" });

    syncExpenses(ports);

    for (const id of ["R-1", "R-2"]) {
      expect(get(ports, id).mf_sync_state).toBe("NEEDS_REVIEW");
      expect(get(ports, id).mf_sync_error).toContain("候補 1 件");
    }
    expect(journalizeCount(ports)).toBe(0);
  });

  it("バッチ（20 行）の外にある行との取り合いも見る。取り合いの 2 行は仕訳されず、残りは予算の 20 件まで", () => {
    const { ports, api } = setup();
    for (let i = 1; i <= 24; i++) {
      const id = `R-${String(i).padStart(2, "0")}`;
      add(ports, id, { amount: 1000 + i });
      txOf(api, { value: 1000 + i });
    }
    add(ports, "R-25", { amount: 1001 }); // R-01 と同じ金額・日付 → 明細を取り合う

    syncExpenses(ports);

    expect(get(ports, "R-01").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(get(ports, "R-25").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(journalizeCount(ports)).toBe(20); // 取り合いの 2 行を除く 23 行のうち、予算（API を呼ぶ行 20）まで
    expect(ports.sheets.getAllExpenses().filter((r) => r.mf_sync_state === "SYNCED")).toHaveLength(20);
    // 次回の実行が続きを処理する。
    syncExpenses(ports);
    expect(ports.sheets.getAllExpenses().filter((r) => r.mf_sync_state === "SYNCED")).toHaveLength(23);
  });

  it("使用中の明細は候補にしない（NEEDS_REVIEW の行が MF明細ID で押さえている）。手放した明細（REVERSED の行）は候補になる", () => {
    const e1 = setup();
    const tx1 = txOf(e1.api);
    add(e1.ports, "R-OWN", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: tx1.id, amount: 5, date: "2026-10-09" }); // 金額違いで検証に通らない
    add(e1.ports, "R-1");
    syncExpenses(e1.ports);
    expect(get(e1.ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
    expect(journalizeCount(e1.ports)).toBe(0);

    const e2 = setup();
    const tx2 = txOf(e2.api);
    add(e2.ports, "R-OLD", { mf_sync_state: "REVERSED", mf_transaction_id: tx2.id });
    add(e2.ports, "R-1");
    syncExpenses(e2.ports);
    expect(get(e2.ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_transaction_id: tx2.id });
  });

  it("日付幅は日付 − 2 日〜日付 + 5 日", () => {
    const e = setup();
    txOf(e.api, { date: "2026-10-07", value: 1 });
    txOf(e.api, { date: "2026-10-08", value: 2 });
    txOf(e.api, { date: "2026-10-15", value: 3 });
    txOf(e.api, { date: "2026-10-16", value: 4 });
    for (const [i, amount] of [1, 2, 3, 4].entries()) {
      add(e.ports, `R-${i + 1}`, { amount, date: "2026-10-10" });
    }
    syncExpenses(e.ports);
    expect(["R-1", "R-2", "R-3", "R-4"].map((id) => get(e.ports, id).mf_sync_state)).toEqual([
      "WAITING_TRANSACTION",
      "SYNCED",
      "SYNCED",
      "WAITING_TRANSACTION",
    ]);
  });

  it("訂正後の新しい行は、訂正元の行が仕訳を持つ間は照合に出ない（同じ金額の別の明細を取らない）", () => {
    const { ports, api } = setup();
    const a = plantLinkedJournal(api, { receiptId: "R-OLD" });
    const other = txOf(api, { date: "2026-10-11" }); // 同じ金額の別の未仕訳明細
    add(ports, "R-OLD", { state: "COMPLETED", mf_sync_state: "SYNCED", mf_journal_id: a.journal.id, mf_transaction_id: a.tx.id });
    add(ports, "R-NEW", { correction_of_receipt_id: "R-OLD" });

    syncExpenses(ports);

    expect(get(ports, "R-NEW").mf_sync_state).toBe("WAITING_TRANSACTION");
    expect(get(ports, "R-NEW").mf_transaction_id).toBeNull();
    expect(other.journalizing_status).toBe("none");
    expect(journalizeCount(ports)).toBe(0);
  });

  it("14 日たっても候補が 0 件の行は 1 回だけ通知する（14 日未満は通知しない）", () => {
    const { ports } = setup();
    add(ports, "R-OLD", { date: "2026-10-05" }); // 今日 10-20 まで 15 日
    add(ports, "R-NEW", { date: "2026-10-10" }); // 10 日

    syncExpenses(ports);
    syncExpenses(ports);

    const msgs = posted(ports);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("R-OLD");
    expect(msgs[0]).toContain("外貨換算");
    expect(get(ports, "R-OLD").mf_sync_state).toBe("WAITING_TRANSACTION");

    ports.clock.currentMs = Date.parse("2026-10-25T12:00:00+09:00");
    syncExpenses(ports);
    expect(posted(ports)).toHaveLength(2); // 10-10 の行は 15 日たったので、ここで 1 回通知される
    syncExpenses(ports);
    expect(posted(ports)).toHaveLength(2);
  });

  it("journalize が 429 なら状態は JOURNALIZING のまま例外を投げ、次回の回収で未仕訳なら送り直す（二重にならない）", () => {
    const { ports, api } = setup();
    txOf(api);
    add(ports, "R-1");
    api.postMode = "rate_limit";
    api.postModeRemaining = 1;

    expect(() => syncExpenses(ports)).toThrow();
    expect(get(ports, "R-1").mf_sync_state).toBe("JOURNALIZING");

    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
    expect(api.journals).toHaveLength(1);
  });
});

describe("JOURNALIZING の回収（§6.5。MF_ENABLED だけで動く）", () => {
  it("経路 1: 明細 ID で仕訳が見つかる → MF仕訳ID を書いて SYNCED。transaction_ids は raw で URL に入る", () => {
    const { ports, api } = setup({ match: false });
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-1" });
    add(ports, "R-1", {
      mf_sync_state: "JOURNALIZING",
      mf_transaction_id: tx.id,
      mf_sync_input: `1200|2026-10-10|消耗品費|linked_card|${tx.id}`,
    });

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: journal.id });
    const u = urls(ports, "/journals?").find((x) => x.includes("transaction_ids="));
    expect(u).toBeDefined();
    expect(u).toContain(`transaction_ids=${tx.id}`);
    expect(u).not.toContain("%25");
    expect(u).toContain("start_date=2026-10-09");
    expect(u).toContain("end_date=2026-10-11");
    expect(journalizeCount(ports)).toBe(0);
  });

  it("経路 2: 見つからず明細が未仕訳のまま → journalize をやり直して SYNCED", () => {
    const { ports, api } = setup({ match: false });
    const tx = txOf(api);
    add(ports, "R-1", {
      mf_sync_state: "JOURNALIZING",
      mf_transaction_id: tx.id,
      mf_sync_input: `1200|2026-10-10|消耗品費|linked_card|${tx.id}`,
    });

    syncExpenses(ports);

    expect(journalizeCount(ports)).toBe(1);
    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: api.journals[0]!.id });
    expect(tx.journalizing_status).toBe("registered");
  });

  it("NEEDS_REVIEW にした回収の理由は、人が MF明細ID を書き直すまで上書きしない（kadobo が押さえた明細 ID を人の記入として検証し直さない）", () => {
    const { ports, api } = setup();
    const tx = txOf(api, { journalizing_status: "registered" });
    add(ports, "R-1", {
      mf_sync_state: "JOURNALIZING",
      mf_transaction_id: tx.id,
      mf_sync_input: `1200|2026-10-10|消耗品費|linked_card|${tx.id}`,
    });

    syncExpenses(ports);
    const reason = get(ports, "R-1").mf_sync_error;
    syncExpenses(ports);
    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(get(ports, "R-1").mf_sync_error).toBe(reason);
    expect(reason).toContain("registered");
    expect(posted(ports)).toHaveLength(1);
  });

  it("経路 3: 見つからず、明細は仕訳済みなのに kadobo の検索で仕訳が無い → NEEDS_REVIEW（Slack で案内）", () => {
    const { ports, api } = setup({ match: false });
    const tx = txOf(api, { journalizing_status: "registered" });
    add(ports, "R-1", {
      mf_sync_state: "JOURNALIZING",
      mf_transaction_id: tx.id,
      mf_sync_input: `1200|2026-10-10|消耗品費|linked_card|${tx.id}`,
    });

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(get(ports, "R-1").mf_sync_error).toContain("registered");
    expect(journalizeCount(ports)).toBe(0);
    expect(posted(ports)).toHaveLength(1);
  });

  it("明細が一覧に見つからない（削除された等）→ NEEDS_REVIEW。MF明細ID が空の JOURNALIZING も NEEDS_REVIEW", () => {
    const e = setup({ match: false });
    const tx = txOf(e.api);
    e.api.transactions.splice(0, 1); // 一覧から消す
    add(e.ports, "R-1", { mf_sync_state: "JOURNALIZING", mf_transaction_id: tx.id });
    add(e.ports, "R-2", { mf_sync_state: "JOURNALIZING", mf_transaction_id: null });
    syncExpenses(e.ports);
    expect(get(e.ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(get(e.ports, "R-1").mf_sync_error).toContain("見つかりません");
    expect(get(e.ports, "R-2").mf_sync_state).toBe("NEEDS_REVIEW");
  });

  it("journalize の成功 → 応答喪失（500）→ JOURNALIZING のまま、この実行では他に作らない → 次回の回収で SYNCED（二重作成しない）", () => {
    const { ports, api } = setup();
    txOf(api, { value: 1200 });
    txOf(api, { value: 3000 });
    add(ports, "R-1");
    add(ports, "R-2", { amount: 3000 });
    api.postMode = "created_but_500";
    api.postModeRemaining = 1;

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("JOURNALIZING");
    expect(get(ports, "R-2").mf_sync_state).toBe("WAITING_TRANSACTION"); // 結果不明の後は作らない
    expect(journalizeCount(ports)).toBe(1);

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: api.journals[0]!.id });
    expect(get(ports, "R-2").mf_sync_state).toBe("SYNCED");
    expect(api.journals).toHaveLength(2);
    expect(journalizeCount(ports)).toBe(2);
  });

  it("journalize の成功 → シート保存で例外 → JOURNALIZING のまま → 次回の回収で SYNCED（二重作成しない）", () => {
    const { ports, api } = setup();
    txOf(api);
    add(ports, "R-1");
    const orig = ports.sheets.updateExpenseColumns.bind(ports.sheets);
    let armed = false;
    api.onRequest = (req) => {
      if (req.url.includes("/transactions/journalize")) {
        armed = true;
      }
    };
    ports.sheets.updateExpenseColumns = (id, patch, order) => {
      if (armed && patch.mf_sync_state === "SYNCED") {
        armed = false;
        throw new Error("SHEET_WRITE_FAILED");
      }
      orig(id, patch, order);
    };

    expect(() => syncExpenses(ports)).toThrow("SHEET_WRITE_FAILED");
    expect(get(ports, "R-1").mf_sync_state).toBe("JOURNALIZING");

    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
    expect(api.journals).toHaveLength(1);
    expect(journalizeCount(ports)).toBe(1);
  });

  it("journalize を MF が 400 で拒否 → 明細は未仕訳のままなので ERROR（作り直さない）。Slack で案内", () => {
    const { ports, api } = setup();
    txOf(api);
    add(ports, "R-1");
    api.postMode = "reject_400";

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("ERROR");
    expect(get(ports, "R-1").mf_sync_error).toContain("400");
    expect(posted(ports)).toHaveLength(1);
    expect(posted(ports)[0]).toContain("拒否");
    syncExpenses(ports);
    expect(journalizeCount(ports)).toBe(1);
  });
});

describe("人が記入した MF明細ID（NEEDS_REVIEW から。§6.5）", () => {
  it("支払方法に対応する連携サービスの未仕訳明細に実在・金額一致・使用中でない → JOURNALIZING → SYNCED", () => {
    const { ports, api } = setup();
    const tx = txOf(api, { date: "2026-10-18" }); // 日付幅の外でも、人が指定した明細は使える
    add(ports, "R-1", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: tx.id, mf_sync_error: "候補 2 件" });

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_transaction_id: tx.id, mf_sync_error: null });
    expect(api.journalizeBodies[0]).toMatchObject({ transaction_id: tx.id, transaction_date: "2026-10-10" });
  });

  it("存在しない明細 ID → NEEDS_REVIEW のまま MF連携エラーに理由。Slack は 1 回だけ。作らない", () => {
    const { ports, api } = setup();
    txOf(api);
    add(ports, "R-1", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: "nonexistent%3D" });

    syncExpenses(ports);
    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(get(ports, "R-1").mf_sync_error).toContain("見つかりません");
    expect(journalizeCount(ports)).toBe(0);
    expect(posted(ports)).toHaveLength(1);
  });

  it("金額が違う・別の連携サービスの明細・他の行が使用中の明細は通さない", () => {
    const e = setup();
    const wrongAmount = txOf(e.api, { value: 999 });
    const bankTx = txOf(e.api, { connected_account_id: BANK_SERVICE_ID });
    const taken = txOf(e.api);
    add(e.ports, "R-A", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: wrongAmount.id });
    add(e.ports, "R-B", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: bankTx.id });
    add(e.ports, "R-C", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: taken.id });
    add(e.ports, "R-D", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: taken.id }); // R-C と同じ明細を指定

    syncExpenses(e.ports);

    expect(get(e.ports, "R-A").mf_sync_error).toContain("金額が一致しません");
    expect(get(e.ports, "R-B").mf_sync_error).toContain("見つかりません");
    expect(get(e.ports, "R-C").mf_sync_error).toContain("使用中");
    expect(get(e.ports, "R-D").mf_sync_error).toContain("使用中");
    expect(["R-A", "R-B", "R-C", "R-D"].every((id) => get(e.ports, id).mf_sync_state === "NEEDS_REVIEW")).toBe(true);
    expect(journalizeCount(e.ports)).toBe(0);
  });

  it("事業使用割合が 100 未満の行は、明細 ID を記入されても自動では仕訳しない（家事按分は MF 側。§2.4）", () => {
    const { ports, api } = setup();
    const tx = txOf(api);
    add(ports, "R-1", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: tx.id, business_use_ratio: 50 });
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(journalizeCount(ports)).toBe(0);
  });
});

describe("明細ルール（§6.6。経費の照合より前に適用）", () => {
  const NISA = "SBI証券投信積立サ-ビス(翌月買付分)";

  it("私用として仕訳: account_id = ルールの科目、remark `私用: {ルール名}`、tags [kadobo-rule]、transaction_date は明細の日付、tax_id なし。経費の行が無くても適用する", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule()];
    const tx = txOf(api, { date: "2026-10-13", value: 10000, content: NISA });

    syncExpenses(ports);

    expect(api.journalizeBodies).toEqual([
      {
        transaction_id: tx.id,
        transaction_date: "2026-10-13",
        account_id: accountIdOf("事業主貸"),
        remark: "私用: NISA クレカ積立",
        tags: ["kadobo-rule"],
      },
    ]);
    expect(ports.http.calls.find((c) => c.url.includes("/transactions/journalize"))?.payload).not.toContain("tax_id");
    expect(tx.journalizing_status).toBe("registered");
    syncExpenses(ports);
    expect(journalizeCount(ports)).toBe(1);
  });

  it("ルールに当たる明細と、金額が違う経費の行は互いに影響しない（経費の行は別の明細と照合され、ルールの明細は私用として仕訳される）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule()];
    txOf(api, { date: "2026-10-13", value: 10000, content: NISA });
    const shop = txOf(api, { date: "2026-10-10", value: 1200 });
    add(ports, "R-1");

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_transaction_id: shop.id });
    expect(journalizeCount(ports)).toBe(2);
  });

  it("応答喪失（500。作成済み）: 次回は明細が仕訳済みで一覧に出ないので送り直さない。応答喪失（作成されていない）: 次回は未仕訳のまま送り直す", () => {
    const e = setup();
    e.ports.sheets.mfRules = [nisaRule()];
    const tx = txOf(e.api, { date: "2026-10-13", value: 10000, content: NISA });
    e.api.postMode = "created_but_500";
    e.api.postModeRemaining = 1;
    syncExpenses(e.ports);
    syncExpenses(e.ports);
    expect(journalizeCount(e.ports)).toBe(1);
    expect(e.api.journals).toHaveLength(1);
    expect(tx.journalizing_status).toBe("registered");

    const e2 = setup();
    e2.ports.sheets.mfRules = [nisaRule()];
    const tx2 = txOf(e2.api, { date: "2026-10-13", value: 10000, content: NISA });
    e2.api.postMode = "not_created_500";
    e2.api.postModeRemaining = 1;
    syncExpenses(e2.ports);
    expect(tx2.journalizing_status).toBe("none");
    syncExpenses(e2.ports);
    expect(journalizeCount(e2.ports)).toBe(2);
    expect(e2.api.journals).toHaveLength(1);
    expect(tx2.journalizing_status).toBe("registered");
  });

  it("無視: 仕訳せず、経費の候補からも外す（同じ金額・日付の口座の経費の行にも当てない）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [debitRule()];
    txOf(api, { connected_account_id: BANK_SERVICE_ID, date: "2026-10-26", value: 80000, content: "ミツイスミトモカ-ド (カ" });
    add(ports, "R-1", { payment_method: "linked_bank", amount: 80000, date: "2026-10-25" });
    ports.clock.currentMs = Date.parse("2026-10-27T12:00:00+09:00");

    syncExpenses(ports);

    expect(journalizeCount(ports)).toBe(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
  });

  it("上から順に最初の一致を使う（先頭が「無視」なら後ろの「私用として仕訳」は使わない）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [
      nisaRule({ name: "先", action: "無視", account: "", amount: null }),
      nisaRule({ name: "後", amount: null }),
    ];
    txOf(api, { date: "2026-10-13", value: 10000, content: NISA });
    syncExpenses(ports);
    expect(journalizeCount(ports)).toBe(0);
  });

  it("対象 card／bank: bank のルールはカードの明細に当たらない（カードの明細は経費の照合に進む）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule({ target: "bank", amount: null })];
    txOf(api, { date: "2026-10-13", value: 10000, content: NISA });
    syncExpenses(ports);
    expect(journalizeCount(ports)).toBe(0);
    ports.sheets.mfRules = [nisaRule({ target: "any", amount: null })];
    syncExpenses(ports);
    expect(journalizeCount(ports)).toBe(1);
  });

  it("内容が空のルール・有効でないルールは無視する（空文字列が全明細に当たらない）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule({ content: "", amount: null }), nisaRule({ enabled: false, amount: null })];
    const tx = txOf(api, { date: "2026-10-10", value: 1200 });
    add(ports, "R-1");

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_transaction_id: tx.id });
    expect(api.journalizeBodies).toHaveLength(1);
    expect(api.journalizeBodies[0]).toMatchObject({ remark: "R-1 ○○商店" });
  });

  it("私用ルールに当たった明細が、経費の待ち行の候補にもなるときは仕訳しない。Slack で 1 回知らせ、待ち行は NEEDS_REVIEW（MF明細ID で決められる）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule({ content: "コンビニ", amount: null })]; // 店名にも当たってしまう誤設定
    const tx = txOf(api, { date: "2026-10-10", value: 1200, content: "コンビニ" });
    add(ports, "R-1");

    syncExpenses(ports);
    syncExpenses(ports);

    expect(journalizeCount(ports)).toBe(0);
    expect(tx.journalizing_status).toBe("none");
    const msgs = posted(ports);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toContain("NISA クレカ積立");
    expect(msgs[0]).toContain("R-1");
    expect(msgs[0]).toContain("どちらか確認してください");
    expect(msgs[0]).toContain(tx.id);
    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");

    // 人が経費の明細だと決めて MF明細ID を書けば、その行の明細として仕訳される（ルールは触らない）。
    ports.sheets.updateExpense("R-1", { mf_transaction_id: tx.id });
    syncExpenses(ports);
    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_transaction_id: tx.id });
    expect(api.journalizeBodies).toHaveLength(1);
    expect(api.journalizeBodies[0]).toMatchObject({ remark: "R-1 ○○商店" });
  });

  it("ルールの勘定科目が MF で 1 件に決まらなければ仕訳せず、運用者に 1 日 1 回 DM する（経費の照合は続く）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule({ account: "存在しない科目" })];
    txOf(api, { date: "2026-10-13", value: 10000, content: NISA });
    const shop = txOf(api, { date: "2026-10-10", value: 1200 });
    add(ports, "R-1");

    syncExpenses(ports);
    syncExpenses(ports);

    expect(ports.slack.dms).toHaveLength(1);
    expect(ports.slack.dms[0]!.text).toContain("存在しない科目");
    expect(api.journalizeBodies).toHaveLength(1); // 経費の 1 件だけ
    expect(get(ports, "R-1").mf_transaction_id).toBe(shop.id);
  });

  it("MF明細ルール シートを読めないときは ③ の新規を止め、運用者に 1 日 1 回 DM する（NISA を経費の候補に混ぜない）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRulesError = new Error("sheet_not_found:MF明細ルール");
    txOf(api);
    add(ports, "R-1");

    syncExpenses(ports);
    syncExpenses(ports);

    expect(ports.slack.dms).toHaveLength(1);
    expect(ports.slack.dms[0]!.text).toContain("MF明細ルール");
    expect(get(ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
    expect(journalizeCount(ports)).toBe(0);
    expect(urls(ports, "/transactions?")).toEqual([]);
  });

  it("ルールによる仕訳も同期の 1 回あたりの上限（20）に数える", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule({ amount: null, content: "積立" })];
    for (let i = 0; i < 25; i++) {
      txOf(api, { date: "2026-10-13", value: 100 + i, content: "積立" });
    }
    syncExpenses(ports);
    expect(journalizeCount(ports)).toBe(20);
    syncExpenses(ports);
    expect(journalizeCount(ports)).toBe(25);
  });
});

describe("訂正・取消（PUT。§6.7 🔄）", () => {
  function journalOf(api: FakeMfAccounting, id: string) {
    return api.journals.find((j) => j.id === id)!;
  }
  function debitAccountOf(j: { branches: Record<string, unknown>[] }): string {
    return ((j.branches[0] as { debitor: { account_id: string } }).debitor.account_id) as string;
  }

  it("VOID: DELETE ではなく PUT。借方を事業主貸に付け替え、remark `取消: {証憑ID} {取引先}`、tags [証憑ID, kadobo-void]、貸方は変えない。明細は未仕訳に戻らず、仕訳済みのまま", () => {
    const { ports, api } = setup({ match: false });
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-1" });
    add(ports, "R-1", {
      state: "VOID",
      mf_sync_state: "SYNCED",
      mf_journal_id: journal.id,
      mf_transaction_id: tx.id,
    });

    syncExpenses(ports);

    expect(ports.http.calls.some((c) => c.method === "delete")).toBe(false);
    expect(api.putBodies).toHaveLength(1);
    const put = ports.http.calls.find((c) => c.method === "put")!;
    expect(put.url).toContain(`/journals/${encodeURIComponent(journal.id)}`); // パスの ID は 1 回エンコード
    const j = (api.putBodies[0]!.body as { journal: Record<string, any> }).journal;
    expect(j.transaction_date).toBe("2026-10-10");
    expect(j.branches).toEqual([
      {
        debitor: { account_id: accountIdOf("事業主貸"), value: 1200 },
        creditor: { account_id: accountIdOf("未払金"), value: 1200 },
        remark: "取消: R-1 ○○商店",
      },
    ]);
    expect(j.tags).toEqual(["R-1", "kadobo-void"]);
    expect(j.memo).toBe("https://drive.example.test/f1");
    expect(JSON.stringify(j)).not.toContain("tax_id");
    expect(debitAccountOf(journalOf(api, journal.id))).toBe(accountIdOf("事業主貸"));
    expect(tx.journalizing_status).toBe("registered");
    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "REVERSED", mf_sync_error: null });
    expect(posted(ports)).toHaveLength(1);
    // 手放した後は二度と処理されない。
    syncExpenses(ports);
    expect(api.putBodies).toHaveLength(1);
  });

  it("CORRECTED: 訂正後の新しい行の金額・科目・摘要・タグで同じ仕訳を更新し、新しい行を SYNCED（MF仕訳ID・MF明細ID を引き継ぐ）、旧行を REVERSED", () => {
    const { ports, api } = setup();
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-OLD" });
    add(ports, "R-OLD", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: journal.id, mf_transaction_id: tx.id });
    add(ports, "R-NEW", {
      correction_of_receipt_id: "R-OLD",
      category: "通信費",
      partner: "新店",
      drive_link: "https://drive.example.test/new",
    });

    syncExpenses(ports);

    expect(ports.http.calls.some((c) => c.method === "delete")).toBe(false);
    expect(journalizeCount(ports)).toBe(0);
    expect(api.putBodies).toHaveLength(1);
    const j = (api.putBodies[0]!.body as { journal: Record<string, any> }).journal;
    expect(j.branches).toEqual([
      {
        debitor: { account_id: accountIdOf("通信費"), value: 1200 },
        creditor: { account_id: accountIdOf("未払金"), value: 1200 },
        remark: "R-NEW 新店",
      },
    ]);
    expect(j.tags).toEqual(["R-NEW"]);
    expect(j.memo).toBe("https://drive.example.test/new");
    expect(api.journals).toHaveLength(1);
    expect(get(ports, "R-NEW")).toMatchObject({
      mf_sync_state: "SYNCED",
      mf_journal_id: journal.id,
      mf_transaction_id: tx.id,
      mf_sync_input: `1200|2026-10-10|通信費|linked_card|${tx.id}`,
    });
    expect(get(ports, "R-OLD").mf_sync_state).toBe("REVERSED");
    expect(posted(ports).some((t) => t.includes("R-OLD") && t.includes("R-NEW"))).toBe(true);
  });

  it("CORRECTED で訂正後の新しい行がまだ無い間は何もしない（旧行は SYNCED のまま。HTTP 0 件）。新しい行が登録されたら引き継ぐ", () => {
    const { ports, api } = setup({ match: false });
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-OLD" });
    add(ports, "R-OLD", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: journal.id, mf_transaction_id: tx.id });

    syncExpenses(ports);
    expect(ports.http.calls).toHaveLength(0);
    expect(get(ports, "R-OLD").mf_sync_state).toBe("SYNCED");

    add(ports, "R-NEW", { correction_of_receipt_id: "R-OLD", state: "FILE_SAVED" }); // 登録中
    syncExpenses(ports);
    expect(ports.http.calls).toHaveLength(0);

    ports.sheets.updateExpense("R-NEW", { state: "COMPLETED" });
    syncExpenses(ports);
    expect(get(ports, "R-NEW").mf_sync_state).toBe("SYNCED");
    expect(get(ports, "R-OLD").mf_sync_state).toBe("REVERSED");
  });

  it("新しい行の金額が旧行と違えば引き継がない: 旧仕訳は事業主貸に付け替え、新しい行は通常の照合（別の明細）へ回る", () => {
    const { ports, api } = setup();
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-OLD" });
    const other = txOf(api, { value: 1500, date: "2026-10-11" });
    add(ports, "R-OLD", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: journal.id, mf_transaction_id: tx.id });
    add(ports, "R-NEW", { correction_of_receipt_id: "R-OLD", amount: 1500 });

    syncExpenses(ports);

    expect(debitAccountOf(journalOf(api, journal.id))).toBe(accountIdOf("事業主貸"));
    expect(get(ports, "R-OLD").mf_sync_state).toBe("REVERSED");
    expect(get(ports, "R-NEW")).toMatchObject({ mf_sync_state: "SYNCED", mf_transaction_id: other.id });
    expect(api.journals).toHaveLength(2);
  });

  it("訂正の連鎖（旧 → 中間 CORRECTED → 最後）: 最後の COMPLETED の行に引き継ぐ。中間の行は仕訳が無いので REVERSED にするだけ", () => {
    const { ports, api } = setup();
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-0" });
    add(ports, "R-0", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: journal.id, mf_transaction_id: tx.id });
    add(ports, "R-1", { state: "CORRECTED", correction_of_receipt_id: "R-0" });
    add(ports, "R-2", { correction_of_receipt_id: "R-1", partner: "最終店" });

    syncExpenses(ports);

    expect(get(ports, "R-2")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: journal.id });
    expect(get(ports, "R-0").mf_sync_state).toBe("REVERSED");
    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
    expect(api.journals).toHaveLength(1);
    expect(api.putBodies).toHaveLength(1);
  });

  it("cash の行は従来どおり DELETE（PUT にしない）", () => {
    const { ports, api } = setup({ match: false });
    const j = api.plantJournal({ transaction_date: "2026-10-10", tags: ["R-C"] });
    add(ports, "R-C", { payment_method: "cash", state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: j.id });

    syncExpenses(ports);

    expect(ports.http.calls.filter((c) => c.method === "delete")).toHaveLength(1);
    expect(api.putBodies).toHaveLength(0);
    expect(api.journals).toHaveLength(0);
    expect(get(ports, "R-C").mf_sync_state).toBe("REVERSED");
  });

  it("PUT を MF が 400 で拒否 → ERROR にして Slack で案内（REVERSING のまま繰り返さない）", () => {
    const { ports, api } = setup({ match: false });
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-1" });
    add(ports, "R-1", { state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: journal.id, mf_transaction_id: tx.id });
    api.putMode = "reject_400";

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("ERROR");
    expect(posted(ports)).toHaveLength(1);
    expect(posted(ports)[0]).toContain("MF で仕訳を直してください");
    syncExpenses(ports);
    expect(api.putBodies).toHaveLength(1);
  });

  it("PUT の応答喪失（500）→ REVERSING のまま例外 → 次回やり直して REVERSED（PUT は何度送っても同じ結果）", () => {
    const { ports, api } = setup({ match: false });
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-1" });
    add(ports, "R-1", { state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: journal.id, mf_transaction_id: tx.id });
    api.putMode = "applied_but_500";
    api.putModeRemaining = 1;

    expect(() => syncExpenses(ports)).toThrow();
    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSING");

    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
    expect(debitAccountOf(journalOf(api, journal.id))).toBe(accountIdOf("事業主貸"));
  });

  it("CORRECTED の引継ぎで、旧行を REVERSED にする前に落ちても（REVERSING のまま）次回に新しい行と整合して完了する", () => {
    const { ports, api } = setup();
    const { tx, journal } = plantLinkedJournal(api, { receiptId: "R-OLD" });
    add(ports, "R-OLD", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: journal.id, mf_transaction_id: tx.id });
    add(ports, "R-NEW", { correction_of_receipt_id: "R-OLD" });
    const orig = ports.sheets.updateExpenseColumns.bind(ports.sheets);
    let failed = false;
    ports.sheets.updateExpenseColumns = (id, patch, order) => {
      if (!failed && id === "R-OLD" && patch.mf_sync_state === "REVERSED") {
        failed = true;
        throw new Error("SHEET_WRITE_FAILED");
      }
      orig(id, patch, order);
    };

    expect(() => syncExpenses(ports)).toThrow("SHEET_WRITE_FAILED");
    expect(get(ports, "R-NEW").mf_sync_state).toBe("SYNCED");
    expect(get(ports, "R-OLD").mf_sync_state).toBe("REVERSING");

    syncExpenses(ports);
    expect(get(ports, "R-OLD").mf_sync_state).toBe("REVERSED");
    expect(api.putBodies).toHaveLength(1); // 新しい行が引継ぎ済みなので、PUT をやり直さない
  });

  it("MF 側に仕訳が無い（人が削除した）→ REVERSED にして Slack で知らせる。1 行でない仕訳は更新せず ERROR", () => {
    const e = setup({ match: false });
    add(e.ports, "R-1", { state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: "gone%3D", mf_transaction_id: "t%3D" });
    syncExpenses(e.ports);
    expect(get(e.ports, "R-1").mf_sync_state).toBe("REVERSED");
    expect(e.api.putBodies).toHaveLength(0);

    const e2 = setup({ match: false });
    const { tx, journal } = plantLinkedJournal(e2.api, { receiptId: "R-2" });
    journal.branches = [journal.branches[0]!, journal.branches[0]!];
    add(e2.ports, "R-2", { state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: journal.id, mf_transaction_id: tx.id });
    syncExpenses(e2.ports);
    expect(get(e2.ports, "R-2").mf_sync_state).toBe("ERROR");
    expect(e2.api.putBodies).toHaveLength(0);
  });

  it("仕訳が無い状態（WAITING_TRANSACTION）の取消は REVERSED にするだけ（HTTP 0 件）", () => {
    const { ports } = setup({ match: false });
    add(ports, "R-1", { state: "VOID", mf_sync_state: "WAITING_TRANSACTION" });
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
    expect(ports.http.calls).toHaveLength(0);
  });
});

describe("書く列・ロック（§0, §6.8）", () => {
  it("③ が書くのは MF仕訳ID・MF明細ID・27〜31 列目だけ。業務列は書かず、updateExpense も使わない。MF・Slack はロックの外", () => {
    const { ports, api, lockViolations } = setup();
    ports.sheets.mfRules = [nisaRule()];
    txOf(api, { date: "2026-10-13", value: 10000, content: "SBI証券投信積立サービス" });
    txOf(api, { value: 1200 });
    txOf(api, { value: 2000 });
    txOf(api, { value: 2000, date: "2026-10-11" });
    add(ports, "R-1");
    add(ports, "R-2", { amount: 2000 });
    const a = plantLinkedJournal(api, { receiptId: "R-3", value: 700 });
    add(ports, "R-3", { amount: 700, state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: a.journal.id, mf_transaction_id: a.tx.id });

    syncExpenses(ports);

    const allowed = new Set([
      "mf_journal_id",
      "mf_transaction_id",
      "mf_sync_state",
      "mf_sync_error",
      "mf_sync_updated_at",
      "mf_sync_attempted_at",
      "mf_sync_input",
    ]);
    expect(ports.sheets.columnPatches.length).toBeGreaterThan(0);
    for (const p of ports.sheets.columnPatches) {
      for (const k of p.keys) {
        expect(allowed.has(k)).toBe(true);
      }
    }
    expect(ports.sheets.updateExpenseCalls).toBe(0);
    expect(lockViolations).toEqual([]);
  });
});

describe("実行単位（§6.8）", () => {
  it("渡された絶対期限が既に過ぎていれば、③ の取得・照合を行わない（状態は変えない）", () => {
    const { ports, api } = setup();
    txOf(api);
    add(ports, "R-1");
    const deadline = new RunDeadline(ports.clock, 1, ports.clock.nowMs() - 10_000);

    syncExpenses(ports, deadline);

    expect(urls(ports, "/transactions")).toEqual([]);
    expect(get(ports, "R-1").mf_sync_state).toBe("WAITING_TRANSACTION");
  });
});

describe("週次報告（§6.6）", () => {
  it("未登録の支出: 未仕訳・EXPENSE・開業日以降・7 日以上前・使用中でない・ルールに当たらない明細だけを列挙する", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule({ amount: null }), debitRule()];
    const listed = txOf(api, { date: "2026-10-05", value: 3300, content: "未登録の店" }); // 15 日前
    txOf(api, { date: "2026-10-14", value: 100, content: "6 日前の店" }); // 7 日未満 → 対象外
    txOf(api, { date: "2026-10-13", value: 200, content: "7 日前の店" }); // 7 日前 → 対象
    txOf(api, { date: "2026-09-20", value: 400, content: "開業前の店" }); // 開業前
    txOf(api, { date: "2026-10-06", value: 500, content: "収入", side: "INCOME" });
    txOf(api, { date: "2026-10-06", value: 600, content: "SBI証券投信積立サービス" }); // ルールに当たる
    txOf(api, { date: "2026-10-06", value: 700, content: "ミツイスミトモカ-ド", connected_account_id: BANK_SERVICE_ID }); // ルール（無視）
    const used = txOf(api, { date: "2026-10-06", value: 800, content: "使用中の店" });
    add(ports, "R-USED", { amount: 800, mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: used.id });
    txOf(api, { date: "2026-10-06", value: 900, content: "仕訳済みの店", journalizing_status: "registered" });

    weeklyJournalReport(ports);

    const text = posted(ports).join("\n");
    expect(text).toContain("未登録の支出");
    expect(text).toContain(listed.date);
    expect(text).toContain("3,300円");
    expect(text).toContain("未登録の店");
    expect(text).toContain("7 日前の店");
    expect(text).toContain("/keihi");
    expect(text).toContain("事業主貸");
    for (const absent of ["6 日前の店", "開業前の店", "収入", "SBI証券", "ミツイスミトモカ", "使用中の店", "仕訳済みの店"]) {
      expect(text).not.toContain(absent);
    }
    expect(text).toContain("2 件");
  });

  it("私用として処理した明細: ルールごとの件数と合計（kadobo-rule タグの仕訳。remark 単位）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRules = [nisaRule()];
    for (const [date, value] of [
      ["2026-10-13", 10000],
      ["2026-11-13", 10000],
    ] as const) {
      api.plantJournal({
        transaction_date: date,
        tags: ["kadobo-rule"],
        branches: [
          {
            debitor: { account_id: accountIdOf("事業主貸"), value },
            creditor: { account_id: accountIdOf("未払金"), value },
            remark: "私用: NISA クレカ積立",
          },
        ],
      });
    }
    api.plantJournal({
      transaction_date: "2026-10-05",
      tags: ["kadobo-rule"],
      branches: [
        {
          debitor: { account_id: accountIdOf("事業主貸"), value: 500 },
          creditor: { account_id: accountIdOf("未払金"), value: 500 },
          remark: "私用: PASMO チャージ",
        },
      ],
    });
    ports.clock.currentMs = Date.parse("2026-11-30T09:00:00+09:00");

    weeklyJournalReport(ports);

    const text = posted(ports).join("\n");
    expect(text).toContain("私用として処理した明細");
    expect(text).toContain("私用: NISA クレカ積立: 2 件（合計 20,000 円、最新 2026-11-13）");
    expect(text).toContain("私用: PASMO チャージ: 1 件（合計 500 円、最新 2026-10-05）");
  });

  it("無効なルール: 内容が空・私用の勘定科目が MF で引けない行を報告する。有効が FALSE の行は意図して止めているので報告しない", () => {
    const { ports } = setup();
    ports.sheets.mfRules = [
      nisaRule({ name: "空ルール", content: "" }),
      nisaRule({ name: "停止中", enabled: false }),
      nisaRule({ name: "科目なし", account: "存在しない科目" }),
      nisaRule({ name: "正常" }),
    ];

    weeklyJournalReport(ports);

    const text = posted(ports).join("\n");
    expect(text).toContain("無効な明細ルール（2 件）");
    expect(text).toContain("2 行目「空ルール」");
    expect(text).toContain("内容に含む文字列が空");
    expect(text).not.toContain("停止中");
    expect(text).not.toContain("有効が TRUE ではありません");
    expect(text).toContain("「科目なし」");
    expect(text).toContain("存在しない科目");
    expect(text).not.toContain("「正常」");
  });

  it("MF_MATCH_ENABLED が無効なら ③ の報告（未登録の支出・私用・無効なルール）を出さず、GET /transactions も呼ばない", () => {
    const { ports, api } = setup({ match: false });
    ports.sheets.mfRules = [nisaRule({ content: "" })];
    txOf(api, { date: "2026-10-05", value: 3300 });

    weeklyJournalReport(ports);

    expect(urls(ports, "/transactions?")).toEqual([]);
    expect(posted(ports)).toEqual([]);
  });

  it("MF明細ルール シートを読めなければ、その旨を報告する（未登録の支出は出さない）", () => {
    const { ports, api } = setup();
    ports.sheets.mfRulesError = new Error("sheet_not_found");
    txOf(api, { date: "2026-10-05", value: 3300, content: "未登録の店" });

    weeklyJournalReport(ports);

    const text = posted(ports).join("\n");
    expect(text).toContain("MF明細ルール シートを読めない");
    expect(text).not.toContain("未登録の店");
  });
});
