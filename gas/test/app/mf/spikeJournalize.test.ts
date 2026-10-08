/**
 * `app/mf/spikeJournalize.ts`（スパイク S-M5 後半 `mfJournalizeSpikeS5b`。実装設計 MF連携 §11.1）。
 * 会計 API は `fakeMfAccounting.ts` の簡易フェイクサーバ。実際の MF にはアクセスしない。
 */
import { describe, expect, it } from "vitest";
import {
  SPIKE_S5B_REMARK,
  SPIKE_S5B_REMARK_AFTER_PUT,
  SPIKE_S5B_TAG,
  runJournalizeSpikeS5b,
} from "../../../src/app/mf/spikeJournalize";
import { makeFakePorts } from "../fakes";
import { accountIdOf, accountingCallsOf, installFakeMfAccounting } from "./fakeMfAccounting";

const NOW = Date.parse("2026-10-08T09:00:00+09:00");

function setup(opts: { txId?: boolean; start?: boolean } = {}) {
  const ports = makeFakePorts(NOW);
  const api = installFakeMfAccounting(ports);
  if (opts.start !== false) {
    ports.props.set("MF_SYNC_START_DATE", "2026-10-01");
  }
  const lines: string[] = [];
  return { ports, api, lines, log: (l: string) => lines.push(l) };
}

function writes(ports: ReturnType<typeof makeFakePorts>): string[] {
  return accountingCallsOf(ports).filter((c) => c.startsWith("POST /transactions") || c.startsWith("PUT") || c.startsWith("DELETE"));
}

describe("runJournalizeSpikeS5b: 拒否", () => {
  it("MF_SPIKE_TRANSACTION_ID が未設定なら何も呼ばず拒否する", () => {
    const { ports, log } = setup();
    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_TRANSACTION_ID_NOT_SET/);
    expect(ports.http.calls).toHaveLength(0);
  });

  it("MF_SYNC_START_DATE が未設定なら、開業前かを判定できないので拒否する（HTTP 0 件）", () => {
    const { ports, api, log } = setup({ start: false });
    const tx = api.plantTransaction({ date: "2026-10-05", value: 1200 });
    ports.props.set("MF_SPIKE_TRANSACTION_ID", tx.id);
    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_SYNC_START_DATE_NOT_SET/);
    expect(ports.http.calls).toHaveLength(0);
  });

  it("明細の date が開業日（MF_SYNC_START_DATE）より前なら拒否する。仕訳は作らない", () => {
    const { ports, api, lines, log } = setup();
    const tx = api.plantTransaction({ date: "2026-09-30", value: 1200 });
    ports.props.set("MF_SPIKE_TRANSACTION_ID", tx.id);

    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_TRANSACTION_BEFORE_START/);

    expect(writes(ports)).toEqual([]);
    expect(api.journals).toHaveLength(0);
    expect(tx.journalizing_status).toBe("none");
    expect(lines.join("\n")).toContain("開業日");
  });

  it("開業日と同日は実行できる（>=）。仕訳済み・収入・見つからない明細は拒否する", () => {
    const e = setup();
    const ok = e.api.plantTransaction({ date: "2026-10-01", value: 100 });
    e.ports.props.set("MF_SPIKE_TRANSACTION_ID", ok.id);
    expect(() => runJournalizeSpikeS5b(e.ports, e.log)).not.toThrow();

    const registered = setup();
    const t1 = registered.api.plantTransaction({ date: "2026-10-05", value: 1, journalizing_status: "registered" });
    registered.ports.props.set("MF_SPIKE_TRANSACTION_ID", t1.id);
    expect(() => runJournalizeSpikeS5b(registered.ports, registered.log)).toThrow(/SPIKE_TRANSACTION_NOT_UNJOURNALIZED/);
    expect(writes(registered.ports)).toEqual([]);

    const income = setup();
    const t2 = income.api.plantTransaction({ date: "2026-10-05", value: 1, side: "INCOME" });
    income.ports.props.set("MF_SPIKE_TRANSACTION_ID", t2.id);
    expect(() => runJournalizeSpikeS5b(income.ports, income.log)).toThrow(/SPIKE_TRANSACTION_NOT_EXPENSE/);

    const missing = setup();
    missing.api.plantTransaction({ date: "2026-10-05", value: 1 });
    missing.ports.props.set("MF_SPIKE_TRANSACTION_ID", "unknown%3D");
    expect(() => runJournalizeSpikeS5b(missing.ports, missing.log)).toThrow(/SPIKE_TRANSACTION_NOT_FOUND/);
    expect(writes(missing.ports)).toEqual([]);
  });
});

describe("runJournalizeSpikeS5b: 成功", () => {
  it("事業主貸で journalize → transaction_ids（raw）で引ける → PUT で remark を書き換え → 読み直して反映を確認。削除しない", () => {
    const { ports, api, lines, log } = setup();
    const tx = api.plantTransaction({ date: "2026-10-05", value: 1234, content: "テスト店" });
    ports.props.set("MF_SPIKE_TRANSACTION_ID", tx.id);

    runJournalizeSpikeS5b(ports, log);

    // journalize の本文: 事業主貸・remark・tags・transaction_date は明細の日付・tax_id なし。
    // 2 回目は同じ明細への再送の確認（拒否されて二重作成されない）。
    const expectedBody = {
      transaction_id: tx.id,
      transaction_date: "2026-10-05",
      account_id: accountIdOf("事業主貸"),
      remark: "私用: S-M5b",
      tags: ["kadobo-spike-s5b"],
    };
    expect(api.journalizeBodies).toEqual([expectedBody, expectedBody]);
    expect(SPIKE_S5B_REMARK).toBe("私用: S-M5b");
    expect(SPIKE_S5B_TAG).toBe("kadobo-spike-s5b");
    const payload = ports.http.calls.find((c) => c.url.includes("/transactions/journalize"))?.payload ?? "";
    expect(payload).not.toContain("tax_id");

    // GET /journals?transaction_ids= は raw（エンコードしない）。
    const listUrl = ports.http.calls.map((c) => c.url).find((u) => u.includes("/journals?") && u.includes("transaction_ids="));
    expect(listUrl).toContain(`transaction_ids=${tx.id}`);
    expect(listUrl).not.toContain("%25");

    // PUT: パスの ID は 1 回エンコード。remark だけ変わり、借方科目・金額・貸方は変わらない。
    expect(api.putBodies).toHaveLength(1);
    const put = ports.http.calls.find((c) => c.method === "put");
    expect(put?.url).toContain(`/journals/${encodeURIComponent(api.journals[0]!.id)}`);
    const body = (api.putBodies[0]!.body as { journal: Record<string, any> }).journal;
    expect(body.branches).toEqual([
      {
        debitor: { account_id: accountIdOf("事業主貸"), value: 1234 },
        creditor: { account_id: accountIdOf("未払金"), value: 1234 },
        remark: "私用: S-M5b（PUT 確認）",
      },
    ]);
    expect(body.tags).toEqual(["kadobo-spike-s5b"]);
    expect(SPIKE_S5B_REMARK_AFTER_PUT).toBe("私用: S-M5b（PUT 確認）");

    // 削除しない。仕訳は 1 件残り、remark が書き換わっている。
    expect(ports.http.calls.some((c) => c.method === "delete")).toBe(false);
    expect(api.journals).toHaveLength(1);
    expect((api.journals[0]!.branches[0] as { remark: string }).remark).toBe("私用: S-M5b（PUT 確認）");
    expect(tx.journalizing_status).toBe("registered");

    const text = lines.join("\n");
    expect(text).toContain("今回作った仕訳が見つかった");
    expect(text).toContain("remark が「私用: S-M5b（PUT 確認）」になっていた");
    expect(text).toContain("削除せず残しています");
    expect(text).toContain("2 回目の journalize: 拒否された（status=400");
    expect(text).toContain("二重作成されない");
    expect(text).toContain("変わらなかった");
    expect(text).not.toContain("mf_api_prd_SECRET");
    expect(text).not.toContain("JWT_FAKE");
  });

  it("MF_ENABLED などのフラグを見ずに動く（手動実行）。シートには書かない", () => {
    const { ports, api, log } = setup();
    const tx = api.plantTransaction({ date: "2026-10-05", value: 10 });
    ports.props.set("MF_SPIKE_TRANSACTION_ID", tx.id);
    runJournalizeSpikeS5b(ports, log);
    expect(api.journals).toHaveLength(1);
    expect(ports.sheets.columnPatches).toHaveLength(0);
    expect(ports.sheets.internal.size).toBe(0);
  });

  it("2 回目の実行は明細が仕訳済みなので拒否される（二重に仕訳しない）", () => {
    const { ports, api, log } = setup();
    const tx = api.plantTransaction({ date: "2026-10-05", value: 10 });
    ports.props.set("MF_SPIKE_TRANSACTION_ID", tx.id);
    runJournalizeSpikeS5b(ports, log);
    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_TRANSACTION_NOT_UNJOURNALIZED/);
    expect(api.journals).toHaveLength(1);
  });
});

describe("runJournalizeSpikeS5b: 前提が崩れていれば失敗にする（レビュー M4）", () => {
  function ready(amount = 1234) {
    const e = setup();
    const tx = e.api.plantTransaction({ date: "2026-10-05", value: amount, content: "テスト店" });
    e.ports.props.set("MF_SPIKE_TRANSACTION_ID", tx.id);
    return { ...e, tx };
  }

  it("transaction_ids の検索で作った仕訳が見つからなければ失敗（最後まで確認したうえで投げる）", () => {
    const { ports, api, lines, log } = ready();
    api.hideFromList = true; // GET /journals（一覧・検索）が何も返さない

    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_NOT_FOUND_BY_TRANSACTION_IDS/);

    const text = lines.join("\n");
    expect(text).toContain("見つからなかった");
    expect(text).toContain("S-M5b 失敗");
    expect(api.putBodies).toHaveLength(1); // PUT・再送の確認までは行う
  });

  it("PUT の後に貸方の科目・金額が変わっていれば失敗。変わった内容をログに出す", () => {
    const { ports, api, lines, log } = ready();
    api.putMutate = (j) => {
      (j.branches[0] as { creditor: Record<string, unknown> }).creditor = { account_id: accountIdOf("事業主借"), value: 1234 };
    };

    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_PUT_CHANGED_UNEXPECTED/);

    expect(lines.join("\n")).toContain("貸方の科目が変わった");
  });

  it("PUT の後に transaction_id（明細との紐付き）が外れていれば失敗", () => {
    const { ports, api, lines, log } = ready();
    api.putMutate = (j) => {
      delete j.transaction_id;
    };

    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_PUT_CHANGED_UNEXPECTED/);

    expect(lines.join("\n")).toContain("明細との紐付き（transaction_id）が外れた");
  });

  it("同じ明細への 2 回目の journalize が 201（二重作成）なら失敗。仕訳 ID を出して、人が削除する案内を出す", () => {
    const { ports, api, lines, log } = ready();
    api.allowDuplicateJournalize = true;

    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_DUPLICATE_JOURNALIZE_CREATED/);

    expect(api.journals).toHaveLength(2);
    const text = lines.join("\n");
    expect(text).toContain("201 が返った。二重作成された");
    expect(text).toContain(`仕訳 id=${api.journals[1]!.id}`);
    expect(text).toContain("MF 画面で不要な方の仕訳を削除してください");
  });

  it("2 回目の journalize が結果不明（500）なら、確認を促して失敗にする", () => {
    const { ports, api, lines, log } = ready();
    api.postMode = "not_created_500";
    api.postModeRemaining = Infinity;
    // 1 回目は通すため、1 回目の POST の後から 500 にする。
    let n = 0;
    const prev = api.onRequest;
    api.onRequest = (req) => {
      prev?.(req);
      if (req.url.includes("/transactions/journalize")) {
        n++;
        api.postMode = n === 1 ? "ok" : "not_created_500";
      }
    };

    expect(() => runJournalizeSpikeS5b(ports, log)).toThrow(/SPIKE_DUPLICATE_JOURNALIZE_UNKNOWN/);
    expect(lines.join("\n")).toContain("結果不明");
  });
});
