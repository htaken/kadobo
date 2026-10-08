/**
 * `app/mf/spikeJournal.ts`（スパイク S-M5 の `POST /journals` 部分。実装設計 MF連携 §11.1）。
 * 会計 API は `fakeMfAccounting.ts` の簡易フェイクサーバ。実際の MF にはアクセスしない。
 */
import { describe, expect, it } from "vitest";
import { MfApiError, MfTransientError } from "../../../src/app/mf/errors";
import {
  SPIKE_JOURNAL_REMARK,
  SPIKE_JOURNAL_TAG,
  runJournalSpikeS5,
} from "../../../src/app/mf/spikeJournal";
import { makeFakePorts } from "../fakes";
import { accountIdOf, accountingCallsOf, installFakeMfAccounting } from "./fakeMfAccounting";

const NOW = Date.parse("2026-10-08T09:00:00+09:00");

function setup() {
  const ports = makeFakePorts(NOW);
  const api = installFakeMfAccounting(ports);
  const lines: string[] = [];
  return { ports, api, lines, log: (l: string) => lines.push(l) };
}

describe("runJournalSpikeS5", () => {
  it("借方 雑費 1 円／貸方 事業主借 1 円・tags・remark・memo・transaction_date 今日・tax_id なしで作る", () => {
    const { ports, api, log } = setup();

    runJournalSpikeS5(ports, log);

    expect(api.postedBodies).toHaveLength(1);
    const j = (api.postedBodies[0] as { journal: Record<string, any> }).journal;
    expect(j.transaction_date).toBe("2026-10-08");
    expect(j.journal_type).toBe("journal_entry");
    expect(j.tags).toEqual([SPIKE_JOURNAL_TAG]);
    expect(j.tags).toEqual(["kadobo-spike-s5"]);
    expect(j.branches).toEqual([
      {
        debitor: { account_id: accountIdOf("雑費"), value: 1 },
        creditor: { account_id: accountIdOf("事業主借"), value: 1 },
        remark: "kadobo S-M5 テスト（削除予定）",
      },
    ]);
    expect(SPIKE_JOURNAL_REMARK).toBe("kadobo S-M5 テスト（削除予定）");
    expect(typeof j.memo).toBe("string");
    const payload = ports.http.calls.find((c) => c.method === "post" && c.url.includes("/journals"))?.payload ?? "";
    expect(payload).not.toContain("tax_id");
    expect(payload).not.toContain("invoice_kind");
  });

  it("GET /journals/{id} の tags・remark・memo・branches の tax_name / tax_value を Logger に出す", () => {
    const { ports, api, lines, log } = setup();
    api.taxName = "対象外";

    runJournalSpikeS5(ports, log);

    const text = lines.join("\n");
    expect(text).toContain('tags: ["kadobo-spike-s5"]');
    expect(text).toContain("memo:");
    expect(text).toContain("branches[0].remark: kadobo S-M5 テスト（削除予定）");
    expect(text).toContain("branches[0].debitor: account_name=雑費 value=1 tax_name=対象外 tax_value=0");
    expect(text).toContain("branches[0].creditor: account_name=事業主借 value=1 tax_name=対象外 tax_value=0");
  });

  it("作成直後に tags で検索して見つかるか、DELETE 後に「存在しない」になるかを確かめ、仕訳は残らない（パスの ID は pathWithId）", () => {
    const { ports, api, lines, log } = setup();

    runJournalSpikeS5(ports, log);

    const text = lines.join("\n");
    expect(text).toContain("今回作った仕訳が見つかった");
    // 実機では削除後の GET は 404 ではなく 400 invalid_request_path_parameter（isMfNotFound が「存在しない」と判定）。
    expect(text).toContain("S-M5 削除済み: DELETE 後の GET");
    expect(text).toContain("status=400 code=invalid_request_path_parameter");
    expect(api.journals).toHaveLength(0);
    const calls = accountingCallsOf(ports);
    expect(calls.filter((c) => c === "POST /journals")).toHaveLength(1);
    expect(calls.filter((c) => c.startsWith("DELETE /journals/"))).toHaveLength(1);
    // 作成直後の検索は今日 1 日だけ。
    expect(
      ports.http.calls.some(
        (c) => c.url.includes("/journals?") && c.url.includes("start_date=2026-10-08") && c.url.includes("end_date=2026-10-08"),
      ),
    ).toBe(true);
  });

  it("作成直後の検索で見つからなくても結果をログに出し、削除は行う", () => {
    const { ports, api, lines, log } = setup();
    // 先に作られた仕訳が、一覧の検索には出ない（反映の遅れ）を再現する。
    api.hideFromList = true;

    runJournalSpikeS5(ports, log);

    expect(lines.join("\n")).toContain("今回作った仕訳が見つからなかった");
    expect(api.journals).toHaveLength(0);
  });

  it("前回の削除失敗分（同じタグの既存）があれば作らずに回収して削除する", () => {
    const { ports, api, lines, log } = setup();
    const old = api.plantJournal({ transaction_date: "2026-10-01", tags: [SPIKE_JOURNAL_TAG] });

    runJournalSpikeS5(ports, log);

    expect(api.postedBodies).toHaveLength(0);
    expect(lines.join("\n")).toContain(`既存の ${SPIKE_JOURNAL_TAG} を 1 件検出したため新規作成しない。id=${old.id}`);
    expect(lines.join("\n")).toContain("作成直後の検索: 既存を回収したため今回は行わない");
    expect(api.journals).toHaveLength(0);
  });

  it("パスの ID は pathWithId（encodeURIComponent 1 回）で置く。読み直し・DELETE・確認 GET とも同じ表記", () => {
    const { ports, api, log } = setup();

    runJournalSpikeS5(ports, log);

    const idCalls = ports.http.calls.filter((c) => c.url.includes("/journals/"));
    expect(idCalls.map((c) => c.method)).toEqual(["get", "delete", "get"]);
    const paths = new Set(idCalls.map((c) => c.url.split("?")[0]));
    expect(paths.size).toBe(1);
    expect([...paths][0]).toContain("%25");
    expect(api.journals).toHaveLength(0);
  });

  it("探査用の複数表記の GET はもう行わない（H1 確定）", () => {
    const { ports, lines, log } = setup();
    runJournalSpikeS5(ports, log);
    expect(lines.join("\n")).not.toContain("ID 表記");
    expect(ports.http.calls.filter((c) => c.method === "get" && c.url.includes("/journals/"))).toHaveLength(2);
  });

  it("削除後の GET が 200 のままなら削除が効いていないとして例外", () => {
    const { ports, api, lines, log } = setup();
    const orig = api.handle.bind(api);
    api.handle = (req) => {
      if (req.method === "delete") {
        return { status: 204, headers: {}, body: "" }; // 削除したと言うが実際は残る
      }
      return orig(req);
    };

    expect(() => runJournalSpikeS5(ports, log)).toThrow(/SPIKE_DELETE_NOT_EFFECTIVE/);
    expect(lines.join("\n")).toContain("手動削除してください");
  });

  it("削除後の GET が従来どおりの 404 でも「削除済み」", () => {
    const { ports, api, lines, log } = setup();
    const orig = api.handle.bind(api);
    let deleted = false;
    api.handle = (req) => {
      if (req.method === "delete") {
        deleted = true;
      }
      if (deleted && req.method === "get" && /\/journals\/[^?]+\?/.test(req.url)) {
        return { status: 404, headers: {}, body: JSON.stringify({ errors: [{ code: "not_found", message: "n" }] }) };
      }
      return orig(req);
    };

    runJournalSpikeS5(ports, log);

    expect(lines.join("\n")).toContain("status=404");
  });

  it("MfApiError 以外（認証・一時障害）の例外はそのまま伝播する", () => {
    const { ports, api, log } = setup();
    const orig = api.handle.bind(api);
    let n = 0;
    api.handle = (req) => {
      if (req.method === "get" && /\/journals\/[^?]+\?/.test(req.url)) {
        n++;
        if (n >= 2) {
          return { status: 503, headers: {}, body: "" };
        }
      }
      return orig(req);
    };

    expect(() => runJournalSpikeS5(ports, log)).toThrow(MfTransientError);
  });

  it("削除に失敗したら仕訳 ID と手動削除の案内を出して例外を投げる", () => {
    const { ports, api, lines, log } = setup();
    api.deleteStatus = 400;

    expect(() => runJournalSpikeS5(ports, log)).toThrow(MfApiError);

    const text = lines.join("\n");
    expect(text).toContain("削除に失敗しました");
    expect(text).toContain(api.journals[0]!.id);
    expect(text).toContain("手動削除してください");
  });

  it("勘定科目が引けなければ作らずに止まる", () => {
    const { ports, api, log } = setup();
    api.missingAccounts.add("事業主借");

    expect(() => runJournalSpikeS5(ports, log)).toThrow(/SPIKE_ACCOUNT_NOT_RESOLVED:事業主借/);
    expect(api.postedBodies).toHaveLength(0);
  });

  it("シートには書かず、MF_*_ENABLED フラグも見ない。API キー・JWT をログに出さない", () => {
    const { ports, lines, log } = setup();
    expect(ports.props.get("MF_ENABLED")).toBeNull();

    runJournalSpikeS5(ports, log);

    expect(ports.sheets.columnPatches).toHaveLength(0);
    expect(ports.sheets.expenses).toHaveLength(0);
    expect(ports.sheets.internal.size).toBe(0);
    const text = lines.join("\n");
    expect(text).not.toContain("mf_api_prd_SECRET");
    expect(text).not.toContain("JWT_FAKE");
  });
});
