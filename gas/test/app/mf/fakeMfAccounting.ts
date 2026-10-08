/**
 * 会計 API v3 の簡易フェイクサーバ（WP-M4 のテスト用。実際の MF にはアクセスしない）。
 * `FakeHttp.fetch` を差し替えて使う（`installFakeMfAccounting`）。
 *
 * 会計 API は ID をパーセントエンコード済みの文字列で返す（実装設計 MF連携 §3.2 🔬）ので、このフェイクの
 * ID も `…%2B…%3D%3D` の形にする。実機（2026-10-08 の S-M5）の観測を再現する:
 * - パスの ID は 1 回デコードしてから保存済みの ID と比較する（`encodeURIComponent(id)` = `pathWithId` は 200。
 *   返された文字列そのままも 200）。`decodeURIComponent(id)`（素の base64 `…+…=`）は一致せず 400。
 * - **存在しない ID への GET/DELETE は 404 ではなく 400 `invalid_request_path_parameter`**
 *   （404 を返す分岐は持たない）。
 *
 * WP-M5 で連携明細（`GET /transactions`・`POST /transactions/journalize`・`GET /journals?transaction_ids`・
 * `PUT /journals/{id}`）を追加した。S-M4 の実測を再現する:
 * - **クエリの ID（`connected_account_id`・`transaction_ids`）は、返された文字列をそのまま置いたときだけ通る**。
 *   サーバーが 1 回デコードした値が、保存済みの ID をデコードした値と一致しなければ 400
 *   `invalid_query_parameter_value`（1 回エンコードした `%252B` 形は 400）。
 * - `GET /transactions` は `start_date`〜`end_date` の差が 366 日を超えると 400。
 * - 明細から作った仕訳を `DELETE` すると、明細は未仕訳に戻らず `excluded` になる（OpenAPI の説明）。
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
  /** 明細から作った仕訳の明細 ID（MF が返した文字列）。 */
  transaction_id?: string;
}

/** 連携明細（`GET /transactions` の 1 件）。 */
export interface FakeTransaction {
  id: string;
  date: string;
  value: number;
  side: "EXPENSE" | "INCOME";
  content: string;
  journalizing_status: "none" | "registered" | "excluded";
  connected_account_id: string;
}

/** `PUT /journals/{id}` の挙動。 */
export type PutMode =
  /** 更新して 200。 */
  | "ok"
  /** 更新したうえで応答は 500（反映成功 → 応答喪失）。 */
  | "applied_but_500"
  /** 更新せず 500。 */
  | "not_applied_500"
  /** 更新せず 400。 */
  | "reject_400"
  /** 更新せず 429。 */
  | "rate_limit";

/** カード・口座の連携サービス ID（パーセントエンコード済みの文字列。実物の形）。 */
export const CARD_SERVICE_ID = "card%2Bsvc%3D";
export const BANK_SERVICE_ID = "bank%2Bsvc%3D";

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

export const ACCOUNT_NAMES = [
  "通信費",
  "消耗品費",
  "旅費交通費",
  "新聞図書費",
  "会議費",
  "支払手数料",
  "雑費",
  "事業主借",
  "事業主貸",
  "未払金",
];

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
  /** `400` にすると、存在する仕訳への DELETE が業務エラー（code `bad`。存在しない ID とは別）になる。 */
  deleteStatus: 204 | 400 = 204;
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
  /** 連携明細。 */
  transactions: FakeTransaction[] = [];
  /** 明細が無くても「存在する連携サービス」として扱う ID（`connected_account_id` の検証用）。 */
  knownServices = new Set<string>([CARD_SERVICE_ID, BANK_SERVICE_ID]);
  /** 受け取った `POST /transactions/journalize` の本文（パース済み）。 */
  journalizeBodies: Record<string, unknown>[] = [];
  /** 受け取った `PUT /journals/{id}` の本文（パース済み）と対象の仕訳 ID。 */
  putBodies: { id: string; body: Record<string, unknown> }[] = [];
  putMode: PutMode = "ok";
  putModeRemaining = Infinity;
  private seq = 0;
  private txSeq = 0;

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
      ...(partial.transaction_id !== undefined ? { transaction_id: partial.transaction_id } : {}),
    };
    this.journals.push(j);
    return j;
  }

  /** テスト側から連携明細を置く。 */
  plantTransaction(partial: Partial<FakeTransaction> & { date: string; value: number }): FakeTransaction {
    this.txSeq++;
    const t: FakeTransaction = {
      id: partial.id ?? `tx%2B${this.txSeq}%2F${this.txSeq}%3D%3D`,
      date: partial.date,
      value: partial.value,
      side: partial.side ?? "EXPENSE",
      content: partial.content ?? "コンビニ",
      journalizing_status: partial.journalizing_status ?? "none",
      connected_account_id: partial.connected_account_id ?? CARD_SERVICE_ID,
    };
    this.transactions.push(t);
    this.knownServices.add(t.connected_account_id);
    return t;
  }

  private effectivePutMode(): PutMode {
    if (this.putModeRemaining > 0) {
      this.putModeRemaining--;
      return this.putMode;
    }
    return "ok";
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
    return { ...j, branches, transaction_id: j.transaction_id ?? "tx%3D%3D", entered_by: "JOURNAL_TYPE_NORMAL" };
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
      /** 同じキーの値をすべて（サーバーが 1 回デコードした形で）返す。 */
      getAll(key: string): string[] {
        const out: string[] = [];
        for (const pair of queryRaw.split("&")) {
          const [k, v = ""] = pair.split("=");
          if (queryRaw !== "" && decodeURIComponent(k as string) === key) {
            out.push(decodeURIComponent(v));
          }
        }
        return out;
      },
    };
    const badQuery = (): { status: number; headers: Record<string, string>; body: string } =>
      json(400, { errors: [{ code: "invalid_query_parameter_value", message: "An invalid value was specified for one of the query parameters." }] });
    const sameId = (decodedFromQuery: string, stored: string): boolean => decodedFromQuery === decodeURIComponent(stored);

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
      const txIds = query.getAll("transaction_ids");
      for (const q of txIds) {
        if (!this.transactions.some((t) => sameId(q, t.id))) {
          return badQuery();
        }
      }
      const all = this.hideFromList
        ? []
        : this.journals.filter(
            (j) =>
              j.transaction_date >= start &&
              j.transaction_date <= end &&
              (txIds.length === 0 || (j.transaction_id !== undefined && txIds.some((q) => sameId(q, j.transaction_id as string)))),
          );
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage).map((j) => this.toResponseJournal(j));
      return json(200, { journals: slice, metadata: { total_count: all.length, total_pages: totalPages } });
    }
    if (req.method === "get" && path === "/transactions") {
      const start = query.get("start_date");
      const end = query.get("end_date");
      if (start === null || end === null) {
        return badQuery();
      }
      const spanDays = (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000;
      if (!(spanDays >= 0) || spanDays > 366) {
        return badQuery();
      }
      const serviceIds = query.getAll("connected_account_id");
      for (const q of serviceIds) {
        if (![...this.knownServices].some((id) => sameId(q, id))) {
          return badQuery();
        }
      }
      const side = query.get("side");
      const statuses = query.getAll("journalizing_statuses");
      const page = Number(query.get("page") ?? "1");
      const perPage = Number(query.get("per_page") ?? "50");
      const all = this.transactions
        .filter(
          (t) =>
            t.date >= start &&
            t.date <= end &&
            (serviceIds.length === 0 || serviceIds.some((q) => sameId(q, t.connected_account_id))) &&
            (side === null || t.side === side) &&
            (statuses.length === 0 || statuses.includes(t.journalizing_status)),
        )
        .sort((a, b) => (query.get("order") === "asc" ? (a.date < b.date ? -1 : 1) : a.date < b.date ? 1 : -1));
      const totalPages = Math.max(1, Math.ceil(all.length / perPage));
      const slice = all.slice((page - 1) * perPage, page * perPage).map((t) => ({
        ...t,
        memo: null,
        connected_sub_account_id: null,
        voucher_file_ids: [],
      }));
      return json(200, { transactions: slice, metadata: { total_count: all.length, total_pages: totalPages } });
    }
    if (req.method === "post" && path === "/transactions/journalize") {
      const body = JSON.parse(req.payload ?? "{}") as Record<string, unknown>;
      this.journalizeBodies.push(body);
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
      const tx = this.transactions.find((t) => typeof body.transaction_id === "string" && sameId(decodeURIComponent(body.transaction_id), t.id));
      if (tx === undefined || tx.journalizing_status !== "none") {
        return json(400, { errors: [{ code: "invalid_request_body", message: "transaction is not journalizable" }] });
      }
      if (typeof body.account_id !== "string" || !ACCOUNT_NAMES.some((n) => accountIdOf(n) === body.account_id)) {
        return json(400, { errors: [{ code: "invalid_request_body", message: "unknown account_id" }] });
      }
      tx.journalizing_status = "registered";
      const j = this.plantJournal({
        transaction_date: typeof body.transaction_date === "string" ? body.transaction_date : tx.date,
        tags: (body.tags as string[] | undefined) ?? [],
        memo: typeof body.memo === "string" ? body.memo : "",
        transaction_id: tx.id,
        branches: [
          {
            debitor: { account_id: body.account_id, value: tx.value },
            creditor: { account_id: accountIdOf("未払金"), value: tx.value },
            remark: typeof body.remark === "string" ? body.remark : "",
          },
        ],
      });
      if (mode === "created_but_500") {
        return { status: 500, headers: {}, body: "" };
      }
      return json(201, { journal: this.toResponseJournal(j) });
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
      const pathId = m[1] as string;
      let decoded: string;
      try {
        decoded = decodeURIComponent(pathId); // 1 回デコードして比較する（実機 H1 の再現）
      } catch {
        decoded = pathId;
      }
      const idx = this.journals.findIndex((j) => j.id === decoded || j.id === pathId);
      const notFound = (): { status: number; headers: Record<string, string>; body: string } =>
        json(400, {
          errors: [{ code: "invalid_request_path_parameter", message: "The given id does not exist for this office." }],
        });
      if (req.method === "get") {
        return idx === -1
          ? notFound()
          : json(200, { journal: this.toResponseJournal(this.journals[idx] as FakeJournal) });
      }
      if (req.method === "put") {
        if (idx === -1) {
          return notFound();
        }
        const body = JSON.parse(req.payload ?? "{}") as { journal?: Record<string, unknown> };
        this.putBodies.push({ id: (this.journals[idx] as FakeJournal).id, body: body as Record<string, unknown> });
        const mode = this.effectivePutMode();
        if (mode === "reject_400") {
          return json(400, { errors: [{ code: "invalid_param", message: "bad request" }] });
        }
        if (mode === "rate_limit") {
          return { status: 429, headers: {}, body: "" };
        }
        if (mode === "not_applied_500") {
          return { status: 500, headers: {}, body: "" };
        }
        const jr = body.journal ?? {};
        const branches = (jr.branches as Record<string, any>[] | undefined) ?? [];
        const balanced = branches.every((b) => b.debitor?.value === b.creditor?.value);
        if (branches.length === 0 || !balanced) {
          return json(400, { errors: [{ code: "invalid_request_body", message: "unbalanced" }] });
        }
        const cur = this.journals[idx] as FakeJournal;
        this.journals[idx] = {
          ...cur,
          transaction_date: String(jr.transaction_date),
          journal_type: String(jr.journal_type ?? cur.journal_type),
          tags: (jr.tags as string[] | undefined) ?? [],
          memo: typeof jr.memo === "string" ? jr.memo : "",
          branches,
        };
        if (mode === "applied_but_500") {
          return { status: 500, headers: {}, body: "" };
        }
        return json(200, { journal: this.toResponseJournal(this.journals[idx] as FakeJournal) });
      }
      if (req.method === "delete") {
        if (idx === -1) {
          return notFound();
        }
        if (this.deleteStatus === 400) {
          return json(400, { errors: [{ code: "bad", message: "cannot delete" }] });
        }
        const removed = this.journals.splice(idx, 1)[0] as FakeJournal;
        // 明細から作った仕訳を消すと、明細は未仕訳に戻らず対象外（excluded）になる（OpenAPI の説明）。
        const tx = this.transactions.find((t) => removed.transaction_id !== undefined && t.id === removed.transaction_id);
        if (tx !== undefined) {
          tx.journalizing_status = "excluded";
        }
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
