/**
 * `core/journalSync.ts`（実装設計 MF連携 §6.2〜§6.4, §2.2, §6.1）の純関数テスト。
 */
import { describe, expect, it } from "vitest";
import {
  CATEGORY_ACCOUNT_NAMES,
  IMPORTABLE_STATES,
  JOURNAL_ACCOUNT_NAMES,
  JOURNAL_SYNC_STATES,
  NO_JOURNAL_STATES,
  buildJournalRequestBody,
  buildMemo,
  buildRemark,
  buildTags,
  buildJournalUpdateBody,
  buildJournalizeBody,
  buildRuleJournalizeBody,
  buildRuleRemark,
  buildVoidRemark,
  buildVoidTags,
  canTransition,
  cancellationRoute,
  journalMatchesUpdate,
  classifyTransaction,
  debitAccountNameOf,
  decideSyncTarget,
  findDuplicateReceiptTags,
  hasInputChanged,
  holdsJournalAncestor,
  indexLedgerRows,
  initialStateFor,
  inputTransactionId,
  isCancelledExpenseState,
  isCandidateFor,
  isJournalSyncState,
  isNoCandidateNoticeDue,
  isRuleUsable,
  isWaitingForTransaction,
  journalHasTag,
  journalIdOf,
  matchTransactions,
  parseTransactions,
  planLinkedCancellation,
  ruleDefects,
  ruleProblems,
  serviceKindOf,
  shiftDate,
  singleBranchOf,
  splitDateRangeBySpan,
  splitRangeByCalendarYear,
  summarizeSyncInput,
  transactionKey,
  unescapeSheetFormula,
  usedTransactionKeys,
  type LedgerRowView,
  type MfTransaction,
  type MfTransactionRule,
  type SyncRowView,
} from "../src/core/journalSync";
import { EXPENSE_CATEGORIES } from "@kadobo/shared/expense";

const START = "2026-10-01";

function row(overrides: Partial<SyncRowView> = {}): SyncRowView {
  return {
    receipt_id: "R-20261005-001",
    date: "2026-10-05",
    amount: 1200,
    partner: "○○商店",
    category: "消耗品費",
    drive_link: "https://drive.example.test/x",
    state: "COMPLETED",
    business_use_ratio: 100,
    payment_method: "cash",
    mf_journal_id: null,
    mf_transaction_id: null,
    mf_sync_input: "",
    ...overrides,
  };
}

describe("decideSyncTarget（§6.2）", () => {
  it("COMPLETED・開業日以降・支払方法あり・割合 100 は ready（支払方法を持つ）", () => {
    expect(decideSyncTarget(row(), START)).toEqual({ kind: "ready", method: "cash" });
    expect(decideSyncTarget(row({ payment_method: "linked_card" }), START)).toEqual({
      kind: "ready",
      method: "linked_card",
    });
  });

  it("開業日と同日は対象（>=）。開業前の日付だけ not_target", () => {
    expect(decideSyncTarget(row({ date: "2026-10-01" }), START).kind).toBe("ready");
    expect(decideSyncTarget(row({ date: "2026-09-30" }), START)).toEqual({ kind: "not_target" });
  });

  it("登録中（RECEIVED・FILE_SAVED）は待つ（永久に対象外にしない）", () => {
    expect(decideSyncTarget(row({ state: "RECEIVED" }), START)).toEqual({ kind: "wait", reason: "registering" });
    expect(decideSyncTarget(row({ state: "FILE_SAVED" }), START)).toEqual({ kind: "wait", reason: "registering" });
  });

  it("ERROR・CORRECTED・VOID の処理状態は作成対象にならない（待つ）", () => {
    for (const state of ["ERROR", "CORRECTED", "VOID"] as const) {
      expect(decideSyncTarget(row({ state }), START)).toEqual({ kind: "wait", reason: "not_completed" });
    }
  });

  it("支払方法が空なら待つ。後から記入すれば同じ関数で ready になる", () => {
    expect(decideSyncTarget(row({ payment_method: "" }), START)).toEqual({ kind: "wait", reason: "no_payment_method" });
    expect(decideSyncTarget(row({ payment_method: "cash" }), START).kind).toBe("ready");
  });

  it("事業使用割合が 100 未満は needs_review（理由に割合を含む）", () => {
    const d = decideSyncTarget(row({ business_use_ratio: 50 }), START);
    expect(d.kind).toBe("needs_review");
    if (d.kind === "needs_review") {
      expect(d.reason).toContain("50");
    }
  });

  it("MF_SYNC_START_DATE が未設定なら同期しない", () => {
    expect(decideSyncTarget(row(), null)).toEqual({ kind: "wait", reason: "no_start_date" });
    expect(decideSyncTarget(row(), "")).toEqual({ kind: "wait", reason: "no_start_date" });
  });
});

describe("initialStateFor（§6.3「（空）」の行）", () => {
  it("cash → PENDING、linked_* → WAITING_TRANSACTION、割合 100 未満 → NEEDS_REVIEW、開業前 → NOT_TARGET、待ち → 書かない", () => {
    expect(initialStateFor({ kind: "ready", method: "cash" })).toBe("PENDING");
    expect(initialStateFor({ kind: "ready", method: "linked_card" })).toBe("WAITING_TRANSACTION");
    expect(initialStateFor({ kind: "ready", method: "linked_bank" })).toBe("WAITING_TRANSACTION");
    expect(initialStateFor({ kind: "needs_review", reason: "x" })).toBe("NEEDS_REVIEW");
    expect(initialStateFor({ kind: "not_target" })).toBe("NOT_TARGET");
    expect(initialStateFor({ kind: "wait", reason: "registering" })).toBeNull();
  });
});

describe("状態の型と遷移（§6.3, §6.4, §6.7）", () => {
  it("§6.3 の 11 状態が定義されている", () => {
    expect([...JOURNAL_SYNC_STATES].sort()).toEqual(
      [
        "NOT_TARGET", "PENDING", "CREATING", "WAITING_TRANSACTION", "JOURNALIZING", "UNKNOWN",
        "NEEDS_REVIEW", "SYNCED", "REVERSING", "REVERSED", "ERROR",
      ].sort(),
    );
    expect(isJournalSyncState("")).toBe(true);
    expect(isJournalSyncState("SYNCED")).toBe(true);
    expect(isJournalSyncState("synced")).toBe(false);
  });

  it("② の主経路: 空 → PENDING → CREATING → SYNCED → REVERSING → REVERSED", () => {
    const path = ["", "PENDING", "CREATING", "SYNCED", "REVERSING", "REVERSED"] as const;
    for (let i = 0; i + 1 < path.length; i++) {
      expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("CREATING からは SYNCED・UNKNOWN・ERROR・PENDING（429 で戻す）に進める。UNKNOWN から作り直しには進めない", () => {
    for (const to of ["SYNCED", "UNKNOWN", "ERROR", "PENDING"] as const) {
      expect(canTransition("CREATING", to)).toBe(true);
    }
    expect(canTransition("UNKNOWN", "PENDING")).toBe(false);
    expect(canTransition("UNKNOWN", "CREATING")).toBe(false);
    expect(canTransition("UNKNOWN", "SYNCED")).toBe(true);
  });

  it("終端（NOT_TARGET・REVERSED・ERROR）から kadobo は動かさない。SYNCED は NEEDS_REVIEW か REVERSING にだけ進む", () => {
    for (const s of ["NOT_TARGET", "REVERSED", "ERROR"] as const) {
      for (const to of JOURNAL_SYNC_STATES) {
        if (to !== s) {
          expect(canTransition(s, to)).toBe(false);
        }
      }
    }
    expect(canTransition("SYNCED", "NEEDS_REVIEW")).toBe(true);
    expect(canTransition("SYNCED", "REVERSING")).toBe(true);
    expect(canTransition("SYNCED", "PENDING")).toBe(false);
  });

  it("③ の状態（WAITING_TRANSACTION → JOURNALIZING → SYNCED）も定義されている", () => {
    expect(canTransition("WAITING_TRANSACTION", "JOURNALIZING")).toBe(true);
    expect(canTransition("JOURNALIZING", "SYNCED")).toBe(true);
    expect(canTransition("JOURNALIZING", "NEEDS_REVIEW")).toBe(true);
  });

  it("仕訳が無い状態・取り込み対象の状態", () => {
    expect([...NO_JOURNAL_STATES]).toEqual(["", "PENDING", "WAITING_TRANSACTION", "NEEDS_REVIEW"]);
    expect(IMPORTABLE_STATES).toContain("UNKNOWN");
    expect(IMPORTABLE_STATES).not.toContain("SYNCED");
  });

  it("isCancelledExpenseState: CORRECTED・VOID だけ", () => {
    expect(isCancelledExpenseState("CORRECTED")).toBe(true);
    expect(isCancelledExpenseState("VOID")).toBe(true);
    expect(isCancelledExpenseState("COMPLETED")).toBe(false);
  });
});

describe("科目対応表（§6.4）", () => {
  it("6 カテゴリは同名、その他は雑費", () => {
    for (const c of EXPENSE_CATEGORIES) {
      expect(debitAccountNameOf(c)).toBe(c === "その他" ? "雑費" : c);
    }
    expect(CATEGORY_ACCOUNT_NAMES["その他"]).toBe("雑費");
  });

  it("連携で名前引きする 8 科目（S-M3 と同じ）。貸方は事業主借", () => {
    expect([...JOURNAL_ACCOUNT_NAMES]).toEqual([
      "通信費", "消耗品費", "旅費交通費", "新聞図書費", "会議費", "支払手数料", "雑費", "事業主借",
    ]);
  });
});

describe("remark・memo・tags（§2.2, §6.4）", () => {
  it("remark は `{証憑ID} {取引先}`", () => {
    expect(buildRemark("R-20261005-001", "○○商店")).toBe("R-20261005-001 ○○商店");
  });

  it("remark は 200 字（コードポイント）で切る。絵文字（サロゲートペア）を壊さない", () => {
    const long = "あ".repeat(300);
    expect(Array.from(buildRemark("R-1", long))).toHaveLength(200);
    const emoji = "😀".repeat(300);
    const cut = buildRemark("R-1", emoji);
    expect(Array.from(cut)).toHaveLength(200);
    expect(cut.endsWith("😀")).toBe(true);
  });

  it("台帳の数式対策の先頭 `'` は MF に送らない", () => {
    expect(unescapeSheetFormula("'=SUM(A1)")).toBe("=SUM(A1)");
    expect(unescapeSheetFormula("'普通の')")).toBe("'普通の')");
    expect(buildRemark("R-1", "'+1商店")).toBe("R-1 +1商店");
  });

  it("memo は Drive リンク。空・200 字超は省略（undefined）", () => {
    expect(buildMemo("https://drive.example.test/x")).toBe("https://drive.example.test/x");
    expect(buildMemo("")).toBeUndefined();
    expect(buildMemo("h".repeat(201))).toBeUndefined();
    expect(buildMemo("h".repeat(200))).toBe("h".repeat(200));
  });

  it("tags は [証憑ID]", () => {
    expect(buildTags("R-1")).toEqual(["R-1"]);
  });
});

describe("mf_sync_input の要約と変更検出（§6.1 列 31）", () => {
  it("`金額|日付|カテゴリ|支払方法|明細ID`", () => {
    expect(summarizeSyncInput(row())).toBe("1200|2026-10-05|消耗品費|cash|");
    expect(summarizeSyncInput(row({ mf_transaction_id: "tx%3D%3D", payment_method: "linked_card" }))).toBe(
      "1200|2026-10-05|消耗品費|linked_card|tx%3D%3D",
    );
  });

  it("保存済みの要約と違えば変更あり。同じ・空（要約なし）は変更なし", () => {
    const saved = summarizeSyncInput(row());
    expect(hasInputChanged(row({ mf_sync_input: saved }))).toBe(false);
    expect(hasInputChanged(row({ mf_sync_input: saved, amount: 1300 }))).toBe(true);
    expect(hasInputChanged(row({ mf_sync_input: saved, date: "2026-10-06" }))).toBe(true);
    expect(hasInputChanged(row({ mf_sync_input: saved, category: "通信費" }))).toBe(true);
    expect(hasInputChanged(row({ mf_sync_input: saved, payment_method: "linked_bank" }))).toBe(true);
    expect(hasInputChanged(row({ mf_sync_input: "" }))).toBe(false);
  });

  it("業務列のうち要約に入らない取引先・メモの変更は検出しない（設計どおり）", () => {
    const saved = summarizeSyncInput(row());
    expect(hasInputChanged(row({ mf_sync_input: saved, partner: "別の店" }))).toBe(false);
  });
});

describe("POST /journals 本文（§6.4）", () => {
  const ids = { debit: "acc%2B6%3D%3D", credit: "acc%2B7%3D%3D" };

  it("transaction_date・journal_type・借方/貸方・remark・memo・tags を組み立てる。ID はそのまま（エンコードしない）", () => {
    const body = buildJournalRequestBody(row(), ids);
    expect(body).toEqual({
      journal: {
        transaction_date: "2026-10-05",
        journal_type: "journal_entry",
        branches: [
          {
            debitor: { account_id: "acc%2B6%3D%3D", value: 1200 },
            creditor: { account_id: "acc%2B7%3D%3D", value: 1200 },
            remark: "R-20261005-001 ○○商店",
          },
        ],
        memo: "https://drive.example.test/x",
        tags: ["R-20261005-001"],
      },
    });
  });

  it("`tax_id`・`invoice_kind` をどこにも含めない（免税事業者は税区分を登録できない。§3.2）", () => {
    const json = JSON.stringify(buildJournalRequestBody(row(), ids));
    expect(json).not.toContain("tax_id");
    expect(json).not.toContain("invoice_kind");
    expect(json).not.toContain("tax_value");
  });

  it("memo が省略できるとき（Drive リンクが空）はキー自体を付けない", () => {
    const body = buildJournalRequestBody(row({ drive_link: "" }), ids);
    expect("memo" in body.journal).toBe(false);
  });
});

describe("GET /journals の応答の読み取り", () => {
  it("journalIdOf: 文字列はそのまま（パーセントエンコードを変えない）。数値は文字列化。無ければ null", () => {
    expect(journalIdOf({ id: "tfAQ%2BSn%2F%3D" })).toBe("tfAQ%2BSn%2F%3D");
    expect(journalIdOf({ id: 12 })).toBe("12");
    expect(journalIdOf({})).toBeNull();
  });

  it("journalHasTag: tags に完全一致で含まれるときだけ true", () => {
    expect(journalHasTag({ tags: ["R-1", "x"] }, "R-1")).toBe(true);
    expect(journalHasTag({ tags: ["R-10"] }, "R-1")).toBe(false);
    expect(journalHasTag({ tags: "R-1" }, "R-1")).toBe(false);
    expect(journalHasTag({}, "R-1")).toBe(false);
  });

  it("findDuplicateReceiptTags: 同じ証憑 ID のタグの仕訳が 2 件以上のものだけ。他のタグは数えない", () => {
    const journals = [
      { id: "a", tags: ["R-1"] },
      { id: "b", tags: ["R-1", "kadobo-rule"] },
      { id: "c", tags: ["R-2"] },
      { id: "d", tags: ["kadobo-rule"] },
      { id: "e", tags: ["kadobo-rule"] },
    ];
    expect(findDuplicateReceiptTags(journals, new Set(["R-1", "R-2"]))).toEqual([
      { receiptId: "R-1", journalIds: ["a", "b"] },
    ]);
  });

  it("同じ仕訳が重複して返っても 1 件と数える（仕訳 ID で重複除去）", () => {
    const j = { id: "a", tags: ["R-1"] };
    expect(findDuplicateReceiptTags([j, j], new Set(["R-1"]))).toEqual([]);
  });
});

describe("splitRangeByCalendarYear（週次報告の取得範囲。各区間は 366 日以内）", () => {
  it("同じ年なら 1 区間", () => {
    expect(splitRangeByCalendarYear("2026-10-01", "2026-12-20")).toEqual([{ start: "2026-10-01", end: "2026-12-20" }]);
  });

  it("暦年の境目で分割する", () => {
    expect(splitRangeByCalendarYear("2026-10-01", "2028-02-10")).toEqual([
      { start: "2026-10-01", end: "2026-12-31" },
      { start: "2027-01-01", end: "2027-12-31" },
      { start: "2028-01-01", end: "2028-02-10" },
    ]);
  });

  it("start > end なら空", () => {
    expect(splitRangeByCalendarYear("2026-10-02", "2026-10-01")).toEqual([]);
  });
});


// ===========================================================================
// WP-M5: ③ 連携明細との照合（実装設計 §6.5・§6.6・§6.7）
// ===========================================================================

function ledger(id: string, o: Partial<LedgerRowView> = {}): LedgerRowView {
  return {
    receipt_id: id,
    date: "2026-10-10",
    amount: 1200,
    partner: "○○商店",
    category: "消耗品費",
    drive_link: "https://drive.example.test/x",
    state: "COMPLETED",
    business_use_ratio: 100,
    payment_method: "linked_card",
    mf_journal_id: null,
    mf_transaction_id: null,
    mf_sync_input: "",
    mf_sync_state: "WAITING_TRANSACTION",
    correction_of_receipt_id: null,
    input_at: 1,
    ...o,
  };
}

function tx(id: string, o: Partial<MfTransaction> = {}): MfTransaction {
  return {
    id,
    date: "2026-10-10",
    value: 1200,
    side: "EXPENSE",
    content: "コンビニ",
    status: "none",
    connected_account_id: "card%2Bsvc%3D",
    service: "card",
    ...o,
  };
}

function rule(o: Partial<MfTransactionRule> = {}): MfTransactionRule {
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

describe("serviceKindOf・shiftDate・splitDateRangeBySpan（§6.5）", () => {
  it("linked_card → card、linked_bank → bank、cash・空 → null", () => {
    expect(serviceKindOf("linked_card")).toBe("card");
    expect(serviceKindOf("linked_bank")).toBe("bank");
    expect(serviceKindOf("cash")).toBeNull();
    expect(serviceKindOf("")).toBeNull();
  });

  it("shiftDate は暦日で移動する（月・年またぎ）", () => {
    expect(shiftDate("2026-10-01", -3)).toBe("2026-09-28");
    expect(shiftDate("2026-12-30", 5)).toBe("2027-01-04");
  });

  it("366 日以内は 1 区間、差がちょうど 366 日でも 1 区間、367 日を超えれば分割する（各区間の差は 366 日以内）", () => {
    expect(splitDateRangeBySpan("2026-10-01", "2026-10-20")).toEqual([{ start: "2026-10-01", end: "2026-10-20" }]);
    expect(splitDateRangeBySpan("2026-10-01", shiftDate("2026-10-01", 366))).toHaveLength(1);
    const two = splitDateRangeBySpan("2026-10-01", shiftDate("2026-10-01", 367));
    expect(two).toEqual([
      { start: "2026-10-01", end: shiftDate("2026-10-01", 366) },
      { start: shiftDate("2026-10-01", 367), end: shiftDate("2026-10-01", 367) },
    ]);
    const long = splitDateRangeBySpan("2026-10-01", "2028-12-31");
    expect(long.length).toBe(3);
    for (const r of long) {
      expect((Date.parse(r.end) - Date.parse(r.start)) / 86_400_000).toBeLessThanOrEqual(366);
    }
    // 連続していて、抜け・重なりが無い。
    expect(long[0]!.start).toBe("2026-10-01");
    expect(long[long.length - 1]!.end).toBe("2028-12-31");
    for (let i = 1; i < long.length; i++) {
      expect(long[i]!.start).toBe(shiftDate(long[i - 1]!.end, 1));
    }
  });

  it("start > end なら空", () => {
    expect(splitDateRangeBySpan("2026-10-02", "2026-10-01")).toEqual([]);
  });
});

describe("parseTransactions（GET /transactions の応答）", () => {
  it("ID はそのまま。id・date・value が読めない要素は除く。連携サービスの種別を付ける", () => {
    const res = {
      transactions: [
        { id: "a%2B1%3D", date: "2026-10-05", value: 1200, side: "EXPENSE", content: "店", journalizing_status: "none", connected_account_id: "c%3D" },
        { id: "", date: "2026-10-05", value: 1 },
        { id: "b", date: "bad", value: 1 },
        { id: "c", date: "2026-10-05", value: "x" },
        { id: "d", date: "2026-10-06", value: "300" },
      ],
    };
    const out = parseTransactions(res, "bank");
    expect(out.map((t) => t.id)).toEqual(["a%2B1%3D", "d"]);
    expect(out[0]).toMatchObject({ value: 1200, side: "EXPENSE", content: "店", status: "none", service: "bank", connected_account_id: "c%3D" });
    expect(out[1]!.value).toBe(300);
    expect(parseTransactions({}, "card")).toEqual([]);
  });

  it("transactionKey はエンコードの有無を吸収する", () => {
    expect(transactionKey("a%2Bb%3D")).toBe("a+b=");
    expect(transactionKey("a+b=")).toBe("a+b=");
  });
});

describe("明細ルールの検証（§6.6）", () => {
  it("正常なルールは不備なし・使える", () => {
    expect(ruleDefects(rule())).toEqual([]);
    expect(ruleProblems(rule())).toEqual([]);
    expect(isRuleUsable(rule())).toBe(true);
    expect(isRuleUsable(rule({ action: "無視", account: "", amount: null }))).toBe(true);
  });

  it("内容に含む文字列が空（空白だけも）は無効。有効が TRUE でないルールは使わず、理由に出る", () => {
    expect(ruleDefects(rule({ content: "" }))[0]).toContain("内容に含む文字列が空");
    expect(isRuleUsable(rule({ content: "   " }))).toBe(false);
    expect(isRuleUsable(rule({ enabled: false }))).toBe(false);
    expect(ruleProblems(rule({ enabled: false })).join()).toContain("有効が TRUE ではありません");
    expect(ruleDefects(rule({ enabled: false }))).toEqual([]);
  });

  it("対象・処理の不正、金額が数値でない、私用なのに勘定科目が空、ルール名が空は不備", () => {
    expect(ruleDefects(rule({ target: "all" })).join()).toContain("対象");
    expect(ruleDefects(rule({ action: "削除" })).join()).toContain("処理");
    expect(ruleDefects(rule({ amount: Number.NaN })).join()).toContain("金額");
    expect(ruleDefects(rule({ account: "" })).join()).toContain("勘定科目が空");
    expect(ruleDefects(rule({ action: "無視", account: "" }))).toEqual([]);
    expect(ruleDefects(rule({ name: "" })).join()).toContain("ルール名");
  });
});

describe("classifyTransaction（§6.6。上から順に最初の一致）", () => {
  const nisa = "SBI証券投信積立サ-ビス(翌月買付分)";

  it("対象 card／bank は取得元と一致するときだけ、any はどちらでも当たる", () => {
    const rs = [rule({ target: "card", amount: null })];
    expect(classifyTransaction({ content: nisa, value: 10000 }, rs, "card")?.index).toBe(0);
    expect(classifyTransaction({ content: nisa, value: 10000 }, rs, "bank")).toBeNull();
    const bank = [rule({ target: "bank", amount: null })];
    expect(classifyTransaction({ content: nisa, value: 10000 }, bank, "bank")?.index).toBe(0);
    expect(classifyTransaction({ content: nisa, value: 10000 }, bank, "card")).toBeNull();
    const any = [rule({ target: "any", amount: null })];
    expect(classifyTransaction({ content: nisa, value: 1 }, any, "card")?.index).toBe(0);
    expect(classifyTransaction({ content: nisa, value: 1 }, any, "bank")?.index).toBe(0);
  });

  it("内容は部分一致。金額があれば一致を要求する（空なら金額を問わない）", () => {
    const withAmount = [rule({ amount: 10000 })];
    expect(classifyTransaction({ content: nisa, value: 10000 }, withAmount, "card")).not.toBeNull();
    expect(classifyTransaction({ content: nisa, value: 10001 }, withAmount, "card")).toBeNull();
    expect(classifyTransaction({ content: "別の店", value: 10000 }, withAmount, "card")).toBeNull();
    const noAmount = [rule({ amount: null })];
    expect(classifyTransaction({ content: nisa, value: 99 }, noAmount, "card")).not.toBeNull();
  });

  it("上から順に見て最初に当たったルールを使う（後ろのルールは見ない）", () => {
    const rs = [
      rule({ name: "先", action: "無視", account: "", amount: null }),
      rule({ name: "後", action: "私用として仕訳", amount: null }),
    ];
    const hit = classifyTransaction({ content: nisa, value: 10000 }, rs, "card");
    expect(hit?.rule.name).toBe("先");
    expect(hit?.index).toBe(0);
  });

  it("内容が空のルール・有効でないルールは無視して、次のルールを見る", () => {
    const rs = [
      rule({ name: "空", content: "", amount: null }),
      rule({ name: "停止", enabled: false, amount: null }),
      rule({ name: "有効", amount: null }),
    ];
    const hit = classifyTransaction({ content: nisa, value: 1 }, rs, "card");
    expect(hit?.rule.name).toBe("有効");
    expect(hit?.index).toBe(2);
    expect(classifyTransaction({ content: "何でも", value: 1 }, [rule({ content: "" })], "card")).toBeNull();
  });

  it("全角半角・大文字小文字の違いを吸収して一致する（NFKC）", () => {
    const rs = [rule({ content: "ﾐﾂｲｽﾐﾄﾓｶ", target: "bank", action: "無視", account: "", amount: null })];
    expect(classifyTransaction({ content: "ミツイスミトモカ-ド (カ", value: 80000 }, rs, "bank")).not.toBeNull();
    expect(classifyTransaction({ content: "ｓｂｉ証券", value: 1 }, [rule({ content: "SBI", amount: null })], "card")).not.toBeNull();
  });
});

describe("inputTransactionId（mf_sync_input の 5 番目の項目）", () => {
  it("kadobo が押さえた明細 ID を取り出す。要約が空・明細 ID が無ければ null", () => {
    expect(inputTransactionId("1200|2026-10-10|消耗品費|linked_card|t%2B1%3D")).toBe("t%2B1%3D");
    expect(inputTransactionId("1200|2026-10-10|消耗品費|cash|")).toBeNull();
    expect(inputTransactionId("")).toBeNull();
  });
});

describe("usedTransactionKeys・isCandidateFor（§6.5）", () => {
  it("使用中の状態は JOURNALIZING・SYNCED・REVERSING・NEEDS_REVIEW。REVERSED・ERROR・WAITING・空は手放している", () => {
    const rows = [
      ledger("a", { mf_sync_state: "JOURNALIZING", mf_transaction_id: "t1%3D" }),
      ledger("b", { mf_sync_state: "SYNCED", mf_transaction_id: "t2%3D" }),
      ledger("c", { mf_sync_state: "REVERSING", mf_transaction_id: "t3%3D" }),
      ledger("d", { mf_sync_state: "NEEDS_REVIEW", mf_transaction_id: "t4%3D" }),
      ledger("e", { mf_sync_state: "REVERSED", mf_transaction_id: "t5%3D" }),
      ledger("f", { mf_sync_state: "ERROR", mf_transaction_id: "t6%3D" }),
      ledger("g", { mf_sync_state: "WAITING_TRANSACTION", mf_transaction_id: "t7%3D" }),
      ledger("h", { mf_sync_state: "SYNCED", mf_transaction_id: null }),
    ];
    expect([...usedTransactionKeys(rows)].sort()).toEqual(["t1=", "t2=", "t3=", "t4="]);
    expect([...usedTransactionKeys(rows, "a")].sort()).toEqual(["t2=", "t3=", "t4="]);
  });

  it("候補の条件: 連携サービス・金額・日付 [日付 − 2, 日付 + 5]（両端を含む）", () => {
    const row = { payment_method: "linked_card" as const, amount: 1200, date: "2026-10-10" };
    expect(isCandidateFor(row, tx("t", { date: "2026-10-07" }))).toBe(false);
    expect(isCandidateFor(row, tx("t", { date: "2026-10-08" }))).toBe(true);
    expect(isCandidateFor(row, tx("t", { date: "2026-10-15" }))).toBe(true);
    expect(isCandidateFor(row, tx("t", { date: "2026-10-16" }))).toBe(false);
    expect(isCandidateFor(row, tx("t", { value: 1201 }))).toBe(false);
    expect(isCandidateFor(row, tx("t", { service: "bank" }))).toBe(false);
    expect(isCandidateFor({ ...row, payment_method: "cash" }, tx("t"))).toBe(false);
  });
});

describe("matchTransactions（§6.5 の表駆動。一対一のときだけ確定）", () => {
  it("候補 0 件 → none。候補 1 件で他の待ち行と取り合わない → matched", () => {
    const rows = [ledger("R-1")];
    expect(matchTransactions(rows, [])).toEqual([{ kind: "none", receipt_id: "R-1" }]);
    expect(matchTransactions(rows, [tx("t1", { value: 999 })])).toEqual([{ kind: "none", receipt_id: "R-1" }]);
    const out = matchTransactions(rows, [tx("t1")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "matched", receipt_id: "R-1" });
    expect((out[0] as { transaction: MfTransaction }).transaction.id).toBe("t1");
  });

  it("候補が複数 → review（multiple。日付・ID の順に並べる）。日付が近いものを優先して決めない", () => {
    const rows = [ledger("R-1")];
    const out = matchTransactions(rows, [tx("t2", { date: "2026-10-12" }), tx("t1", { date: "2026-10-10" })]);
    expect(out[0]).toMatchObject({ kind: "review", reason: "multiple" });
    expect((out[0] as { candidates: MfTransaction[] }).candidates.map((t) => t.id)).toEqual(["t1", "t2"]);
  });

  it("支払方法と連携サービスの対応: linked_card はカードの明細だけ、linked_bank は口座の明細だけ", () => {
    const card = ledger("R-C", { payment_method: "linked_card" });
    const bank = ledger("R-B", { payment_method: "linked_bank", amount: 1200 });
    const out = matchTransactions([card, bank], [tx("tb", { service: "bank" })]);
    expect(out.find((o) => o.receipt_id === "R-C")?.kind).toBe("none");
    expect(out.find((o) => o.receipt_id === "R-B")?.kind).toBe("matched");
  });

  it("取り合い: 2 行が同じ 1 件を候補にしていれば、両方 review（contested）で確定しない", () => {
    const rows = [ledger("R-1"), ledger("R-2", { date: "2026-10-11" })];
    const out = matchTransactions(rows, [tx("t1")]);
    expect(out.map((o) => o.kind)).toEqual(["review", "review"]);
    expect(out.every((o) => o.kind === "review" && o.reason === "contested")).toBe(true);
  });

  it("バッチ（20 行）の外にある行との取り合いも見る（待ち行すべてで照合する）", () => {
    const rows: LedgerRowView[] = [];
    const txs: MfTransaction[] = [];
    for (let i = 1; i <= 24; i++) {
      rows.push(ledger(`R-${String(i).padStart(2, "0")}`, { amount: 1000 + i }));
      txs.push(tx(`t${i}`, { value: 1000 + i }));
    }
    // 25 行目は 1 行目と同じ金額・日付 → 1 件の明細を取り合う。
    rows.push(ledger("R-25", { amount: 1001 }));
    const out = matchTransactions(rows, txs);
    expect(out).toHaveLength(25);
    expect(out.find((o) => o.receipt_id === "R-01")).toMatchObject({ kind: "review", reason: "contested" });
    expect(out.find((o) => o.receipt_id === "R-25")).toMatchObject({ kind: "review", reason: "contested" });
    expect(out.filter((o) => o.kind === "matched")).toHaveLength(23);
  });

  it("使用中の明細（JOURNALIZING・SYNCED・REVERSING・NEEDS_REVIEW の行の MF明細ID）は候補にしない。手放した明細（REVERSED・ERROR）は候補になる", () => {
    for (const st of ["JOURNALIZING", "SYNCED", "REVERSING", "NEEDS_REVIEW"] as const) {
      const rows = [ledger("R-1"), ledger("R-0", { mf_sync_state: st, mf_transaction_id: "t1", amount: 5, date: "2026-09-01" })];
      expect(matchTransactions(rows, [tx("t1")])[0]).toMatchObject({ kind: "none" });
    }
    for (const st of ["REVERSED", "ERROR"] as const) {
      const rows = [ledger("R-1"), ledger("R-0", { mf_sync_state: st, mf_transaction_id: "t1" })];
      expect(matchTransactions(rows, [tx("t1")])[0]).toMatchObject({ kind: "matched" });
    }
  });

  it("日付幅: 日付 − 3 日・日付 + 6 日の明細は候補にしない（−2〜+5 は候補）", () => {
    const rows = [ledger("R-1")];
    expect(matchTransactions(rows, [tx("t", { date: "2026-10-07" })])[0]!.kind).toBe("none");
    expect(matchTransactions(rows, [tx("t", { date: "2026-10-08" })])[0]!.kind).toBe("matched");
    expect(matchTransactions(rows, [tx("t", { date: "2026-10-15" })])[0]!.kind).toBe("matched");
    expect(matchTransactions(rows, [tx("t", { date: "2026-10-16" })])[0]!.kind).toBe("none");
  });

  it("待ち行でない行（WAITING_TRANSACTION 以外・登録未完了・仕訳あり・cash）は対象にしない", () => {
    const rows = [
      ledger("R-a", { mf_sync_state: "" }),
      ledger("R-b", { state: "FILE_SAVED" }),
      ledger("R-c", { mf_journal_id: "j1" }),
      ledger("R-d", { payment_method: "cash" }),
    ];
    expect(matchTransactions(rows, [tx("t")])).toEqual([]);
  });

  it("訂正元が仕訳を持つ（SYNCED 等）間、訂正後の新しい行は照合に出さない。訂正元が REVERSED なら通常どおり照合する", () => {
    const old = ledger("R-OLD", { mf_sync_state: "SYNCED", mf_transaction_id: "t0", state: "CORRECTED", mf_journal_id: "j0" });
    const neu = ledger("R-NEW", { correction_of_receipt_id: "R-OLD" });
    expect(matchTransactions([old, neu], [tx("t1")])).toEqual([]);
    expect(isWaitingForTransaction(neu, indexLedgerRows([old, neu]))).toBe(false);
    expect(holdsJournalAncestor(neu, indexLedgerRows([old, neu]))).toBe(true);
    const released = { ...old, mf_sync_state: "REVERSED" as const };
    expect(matchTransactions([released, neu], [tx("t1")])[0]).toMatchObject({ kind: "matched", receipt_id: "R-NEW" });
    // 訂正の連鎖（孫）でも祖先をたどる。
    const grand = ledger("R-NEW2", { correction_of_receipt_id: "R-NEW" });
    expect(holdsJournalAncestor(grand, indexLedgerRows([old, neu, grand]))).toBe(true);
  });

  it("isNoCandidateNoticeDue: 日付から 14 日たった日から（当日を含む）", () => {
    expect(isNoCandidateNoticeDue("2026-10-05", "2026-10-18")).toBe(false);
    expect(isNoCandidateNoticeDue("2026-10-05", "2026-10-19")).toBe(true);
    expect(isNoCandidateNoticeDue("2026-10-05", "2026-11-30")).toBe(true);
  });
});

describe("journalize 本文（§6.5・§6.6）", () => {
  it("経費の journalize: transaction_date は経費台帳の日付（明細の日付ではない）、remark・memo・tags は §2.2 と同じ、tax_id なし", () => {
    const body = buildJournalizeBody(ledger("R-1", { date: "2026-10-10" }), "t%2B1%3D", "acc%2B1%3D");
    expect(body).toEqual({
      transaction_id: "t%2B1%3D",
      transaction_date: "2026-10-10",
      account_id: "acc%2B1%3D",
      remark: "R-1 ○○商店",
      memo: "https://drive.example.test/x",
      tags: ["R-1"],
    });
    const json = JSON.stringify(body);
    expect(json).not.toContain("tax_id");
    expect(json).not.toContain("invoice_kind");
    expect("memo" in buildJournalizeBody(ledger("R-1", { drive_link: "" }), "t", "a")).toBe(false);
  });

  it("ルールの journalize: remark `私用: {ルール名}`、tags [kadobo-rule]、transaction_date は明細の日付", () => {
    expect(buildRuleRemark("NISA クレカ積立")).toBe("私用: NISA クレカ積立");
    expect(buildRuleJournalizeBody(tx("t1", { date: "2026-10-13" }), "NISA クレカ積立", "acc%3D")).toEqual({
      transaction_id: "t1",
      transaction_date: "2026-10-13",
      account_id: "acc%3D",
      remark: "私用: NISA クレカ積立",
      tags: ["kadobo-rule"],
    });
  });

  it("取消の remark・tags", () => {
    expect(buildVoidRemark("R-1", "'=商店")).toBe("取消: R-1 =商店");
    expect(buildVoidTags("R-1")).toEqual(["R-1", "kadobo-void"]);
  });
});

describe("PUT /journals/{id} 本文（§6.7 🔄）", () => {
  const existing = {
    id: "j%2B1%3D",
    transaction_date: "2026-10-10",
    journal_type: "journal_entry",
    memo: "https://drive.example.test/old",
    tags: ["R-OLD"],
    transaction_id: "t1",
    branches: [
      {
        remark: "R-OLD 旧店",
        debitor: { account_id: "exp%2B1%3D", value: 1200, account_name: "消耗品費", tax_name: "対象外", tax_id: "TAX", sub_account_id: "oldsub", department_id: "dep1" },
        creditor: { account_id: "card%2B9%3D", value: 1200, account_name: "未払金", sub_account_id: "cardsub", tax_id: "TAX2", invoice_kind: "INVOICE_KIND_NOT_TARGET" },
      },
    ],
  };

  it("借方の account_id・value、remark、tags、memo を差し替え、貸方の科目・金額は変えない。tax_id・invoice_kind は送らない", () => {
    const r = buildJournalUpdateBody(existing, {
      debitAccountId: "priv%3D",
      remark: "取消: R-OLD 旧店",
      tags: ["R-OLD", "kadobo-void"],
      memo: "https://drive.example.test/old",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.body).toEqual({
      journal: {
        transaction_date: "2026-10-10",
        journal_type: "journal_entry",
        branches: [
          {
            debitor: { account_id: "priv%3D", value: 1200, department_id: "dep1" },
            creditor: { account_id: "card%2B9%3D", value: 1200, sub_account_id: "cardsub" },
            remark: "取消: R-OLD 旧店",
          },
        ],
        memo: "https://drive.example.test/old",
        tags: ["R-OLD", "kadobo-void"],
      },
    });
    const json = JSON.stringify(r.body);
    expect(json).not.toContain("tax_id");
    expect(json).not.toContain("invoice_kind");
    expect(json).not.toContain("oldsub");
  });

  it("memo を渡さなければ memo キーを付けない。取引日・借方金額は指定すれば差し替える", () => {
    const r = buildJournalUpdateBody(existing, {
      debitAccountId: "x",
      debitValue: 1200,
      remark: "r",
      tags: [],
      transactionDate: "2026-10-12",
    });
    expect(r.ok && "memo" in r.body.journal).toBe(false);
    expect(r.ok && r.body.journal.transaction_date).toBe("2026-10-12");
  });

  it("貸方と金額が合わなくなる更新・1 行でない仕訳は ok: false（送らずに人の確認に回す）", () => {
    expect(buildJournalUpdateBody(existing, { debitAccountId: "x", debitValue: 1500, remark: "r", tags: [] })).toMatchObject({ ok: false });
    expect(buildJournalUpdateBody({ ...existing, branches: [existing.branches[0], existing.branches[0]] }, { debitAccountId: "x", remark: "r", tags: [] })).toMatchObject({ ok: false });
    expect(buildJournalUpdateBody({ ...existing, branches: [] }, { debitAccountId: "x", remark: "r", tags: [] })).toMatchObject({ ok: false });
    expect(singleBranchOf({ branches: [{ debitor: { account_id: "a" }, creditor: { account_id: "b", value: 1 } }] })).toBeNull();
  });
});

describe("planLinkedCancellation（§6.7 🔄・§6.5）", () => {
  const old = (o: Partial<LedgerRowView> = {}): LedgerRowView =>
    ledger("R-OLD", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: "j1", mf_transaction_id: "t1", ...o });
  const neu = (o: Partial<LedgerRowView> = {}): LedgerRowView =>
    ledger("R-NEW", { correction_of_receipt_id: "R-OLD", mf_sync_state: "", ...o });

  it("VOID は void", () => {
    expect(planLinkedCancellation(old({ state: "VOID" }), [old({ state: "VOID" })], START)).toEqual({ kind: "void" });
  });

  it("CORRECTED で訂正後の新しい行が無い・登録中・エラーなら wait", () => {
    expect(planLinkedCancellation(old(), [old()], START)).toEqual({ kind: "wait" });
    expect(planLinkedCancellation(old(), [old(), neu({ state: "FILE_SAVED" })], START)).toEqual({ kind: "wait" });
    expect(planLinkedCancellation(old(), [old(), neu({ state: "ERROR" })], START)).toEqual({ kind: "wait" });
  });

  it("新しい行が同じ支払方法・同じ金額・自動仕訳の対象・仕訳なしなら inherit（状態は空でも WAITING_TRANSACTION でも）", () => {
    expect(planLinkedCancellation(old(), [old(), neu()], START)).toEqual({ kind: "inherit", successor: "R-NEW" });
    expect(planLinkedCancellation(old(), [old(), neu({ mf_sync_state: "WAITING_TRANSACTION" })], START)).toEqual({
      kind: "inherit",
      successor: "R-NEW",
    });
  });

  it("金額・支払方法が違う、割合 100 未満、開業前、他の仕訳を持つ新しい行は void（旧仕訳は事業主貸にして、新しい行は通常の照合へ）", () => {
    for (const o of [
      { amount: 1500 },
      { payment_method: "linked_bank" as const },
      { payment_method: "cash" as const },
      { business_use_ratio: 50 },
      { date: "2026-09-30" },
      { mf_sync_state: "JOURNALIZING" as const },
      { mf_journal_id: "jX" },
    ]) {
      expect(planLinkedCancellation(old(), [old(), neu(o)], START)).toEqual({ kind: "void" });
    }
  });

  it("新しい行がすべて VOID なら void。開業日が未設定なら wait", () => {
    expect(planLinkedCancellation(old(), [old(), neu({ state: "VOID" })], START)).toEqual({ kind: "void" });
    expect(planLinkedCancellation(old(), [old(), neu()], null)).toEqual({ kind: "wait" });
  });

  it("新しい行が既にこの仕訳を持っていれば done", () => {
    expect(planLinkedCancellation(old(), [old(), neu({ mf_sync_state: "SYNCED", mf_journal_id: "j1" })], START)).toEqual({
      kind: "done",
      successor: "R-NEW",
    });
  });

  it("訂正の連鎖: 中間の CORRECTED を飛ばして最後の COMPLETED の行に引き継ぐ。最後の行が未登録なら wait", () => {
    const mid = neu({ state: "CORRECTED" });
    const last = ledger("R-NEW2", { correction_of_receipt_id: "R-NEW", mf_sync_state: "" });
    expect(planLinkedCancellation(old(), [old(), mid, last], START)).toEqual({ kind: "inherit", successor: "R-NEW2" });
    expect(planLinkedCancellation(old(), [old(), mid], START)).toEqual({ kind: "wait" });
  });
});


describe("cancellationRoute（取消方法は作成経路で決める。レビュー B2）", () => {
  const r = (o: Partial<LedgerRowView>) => cancellationRoute(ledger("R-1", { mf_sync_state: "SYNCED", ...o }));

  it("要約あり: 連携で作った（作成時 linked_*・明細 ID あり）行は、現在の支払方法・MF明細ID が一致すれば put", () => {
    expect(r({ mf_sync_input: "1200|2026-10-10|消耗品費|linked_card|t1", mf_transaction_id: "t%31" }).route).toBe("put");
    expect(r({ mf_sync_input: "1200|2026-10-10|消耗品費|linked_bank|t1", mf_transaction_id: "t1", payment_method: "linked_bank" }).route).toBe("put");
  });

  it("要約あり: 現金で作った（作成時 cash・明細 ID なし）行は、現在も cash で MF明細ID なしなら delete", () => {
    expect(r({ mf_sync_input: "1200|2026-10-10|消耗品費|cash|", payment_method: "cash" }).route).toBe("delete");
  });

  it("矛盾は unknown: 連携で作ったのに cash に変更・MF明細ID が変わった／空、現金で作ったのに linked_* に変更・MF明細ID あり", () => {
    expect(r({ mf_sync_input: "1|2026-10-10|消耗品費|linked_card|t1", payment_method: "cash", mf_transaction_id: "t1" }).route).toBe("unknown");
    expect(r({ mf_sync_input: "1|2026-10-10|消耗品費|linked_card|t1", mf_transaction_id: "t2" }).route).toBe("unknown");
    expect(r({ mf_sync_input: "1|2026-10-10|消耗品費|linked_card|t1", mf_transaction_id: null }).route).toBe("unknown");
    expect(r({ mf_sync_input: "1|2026-10-10|消耗品費|linked_card|t1", payment_method: "linked_bank", mf_transaction_id: "t1" }).route).toBe("unknown");
    expect(r({ mf_sync_input: "1|2026-10-10|消耗品費|cash|", payment_method: "linked_card", mf_transaction_id: null }).route).toBe("unknown");
    expect(r({ mf_sync_input: "1|2026-10-10|消耗品費|cash|", payment_method: "cash", mf_transaction_id: "t1" }).route).toBe("unknown");
    expect(r({ mf_sync_input: "壊れた要約" }).route).toBe("unknown");
    const u = r({ mf_sync_input: "1|2026-10-10|消耗品費|linked_card|t1", payment_method: "cash", mf_transaction_id: "t1" });
    expect(u.route === "unknown" && u.reason).toContain("linked_card");
  });

  it("要約が空（手で状態や MF仕訳ID を書いた行）は現在の列だけで見る: linked_* かつ MF明細ID あり → put、cash かつ MF明細ID なし → delete、それ以外は unknown", () => {
    expect(r({ mf_sync_input: "", mf_transaction_id: "t1" }).route).toBe("put");
    expect(r({ mf_sync_input: "", payment_method: "cash", mf_transaction_id: null }).route).toBe("delete");
    expect(r({ mf_sync_input: "", payment_method: "cash", mf_transaction_id: "t1" }).route).toBe("unknown");
    expect(r({ mf_sync_input: "", payment_method: "linked_card", mf_transaction_id: null }).route).toBe("unknown");
    expect(r({ mf_sync_input: "", payment_method: "", mf_transaction_id: null }).route).toBe("unknown");
  });

  it("祖先の引継ぎ待ちは作成経路で判定する: 親の経路が unknown なら待たせない", () => {
    const parent = ledger("R-OLD", { mf_sync_state: "SYNCED", mf_transaction_id: "t0", mf_sync_input: "1|2026-10-10|消耗品費|linked_card|t0" });
    const child = ledger("R-NEW", { correction_of_receipt_id: "R-OLD" });
    expect(holdsJournalAncestor(child, indexLedgerRows([parent, child]))).toBe(true);
    const changed = { ...parent, payment_method: "cash" as const };
    expect(holdsJournalAncestor(child, indexLedgerRows([changed, child]))).toBe(false);
  });
});

describe("planLinkedCancellation: 引継ぎの途中で止まった新しい行（recover。レビュー B1）", () => {
  const old = (): LedgerRowView => ledger("R-OLD", { state: "CORRECTED", mf_sync_state: "SYNCED", mf_journal_id: "j1", mf_transaction_id: "t1" });
  const neu = (o: Partial<LedgerRowView>): LedgerRowView => ledger("R-NEW", { correction_of_receipt_id: "R-OLD", ...o });

  it("同じ仕訳 ID を持つが未確定（状態が空・WAITING_TRANSACTION）の新しい行 → void にせず recover", () => {
    for (const st of ["", "WAITING_TRANSACTION"] as const) {
      expect(planLinkedCancellation(old(), [old(), neu({ mf_sync_state: st, mf_journal_id: "j1" })], START)).toEqual({
        kind: "recover",
        successor: "R-NEW",
      });
    }
    // 金額・支払方法が違っていても、同じ仕訳 ID を持つ行があれば void にしない。
    expect(planLinkedCancellation(old(), [old(), neu({ mf_sync_state: "", mf_journal_id: "j1", amount: 9 })], START).kind).toBe("recover");
  });

  it("同じ仕訳 ID を持つ行が SYNCED なら done（登録中・エラー等の他の子孫より優先）", () => {
    expect(planLinkedCancellation(old(), [old(), neu({ mf_sync_state: "SYNCED", mf_journal_id: "j1" })], START).kind).toBe("done");
    const err = ledger("R-ERR", { correction_of_receipt_id: "R-OLD", state: "ERROR", mf_sync_state: "" });
    expect(planLinkedCancellation(old(), [old(), err, neu({ mf_sync_state: "SYNCED", mf_journal_id: "j1" })], START).kind).toBe("done");
  });

  it("同じ仕訳 ID を持つ行が想定外の状態（NEEDS_REVIEW 等）なら、勝手に void せず wait", () => {
    expect(planLinkedCancellation(old(), [old(), neu({ mf_sync_state: "NEEDS_REVIEW", mf_journal_id: "j1" })], START)).toEqual({ kind: "wait" });
  });
});

describe("journalMatchesUpdate", () => {
  const existing = {
    transaction_date: "2026-10-10",
    memo: "m",
    tags: ["R-NEW"],
    branches: [
      { remark: "R-NEW 店", debitor: { account_id: "d", value: 5 }, creditor: { account_id: "c", value: 5 } },
    ],
  };
  const body = (o: Partial<{ remark: string; tags: string[]; memo: string | undefined; debit: string }> = {}) => {
    const r = buildJournalUpdateBody(existing, {
      debitAccountId: o.debit ?? "d",
      remark: o.remark ?? "R-NEW 店",
      tags: o.tags ?? ["R-NEW"],
      memo: "memo" in o ? o.memo : "m",
    });
    if (!r.ok) {
      throw new Error("build failed");
    }
    return r.body;
  };

  it("取引日・借方・貸方・摘要・タグ・メモがすべて同じなら true。どれかが違えば false", () => {
    expect(journalMatchesUpdate(existing, body())).toBe(true);
    expect(journalMatchesUpdate(existing, body({ remark: "別" }))).toBe(false);
    expect(journalMatchesUpdate(existing, body({ tags: ["R-NEW", "x"] }))).toBe(false);
    expect(journalMatchesUpdate(existing, body({ debit: "other" }))).toBe(false);
    expect(journalMatchesUpdate(existing, body({ memo: undefined }))).toBe(false);
    expect(journalMatchesUpdate({ ...existing, memo: "" }, body({ memo: undefined }))).toBe(true);
  });
});
