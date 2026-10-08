/**
 * `app/mf/pingFormat.ts`（`mfInvoicePing`/`mfAccountingPing` が Logger に出す文字列の組み立て）。
 * これらの純関数は MF の応答 JSON だけを受け取り、トークン・API キーには一切触れない
 * （引数として渡りようがない）ため、この関数の入出力を見るだけで「Logger にトークンが
 * 混ざりようがない」ことが確認できる。
 */
import { describe, expect, it } from "vitest";
import {
  S_M3_ACCOUNT_NAMES,
  collectTaxIds,
  extractAccountCount,
  extractAccounts,
  extractOfficeName,
  extractOffices,
  extractTaxes,
  formatAccountCounts,
  formatAccountLookup,
  formatOffice,
  formatTaxLine,
  lookupAccountsByName,
} from "../../../src/app/mf/pingFormat";

describe("extractOfficeName", () => {
  it("トップレベルの name を拾う", () => {
    expect(extractOfficeName({ name: "サンプル商店" })).toBe("サンプル商店");
  });

  it("office にラップされた name を拾う", () => {
    expect(extractOfficeName({ office: { name: "サンプル商店" } })).toBe("サンプル商店");
  });

  it("company_name も拾う", () => {
    expect(extractOfficeName({ company_name: "サンプル商店" })).toBe("サンプル商店");
  });

  it("見つからなければ固定文言を返す（トークン等を誤って拾わない）", () => {
    expect(extractOfficeName({ access_token: "SECRET" })).toBe("(事業者名が見つかりません)");
    expect(extractOfficeName(null)).toBe("(事業者名が見つかりません)");
    expect(extractOfficeName(undefined)).toBe("(事業者名が見つかりません)");
  });
});

describe("extractOffices", () => {
  it("accessible_offices 配列から name・code・type を拾う", () => {
    expect(
      extractOffices({
        accessible_offices: [
          { name: "サンプル商店", code: "AAAA-1111", type: "individual", accounting_periods: [] },
          { name: "別事業者", code: "BBBB-2222", type: "corporation" },
        ],
      }),
    ).toEqual([
      { name: "サンプル商店", code: "AAAA-1111", type: "individual" },
      { name: "別事業者", code: "BBBB-2222", type: "corporation" },
    ]);
  });

  it("code が無ければ office_code にフォールバックする（後方互換）", () => {
    expect(extractOffices({ accessible_offices: [{ name: "旧形式", office_code: "AAAA-1111", type: "x" }] })).toEqual([
      { name: "旧形式", code: "AAAA-1111", type: "x" },
    ]);
  });

  it("code と office_code が両方あれば code を優先する", () => {
    expect(extractOffices({ accessible_offices: [{ code: "NEW", office_code: "OLD" }] })[0]?.code).toBe("NEW");
  });

  it("offices 配列や応答自体の配列でも拾う", () => {
    expect(extractOffices({ offices: [{ code: "A" }] })[0]?.code).toBe("A");
    expect(extractOffices([{ code: "A" }])[0]?.code).toBe("A");
  });

  it("項目が無ければ ? にする", () => {
    expect(extractOffices({ accessible_offices: [{}] })).toEqual([{ name: "?", code: "?", type: "?" }]);
  });

  it("見つからなければ空配列", () => {
    expect(extractOffices({})).toEqual([]);
    expect(extractOffices(null)).toEqual([]);
  });
});

describe("formatOffice", () => {
  it("name (code) type の形にする", () => {
    expect(formatOffice({ name: "サンプル商店", code: "AAAA-1111", type: "individual" })).toBe(
      "サンプル商店 (AAAA-1111) individual",
    );
  });
});

describe("extractAccountCount", () => {
  it("accounts 配列の件数を数える", () => {
    expect(extractAccountCount({ accounts: [{}, {}, {}] })).toBe(3);
  });

  it("応答自体が配列でも数える", () => {
    expect(extractAccountCount([{}, {}])).toBe(2);
  });

  it("見つからなければ 0", () => {
    expect(extractAccountCount({})).toBe(0);
  });
});

const acc = (id: string, name: string, taxId: string | number | null, available = true) => ({
  id,
  name,
  tax_id: taxId,
  available,
  financial_statement_type: "profit_and_loss",
});

/** 8 科目すべてが 1 件ずつある `GET /accounts?available=true` の応答。 */
function allEightAccounts(): { accounts: ReturnType<typeof acc>[] } {
  return { accounts: S_M3_ACCOUNT_NAMES.map((n, i) => acc(`id-${i}`, n, i === 7 ? null : 21)) };
}

describe("S_M3_ACCOUNT_NAMES", () => {
  it("設計書 §6.4 の 8 科目", () => {
    expect([...S_M3_ACCOUNT_NAMES]).toEqual([
      "通信費",
      "消耗品費",
      "旅費交通費",
      "新聞図書費",
      "会議費",
      "支払手数料",
      "雑費",
      "事業主借",
    ]);
  });
});

describe("extractAccounts", () => {
  it("id・name・tax_id・available を取り出す（数値 id も文字列にする）", () => {
    expect(extractAccounts({ accounts: [acc("a1", "通信費", 21), { id: 7, name: "雑費", available: false }] })).toEqual([
      { id: "a1", name: "通信費", taxId: "21", available: true },
      { id: "7", name: "雑費", taxId: null, available: false },
    ]);
  });

  it("id か name が無い要素は除く", () => {
    expect(extractAccounts({ accounts: [{ name: "x" }, { id: "1" }, null] })).toEqual([]);
  });
});

describe("lookupAccountsByName", () => {
  it("8 科目が 1 件ずつなら全部 one", () => {
    const r = lookupAccountsByName(allEightAccounts());
    expect(r.map((l) => l.status)).toEqual(Array(8).fill("one"));
    expect(r[0]?.matches).toEqual([{ id: "id-0", name: "通信費", taxId: "21", available: true }]);
  });

  it("名前が無ければ none", () => {
    const res = { accounts: [acc("1", "通信費", 21)] };
    const r = lookupAccountsByName(res);
    expect(r.find((l) => l.name === "雑費")).toMatchObject({ status: "none", matches: [] });
    expect(r.find((l) => l.name === "通信費")?.status).toBe("one");
  });

  it("同名が 2 件あれば multiple", () => {
    const res = { accounts: [acc("1", "雑費", 21), acc("2", "雑費", 22)] };
    const l = lookupAccountsByName(res).find((x) => x.name === "雑費");
    expect(l?.status).toBe("multiple");
    expect(l?.matches.map((m) => m.id)).toEqual(["1", "2"]);
  });

  it("完全一致のみ数える（部分一致・前後空白は別物）", () => {
    const res = { accounts: [acc("1", "通信費（旧）", 21), acc("2", " 通信費", 21), acc("3", "通信費 ", 21)] };
    expect(lookupAccountsByName(res).find((x) => x.name === "通信費")?.status).toBe("none");
  });

  it("available:false の科目は数えない", () => {
    const res = { accounts: [acc("1", "雑費", 21, false), acc("2", "雑費", 21, true)] };
    const l = lookupAccountsByName(res).find((x) => x.name === "雑費");
    expect(l?.status).toBe("one");
    expect(l?.matches[0]?.id).toBe("2");
  });

  it("応答が空なら 8 件すべて none", () => {
    expect(lookupAccountsByName({}).map((l) => l.status)).toEqual(Array(8).fill("none"));
  });
});

describe("formatAccountCounts", () => {
  it("有効件数と無指定の全件数を出す", () => {
    expect(formatAccountCounts({ accounts: [{}, {}] }, { accounts: [{}, {}, {}] })).toBe(
      "MF accounting GET /accounts: 有効(available=true) 2 件 / 無指定 3 件",
    );
  });
});

describe("formatAccountLookup", () => {
  it("1 件なら id と tax_id を添える", () => {
    const l = lookupAccountsByName({ accounts: [acc("A1", "通信費", 21)] })[0]!;
    expect(formatAccountLookup(l)).toBe("S-M3 科目 通信費: 1 件 OK id=A1 tax_id=21");
  });

  it("tax_id が無い科目は tax_id=なし", () => {
    const l = lookupAccountsByName({ accounts: [acc("A1", "通信費", null)] })[0]!;
    expect(formatAccountLookup(l)).toBe("S-M3 科目 通信費: 1 件 OK id=A1 tax_id=なし");
  });

  it("0 件", () => {
    const l = lookupAccountsByName({})[0]!;
    expect(formatAccountLookup(l)).toBe("S-M3 科目 通信費: 0 件 NG（有効な科目に名前完全一致なし）");
  });

  it("複数件は全件の id と tax_id を出す", () => {
    const l = lookupAccountsByName({ accounts: [acc("A1", "通信費", 21), acc("A2", "通信費", 22)] })[0]!;
    expect(formatAccountLookup(l)).toBe("S-M3 科目 通信費: 2 件 NG（複数一致） id=A1 tax_id=21 / id=A2 tax_id=22");
  });
});

describe("collectTaxIds", () => {
  it("見つかった科目の tax_id を重複なし・出現順で集める（null は除く）", () => {
    const res = { accounts: [acc("1", "通信費", 21), acc("2", "消耗品費", 22), acc("3", "雑費", 21), acc("4", "会議費", null)] };
    expect(collectTaxIds(lookupAccountsByName(res))).toEqual(["21", "22"]);
  });

  it("複数一致の科目の tax_id も含める", () => {
    const res = { accounts: [acc("1", "雑費", 21), acc("2", "雑費", 30)] };
    expect(collectTaxIds(lookupAccountsByName(res))).toEqual(["21", "30"]);
  });

  it("科目が無ければ空", () => {
    expect(collectTaxIds(lookupAccountsByName({}))).toEqual([]);
  });
});

describe("extractTaxes / formatTaxLine", () => {
  const taxes = {
    taxes: [
      { id: 21, name: "対象外", abbreviation: "対象外", tax_rate: 0, search_key: "x", available: true },
      { id: "22", name: "課税仕入 10%", tax_rate: 0.1, available: false },
    ],
  };

  it("id・name・tax_rate・available を取り出す", () => {
    expect(extractTaxes(taxes)).toEqual([
      { id: "21", name: "対象外", taxRate: "0", available: "true" },
      { id: "22", name: "課税仕入 10%", taxRate: "0.1", available: "false" },
    ]);
  });

  it("tax_id（文字列）と数値 id を突き合わせる", () => {
    expect(formatTaxLine("21", taxes)).toBe("S-M3 税区分 tax_id=21: name=対象外 tax_rate=0 available=true");
    expect(formatTaxLine("22", taxes)).toBe("S-M3 税区分 tax_id=22: name=課税仕入 10% tax_rate=0.1 available=false");
  });

  it("taxes に無い tax_id は見つからない旨を出す", () => {
    expect(formatTaxLine("99", taxes)).toBe("S-M3 税区分 tax_id=99: /taxes に見つかりません");
    expect(formatTaxLine("99", {})).toBe("S-M3 税区分 tax_id=99: /taxes に見つかりません");
  });
});

describe("認証情報がログに混ざらない", () => {
  it("応答に token や api_key があっても整形結果に出ない", () => {
    const res = { accounts: [{ ...acc("A1", "通信費", 21), access_token: "SECRET", api_key: "SECRET" }], access_token: "SECRET" };
    const lines = [
      formatAccountCounts(res, res),
      ...lookupAccountsByName(res).map(formatAccountLookup),
      formatTaxLine("21", { taxes: [{ id: 21, name: "対象外", tax_rate: 0, available: true, access_token: "SECRET" }] }),
      ...extractOffices({ accessible_offices: [{ name: "n", code: "c", type: "t", access_token: "SECRET" }] }).map(formatOffice),
    ];
    expect(lines.join("\n")).not.toContain("SECRET");
  });
});
