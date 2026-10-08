/**
 * 会計 API v3 の簡易フェイクサーバ（WP-M4 のテスト用。実際の MF にはアクセスしない）。
 * `FakeHttp.fetch` を差し替えて使う（`installFakeMfAccounting`）。
 *
 * 会計 API は ID をパーセントエンコード済みの文字列で返す（実装設計 MF連携 §3.2 🔬）ので、このフェイクの
 * ID も `…%2B…%3D%3D` の形にし、パスの ID は**デコードせず生のまま**比較する。パスに
 * `encodeURIComponent` が重ねられていると（`%252B…`）見つからず 404 になる。
 */
import type { FakeHttpRequest, FakePorts } from "../fakes";

export const ACC_BASE = "https://api-accounting.moneyforward.com/api/v3";

export interface FakeJournal {
  id: string;
  transaction_date: string;
  journal_type: string;
  tags: string[];
  memo: string;
  branches: Record<string, unknown>[];
}

export type PostMode =
  /** 作成して 201。 */
  | "ok"
  /** 作成したうえで応答は 500（作成成功 → 応答喪失。`MfOutcomeUnknownError` になる）。 */
  | "created_but_500"
  /** 作成せず 500（結果不明だが実際は作られていない）。 */
  | "not_created_500"
  /** 作成せず 400（`MfApiError`）。 */
  | "reject_400"
  /** 作成せず 429（`Retry-After` なし）。 */
  | "rate_limit";

export const ACCOUNT_NAMES = ["通信費", "消耗品費", "旅費交通費", "新聞図書費", "会議費", "支払手数料", "雑費", "事業主借"];

/** 名前 → パーセントエンコード済みの ID（実物の形）。 */
export function accountIdOf(name: string): string {
  return `acc%2B${ACCOUNT_NAMES.indexOf(name)}%3D%3D`;
}

function json(status: number, body: unknown): { status: number; headers: Record<string, string>; body: string } {
  return { status, headers: {}, body: JSON.stringify(body) };
}

export class FakeMfAccounting {
  journals: FakeJournal[] = [];
  postMode: PostMode = "ok";
  /** `postMode` を `n` 回だけ有効にして、その後は `ok` に戻す。 */
  postModeRemaining = Infinity;
  deleteStatus: 204 | 404 | 400 = 204;
  /** 受け取った POST /journals の本文（パース済み）。 */
  postedBodies: Record<string, unknown>[] = [];
  /** accounts に含めない名前（科目解決の失敗の再現）。 */
  missingAccounts = new Set<string>();
  /** `GET /journals`（一覧）に何も返さない（作成直後の検索で見つからない、の再現）。 */
  hideFromList = false;
  /** 作成した仕訳の branches に MF が付けると想定する `tax_name`（免税設定での挙動の再現）。 */
  taxName = "対象外";
  /** `/auth/exchange` 以外のすべての会計 API 呼び出しに 403 を返す（API キーの権限不足の再現）。 */
  forbidAll = false;
  /** 受信ごとに呼ぶフック（ロック外であることの検証や、時計を進める用途）。 */
  onRequest: ((req: FakeHttpRequest) => void) | null = null;
  private seq = 0;

  /** 実物と同じくパーセントエンコード済みの形の仕訳 ID。 */
  nextId(): string {
    this.seq++;
    return `jrnl%2B${this.seq}%2F${this.seq}%3D%3D`;
  }

  /** テスト側から「MF に既にある仕訳」を置く。 */
  plantJournal(partial: Partial<FakeJournal> & { transaction_date: string }): FakeJournal {
    const j: FakeJournal = {
      id: partial.id ?? this.nextId(),
      transaction_date: partial.transaction_date,
      journal_type: "journal_entry",
      tags: partial.tags ?? [],
      memo: partial.memo ?? "",
      branches: partial.branches ?? [],
    };
    this.journals.push(j);
    return j;
  }

  private effectivePostMode(): PostMode {
    if (this.postModeRemaining > 0) {
      this.postModeRemaining--;
      return this.postMode;
    }
    return "ok";
  }

  private toResponseJournal(j: FakeJournal): Record<string, unknown> {
    const branches = j.branches.map((b) => {
      const out: Record<string, unknown> = { ...b };
      for (const side of ["debitor", "creditor"]) {
        const s = b[side] as Record<string, unknown> | undefined;
        if (s !== undefined) {
          const name = ACCOUNT_NAMES.find((n) => accountIdOf(n) === s.account_id) ?? "?";
          out[side] = { ...s, account_name: name, tax_name: this.taxName, tax_value: 0 };
        }
      }
      return out;
    });
    return { ...j, branches, transaction_id: "tx%3D%3D", entered_by: "JOURNAL_TYPE_NORMAL" };
  }

  handle(req: FakeHttpRequest): { status: number; headers: Record<string, string>; body: string } {
    this.onRequest?.(req);
    if (req.url === "https://api.biz.moneyforward.com/auth/exchange") {
      return json(200, { access_token: "JWT_FAKE", expires_in: 3600 });
    }
    if (this.forbidAll) {
      return json(403, { errors: [{ code: "forbidden", message: "権限がありません" }] });
    }
    const rest = req.url.slice(ACC_BASE.length);
    const [pathRaw, queryRaw = ""] = rest.split("?");
    const path = pathRaw as string;
    const query = {
      get(key: string): string | null {
        for (const pair of queryRaw.split("&")) {
          const [k, v = ""] = pair.split("=");
          if (decodeURIComponent(k as string) === key) {
            return decodeURIComponent(v);
          }
        }
        return null;
      },
    };

    if (req.method === "get" && path === "/accounts") {
      const accounts = ACCOUNT_NAMES.filter((n) => !this.missingAccounts.has(n)).map((n) => ({
        id: accountIdOf(n),
        name: n,
        available: true,
        tax_id: null,
      }));
      return json(200, { accounts });
    }
    if (req.method === "get" && path === "/journals") {
      const start = query.get("start_date") ?? "0000-00-00";
      const end = query.get("end_date") ?? "9999-99-99";
      const page = Number(query.get("page") ?? "1");
      const perPage = Number(query.get("per_page") ?? "10");
      const all = this.hideFromList
        ? []
        : this.journals.filter((j) => j.transaction_date >= start && j.transaction_date <= end);
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage).map((j) => this.toResponseJournal(j));
      return json(200, { journals: slice, metadata: { total_count: all.length, total_pages: totalPages } });
    }
    if (req.method === "post" && path === "/journals") {
      const body = JSON.parse(req.payload ?? "{}") as { journal: Record<string, unknown> };
      this.postedBodies.push(body as Record<string, unknown>);
      const mode = this.effectivePostMode();
      if (mode === "reject_400") {
        return json(400, { errors: [{ code: "invalid_param", message: "bad request" }] });
      }
      if (mode === "rate_limit") {
        return { status: 429, headers: {}, body: "" };
      }
      if (mode === "not_created_500") {
        return { status: 500, headers: {}, body: "" };
      }
      const j = this.plantJournal({
        transaction_date: String(body.journal.transaction_date),
        tags: (body.journal.tags as string[]) ?? [],
        memo: typeof body.journal.memo === "string" ? body.journal.memo : "",
        branches: (body.journal.branches as Record<string, unknown>[]) ?? [],
      });
      if (mode === "created_but_500") {
        return { status: 500, headers: {}, body: "" };
      }
      return json(201, { journal: this.toResponseJournal(j) });
    }
    const m = /^\/journals\/(.+)$/.exec(path);
    if (m !== null) {
      const idRaw = m[1] as string; // デコードしない（二重エンコードを検出するため）
      const idx = this.journals.findIndex((j) => j.id === idRaw);
      if (req.method === "get") {
        return idx === -1
          ? json(404, { errors: [{ code: "not_found", message: "not found" }] })
          : json(200, { journal: this.toResponseJournal(this.journals[idx] as FakeJournal) });
      }
      if (req.method === "delete") {
        if (this.deleteStatus === 400) {
          return json(400, { errors: [{ code: "bad", message: "cannot delete" }] });
        }
        if (this.deleteStatus === 404 || idx === -1) {
          return json(404, { errors: [{ code: "not_found", message: "not found" }] });
        }
        this.journals.splice(idx, 1);
        return { status: 204, headers: {}, body: "" };
      }
    }
    return json(404, { errors: [{ code: "no_route", message: `${req.method} ${path}` }] });
  }
}

/** `ports.http.fetch` をフェイクサーバに差し替える（`FakeHttp.calls` にも記録する）。 */
export function installFakeMfAccounting(ports: FakePorts): FakeMfAccounting {
  const api = new FakeMfAccounting();
  ports.props.set("MF_ACCOUNTING_API_KEY", "mf_api_prd_SECRET");
  ports.props.set("MF_OFFICE_CODE", "1234-5678");
  ports.http.fetch = (req: FakeHttpRequest) => {
    ports.http.calls.push(req);
    return api.handle(req);
  };
  return api;
}

/** `ports.http.calls` のうち会計 API の `GET/POST/DELETE パス` だけを `METHOD /path` の形で返す（JWT 交換は除く）。 */
export function accountingCallsOf(ports: FakePorts): string[] {
  return ports.http.calls
    .filter((c) => c.url.startsWith(ACC_BASE))
    .map((c) => `${c.method.toUpperCase()} ${c.url.slice(ACC_BASE.length).split("?")[0]}`);
}
