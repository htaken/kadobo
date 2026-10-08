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
  canTransition,
  debitAccountNameOf,
  decideSyncTarget,
  findDuplicateReceiptTags,
  hasInputChanged,
  initialStateFor,
  isCancelledExpenseState,
  isJournalSyncState,
  journalHasTag,
  journalIdOf,
  splitRangeByCalendarYear,
  summarizeSyncInput,
  unescapeSheetFormula,
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
