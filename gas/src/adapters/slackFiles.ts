/**
 * `SlackFilesPort` の GAS 実装（実装設計 経費フェーズ §5.5, §3.2）。`UrlFetchApp` で
 * `url_private` を `Authorization: Bearer` 付きで GET する。`muteHttpExceptions: true`。
 * トークンはログに出さない（例外メッセージにも含めない）。
 */
import { isAllowedSlackFileUrl } from "@kadobo/shared/expense";
import {
  SlackFileFetchError,
  SlackFileForbiddenError,
  SlackFileNotFoundError,
  SlackFileUnavailableError,
  type PropsPort,
  type SlackFilesPort,
} from "../app/ports";

/**
 * GAS の byte array（`Blob#getBytes()`）は符号付き -128〜127 で返ることがあるため、
 * 符号なし 0〜255 へ正規化する（`hmac.ts`/`core/expense.ts` の `byteAt` と同じ考え方）。
 */
function normalizeBytes(bytes: GoogleAppsScript.Byte[]): number[] {
  return bytes.map((b) => (b < 0 ? b + 256 : b));
}

/** `getHeaders()`（大小文字表記はサーバ依存）から `Retry-After` を探す。無ければ `null`。 */
function findRetryAfter(headers: object): string | null {
  const record = headers as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key.toLowerCase() === "retry-after") {
      const v = record[key];
      return Array.isArray(v) ? String(v[0]) : String(v);
    }
  }
  return null;
}

export class SlackFilesAdapter implements SlackFilesPort {
  constructor(private readonly props: PropsPort) {}

  private token(): string {
    const token = this.props.get("SLACK_BOT_TOKEN");
    if (token === null) {
      throw new Error("missing_slack_bot_token");
    }
    return token;
  }

  download(urlPrivate: string): { bytes: number[]; contentType: string } {
    // ホスト検証（§5.5 の SSRF 対策）。Worker 側でも検証済みだが、Bot トークンを実際に
    // 付けて GET するのはここなので、多層防御としてここでも必ず検証する。
    if (!isAllowedSlackFileUrl(urlPrivate)) {
      throw new SlackFileForbiddenError("SLACK_FILE_URL_NOT_ALLOWED");
    }

    // `this.token()`（Script Property 未設定）は通信失敗ではなく設定不備のため、
    // try 節の外で評価する（try 節の中に置くと catch が「通信失敗」に誤分類してしまう）。
    const token = this.token();

    let res: GoogleAppsScript.URL_Fetch.HTTPResponse;
    try {
      res = UrlFetchApp.fetch(urlPrivate, {
        method: "get",
        headers: { Authorization: `Bearer ${token}` },
        muteHttpExceptions: true,
      });
    } catch {
      // DNS 解決不可・接続不可等、HTTP レスポンス自体を得られない通信失敗（§3.2 のエラー分類表）。
      throw new SlackFileFetchError("SLACK_FILE_FETCH_FAILED:network_error");
    }

    const code = res.getResponseCode();
    if (code >= 200 && code < 300) {
      const blob = res.getBlob();
      return {
        bytes: normalizeBytes(blob.getBytes()),
        contentType: blob.getContentType() ?? "application/octet-stream",
      };
    }
    if (code === 404) {
      throw new SlackFileNotFoundError();
    }
    if (code === 401 || code === 403) {
      throw new SlackFileForbiddenError();
    }
    if (code === 429) {
      const retryAfter = findRetryAfter(res.getHeaders());
      throw new SlackFileFetchError(`SLACK_FILE_FETCH_FAILED:429:retry_after=${retryAfter ?? "unknown"}`);
    }
    if (code >= 500) {
      // 5xx はサーバ側の一時的な問題で直りうるため再試行させる。
      throw new SlackFileFetchError(`SLACK_FILE_FETCH_FAILED:http_${code}`);
    }
    // 🔄 429 を除く未分類の 4xx（例: 400・410）は非再試行にする（実装設計 経費フェーズ §3.2 の
    // 改訂。Cron 再送は回数上限を持たないため、恒久的な 4xx を retryable にすると無限に再送され
    // 続け、行が永久に pending のまま残ってしまう。HTTP のセマンティクス（4xx＝クライアント誤りで
    // 自然には直らない）に従う）。
    if (code >= 400 && code < 500) {
      throw new SlackFileUnavailableError(`SLACK_FILE_UNAVAILABLE:http_${code}`);
    }
    // 3xx、および契約に定義の無いそれ以外の未分類コードは「再試行すればいつか成功しうる」側に倒す。
    throw new SlackFileFetchError(`SLACK_FILE_FETCH_FAILED:http_${code}`);
  }
}
