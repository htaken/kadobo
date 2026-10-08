/**
 * `app/mf/pingFormat.ts`（`mfInvoicePing`/`mfAccountingPing` が Logger に出す文字列の組み立て）。
 * これらの純関数は MF の応答 JSON だけを受け取り、トークン・API キーには一切触れない
 * （引数として渡りようがない）ため、この関数の入出力を見るだけで「Logger にトークンが
 * 混ざりようがない」ことが確認できる。
 */
import { describe, expect, it } from "vitest";
import { extractAccountCount, extractOfficeCodes, extractOfficeName } from "../../../src/app/mf/pingFormat";

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

describe("extractOfficeCodes", () => {
  it("offices 配列から office_code を拾う", () => {
    expect(extractOfficeCodes({ offices: [{ office_code: "AAAA-1111" }, { office_code: "BBBB-2222" }] })).toEqual([
      "AAAA-1111",
      "BBBB-2222",
    ]);
  });

  it("accessible_offices 配列からも拾う", () => {
    expect(extractOfficeCodes({ accessible_offices: [{ office_code: "AAAA-1111" }] })).toEqual(["AAAA-1111"]);
  });

  it("応答自体が配列でも拾う", () => {
    expect(extractOfficeCodes([{ office_code: "AAAA-1111" }])).toEqual(["AAAA-1111"]);
  });

  it("見つからなければ空配列", () => {
    expect(extractOfficeCodes({})).toEqual([]);
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
