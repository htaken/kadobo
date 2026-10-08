/**
 * `app/journalSync.ts`（実装設計 MF連携 §6.1〜§6.4, §6.7, §6.8, §11.2 WP-M4 受入条件）のテスト。
 * 会計 API は `mf/fakeMfAccounting.ts` の簡易フェイクサーバ（ID はパーセントエンコード済みの文字列）。
 */
import { describe, expect, it } from "vitest";
import { syncExpenses, weeklyJournalReport, MF_ACCOUNTS_CACHE_KEY } from "../../src/app/journalSync";
import { acquireLease } from "../../src/app/mf/lease";
import { RunDeadline } from "../../src/app/mf/deadline";
import { MfAuthError, MfTransientError } from "../../src/app/mf/errors";
import type { ExpenseLedgerRow } from "../../src/app/ports";
import { makeFakePorts, type FakePorts } from "./fakes";
import { accountIdOf, accountingCallsOf, installFakeMfAccounting, type FakeMfAccounting } from "./mf/fakeMfAccounting";

const NOW = Date.parse("2026-10-20T12:00:00+09:00");
const HOUR = 60 * 60 * 1000;

function expenseRow(id: string, o: Partial<ExpenseLedgerRow> = {}): ExpenseLedgerRow {
  return {
    receipt_id: id,
    receipt_type: "paper",
    date: "2026-10-05",
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

interface Env {
  ports: FakePorts;
  api: FakeMfAccounting;
  /** 会計 API・Slack を呼んだ瞬間にスクリプトロックを保持していた回数（0 であるべき）。 */
  lockViolations: string[];
}

function setup(flags: { journal?: boolean; mf?: boolean } = {}): Env {
  const ports = makeFakePorts(NOW);
  const api = installFakeMfAccounting(ports);
  if (flags.mf !== false) {
    ports.props.set("MF_ENABLED", "true");
  }
  if (flags.journal !== false) {
    ports.props.set("MF_JOURNAL_ENABLED", "true");
  }
  ports.props.set("MF_SYNC_START_DATE", "2026-10-01");
  ports.props.set("SLACK_CHANNEL_ID", "C1");
  ports.props.set("SLACK_USER_ID", "U1");
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

function postedTexts(ports: FakePorts): string[] {
  return ports.slack.posted.map((p) => p.text);
}

function postCount(ports: FakePorts): number {
  return accountingCallsOf(ports).filter((c) => c === "POST /journals").length;
}

describe("フラグ・lease（§9, §6.8）", () => {
  it("MF_ENABLED が無効なら HTTP 0 件（回収対象の行があっても何もしない）", () => {
    const { ports } = setup({ mf: false });
    add(ports, "R-1", { mf_sync_state: "CREATING", mf_sync_attempted_at: NOW });
    add(ports, "R-2", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: "j%3D" });
    add(ports, "R-3", { mf_sync_state: "PENDING" });

    syncExpenses(ports);

    expect(ports.http.calls).toHaveLength(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("CREATING");
    expect(get(ports, "R-2").mf_sync_state).toBe("SYNCED");
  });

  it("MF_JOURNAL_ENABLED だけ有効で MF_ENABLED が無効でも HTTP 0 件", () => {
    const { ports } = setup({ mf: false, journal: true });
    add(ports, "R-3", { mf_sync_state: "PENDING" });
    syncExpenses(ports);
    expect(ports.http.calls).toHaveLength(0);
  });

  it("MF_ENABLED だけ有効: 回収・取消は動くが、新規作成は動かない（POST も状態の新規判定も無い）", () => {
    const { ports, api } = setup({ journal: false });
    // 回収: CREATING で、MF に仕訳がある。
    add(ports, "R-1", { mf_sync_state: "CREATING", mf_sync_attempted_at: NOW - HOUR });
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });
    // 取消: SYNCED で CORRECTED。
    const j2 = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-2"] });
    add(ports, "R-2", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: j2.id });
    // 新規: COMPLETED の未着手の行と PENDING の行。
    add(ports, "R-3");
    add(ports, "R-4", { mf_sync_state: "PENDING" });

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: j.id });
    expect(get(ports, "R-2").mf_sync_state).toBe("REVERSED");
    expect(api.journals.map((x) => x.id)).toEqual([j.id]);
    expect(postCount(ports)).toBe(0);
    expect(get(ports, "R-3").mf_sync_state).toBe("");
    expect(get(ports, "R-4").mf_sync_state).toBe("PENDING");
  });

  it("lease mf_sync を別の実行が持っていれば何もしない（HTTP 0 件）", () => {
    const { ports } = setup();
    add(ports, "R-1");
    expect(acquireLease(ports, "mf_sync", 10 * 60 * 1000)).toBe(true);

    syncExpenses(ports);

    expect(ports.http.calls).toHaveLength(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("");
  });

  it("実行後は lease を解放する（次の実行が動ける）。期限切れの lease は奪える", () => {
    const { ports } = setup();
    add(ports, "R-1");
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");

    add(ports, "R-2");
    syncExpenses(ports);
    expect(get(ports, "R-2").mf_sync_state).toBe("SYNCED");
  });
});

describe("対象判定と状態の進み方（§6.2, §6.3）", () => {
  it("登録中（FILE_SAVED）の行は待つ。COMPLETED になった後の実行で同期される", () => {
    const { ports } = setup();
    add(ports, "R-1", { state: "FILE_SAVED" });

    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("");
    expect(postCount(ports)).toBe(0);

    ports.sheets.updateExpense("R-1", { state: "COMPLETED" });
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
    expect(postCount(ports)).toBe(1);
  });

  it("支払方法を後から記入した行が次の実行で対象になる", () => {
    const { ports } = setup();
    add(ports, "R-1", { payment_method: "" });

    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("");
    expect(postCount(ports)).toBe(0);

    ports.sheets.updateExpense("R-1", { payment_method: "cash" });
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
  });

  it("事業使用割合が 100 未満は NEEDS_REVIEW（作らない）。Slack に 1 回案内する", () => {
    const { ports } = setup();
    add(ports, "R-1", { business_use_ratio: 60 });

    syncExpenses(ports);
    syncExpenses(ports);

    const r = get(ports, "R-1");
    expect(r.mf_sync_state).toBe("NEEDS_REVIEW");
    expect(r.mf_sync_error).toContain("60");
    expect(postCount(ports)).toBe(0);
    expect(postedTexts(ports).filter((t) => t.includes("R-1"))).toHaveLength(1);
  });

  it("開業日（MF_SYNC_START_DATE）より前の日付だけ NOT_TARGET。MF は呼ばない", () => {
    const { ports } = setup();
    add(ports, "R-OLD", { date: "2026-09-30" });
    add(ports, "R-DAY1", { date: "2026-10-01" });

    syncExpenses(ports);

    expect(get(ports, "R-OLD").mf_sync_state).toBe("NOT_TARGET");
    expect(get(ports, "R-DAY1").mf_sync_state).toBe("SYNCED");
    // R-OLD のために tags 検索も POST もしていない（検索は R-DAY1 の 2026-10-01 だけ）。
    const searches = ports.http.calls.filter((c) => c.url.includes("/journals?") && c.url.includes("2026-09-30"));
    expect(searches).toHaveLength(0);
  });

  it("MF_SYNC_START_DATE が未設定なら新規は同期しない", () => {
    const { ports } = setup();
    ports.props.values.delete("MF_SYNC_START_DATE");
    add(ports, "R-1");
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("");
    expect(postCount(ports)).toBe(0);
  });

  it("linked_card・linked_bank は WAITING_TRANSACTION にするだけ。以後は何もしない（照合は WP-M5）", () => {
    const { ports } = setup();
    add(ports, "R-C", { payment_method: "linked_card" });
    add(ports, "R-B", { payment_method: "linked_bank" });

    syncExpenses(ports);
    syncExpenses(ports);

    expect(get(ports, "R-C").mf_sync_state).toBe("WAITING_TRANSACTION");
    expect(get(ports, "R-B").mf_sync_state).toBe("WAITING_TRANSACTION");
    expect(ports.http.calls).toHaveLength(0);
  });

  it("JOURNALIZING の行には触れない（WP-M5）", () => {
    const { ports } = setup();
    add(ports, "R-J", { payment_method: "linked_card", mf_sync_state: "JOURNALIZING", mf_transaction_id: "tx%3D" });
    const before = get(ports, "R-J");

    syncExpenses(ports);

    expect(get(ports, "R-J")).toEqual(before);
    expect(ports.http.calls).toHaveLength(0);
  });
});

describe("② 現金・立替の作成（§6.4）", () => {
  it("POST /journals の本文・SYNCED・MF仕訳ID（パーセントエンコード済みのまま）・入力要約・試行時刻", () => {
    const { ports, api } = setup();
    add(ports, "R-20261005-001", { category: "その他", partner: "△△書店" });

    syncExpenses(ports);

    expect(api.postedBodies).toHaveLength(1);
    const body = api.postedBodies[0] as { journal: Record<string, any> };
    expect(body.journal.transaction_date).toBe("2026-10-05");
    expect(body.journal.journal_type).toBe("journal_entry");
    expect(body.journal.tags).toEqual(["R-20261005-001"]);
    expect(body.journal.memo).toBe("https://drive.example.test/f1");
    expect(body.journal.branches).toEqual([
      {
        debitor: { account_id: accountIdOf("雑費"), value: 1200 },
        creditor: { account_id: accountIdOf("事業主借"), value: 1200 },
        remark: "R-20261005-001 △△書店",
      },
    ]);
    const r = get(ports, "R-20261005-001");
    expect(r.mf_sync_state).toBe("SYNCED");
    expect(r.mf_journal_id).toBe(api.journals[0]!.id);
    expect(r.mf_journal_id).toMatch(/%2B|%2F|%3D/);
    expect(r.mf_sync_input).toBe("1200|2026-10-05|その他|cash|");
    expect(r.mf_sync_attempted_at).not.toBeNull();
    expect(r.mf_sync_error).toBeNull();
    expect(r.mf_sync_updated_at).not.toBeNull();
  });

  it("POST /journals の本文に tax_id・invoice_kind が無い（免税事業者は税区分を登録できない）", () => {
    const { ports } = setup();
    add(ports, "R-1");
    syncExpenses(ports);
    const posted = ports.http.calls.find((c) => c.method === "post" && c.url.includes("/journals"));
    expect(posted?.payload).toBeDefined();
    expect(posted?.payload).not.toContain("tax_id");
    expect(posted?.payload).not.toContain("invoice_kind");
  });

  it("カテゴリに応じた借方科目（その他は雑費）の ID を使う", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { category: "旅費交通費" });
    syncExpenses(ports);
    const body = api.postedBodies[0] as { journal: { branches: { debitor: { account_id: string } }[] } };
    expect(body.journal.branches[0]!.debitor.account_id).toBe(accountIdOf("旅費交通費"));
  });

  it("科目解決の失敗（名前完全一致で見つからない）では POST せず止まり、運用者に DM する（1 日 1 回）", () => {
    const { ports, api } = setup();
    api.missingAccounts.add("雑費");
    add(ports, "R-1", { category: "その他" });

    expect(() => syncExpenses(ports)).not.toThrow();
    expect(postCount(ports)).toBe(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("PENDING");
    expect(ports.slack.dms).toHaveLength(1);
    expect(ports.slack.dms[0]!.text).toContain("雑費");

    syncExpenses(ports); // 同じ日に再実行しても DM は増えない
    expect(ports.slack.dms).toHaveLength(1);

    // MF 側で科目が見つかるようになれば作成される。
    api.missingAccounts.delete("雑費");
    ports.ttlCache.remove(MF_ACCOUNTS_CACHE_KEY);
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
  });

  it("科目名 → ID の解決を TtlCache に 6 時間保存し、2 回目の実行では GET /accounts を呼ばない", () => {
    const { ports } = setup();
    add(ports, "R-1");
    syncExpenses(ports);
    add(ports, "R-2");
    syncExpenses(ports);

    expect(accountingCallsOf(ports).filter((c) => c === "GET /accounts")).toHaveLength(1);
    const put = ports.ttlCache.puts.find((p) => p.key === MF_ACCOUNTS_CACHE_KEY);
    expect(put?.ttlSec).toBe(6 * 60 * 60);
  });

  it("MfApiError（400）は ERROR にして通知する。次の実行で作り直さない", () => {
    const { ports, api } = setup();
    api.postMode = "reject_400";
    add(ports, "R-1");

    syncExpenses(ports);
    const r = get(ports, "R-1");
    expect(r.mf_sync_state).toBe("ERROR");
    expect(r.mf_sync_error).toContain("status=400");
    expect(postedTexts(ports).some((t) => t.includes("R-1") && t.includes("拒否"))).toBe(true);

    api.postMode = "ok";
    syncExpenses(ports);
    expect(postCount(ports)).toBe(1);
    expect(get(ports, "R-1").mf_sync_state).toBe("ERROR");

    // 人が MF連携状態 を空に戻すと再評価されて作られる。
    ports.sheets.updateExpense("R-1", { mf_sync_state: "", mf_sync_error: null });
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
  });

  it("429（MfTransientError）は PENDING に戻して投げる。次の実行で作られる", () => {
    const { ports, api } = setup();
    api.postMode = "rate_limit";
    api.postModeRemaining = 1;
    add(ports, "R-1");

    expect(() => syncExpenses(ports)).toThrow(MfTransientError);
    expect(get(ports, "R-1").mf_sync_state).toBe("PENDING");
    expect(api.journals).toHaveLength(0);

    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
    expect(api.journals).toHaveLength(1);
  });

  it("冪等確認: MF に既に tags が証憑 ID の仕訳があれば、POST せずそれを採用する", () => {
    const { ports, api } = setup();
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });
    add(ports, "R-1", { mf_sync_state: "PENDING" });

    syncExpenses(ports);

    expect(postCount(ports)).toBe(0);
    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: j.id });
  });

  it("tags 検索は全ページを見る（1 ページ目に無くても後ろのページの仕訳を見つける）", () => {
    const { ports, api } = setup();
    for (let i = 0; i < 120; i++) {
      api.plantJournal({ transaction_date: "2026-10-05", tags: [`other-${i}`] });
    }
    const target = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });
    add(ports, "R-1", { mf_sync_state: "PENDING" });

    syncExpenses(ports);

    expect(postCount(ports)).toBe(0);
    expect(get(ports, "R-1").mf_journal_id).toBe(target.id);
    const searches = accountingCallsOf(ports).filter((c) => c === "GET /journals");
    expect(searches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("403（権限不足）は認証エラーとして全体を止める（行ごとの ERROR にしない）", () => {
  it("POST /journals が 403: MfAuthError(accounting) を投げ、行は PENDING に戻る（ERROR にしない）", () => {
    const { ports, api } = setup();
    add(ports, "R-1");
    add(ports, "R-2");
    // JWT 交換と /accounts は通し、/journals への書き込みだけ権限不足にする。
    const orig = api.handle.bind(api);
    api.handle = (req) =>
      req.method === "post" && req.url.includes("/journals")
        ? { status: 403, headers: {}, body: JSON.stringify({ errors: [{ code: "forbidden", message: "x" }] }) }
        : orig(req);

    let caught: unknown;
    try {
      syncExpenses(ports);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(MfAuthError);
    expect((caught as MfAuthError).service).toBe("accounting");
    expect(get(ports, "R-1").mf_sync_state).toBe("PENDING");
    expect(get(ports, "R-2").mf_sync_state).toBe("PENDING");
    expect(ports.sheets.getAllExpenses().some((r) => r.mf_sync_state === "ERROR")).toBe(false);
    expect(postCount(ports)).toBe(1); // 1 行目で止まる（2 行目に POST しない）
  });

  it("GET が 403（回収・取り込み・取消）でも行の状態を変えず MfAuthError を投げる", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { mf_sync_state: "CREATING", mf_sync_attempted_at: NOW - HOUR });
    api.forbidAll = true;

    expect(() => syncExpenses(ports)).toThrow(MfAuthError);
    expect(get(ports, "R-1").mf_sync_state).toBe("CREATING");

    const { ports: p2, api: api2 } = setup();
    add(p2, "R-2", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: "j%3D" });
    api2.forbidAll = true;
    expect(() => syncExpenses(p2)).toThrow(MfAuthError);
    expect(get(p2, "R-2").mf_sync_state).toBe("REVERSING"); // 次回の回収で DELETE をやり直す
  });

  it("MfApiError の 4xx（400）は従来どおり行ごとに ERROR（他の行は処理を続ける）", () => {
    const { ports, api } = setup();
    api.postMode = "reject_400";
    api.postModeRemaining = 1;
    add(ports, "R-1");
    add(ports, "R-2");

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("ERROR");
    expect(get(ports, "R-2").mf_sync_state).toBe("SYNCED");
  });
});

describe("3 経路: 応答喪失・シート保存失敗・その間の取消（§6.4, §6.7, §11.2）", () => {
  it("作成成功 → 応答喪失（MfOutcomeUnknownError）→ CREATING のまま → 次回 tags で回収（二重作成しない）", () => {
    const { ports, api } = setup();
    api.postMode = "created_but_500";
    api.postModeRemaining = 1;
    add(ports, "R-1");

    expect(() => syncExpenses(ports)).not.toThrow();
    const mid = get(ports, "R-1");
    expect(mid.mf_sync_state).toBe("CREATING");
    expect(mid.mf_sync_attempted_at).not.toBeNull();
    expect(mid.mf_sync_input).toBe("1200|2026-10-05|消耗品費|cash|");
    expect(api.journals).toHaveLength(1);

    syncExpenses(ports);

    expect(postCount(ports)).toBe(1);
    expect(api.journals).toHaveLength(1);
    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: api.journals[0]!.id });
  });

  it("応答喪失の後は、この実行で他の行を作らない（結果不明のまま POST を重ねない）", () => {
    const { ports, api } = setup();
    api.postMode = "created_but_500";
    api.postModeRemaining = 1;
    add(ports, "R-1");
    add(ports, "R-2");

    syncExpenses(ports);

    expect(postCount(ports)).toBe(1);
    expect(get(ports, "R-2").mf_sync_state).toBe("PENDING");
  });

  it("作成成功 → シート保存で例外 → 状態は CREATING のまま → 次回回収（二重作成しない）", () => {
    const { ports, api } = setup();
    add(ports, "R-1");
    const orig = ports.sheets.updateExpenseColumns.bind(ports.sheets);
    let thrown = false;
    ports.sheets.updateExpenseColumns = (id, patch) => {
      if (!thrown && patch.mf_sync_state === "SYNCED") {
        thrown = true;
        throw new Error("SHEET_SAVE_FAILED");
      }
      orig(id, patch);
    };

    expect(() => syncExpenses(ports)).toThrow("SHEET_SAVE_FAILED");
    expect(get(ports, "R-1").mf_sync_state).toBe("CREATING");
    expect(api.journals).toHaveLength(1);

    syncExpenses(ports);

    expect(postCount(ports)).toBe(1);
    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: api.journals[0]!.id });
  });

  it("作成成功 → 応答喪失 → その間に取消（CORRECTED）→ 回収後に DELETE して REVERSED", () => {
    const { ports, api } = setup();
    api.postMode = "created_but_500";
    api.postModeRemaining = 1;
    add(ports, "R-1");
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("CREATING");
    const id = api.journals[0]!.id;

    ports.sheets.updateExpense("R-1", { state: "CORRECTED" });
    syncExpenses(ports);

    expect(api.journals).toHaveLength(0); // 回収した仕訳を DELETE した
    const r = get(ports, "R-1");
    expect(r.mf_sync_state).toBe("REVERSED");
    expect(r.mf_journal_id).toBe(id);
    expect(postCount(ports)).toBe(1);
    expect(postedTexts(ports).filter((t) => t.includes("R-1") && t.includes("削除"))).toHaveLength(1);
  });

  it("CREATING で試行から 24 時間未満なら待つ（通知なし・UNKNOWN にしない）", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_sync_state: "CREATING", mf_sync_attempted_at: NOW - 23 * HOUR });

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("CREATING");
    expect(ports.slack.posted).toHaveLength(0);
  });

  it("24 時間以上たっても見つからなければ UNKNOWN にして Slack で依頼を 1 回だけ出す", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_sync_state: "CREATING", mf_sync_attempted_at: NOW - 25 * HOUR });

    syncExpenses(ports);
    syncExpenses(ports);
    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("UNKNOWN");
    const notices = postedTexts(ports).filter((t) => t.includes("R-1"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("MF連携状態 を空に戻してください");
    expect(notices[0]).toContain("MF仕訳ID に ID を書いてください");
    expect(postCount(ports)).toBe(0); // 自動では作り直さない
  });

  it("UNKNOWN の後に MF に仕訳が見つかれば SYNCED に回収する", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { mf_sync_state: "UNKNOWN", mf_sync_attempted_at: NOW - 30 * HOUR });
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: j.id });
  });

  it("UNKNOWN の行は人が MF連携状態 を空に戻すと再評価され、作られる", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_sync_state: "UNKNOWN", mf_sync_attempted_at: NOW - 30 * HOUR });
    ports.sheets.updateExpense("R-1", { mf_sync_state: "" });

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
    expect(postCount(ports)).toBe(1);
  });
});

describe("取消（§6.7）", () => {
  it("SYNCED の行が CORRECTED になったら DELETE（パスの ID は pathWithId で 1 回エンコード）→ REVERSED、Slack に 1 行", () => {
    const { ports, api } = setup();
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });
    add(ports, "R-1", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: j.id });

    syncExpenses(ports);

    const del = ports.http.calls.find((c) => c.method === "delete");
    // パスには encodeURIComponent を 1 回かけた形（`%` → `%25`）を置く。生のままでは MF が 400 にする（実機 S-M5）。
    expect(del?.url).toContain(`/journals/${encodeURIComponent(j.id)}?`);
    expect(del?.url).toContain("%25");
    expect(del?.url).not.toContain(`/journals/${j.id}?`);
    expect(api.journals).toHaveLength(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
    expect(ports.slack.posted).toHaveLength(1);
    expect(ports.slack.posted[0]!.text).toContain("R-1");
  });

  it("VOID も同じ。存在しない ID への DELETE（実機は 400 invalid_request_path_parameter）は削除済みとして REVERSED", () => {
    const { ports } = setup();
    add(ports, "R-1", { state: "VOID", mf_sync_state: "SYNCED", mf_journal_id: "gone%3D%3D" });

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
    expect(get(ports, "R-1").mf_sync_error).toBeNull();
    expect(ports.http.calls.filter((c) => c.method === "delete")).toHaveLength(1);
  });

  it("従来どおりの 404 も削除済みとして REVERSED", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: "gone%3D%3D" });
    const orig = api.handle.bind(api);
    api.handle = (req) =>
      req.method === "delete" ? { status: 404, headers: {}, body: JSON.stringify({ errors: [{ code: "not_found", message: "n" }] }) } : orig(req);

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
  });

  it("REVERSING で DELETE が「存在しない」（400 invalid_request_path_parameter）なら REVERSED（削除は成功済みだった）", () => {
    const { ports } = setup();
    add(ports, "R-1", { state: "CORRECTED", mf_sync_state: "REVERSING", mf_journal_id: "already%3D%3D" });

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
  });

  it("DELETE が 400 なら ERROR にして通知（REVERSING のまま繰り返さない）", () => {
    const { ports, api } = setup();
    api.deleteStatus = 400;
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });
    add(ports, "R-1", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: j.id });

    syncExpenses(ports);
    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("ERROR");
    expect(ports.http.calls.filter((c) => c.method === "delete")).toHaveLength(1);
    expect(postedTexts(ports).some((t) => t.includes("R-1") && t.includes("MF で仕訳を削除"))).toBe(true);
  });

  it("REVERSING のまま残った行（削除の途中で落ちた）は次回 DELETE をやり直して REVERSED にする", () => {
    const { ports, api } = setup();
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });
    add(ports, "R-1", { state: "CORRECTED", mf_sync_state: "REVERSING", mf_journal_id: j.id });

    syncExpenses(ports);

    expect(api.journals).toHaveLength(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
  });

  it("仕訳が無い状態（空・PENDING・WAITING_TRANSACTION・NEEDS_REVIEW）の取消は REVERSED にするだけ（HTTP 0 件）", () => {
    const { ports } = setup();
    add(ports, "R-E", { state: "VOID", mf_sync_state: "" });
    add(ports, "R-P", { state: "CORRECTED", mf_sync_state: "PENDING" });
    add(ports, "R-W", { state: "CORRECTED", mf_sync_state: "WAITING_TRANSACTION", payment_method: "linked_card" });
    add(ports, "R-N", { state: "VOID", mf_sync_state: "NEEDS_REVIEW", business_use_ratio: 50 });

    syncExpenses(ports);

    for (const id of ["R-E", "R-P", "R-W", "R-N"]) {
      expect(get(ports, id).mf_sync_state).toBe("REVERSED");
    }
    expect(ports.http.calls).toHaveLength(0);
  });

  it("CORRECTED の旧行は REVERSED のあと二度と処理されない。訂正後の新しい行は通常どおり同期される", () => {
    const { ports, api } = setup();
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-OLD"] });
    add(ports, "R-OLD", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: j.id });
    add(ports, "R-NEW", { amount: 1500, correction_of_receipt_id: "R-OLD" });

    syncExpenses(ports);
    syncExpenses(ports);

    expect(get(ports, "R-OLD").mf_sync_state).toBe("REVERSED");
    expect(get(ports, "R-NEW").mf_sync_state).toBe("SYNCED");
    expect(api.journals).toHaveLength(1);
    expect(api.journals[0]!.tags).toEqual(["R-NEW"]);
    expect(ports.http.calls.filter((c) => c.method === "delete")).toHaveLength(1);
  });
});

describe("手入力の MF仕訳ID の取り込み（B7）", () => {
  it("空・PENDING・WAITING_TRANSACTION・NEEDS_REVIEW・UNKNOWN で MF仕訳ID がある行は、作らずに存在確認して SYNCED", () => {
    const { ports, api } = setup();
    const states = ["", "PENDING", "WAITING_TRANSACTION", "NEEDS_REVIEW", "UNKNOWN"] as const;
    states.forEach((s, i) => {
      const j = api.plantJournal({ transaction_date: "2026-10-05", tags: [] });
      add(ports, `R-${i}`, {
        mf_sync_state: s,
        mf_journal_id: j.id,
        payment_method: s === "WAITING_TRANSACTION" ? "linked_card" : "cash",
        business_use_ratio: s === "NEEDS_REVIEW" ? 50 : 100,
      });
    });

    syncExpenses(ports);

    states.forEach((_, i) => {
      const r = get(ports, `R-${i}`);
      expect(r.mf_sync_state).toBe("SYNCED");
      expect(r.mf_sync_input).toBe(`1200|2026-10-05|消耗品費|${r.payment_method}|`);
    });
    expect(postCount(ports)).toBe(0);
    // 存在確認は GET /journals/{id}（パスの ID は pathWithId で 1 回エンコード）。
    const gets = ports.http.calls.filter((c) => c.method === "get" && /\/journals\/[^?]+\?/.test(c.url));
    expect(gets).toHaveLength(states.length);
    expect(gets.every((c) => c.url.includes("%25"))).toBe(true);
  });

  it("MF に無い ID が書かれていたら NEEDS_REVIEW にして 1 回だけ通知し、作らない", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_journal_id: "typo%3D%3D" });

    syncExpenses(ports);
    syncExpenses(ports);

    const r = get(ports, "R-1");
    expect(r.mf_sync_state).toBe("NEEDS_REVIEW");
    expect(r.mf_sync_error).toContain("MF仕訳ID が見つかりません");
    expect(r.mf_sync_error).toContain("typo%3D%3D");
    expect(postCount(ports)).toBe(0);
    expect(postedTexts(ports).filter((t) => t.includes("R-1"))).toHaveLength(1);
  });

  it("存在しない ID（従来どおりの 404）でも NEEDS_REVIEW。他の 4xx（403 以外の業務エラー）は取り込みを止めず例外にする", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { mf_journal_id: "typo%3D%3D" });
    const orig = api.handle.bind(api);
    api.handle = (req) =>
      req.method === "get" && /\/journals\/[^?]+\?/.test(req.url)
        ? { status: 404, headers: {}, body: JSON.stringify({ errors: [{ code: "not_found", message: "n" }] }) }
        : orig(req);

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(get(ports, "R-1").mf_sync_error).toContain("MF仕訳ID が見つかりません");

    // 「存在しない」ではない 400（別の code）は NEEDS_REVIEW に落とさず例外として上へ伝える。
    const env2 = setup();
    add(env2.ports, "R-2", { mf_journal_id: "x%3D" });
    const orig2 = env2.api.handle.bind(env2.api);
    env2.api.handle = (req) =>
      req.method === "get" && /\/journals\/[^?]+\?/.test(req.url)
        ? { status: 400, headers: {}, body: JSON.stringify({ errors: [{ code: "invalid_param", message: "bad" }] }) }
        : orig2(req);
    expect(() => syncExpenses(env2.ports)).toThrow();
    expect(get(env2.ports, "R-2").mf_sync_state).toBe("");
  });

  it("MF仕訳ID がある未着手の行は新規作成の対象にならない（取り込みの予算が尽きた場合でも作らない）", () => {
    const { ports, api } = setup();
    const j = api.plantJournal({ transaction_date: "2026-10-05" });
    add(ports, "R-1", { mf_journal_id: j.id });

    syncExpenses(ports);

    expect(postCount(ports)).toBe(0);
  });
});

describe("作成後の業務列の変更の検出（§6.3 手順 4）", () => {
  it("SYNCED の行で金額などが mf_sync_input と違えば、通知して NEEDS_REVIEW（MF は呼ばない）", () => {
    const { ports } = setup();
    add(ports, "R-1");
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
    const callsBefore = ports.http.calls.length;

    ports.sheets.updateExpense("R-1", { amount: 9999 });
    syncExpenses(ports);

    const r = get(ports, "R-1");
    expect(r.mf_sync_state).toBe("NEEDS_REVIEW");
    expect(r.mf_sync_error).toContain("1200|2026-10-05|消耗品費|cash|");
    expect(r.mf_sync_error).toContain("9999");
    expect(ports.http.calls.length).toBe(callsBefore);
    expect(postedTexts(ports).filter((t) => t.includes("R-1") && t.includes("変更"))).toHaveLength(1);
  });

  it("NEEDS_REVIEW になった行は MF仕訳ID があっても自動では SYNCED に戻らない（人が状態を空に戻すと取り込み直す）", () => {
    const { ports } = setup();
    add(ports, "R-1");
    syncExpenses(ports);
    ports.sheets.updateExpense("R-1", { amount: 9999 });
    syncExpenses(ports);
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(postedTexts(ports).filter((t) => t.includes("変更"))).toHaveLength(1);

    ports.sheets.updateExpense("R-1", { mf_sync_state: "" });
    syncExpenses(ports);

    const r = get(ports, "R-1");
    expect(r.mf_sync_state).toBe("SYNCED");
    expect(r.mf_sync_input).toBe("9999|2026-10-05|消耗品費|cash|");
    expect(postCount(ports)).toBe(1); // 作り直していない
  });

  it("変更が無ければ何もしない。取引先・メモの変更は検出しない", () => {
    const { ports } = setup();
    add(ports, "R-1");
    syncExpenses(ports);
    ports.sheets.updateExpense("R-1", { partner: "別名", memo: "メモ" });

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
  });
});

describe("書く列・ロック（§0, §6.8）", () => {
  it("同期が書くのは MF仕訳ID・MF明細ID・27〜31 列目だけ。業務列は書かず、updateExpense（行全体の書き戻し）も使わない", () => {
    const { ports, api } = setup();
    add(ports, "R-1");
    add(ports, "R-2", { business_use_ratio: 50 });
    add(ports, "R-3", { date: "2026-09-01" });
    add(ports, "R-4", { payment_method: "linked_card" });
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-5"] });
    add(ports, "R-5", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: j.id });
    api.postMode = "created_but_500";
    api.postModeRemaining = 0;
    const businessBefore = ports.sheets.getAllExpenses().map((r) => ({
      id: r.receipt_id,
      business: [r.receipt_type, r.date, r.amount, r.partner, r.category, r.memo, r.drive_link, r.payment_method, r.state, r.business_use_ratio],
    }));

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
    const businessAfter = ports.sheets.getAllExpenses().map((r) => ({
      id: r.receipt_id,
      business: [r.receipt_type, r.date, r.amount, r.partner, r.category, r.memo, r.drive_link, r.payment_method, r.state, r.business_use_ratio],
    }));
    expect(businessAfter).toEqual(businessBefore);
  });

  it("MF 呼び出し・Slack 投稿はスクリプトロックの外で行う（作成・回収・取消・取り込み・通知のすべて）", () => {
    const { ports, api, lockViolations } = setup();
    api.postMode = "created_but_500";
    api.postModeRemaining = 1;
    add(ports, "R-CREATE-LOST"); // 応答喪失 → CREATING
    const j = api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-CANCEL"] });
    add(ports, "R-CANCEL", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: j.id });
    add(ports, "R-IMPORT-BAD", { mf_journal_id: "bad%3D" });
    add(ports, "R-REVIEW", { business_use_ratio: 10 });
    add(ports, "R-UNKNOWN", { mf_sync_state: "CREATING", mf_sync_attempted_at: NOW - 30 * HOUR, date: "2026-10-06" });

    syncExpenses(ports);
    syncExpenses(ports);

    expect(ports.http.calls.length).toBeGreaterThan(5);
    expect(ports.slack.posted.length).toBeGreaterThan(2);
    expect(lockViolations).toEqual([]);
  });
});

describe("B2: 作成直前の再読込で対象条件・入力の一致を確認する", () => {
  /** 最初の `GET /journals`（タグ検索）が来た瞬間に、人が台帳を編集した状況を再現する。 */
  function editDuringSearch(env: Env, receiptId: string, patch: Partial<ExpenseLedgerRow>): void {
    const prev = env.api.onRequest;
    let done = false;
    env.api.onRequest = (req) => {
      prev?.(req);
      if (!done && req.method === "get" && req.url.includes("/journals?")) {
        done = true;
        env.ports.sheets.updateExpense(receiptId, patch);
      }
    };
  }

  it("タグ検索中に「消耗品費・cash・100%」→「通信費・linked_card・50%」に変わったら POST しない。次回は NEEDS_REVIEW に再評価", () => {
    const env = setup();
    const { ports, api } = env;
    add(ports, "R-1", { mf_sync_state: "PENDING", category: "消耗品費", payment_method: "cash", business_use_ratio: 100 });
    editDuringSearch(env, "R-1", { category: "通信費", payment_method: "linked_card", business_use_ratio: 50 });

    syncExpenses(ports);

    expect(postCount(ports)).toBe(0);
    expect(api.journals).toHaveLength(0);
    const r = get(ports, "R-1");
    expect(r.mf_sync_state).toBe("PENDING"); // 状態は変えない
    expect(r.mf_sync_attempted_at).toBeNull();

    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    expect(postCount(ports)).toBe(0);
  });

  it("金額だけ変わった場合も、その実行では POST しない（古い入力で作らない）。次回は新しい入力で作る", () => {
    const env = setup();
    const { ports, api } = env;
    add(ports, "R-1", { mf_sync_state: "PENDING", amount: 1200 });
    editDuringSearch(env, "R-1", { amount: 1500 });

    syncExpenses(ports);
    expect(postCount(ports)).toBe(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("PENDING");

    syncExpenses(ports);
    expect(postCount(ports)).toBe(1);
    const body = api.postedBodies[0] as { journal: { branches: { debitor: { value: number } }[] } };
    expect(body.journal.branches[0]!.debitor.value).toBe(1500);
    expect(get(ports, "R-1").mf_sync_input).toBe("1500|2026-10-05|消耗品費|cash|");
  });

  it("本文・借方科目・保存する入力要約は同じスナップショット（再読込した行）から作る", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { category: "旅費交通費", amount: 700 });

    syncExpenses(ports);

    const body = api.postedBodies[0] as { journal: { branches: { debitor: { account_id: string; value: number } }[] } };
    expect(body.journal.branches[0]!.debitor).toEqual({ account_id: accountIdOf("旅費交通費"), value: 700 });
    expect(get(ports, "R-1").mf_sync_input).toBe("700|2026-10-05|旅費交通費|cash|");
  });

  it("人が処理状態を CORRECTED にした（COMPLETED でなくなった）場合も POST しない", () => {
    const env = setup();
    add(env.ports, "R-1", { mf_sync_state: "PENDING" });
    editDuringSearch(env, "R-1", { state: "CORRECTED" });

    syncExpenses(env.ports);

    expect(postCount(env.ports)).toBe(0);
  });
});

describe("M1: 日付を変えても作成時の日付で回収・取消できる", () => {
  it("作成後に応答を失い、台帳の日付を直して取消しても、作成時の日付で回収して DELETE できる", () => {
    const { ports, api } = setup();
    api.postMode = "created_but_500";
    api.postModeRemaining = 1;
    add(ports, "R-1", { date: "2026-10-05" });
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("CREATING");
    expect(api.journals[0]!.transaction_date).toBe("2026-10-05");

    ports.sheets.updateExpense("R-1", { date: "2026-10-06", state: "CORRECTED" });
    syncExpenses(ports);

    expect(api.journals).toHaveLength(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("REVERSED");
  });

  it("現在の日付と作成時の日付の両方で検索する（作成時の日付が先）", () => {
    const { ports } = setup();
    add(ports, "R-1", {
      mf_sync_state: "UNKNOWN",
      date: "2026-10-09",
      mf_sync_input: "1200|2026-10-05|消耗品費|cash|",
      mf_sync_attempted_at: NOW - 30 * HOUR,
    });

    syncExpenses(ports);

    const dates = ports.http.calls
      .filter((c) => c.url.includes("/journals?"))
      .map((c) => /start_date=([^&]*)/.exec(c.url)?.[1]);
    expect(dates).toEqual(["2026-10-05", "2026-10-09"]);
  });

  it("mf_sync_input が無い CREATING は、mf_sync_updated_at の前後 1 日と現在の日付で検索する", () => {
    const { ports, api } = setup();
    // 日付は 10/07 に直されたが、仕訳は前日（updated_at の前日 = 10/19）の transaction_date で作られていた。
    const j = api.plantJournal({ transaction_date: "2026-10-19", tags: ["R-1"] });
    add(ports, "R-1", {
      mf_sync_state: "CREATING",
      date: "2026-10-07",
      mf_sync_input: "",
      mf_sync_attempted_at: null,
      mf_sync_updated_at: NOW - HOUR,
    });

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: j.id });
    const range = ports.http.calls.find((c) => c.url.includes("/journals?"));
    expect(range?.url).toContain("start_date=2026-10-19");
    expect(range?.url).toContain("end_date=2026-10-21");
  });
});

describe("M2: セル単位の途中書込み失敗からの復旧", () => {
  it("作成前の書込み順は 試行時刻・入力要約・更新日時 → 状態（最後）", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_sync_state: "PENDING" });
    ports.sheets.cellWrites.length = 0;

    syncExpenses(ports);

    // PENDING のまま始めるので、最初の更新が CREATING への書込み。
    expect(ports.sheets.cellWrites.slice(0, 5)).toEqual([
      "mf_sync_error",
      "mf_sync_attempted_at",
      "mf_sync_input",
      "mf_sync_updated_at",
      "mf_sync_state",
    ]);
  });

  it.each([1, 2, 3, 4, 5])(
    "CREATING への書込みの %i 個目のセルで失敗しても、『CREATING なのに試行時刻・入力要約が無い』行を残さない。POST もしない。次回に作れる",
    (n) => {
      const { ports, api } = setup();
      add(ports, "R-1", { mf_sync_state: "PENDING" });
      ports.sheets.armFailAtCellWrite(n);

      expect(() => syncExpenses(ports)).toThrow(/CELL_WRITE_FAILED/);

      const r = get(ports, "R-1");
      if (r.mf_sync_state === "CREATING") {
        throw new Error("CREATING が残ってはいけない（状態は最後に書く）");
      }
      expect(r.mf_sync_state).toBe("PENDING");
      expect(postCount(ports)).toBe(0);
      expect(api.journals).toHaveLength(0);

      syncExpenses(ports);
      expect(get(ports, "R-1").mf_sync_state).toBe("SYNCED");
      expect(postCount(ports)).toBe(1);
    },
  );

  it("POST 成功後の SYNCED 書込みの途中（MF仕訳ID は保存、状態は未保存）で失敗 → 次回の回収で SYNCED。二重作成しない", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { mf_sync_state: "PENDING" });
    // CREATING への書込み 5 セル + SYNCED への書込み（mf_journal_id, mf_sync_error, mf_sync_updated_at, mf_sync_state）の 4 個目。
    ports.sheets.armFailAtCellWrite(9);

    expect(() => syncExpenses(ports)).toThrow(/CELL_WRITE_FAILED:mf_sync_state/);
    const mid = get(ports, "R-1");
    expect(mid.mf_sync_state).toBe("CREATING");
    expect(mid.mf_journal_id).toBe(api.journals[0]!.id); // ID は先に保存されている

    syncExpenses(ports);

    expect(get(ports, "R-1")).toMatchObject({ mf_sync_state: "SYNCED", mf_journal_id: api.journals[0]!.id });
    expect(postCount(ports)).toBe(1);
  });

  it("試行時刻が空の CREATING は mf_sync_updated_at を代わりに使い、24 時間後に UNKNOWN にして通知する", () => {
    const { ports } = setup();
    add(ports, "R-1", {
      mf_sync_state: "CREATING",
      mf_sync_attempted_at: null,
      mf_sync_input: "",
      mf_sync_updated_at: NOW - 30 * HOUR,
    });

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("UNKNOWN");
    expect(postedTexts(ports).filter((t) => t.includes("R-1"))).toHaveLength(1);
  });

  it("試行時刻も更新日時も無い CREATING は 24 時間の判定ができないので待つ（通知しない）", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_sync_state: "CREATING", mf_sync_attempted_at: null, mf_sync_updated_at: null, mf_sync_input: "" });

    syncExpenses(ports);

    expect(get(ports, "R-1").mf_sync_state).toBe("CREATING");
    expect(ports.slack.posted).toHaveLength(0);
  });
});

describe("M3: 予算のフェーズ別配分と巡回", () => {
  it("UNKNOWN 20 件＋新規 1 件でも、1 回の同期で新規が作られる", () => {
    const { ports } = setup();
    for (let i = 1; i <= 20; i++) {
      add(ports, `R-U${String(i).padStart(2, "0")}`, {
        mf_sync_state: "UNKNOWN",
        date: `2026-10-${String(i).padStart(2, "0")}`,
        mf_sync_attempted_at: NOW - 30 * HOUR,
        mf_sync_input: `1200|2026-10-${String(i).padStart(2, "0")}|消耗品費|cash|`,
      });
    }
    add(ports, "R-NEW", { date: "2026-10-25" });

    syncExpenses(ports);

    expect(get(ports, "R-NEW").mf_sync_state).toBe("SYNCED");
    expect(postCount(ports)).toBe(1);
  });

  it("維持作業は最大 10 行、新規が少なければ余りを維持作業の続きに回す（合計 20 行まで）", () => {
    const { ports } = setup();
    for (let i = 1; i <= 25; i++) {
      add(ports, `R-U${String(i).padStart(2, "0")}`, {
        mf_sync_state: "UNKNOWN",
        date: `2026-10-${String(i).padStart(2, "0")}`,
        mf_sync_attempted_at: NOW - 30 * HOUR,
        mf_sync_input: `1200|2026-10-${String(i).padStart(2, "0")}|消耗品費|cash|`,
      });
    }

    syncExpenses(ports);

    // 新規が無いので 20 行ぶん（1 行 1 回の検索）まで維持作業が進む。
    const searches = ports.http.calls.filter((c) => c.url.includes("/journals?"));
    expect(searches).toHaveLength(20);
  });

  it("新規が 10 行を超えて残っていても、維持作業に先に最大 10 行が割り当たる（新規は残り 10 行まで）", () => {
    const { ports } = setup();
    for (let i = 1; i <= 15; i++) {
      add(ports, `R-U${String(i).padStart(2, "0")}`, {
        mf_sync_state: "UNKNOWN",
        date: `2026-10-${String(i).padStart(2, "0")}`,
        mf_sync_attempted_at: NOW - 30 * HOUR,
        mf_sync_input: `1200|2026-10-${String(i).padStart(2, "0")}|消耗品費|cash|`,
      });
    }
    for (let i = 1; i <= 15; i++) {
      add(ports, `R-N${String(i).padStart(2, "0")}`, { date: "2026-10-28" });
    }

    syncExpenses(ports);

    expect(postCount(ports)).toBe(10);
    expect(ports.http.calls.filter((c) => c.url.includes("/journals?") && c.url.includes("2026-10-28")).length).toBe(10);
  });

  it("巡回位置 mf_sync/cursor を保存し、次回は続きから始める。後ろの REVERSING にも到達する", () => {
    const { ports, api } = setup();
    for (let i = 1; i <= 20; i++) {
      add(ports, `R-U${String(i).padStart(2, "0")}`, {
        mf_sync_state: "UNKNOWN",
        date: `2026-10-${String(i).padStart(2, "0")}`,
        mf_sync_attempted_at: NOW - 30 * HOUR,
        mf_sync_input: `1200|2026-10-${String(i).padStart(2, "0")}|消耗品費|cash|`,
      });
    }
    const j = api.plantJournal({ transaction_date: "2026-10-25", tags: ["R-REV"] });
    add(ports, "R-REV", { state: "CORRECTED", mf_sync_state: "REVERSING", mf_journal_id: j.id, date: "2026-10-25" });

    syncExpenses(ports);

    expect(get(ports, "R-REV").mf_sync_state).toBe("REVERSING"); // 1 回目は 20 行で打ち切り。REVERSING は 21 行目
    expect(ports.sheets.getInternalValue("mf_sync", "cursor")).toBe("R-U20");

    syncExpenses(ports);

    expect(get(ports, "R-REV").mf_sync_state).toBe("REVERSED");
    expect(api.journals).toHaveLength(0);
  });

  it("全件を処理し終えたら巡回位置は空に戻る", () => {
    const { ports } = setup();
    add(ports, "R-U1", { mf_sync_state: "UNKNOWN", mf_sync_attempted_at: NOW - 30 * HOUR });

    syncExpenses(ports);

    expect(ports.sheets.getInternalValue("mf_sync", "cursor") ?? "").toBe("");
  });

  it("既に『見つかりません』と記録した手入力 ID の行は、ID が直るまで予算を使わない（毎回 GET しない）", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_journal_id: "typo%3D%3D" });
    syncExpenses(ports);
    expect(get(ports, "R-1").mf_sync_state).toBe("NEEDS_REVIEW");
    const calls = ports.http.calls.length;

    syncExpenses(ports);

    expect(ports.http.calls.length).toBe(calls);
  });
});

describe("M4: 仕訳検索のページ取得ループでも絶対期限を確認する", () => {
  it("検索の途中で期限切れ: 『見つからなかった』と読んで POST することはなく、状態は変わらない（次回に続ける）", () => {
    const { ports, api } = setup();
    for (let i = 0; i < 250; i++) {
      api.plantJournal({ transaction_date: "2026-10-05", tags: [`other-${i}`] });
    }
    add(ports, "R-1", { mf_sync_state: "PENDING" });
    // 1 ページ取るごとに 3 分かかる（3 ページ必要。2 ページ目は 4 分以内に始まるが、3 ページ目の前に期限切れ）。
    api.onRequest = (req) => {
      if (req.method === "get" && req.url.includes("/journals?")) {
        ports.clock.currentMs += 3 * 60 * 1000;
      }
    };

    expect(() => syncExpenses(ports)).not.toThrow();

    expect(postCount(ports)).toBe(0);
    expect(accountingCallsOf(ports).filter((c) => c === "GET /journals")).toHaveLength(2);
    const r = get(ports, "R-1");
    expect(r.mf_sync_state).toBe("PENDING");
    expect(r.mf_sync_attempted_at).toBeNull();
  });

  it("渡された絶対期限（trigMfSync 開始基準）が既に過ぎていれば、MF を一切呼ばない", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_sync_state: "CREATING", mf_sync_attempted_at: NOW - HOUR });
    const deadline = new RunDeadline(ports.clock, 4 * 60 * 1000);
    ports.clock.currentMs += 5 * 60 * 1000;

    syncExpenses(ports, deadline);

    expect(accountingCallsOf(ports)).toHaveLength(0);
    expect(get(ports, "R-1").mf_sync_state).toBe("CREATING");
  });
});

describe("実行単位（§6.8）", () => {
  it("API を呼ぶ行は 1 回 20 行まで。残りは次の実行が続きから処理する", () => {
    const { ports } = setup();
    for (let i = 1; i <= 25; i++) {
      add(ports, `R-${String(i).padStart(3, "0")}`, { date: "2026-10-05" });
    }

    syncExpenses(ports);

    const synced1 = ports.sheets.getAllExpenses().filter((r) => r.mf_sync_state === "SYNCED");
    expect(synced1).toHaveLength(20);
    expect(postCount(ports)).toBe(20);

    syncExpenses(ports);

    expect(ports.sheets.getAllExpenses().filter((r) => r.mf_sync_state === "SYNCED")).toHaveLength(25);
    expect(postCount(ports)).toBe(25);
  });

  it("実行開始から 4 分たったら新しい行に手を付けずに終える。次の実行が続きから再開する", () => {
    const { ports, api } = setup();
    for (let i = 1; i <= 3; i++) {
      add(ports, `R-00${i}`);
    }
    // 1 行目の POST が 5 分かかったことにする。
    api.onRequest = (req) => {
      if (req.method === "post" && req.url.includes("/journals")) {
        ports.clock.currentMs += 5 * 60 * 1000;
      }
    };

    syncExpenses(ports);
    expect(postCount(ports)).toBe(1);
    expect(get(ports, "R-001").mf_sync_state).toBe("SYNCED");
    expect(get(ports, "R-002").mf_sync_state).toBe("PENDING"); // 状態の判定は進めるが API は呼ばない

    syncExpenses(ports);
    expect(postCount(ports)).toBe(2);
    expect(get(ports, "R-002").mf_sync_state).toBe("SYNCED");

    syncExpenses(ports);
    expect(get(ports, "R-003").mf_sync_state).toBe("SYNCED");
    expect(api.journals).toHaveLength(3);
  });

  it("MF の呼び出しを含まない状態の判定（NOT_TARGET など）は予算を消費しない", () => {
    const { ports } = setup();
    for (let i = 1; i <= 30; i++) {
      add(ports, `R-OLD-${i}`, { date: "2026-09-01" });
    }
    add(ports, "R-NEW");

    syncExpenses(ports);

    expect(get(ports, "R-NEW").mf_sync_state).toBe("SYNCED");
  });
});

describe("weeklyJournalReport（§6.6 週次の報告の仕訳部分）", () => {
  it("同じ証憑 ID のタグの仕訳が 2 件以上あれば列挙する", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { mf_sync_state: "SYNCED" });
    add(ports, "R-2", { mf_sync_state: "SYNCED" });
    api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });
    api.plantJournal({ transaction_date: "2026-10-06", tags: ["R-1", "x"] });
    api.plantJournal({ transaction_date: "2026-10-07", tags: ["R-2"] });

    weeklyJournalReport(ports);

    expect(ports.slack.posted).toHaveLength(1);
    const text = ports.slack.posted[0]!.text;
    expect(text).toContain("二重作成の疑い");
    expect(text).toContain("R-1");
    expect(text).not.toContain("R-2");
  });

  it("NEEDS_REVIEW・UNKNOWN の行の件数を報告する", () => {
    const { ports } = setup();
    add(ports, "R-1", { mf_sync_state: "NEEDS_REVIEW" });
    add(ports, "R-2", { mf_sync_state: "NEEDS_REVIEW" });
    add(ports, "R-3", { mf_sync_state: "UNKNOWN" });
    add(ports, "R-4", { mf_sync_state: "SYNCED" });

    weeklyJournalReport(ports);

    const text = ports.slack.posted[0]!.text;
    expect(text).toContain("NEEDS_REVIEW 2 件");
    expect(text).toContain("UNKNOWN 1 件");
  });

  it("報告することが無ければ投稿しない", () => {
    const { ports, api } = setup();
    add(ports, "R-1", { mf_sync_state: "SYNCED" });
    api.plantJournal({ transaction_date: "2026-10-05", tags: ["R-1"] });

    weeklyJournalReport(ports);

    expect(ports.slack.posted).toHaveLength(0);
  });

  it("MF_ENABLED が無効なら HTTP 0 件・投稿なし", () => {
    const { ports } = setup({ mf: false });
    add(ports, "R-1", { mf_sync_state: "NEEDS_REVIEW" });
    weeklyJournalReport(ports);
    expect(ports.http.calls).toHaveLength(0);
    expect(ports.slack.posted).toHaveLength(0);
  });

  it("MF_SYNC_START_DATE 以降を暦年（366 日以内）で分割して取得する", () => {
    const { ports } = setup();
    ports.clock.currentMs = Date.parse("2028-03-10T09:00:00+09:00");

    weeklyJournalReport(ports);

    const ranges = ports.http.calls
      .filter((c) => c.url.includes("/journals?"))
      .map((c) => `${/start_date=([^&]*)/.exec(c.url)?.[1]}..${/end_date=([^&]*)/.exec(c.url)?.[1]}`);
    expect(ranges).toEqual(["2026-10-01..2026-12-31", "2027-01-01..2027-12-31", "2028-01-01..2028-03-10"]);
  });
});
