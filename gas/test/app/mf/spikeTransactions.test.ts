/**
 * `app/mf/spikeTransactions.ts`（スパイク S-M4。実装設計 MF連携 §11.1）。
 * 会計 API はテスト内のフェイク応答。実際の MF にはアクセスしない。
 *
 * フェイクは実機の S-M4 の観測を再現する: `connected_account_id` のクエリ値は特定の表記だけを受け付け
 * （既定は「返された文字列そのまま」）、他の表記（特に 1 回エンコード）は 400 `invalid_query_parameter_value`。
 */
import { describe, expect, it } from "vitest";
import { ConfigMissingError } from "../../../src/app/ports";
import {
  S4_KEYWORDS,
  matchesS4Keyword,
  runTransactionSpikeS4,
  summarizeStatuses,
} from "../../../src/app/mf/spikeTransactions";
import { makeFakePorts, type FakeHttpRequest, type FakePorts } from "../fakes";
import { ACC_BASE, accountIdOf, accountingCallsOf } from "./fakeMfAccounting";

const NOW = Date.parse("2026-10-08T09:00:00+09:00");

/** URL のクエリ値を取り出す。`decode: false` ならエンコードされたまま返す。 */
function queryOf(url: string, key: string, decode = true): string | null {
  const qs = url.split("?")[1] ?? "";
  for (const pair of qs === "" ? [] : qs.split("&")) {
    const eq = pair.indexOf("=");
    const k = eq === -1 ? pair : pair.slice(0, eq);
    const v = eq === -1 ? "" : pair.slice(eq + 1);
    if (decodeURIComponent(k) === key) {
      return decode ? decodeURIComponent(v) : v;
    }
  }
  return null;
}

interface Tx {
  id: string;
  date: string;
  value: number;
  side: string;
  content: string | null;
  journalizing_status: string;
  connected_account_id: string;
  connected_sub_account_id: string | null;
}

const CARD_ID = "card%2B1%3D%3D";
const BANK_ID = "bank%2B1%3D%3D";
const MANUAL_ID = "manual%2B1%3D%3D";
const SUB1 = "sub%2B1%3D%3D";

function tx(i: number, over: Partial<Tx> & { connected_account_id: string }): Tx {
  return {
    id: `tx%2B${i}%3D%3D`,
    date: "2026-09-01",
    value: 1000 + i,
    side: "EXPENSE",
    content: `店${i}`,
    journalizing_status: "none",
    connected_sub_account_id: null,
    ...over,
  };
}

type AcceptForm = "once" | "raw" | "decoded" | "none";

interface Opts {
  connectedAccounts?: unknown[];
  acceptForm?: AcceptForm;
  all?: Tx[];
}

function setup(opts: Opts = {}) {
  const ports: FakePorts = makeFakePorts(NOW);
  ports.props.set("MF_ACCOUNTING_API_KEY", "mf_api_prd_SECRET");
  ports.props.set("MF_OFFICE_CODE", "1234-5678");
  const connectedAccounts = opts.connectedAccounts ?? [
    {
      id: CARD_ID,
      name: "テストカード",
      is_manual: false,
      account_id: null,
      sub_account_id: null,
      connected_sub_accounts: [
        { id: SUB1, name: "カード本体", account_id: accountIdOf("通信費"), sub_account_id: null },
        { id: "sub%2B2%3D%3D", name: "ポイント", account_id: accountIdOf("雑費"), sub_account_id: null },
      ],
    },
    {
      id: BANK_ID,
      name: "テスト銀行",
      is_manual: false,
      account_id: accountIdOf("雑費"),
      sub_account_id: null,
      connected_sub_accounts: [],
    },
    {
      id: MANUAL_ID,
      name: "手動の現金",
      is_manual: true,
      account_id: accountIdOf("事業主借"),
      sub_account_id: null,
      connected_sub_accounts: [],
    },
  ];
  const state = { acceptForm: opts.acceptForm ?? ("raw" as AcceptForm), all: opts.all ?? ([] as Tx[]) };
  const requests: FakeHttpRequest[] = [];
  const json = (status: number, body: unknown) => ({ status, headers: {}, body: JSON.stringify(body) });
  ports.http.fetch = (req: FakeHttpRequest) => {
    ports.http.calls.push(req);
    requests.push(req);
    if (req.url === "https://api.biz.moneyforward.com/auth/exchange") {
      return json(200, { access_token: "JWT_FAKE", expires_in: 3600 });
    }
    const path = req.url.slice(ACC_BASE.length).split("?")[0];
    if (path === "/connected_accounts") {
      return json(200, { connected_accounts: connectedAccounts });
    }
    if (path === "/accounts") {
      return json(200, {
        accounts: ["通信費", "雑費", "事業主借"].map((n) => ({ id: accountIdOf(n), name: n, available: true })),
      });
    }
    if (path === "/transactions") {
      const rawFilter = queryOf(req.url, "connected_account_id", false);
      let rows = state.all;
      if (rawFilter !== null) {
        const ids = (connectedAccounts as { id: string }[]).map((c) => c.id);
        const form = (id: string): string =>
          state.acceptForm === "once"
            ? encodeURIComponent(id)
            : state.acceptForm === "decoded"
              ? decodeURIComponent(id)
              : id;
        const hit = state.acceptForm === "none" ? undefined : ids.find((id) => form(id) === rawFilter);
        if (hit === undefined) {
          return json(400, {
            errors: [{ code: "invalid_query_parameter_value", message: "invalid value. Target: connected_account_id" }],
          });
        }
        rows = rows.filter((t) => t.connected_account_id === hit);
      }
      const perPage = Number(queryOf(req.url, "per_page"));
      const page = Number(queryOf(req.url, "page") ?? "1");
      return json(200, {
        transactions: rows.slice((page - 1) * perPage, page * perPage),
        metadata: { total_pages: Math.max(1, Math.ceil(rows.length / perPage)), total_count: rows.length },
      });
    }
    return json(404, { errors: [{ code: "no_route", message: `${req.method} ${path}` }] });
  };
  const lines: string[] = [];
  return { ports, state, requests, lines, log: (l: string) => lines.push(l) };
}

function txRequests(requests: FakeHttpRequest[]): FakeHttpRequest[] {
  return requests.filter((r) => r.url.startsWith(`${ACC_BASE}/transactions`));
}

describe("runTransactionSpikeS4: 連携サービスと口座", () => {
  it("連携サービスと口座を科目名つきで出す（科目の無い連携サービスは (なし)）", () => {
    const { ports, lines, log } = setup();

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain(`connected_account: id=${CARD_ID} name=テストカード is_manual=false account=(なし)`);
    expect(lines).toContain(`  sub_account: id=${SUB1} name=カード本体 account=通信費(${accountIdOf("通信費")})`);
    expect(lines).toContain(
      `connected_account: id=${BANK_ID} name=テスト銀行 is_manual=false account=雑費(${accountIdOf("雑費")})`,
    );
    expect(lines).toContain(
      `connected_account: id=${MANUAL_ID} name=手動の現金 is_manual=true account=事業主借(${accountIdOf("事業主借")})`,
    );
  });

  it("科目名が引けない account_id は (科目名不明) と出す", () => {
    const { ports, lines, log } = setup({
      connectedAccounts: [
        { id: BANK_ID, name: "銀行", is_manual: false, account_id: "unknown%2B%3D", sub_account_id: null, connected_sub_accounts: [] },
      ],
    });

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain("connected_account: id=bank%2B1%3D%3D name=銀行 is_manual=false account=(科目名不明)(unknown%2B%3D)");
  });

  it("連携サービスが 0 件なら明細を取らず、その旨を出す", () => {
    const { ports, requests, lines, log } = setup({ connectedAccounts: [] });

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain("S-M4 連携サービス 0 件（MF_CARD_ACCOUNT_IDS／MF_BANK_ACCOUNT_IDS には connected_account の id を入れる）");
    expect(lines).toContain("connected_account: (なし)");
    expect(lines).toContain("S-M4 明細を取得する連携サービス（is_manual=false）がありません。");
    expect(txRequests(requests)).toHaveLength(0);
  });
});

describe("runTransactionSpikeS4: connected_account_id の表記の探査", () => {
  it("(a)(b)(c) を per_page=10 で順に試し、結果を 1 行ずつ出す。最初に 200 になった (b) を以後のサービスにも使う", () => {
    const { ports, state, requests, lines, log } = setup({ acceptForm: "raw" });
    state.all = [tx(1, { connected_account_id: CARD_ID }), tx(2, { connected_account_id: CARD_ID })];

    runTransactionSpikeS4(ports, log);

    const probe = (label: string, id: string) => lines.find((l) => l.startsWith(`S-M4 探査 ${label}`) && l.includes(`id=${id} `));
    expect(probe("(a)", CARD_ID)).toContain("status=400 code=invalid_query_parameter_value");
    expect(probe("(b)", CARD_ID)).toContain("200 件数=2 total_count=2");
    expect(probe("(c)", CARD_ID)).toContain("status=400 code=invalid_query_parameter_value");
    expect(lines).toContain("S-M4 探査: 200 になった最初の表記は (b) raw（返された文字列そのまま）。以後のサービスにも使う。");
    expect(probe("(b)", BANK_ID)).toContain("200 件数=0");
    // 2 件目のサービスは (b) だけ（a・c は試さない）。manual は探査しない。
    expect(lines.filter((l) => l.startsWith("S-M4 探査 (") && l.includes(`id=${BANK_ID} `))).toHaveLength(1);
    expect(lines.some((l) => l.startsWith("S-M4 探査 (") && l.includes(`id=${MANUAL_ID} `))).toBe(false);

    const filtered = txRequests(requests).filter((r) => queryOf(r.url, "connected_account_id", false) !== null);
    expect(filtered.map((r) => queryOf(r.url, "connected_account_id", false))).toEqual([
      encodeURIComponent(CARD_ID), // (a) 従来の 1 回エンコード
      CARD_ID, // (b) そのまま
      decodeURIComponent(CARD_ID), // (c) デコード
      BANK_ID, // 2 件目は (b)
    ]);
    expect(filtered.every((r) => queryOf(r.url, "per_page") === "10")).toBe(true);
  });

  it("(c) だけが 200 なら (c) を以後に使う", () => {
    const { ports, requests, lines, log } = setup({ acceptForm: "decoded" });

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain("S-M4 探査: 200 になった最初の表記は (c) raw（decodeURIComponent した文字列）。以後のサービスにも使う。");
    const filtered = txRequests(requests).filter((r) => queryOf(r.url, "connected_account_id", false) !== null);
    const ids = filtered.map((r) => queryOf(r.url, "connected_account_id", false));
    expect(ids[ids.length - 1]).toBe(decodeURIComponent(BANK_ID));
  });

  it("(a) が 200 なら (a) を使う", () => {
    const { ports, lines, log } = setup({ acceptForm: "once" });

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain("S-M4 探査: 200 になった最初の表記は (a) 1 回エンコード（従来）。以後のサービスにも使う。");
  });

  it("どの表記も 200 にならなければその旨を出し、絞り込みなし取得は行う", () => {
    const { ports, state, requests, lines, log } = setup({ acceptForm: "none" });
    state.all = [tx(1, { connected_account_id: CARD_ID, content: "カード引落" })];

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain("S-M4 探査: どの表記でも 200 にならなかった。以後の絞り込み取得は行わず、絞り込みなし取得だけを使う。");
    const filtered = txRequests(requests).filter((r) => queryOf(r.url, "connected_account_id", false) !== null);
    expect(filtered).toHaveLength(3);
    expect(lines.some((l) => l.includes("カード引落") && l.startsWith("2026-09-01 "))).toBe(true);
  });
});

describe("runTransactionSpikeS4: 絞り込みなし取得", () => {
  it("connected_account_id なし・今日−90日〜今日・order=desc・per_page=500・page=1 で取り、全体の total_count を出す", () => {
    const { ports, state, requests, lines, log } = setup();
    state.all = [tx(1, { connected_account_id: CARD_ID }), tx(2, { connected_account_id: BANK_ID })];

    runTransactionSpikeS4(ports, log);

    const unfiltered = txRequests(requests).filter((r) => queryOf(r.url, "connected_account_id", false) === null);
    expect(unfiltered).toHaveLength(1);
    const url = unfiltered[0]?.url as string;
    expect(queryOf(url, "start_date")).toBe("2026-07-10");
    expect(queryOf(url, "end_date")).toBe("2026-10-08");
    expect(queryOf(url, "order")).toBe("desc");
    expect(queryOf(url, "page")).toBe("1");
    expect(queryOf(url, "per_page")).toBe("500");
    expect(queryOf(url, "office_code")).toBe("1234-5678");
    expect(lines).toContain(
      "S-M4 絞り込みなし取得・全体 total_count=2 total_pages=1 2026-07-10〜2026-10-08 order=desc per_page=500 取得 1 ページ 2 件",
    );
  });

  it("total_pages まで（最大 3 ページ）取り、超える分は取らずに注意を出す", () => {
    const { ports, state, requests, lines, log } = setup();
    state.all = Array.from({ length: 1600 }, (_, i) => tx(i + 1, { connected_account_id: CARD_ID }));

    runTransactionSpikeS4(ports, log);

    const pages = txRequests(requests)
      .filter((r) => queryOf(r.url, "connected_account_id", false) === null)
      .map((r) => queryOf(r.url, "page"));
    expect(pages).toEqual(["1", "2", "3"]);
    expect(lines).toContain(
      "S-M4 絞り込みなし取得・全体 total_count=1600 total_pages=4 2026-07-10〜2026-10-08 order=desc per_page=500 取得 3 ページ 1500 件",
    );
    expect(lines).toContain("S-M4 注意: total_pages=4 のうち 3 ページ目までしか取っていない（古い明細が含まれない）。");
  });

  it("2 ページで足りるなら 2 ページで止める", () => {
    const { ports, state, requests, log } = setup();
    state.all = Array.from({ length: 700 }, (_, i) => tx(i + 1, { connected_account_id: CARD_ID }));

    runTransactionSpikeS4(ports, log);

    const pages = txRequests(requests)
      .filter((r) => queryOf(r.url, "connected_account_id", false) === null)
      .map((r) => queryOf(r.url, "page"));
    expect(pages).toEqual(["1", "2"]);
  });

  it("手元で connected_account_id ごとに分け、is_manual=true は出力しない。一覧にないサービスは注意を出す", () => {
    const { ports, state, lines, log } = setup();
    state.all = [
      tx(1, { connected_account_id: CARD_ID, content: "カード店A" }),
      tx(2, { connected_account_id: BANK_ID, content: "銀行店B" }),
      tx(3, { connected_account_id: MANUAL_ID, content: "手動明細" }),
      tx(4, { connected_account_id: "other%2B%3D", content: "謎の明細" }),
    ];

    runTransactionSpikeS4(ports, log);

    const text = lines.join("\n");
    expect(text).toContain("カード店A");
    expect(text).toContain("銀行店B");
    expect(text).not.toContain("手動明細");
    expect(text).not.toContain("謎の明細");
    expect(lines).toContain(`S-M4 明細: connected_account id=${CARD_ID} name=テストカード 絞り込みなし取得のうち 1 件`);
    expect(lines).toContain(`S-M4 明細: connected_account id=${BANK_ID} name=テスト銀行 絞り込みなし取得のうち 1 件`);
    expect(lines).toContain("S-M4 注意: 連携サービス一覧にない connected_account_id の明細が 1 件ある。");
    expect(lines).toContain("S-M4 is_manual=true の連携サービスの明細 1 件は出力しない。");
    expect(lines).toContain(`S-M4 connected_account id=${MANUAL_ID} name=手動の現金: is_manual=true のため対象外`);
  });

  it("明細行に口座名を `[…]` で足す（直接紐付きは (直接)、一覧にない口座は (口座名不明)）。口座別の件数も出す", () => {
    const { ports, state, lines, log } = setup();
    state.all = [
      tx(1, { connected_account_id: CARD_ID, connected_sub_account_id: SUB1, content: "A", value: 100 }),
      tx(2, { connected_account_id: CARD_ID, connected_sub_account_id: SUB1, content: "B", value: 200 }),
      tx(3, { connected_account_id: CARD_ID, connected_sub_account_id: "sub%2B2%3D%3D", content: "C", value: 300 }),
      tx(4, { connected_account_id: CARD_ID, connected_sub_account_id: null, content: "D", value: 400 }),
      tx(5, { connected_account_id: CARD_ID, connected_sub_account_id: "zzz%3D", content: "E", value: 500 }),
    ];

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain("2026-09-01 100 EXPENSE none [カード本体] A");
    expect(lines).toContain("2026-09-01 300 EXPENSE none [ポイント] C");
    expect(lines).toContain("2026-09-01 400 EXPENSE none [(直接)] D");
    expect(lines).toContain("2026-09-01 500 EXPENSE none [(口座名不明)] E");
    expect(lines).toContain("S-M4 口座別の件数: [カード本体]=2 [ポイント]=1 [(直接)]=1 [(口座名不明)]=1");
  });

  it("明細は最大 40 件まで列挙し、date の範囲・集計・キーワード抽出は取得した全件が対象", () => {
    const { ports, state, lines, log } = setup();
    state.all = Array.from({ length: 100 }, (_, i) =>
      tx(i + 1, {
        connected_account_id: CARD_ID,
        date: `2026-09-${String(((i + 1) % 28) + 1).padStart(2, "0")}`,
        content: i + 1 === 90 ? "積立 NISA" : `店${i + 1}`,
        journalizing_status: (i + 1) % 2 === 0 ? "registered" : "none",
      }),
    );

    runTransactionSpikeS4(ports, log);

    const listed = lines.filter((l) => /^2026-09-\d\d \d+ EXPENSE (none|registered) \[\(直接\)\] 店\d+$/.test(l));
    expect(listed).toHaveLength(40);
    expect(lines.some((l) => l.endsWith(" 店41"))).toBe(false);
    expect(lines).toContain("S-M4 明細（date value side journalizing_status [口座名] content）先頭 40 件");
    expect(lines).toContain("S-M4 date の最小=2026-09-01 最大=2026-09-28（取得した明細 100 件）");
    expect(lines).toContain("S-M4 journalizing_status 集計: none=50 registered=50");
    expect(lines.some((l) => l.startsWith("  ") && l.endsWith("積立 NISA"))).toBe(true);
  });

  it("journalizing_status を連携サービスごとと全体で集計する", () => {
    const { ports, state, lines, log } = setup();
    state.all = [
      tx(1, { connected_account_id: CARD_ID, journalizing_status: "none" }),
      tx(2, { connected_account_id: CARD_ID, journalizing_status: "none" }),
      tx(3, { connected_account_id: CARD_ID, journalizing_status: "excluded" }),
      tx(4, { connected_account_id: BANK_ID, journalizing_status: "registered" }),
    ];

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain("S-M4 journalizing_status 集計: none=2 excluded=1");
    expect(lines).toContain("S-M4 journalizing_status 集計: registered=1");
    expect(lines).toContain("S-M4 journalizing_status 集計（is_manual=false の全連携サービス 4 件）: none=2 excluded=1 registered=1");
  });

  it("NISA・ニーサ・積立・つみたて・カード・引落を含む content だけを別に列挙する（大文字小文字・全角半角を無視）", () => {
    const { ports, state, lines, log } = setup();
    const contents = ["Nisa つみたて", "ニーサ口座", "投信積立", "つみたて投資", "ｶｰﾄﾞ引落", "ｸﾚｼﾞｯﾄ ＮＩＳＡ", "コンビニ", "ガソリン代"];
    state.all = contents.map((c, i) => tx(i + 1, { connected_account_id: BANK_ID, content: c }));

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain(`S-M4 キーワード（${S4_KEYWORDS.join("・")}）を content に含む明細 6 件`);
    const hits = lines.filter((l) => l.startsWith("  2026-09-01 ")).map((l) => l.split(" [(直接)] ")[1]);
    expect(hits).toEqual(["Nisa つみたて", "ニーサ口座", "投信積立", "つみたて投資", "ｶｰﾄﾞ引落", "ｸﾚｼﾞｯﾄ ＮＩＳＡ"]);
  });

  it("明細が 0 件の連携サービスは 0 件と出し、全体の total_count=0 も出す", () => {
    const { ports, lines, log } = setup();

    runTransactionSpikeS4(ports, log);

    expect(lines).toContain(`S-M4 明細: connected_account id=${CARD_ID} name=テストカード 絞り込みなし取得のうち 0 件`);
    expect(lines).toContain("S-M4 明細 0 件");
    expect(lines.some((l) => l.startsWith("S-M4 絞り込みなし取得・全体 total_count=0 "))).toBe(true);
    expect(lines.some((l) => l.startsWith("S-M4 date の最小"))).toBe(false);
  });
});

describe("runTransactionSpikeS4: 安全性", () => {
  it("GET だけを呼ぶ（POST/PUT/DELETE なし）", () => {
    const { ports, state, log } = setup();
    state.all = [tx(1, { connected_account_id: CARD_ID })];

    runTransactionSpikeS4(ports, log);

    expect(
      ports.http.calls.every((c) => c.method === "get" || c.url === "https://api.biz.moneyforward.com/auth/exchange"),
    ).toBe(true);
    const calls = accountingCallsOf(ports);
    expect(calls.every((c) => c.startsWith("GET "))).toBe(true);
    expect(calls.slice(0, 2)).toEqual(["GET /connected_accounts", "GET /accounts"]);
  });

  it("MF_OFFICE_CODE・MF_ACCOUNTING_API_KEY が未設定なら ConfigMissingError（HTTP を送らない）", () => {
    for (const key of ["MF_OFFICE_CODE", "MF_ACCOUNTING_API_KEY"]) {
      const { ports, log } = setup();
      ports.props.set(key, "");

      let caught: unknown;
      try {
        runTransactionSpikeS4(ports, log);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ConfigMissingError);
      expect((caught as ConfigMissingError).propertyKey).toBe(key);
      expect(ports.http.calls).toHaveLength(0);
    }
  });

  it("API キー・JWT・事業者番号をログに出さない", () => {
    const { ports, state, lines, log } = setup();
    state.all = [tx(1, { connected_account_id: CARD_ID })];

    runTransactionSpikeS4(ports, log);

    const text = lines.join("\n");
    expect(text).not.toContain("mf_api_prd_SECRET");
    expect(text).not.toContain("JWT_FAKE");
    expect(text).not.toContain("1234-5678");
  });
});

describe("matchesS4Keyword / summarizeStatuses", () => {
  it("content が null や該当なしなら false", () => {
    expect(matchesS4Keyword(null)).toBe(false);
    expect(matchesS4Keyword("コンビニ")).toBe(false);
    expect(matchesS4Keyword("nisa")).toBe(true);
  });

  it("明細が無ければ (明細なし)", () => {
    expect(summarizeStatuses([])).toBe("(明細なし)");
  });
});
