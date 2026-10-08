/**
 * `app/mf/spikeInvoice.ts`（スパイク S-M1・S-M2。実装設計 MF連携 §11.1）。
 * `FakeHttp.fetch` を請求書 API の簡易フェイクサーバに差し替えて検証する。実際の MF にはアクセスしない。
 */
import { describe, expect, it } from "vitest";
import { MF_INVOICE_TOKENS_KEY } from "../../../src/app/mf/invoiceClient";
import { ConfigMissingError } from "../../../src/app/ports";
import {
  expectedSpikeAmounts,
  runInvoiceSpikeS1,
} from "../../../src/app/mf/spikeInvoice";
import { makeFakePorts, type FakeHttpRequest, type FakePorts } from "../fakes";

const BASE = "https://invoice.moneyforward.com/api/v3";
const ACCESS = "SECRET_ACCESS_TOKEN_VALUE";
const REFRESH = "SECRET_REFRESH_TOKEN_VALUE";

interface ServerOptions {
  /** 既存の請求書（前回の削除失敗分）。 */
  preexisting?: boolean;
  /** 作成時の端数処理。`round_off` だと消費税が 28802 になる（不一致）。 */
  rounding?: "round_down" | "round_off";
  /** `document_number` の検索方式。 */
  search?: "exact" | "partial";
  /** DELETE の応答ステータス。 */
  deleteStatus?: number;
  /** DELETE 後も GET が 200 を返す（削除が効いていない）。 */
  deleteIneffective?: boolean;
  /** GET /billings/{id} の応答ステータスを 500 にする。 */
  failDetail?: boolean;
}

function json(status: number, body: unknown): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers: {}, body: JSON.stringify(body) };
}

function makeBilling(id: string, rounding: "round_down" | "round_off"): Record<string, unknown> {
  const excise = rounding === "round_down" ? "28801" : "28802";
  return {
    id,
    billing_number: "KD-TEST-S1",
    subtotal_price: "288018",
    excise_price: excise,
    total_price: String(288018 + Number(excise)),
    deduct_price: "0",
    payment_status: "未設定",
    email_status: "未送信",
    posting_status: "未郵送",
    items: [{ name: "テスト（削除予定）", quantity: 160.01, price: "1800", excise: "ten_percent" }],
    config: { rounding, rounding_consumption_tax: rounding, consumption_tax_display_type: "external" },
  };
}

/** `ports.http.fetch` を差し替え、`FakeHttp.calls` にも記録する。 */
function installServer(ports: FakePorts, opts: ServerOptions = {}) {
  const state = {
    billing: opts.preexisting === true ? makeBilling("EXISTING_ID", opts.rounding ?? "round_down") : null,
    deleted: false,
    posts: [] as Record<string, unknown>[],
  };
  const http = ports.http;
  http.fetch = (req: FakeHttpRequest) => {
    http.calls.push(req);
    const url = req.url.slice(BASE.length);
    if (req.method === "get" && url.startsWith("/billings?")) {
      const q = decodeURIComponent(/document_number=([^&]*)/.exec(url)?.[1] ?? "");
      const b = state.billing;
      const hit =
        b !== null &&
        !state.deleted &&
        (opts.search === "partial" ? String(b.billing_number).includes(q) : b.billing_number === q);
      const data = hit ? [b] : [];
      return json(200, {
        data,
        pagination: { total_count: data.length, total_pages: 1, current_page: 1, per_page: 100 },
      });
    }
    if (req.method === "post" && url === "/invoice_template_billings") {
      state.posts.push(JSON.parse(req.payload ?? "{}") as Record<string, unknown>);
      state.billing = makeBilling("NEW_ID", opts.rounding ?? "round_down");
      return json(201, state.billing);
    }
    const m = /^\/billings\/([^/?]+)$/.exec(url);
    if (m !== null && state.billing !== null && m[1] === state.billing.id) {
      if (req.method === "get") {
        if (opts.failDetail === true && !state.deleted) {
          return { status: 500, headers: {}, body: "" };
        }
        if (state.deleted && opts.deleteIneffective !== true) {
          return json(404, { errors: [{ code: "not_found", message: "not found" }] });
        }
        return json(200, state.billing);
      }
      if (req.method === "delete") {
        const status = opts.deleteStatus ?? 204;
        if (status === 204) {
          state.deleted = true;
        }
        return { status, headers: {}, body: "" };
      }
    }
    return json(404, { errors: [{ code: "not_found", message: "no route" }] });
  };
  return state;
}

function setup(opts: ServerOptions = {}) {
  const ports = makeFakePorts(Date.parse("2026-10-08T09:00:00+09:00"));
  ports.secrets.set(
    MF_INVOICE_TOKENS_KEY,
    JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, refreshed_at: 1_000, generation: 1 }),
  );
  ports.props.set("MF_DEPARTMENT_ID", "DEPT_1");
  const state = installServer(ports, opts);
  const lines: string[] = [];
  return { ports, state, lines, log: (l: string) => lines.push(l) };
}

function methodsOf(ports: FakePorts): string[] {
  return ports.http.calls.map((c) => `${c.method} ${c.url.slice(BASE.length).split("?")[0]}`);
}

describe("expectedSpikeAmounts", () => {
  it("160.01 × 1800 の切捨は 288018 / 28801 / 316819", () => {
    expect(expectedSpikeAmounts()).toEqual({
      amount: 288018,
      tax_amount: 28801,
      withholding_amount: 0,
      net_amount: 316819,
    });
  });
});

describe("runInvoiceSpikeS1", () => {
  it("MF_DEPARTMENT_ID が未設定なら ConfigMissingError（MF は呼ばない）", () => {
    const { ports, log } = setup();
    ports.props.values.delete("MF_DEPARTMENT_ID");
    expect(() => runInvoiceSpikeS1(ports, log)).toThrow(ConfigMissingError);
    expect(ports.http.calls).toHaveLength(0);
  });

  it("既存の KD-TEST-S1 が無ければ POST する（本文は仕様どおり）", () => {
    const { ports, state, lines, log } = setup();
    runInvoiceSpikeS1(ports, log);

    expect(state.posts).toHaveLength(1);
    const body = state.posts[0] as Record<string, unknown>;
    expect(body).toMatchObject({
      department_id: "DEPT_1",
      billing_number: "KD-TEST-S1",
      title: "【テスト・削除予定】kadobo S-M1",
      billing_date: "2026-10-08",
      sales_date: "2026-10-08",
      due_date: "2026-11-07",
      memo: "kadobo spike S-M1",
      items: [
        {
          name: "テスト（削除予定）",
          unit: "時間",
          quantity: 160.01,
          price: 1800,
          excise: "ten_percent",
          is_deduct_withholding_tax: false,
        },
      ],
    });
    expect(lines).toContain("S-M1 作成した: id=NEW_ID");
    const post = ports.http.calls.find((c) => c.method === "post")!;
    expect(post.url).toBe(`${BASE}/invoice_template_billings`);
  });

  it("既存の KD-TEST-S1 があれば POST せず、その id を使って削除まで行う", () => {
    const { ports, state, lines, log } = setup({ preexisting: true });
    runInvoiceSpikeS1(ports, log);

    expect(state.posts).toHaveLength(0);
    expect(methodsOf(ports)).not.toContain("post /invoice_template_billings");
    expect(lines.some((l) => l.includes("新規作成しない") && l.includes("id=EXISTING_ID"))).toBe(true);
    expect(methodsOf(ports)).toContain("delete /billings/EXISTING_ID");
    expect(lines.some((l) => l.startsWith("S-M2 作成直後の検索: 既存を回収した"))).toBe(true);
  });

  it("読み直した値を 1 行ずつ出す（小数数量の保持を含む）", () => {
    const { ports, lines, log } = setup();
    runInvoiceSpikeS1(ports, log);

    expect(lines).toContain("S-M1 subtotal_price: 288018");
    expect(lines).toContain("S-M1 excise_price: 28801");
    expect(lines).toContain("S-M1 total_price: 316819");
    expect(lines).toContain("S-M1 deduct_price: 0");
    expect(lines).toContain("S-M1 config.rounding: round_down");
    expect(lines).toContain("S-M1 config.rounding_consumption_tax: round_down");
    expect(lines).toContain("S-M1 config.consumption_tax_display_type: external");
    expect(lines).toContain("S-M1 payment_status: 未設定");
    expect(lines).toContain("S-M1 email_status: 未送信");
    expect(lines).toContain("S-M1 posting_status: 未郵送");
    expect(lines).toContain("S-M1 items[0].quantity: 160.01（小数 160.01 が保持されている）");
    expect(lines).toContain("S-M1 billing_number: KD-TEST-S1");
  });

  it("金額が一致すれば「一致」を出し、案内は出さない", () => {
    const { ports, lines, log } = setup();
    runInvoiceSpikeS1(ports, log);

    expect(lines).toContain("S-M1 金額照合: 一致");
    expect(lines.some((l) => l.includes("S-M1 対応:"))).toBe(false);
  });

  it("金額が不一致なら差額の要約と config.rounding 変更の案内を出す", () => {
    const { ports, lines, log } = setup({ rounding: "round_off" });
    runInvoiceSpikeS1(ports, log);

    const cmp = lines.find((l) => l.startsWith("S-M1 金額照合: 不一致"));
    expect(cmp).toBeDefined();
    expect(cmp).toContain("消費税相当額: MF28802 / シート28801");
    expect(cmp).toContain("税込額: MF316820 / シート316819");
    const guide = lines.find((l) => l.startsWith("S-M1 対応:"));
    expect(guide).toContain("config.rounding");
    expect(guide).toContain("round_off");
  });

  it("作成直後の完全一致検索と、部分文字列検索の件数を出す（部分一致する場合）", () => {
    const { ports, lines, log } = setup({ search: "partial" });
    runInvoiceSpikeS1(ports, log);

    expect(lines.some((l) => l.startsWith("S-M2 作成直後の検索: 返却 1 件") && l.includes("完全一致 1 件"))).toBe(true);
    expect(
      lines.some((l) => l.includes("document_number=KD-TEST-S1（完全一致の検索）") && l.includes("返却 1 件")),
    ).toBe(true);
    expect(
      lines.some(
        (l) => l.includes("document_number=KD-TEST（部分文字列の検索）") && l.includes("返却 1 件") && l.includes("完全一致 1 件"),
      ),
    ).toBe(true);
    expect(lines.some((l) => l.includes("S-M2 結論") && l.includes("部分一致"))).toBe(true);
  });

  it("部分文字列検索で返らない場合（完全一致のみ）は 0 件と出す", () => {
    const { ports, lines, log } = setup({ search: "exact" });
    runInvoiceSpikeS1(ports, log);

    expect(
      lines.some((l) => l.includes("document_number=KD-TEST（部分文字列の検索）") && l.includes("返却 0 件")),
    ).toBe(true);
    expect(lines.some((l) => l.includes("S-M2 結論") && l.includes("は返らなかった"))).toBe(true);
  });

  it("DELETE のあと GET が 404 になることを確認して「削除済み」と出す", () => {
    const { ports, lines, log } = setup();
    runInvoiceSpikeS1(ports, log);

    const methods = methodsOf(ports);
    const del = methods.indexOf("delete /billings/NEW_ID");
    expect(del).toBeGreaterThan(-1);
    expect(methods[del + 1]).toBe("get /billings/NEW_ID");
    expect(lines.some((l) => l.startsWith("S-M1 削除済み"))).toBe(true);
  });

  it("DELETE が失敗したら id と手動削除の案内を出し、例外を再スローする", () => {
    const { ports, lines, log } = setup({ deleteStatus: 422 });

    expect(() => runInvoiceSpikeS1(ports, log)).toThrow(/MF_API_ERROR/);
    const guide = lines.find((l) => l.includes("手動削除してください"));
    expect(guide).toBeDefined();
    expect(guide).toContain("id=NEW_ID");
    expect(lines.some((l) => l.startsWith("S-M1 削除済み"))).toBe(false);
  });

  it("DELETE が 204 でも GET が 404 にならなければ、案内を出して例外を投げる", () => {
    const { ports, lines, log } = setup({ deleteIneffective: true });

    expect(() => runInvoiceSpikeS1(ports, log)).toThrow(/SPIKE_DELETE_NOT_EFFECTIVE:NEW_ID/);
    expect(lines.some((l) => l.includes("id=NEW_ID") && l.includes("手動削除してください"))).toBe(true);
  });

  it("途中の読み直しで例外が起きても削除を試み、元の例外を再スローする", () => {
    const { ports, state, lines, log } = setup({ failDetail: true });

    expect(() => runInvoiceSpikeS1(ports, log)).toThrow(/MF_5XX:500/);
    expect(methodsOf(ports)).toContain("delete /billings/NEW_ID");
    expect(state.billing).not.toBeNull();
    expect(lines.some((l) => l.includes("手動削除してください"))).toBe(false);
  });

  it("ログにトークンが含まれない", () => {
    const ok = setup();
    runInvoiceSpikeS1(ok.ports, ok.log);
    const failed = setup({ deleteStatus: 422 });
    expect(() => runInvoiceSpikeS1(failed.ports, failed.log)).toThrow();

    for (const text of [ok.lines.join("\n"), failed.lines.join("\n")]) {
      expect(text).not.toContain(ACCESS);
      expect(text).not.toContain(REFRESH);
      expect(text.toLowerCase()).not.toContain("bearer");
    }
  });

  it("シートには書かず、フラグも見ない（MF_INVOICE_ENABLED 未設定でも動く）", () => {
    const { ports, lines, log } = setup();
    expect(ports.props.get("MF_INVOICE_ENABLED")).toBeNull();
    runInvoiceSpikeS1(ports, log);
    expect(lines.length).toBeGreaterThan(0);
  });
});
