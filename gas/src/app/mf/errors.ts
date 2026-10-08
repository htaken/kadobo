/**
 * MF API 呼び出しの例外分類（実装設計 MF連携 §4.4）。
 *
 * **メッセージにトークン・API キー・`Authorization` ヘッダー・URL のクエリを含めないこと。**
 * ここで組み立てるメッセージは固定の定数文字列と（あれば）MF の応答本文から拾った
 * `errors[].code`/`errors[].message`（業務エラーの説明文であり秘匿情報ではない）だけにする。
 */

/**
 * どの MF API の認証で起きたか（レビュー指摘: 通知文言・抑止キーを分けるため）。
 * 請求書 API（OAuth）は `"invoice"`、会計 API（API キー）は `"accounting"`。
 */
export type MfService = "invoice" | "accounting";

/** リフレッシュトークン失効・トークン保存失敗（読み直しの不一致が再保存後も解消しない）。 */
export class MfReauthRequiredError extends Error {
  constructor(
    message: string,
    readonly service: MfService,
  ) {
    super(message);
    this.name = "MfReauthRequiredError";
  }
}

/**
 * トークン・API キーの認証エラー（設定不備の可能性を含む）。請求書 API では「更新後も 401」
 * や「トークンエンドポイントが 429・5xx・通信失敗以外の非 2xx を返した」場合
 * （`invalid_client` 等。429・5xx・通信失敗は `MfTransientError` に、`invalid_grant` は
 * `MfReauthRequiredError` に分類する）。会計 API では JWT 交換・再交換が 429・5xx 以外の
 * 非 2xx を返した場合。
 */
export class MfAuthError extends Error {
  constructor(
    message: string,
    readonly service: MfService,
  ) {
    super(message);
    this.name = "MfAuthError";
  }
}

/** 429・5xx・通信失敗（作成系 POST 以外）。状態を変えず、次のトリガーで再試行させる。 */
export class MfTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfTransientError";
  }
}

/**
 * 作成系 POST が 5xx・通信失敗・タイムアウトで、MF 側で作られたかどうか分からない
 * （実装設計 MF連携 §4.4）。対象は `UNKNOWN` にし、以後は検索による回収だけを行い、
 * 自動では作り直さない。
 */
export class MfOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MfOutcomeUnknownError";
  }
}

/** MF の応答本文から短く拾ったエラー詳細（実装設計 MF連携 §4.4）。 */
const MAX_DETAIL_LEN = 200;

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** その他 4xx の業務エラー（作られていないことが確実）。本文の `errors[].code`/`message` を短く添える。 */
export class MfApiError extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly apiMessage?: string,
  ) {
    const parts = [`status=${status}`];
    if (code !== undefined) {
      parts.push(`code=${code}`);
    }
    if (apiMessage !== undefined) {
      parts.push(`message=${apiMessage}`);
    }
    super(`MF_API_ERROR:${parts.join(" ")}`);
    this.name = "MfApiError";
  }
}

/** {@link MfApiError} 用に MF の応答本文（JSON）から `errors[0].code`/`errors[0].message` を短く拾う。 */
export function parseMfApiErrorBody(body: string): { code?: string; message?: string } | null {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) {
    return null;
  }
  const errors = (json as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return null;
  }
  const first = errors[0] as { code?: unknown; message?: unknown };
  const code = typeof first.code === "string" ? truncate(first.code, MAX_DETAIL_LEN) : undefined;
  const message = typeof first.message === "string" ? truncate(first.message, MAX_DETAIL_LEN) : undefined;
  if (code === undefined && message === undefined) {
    return null;
  }
  return { code, message };
}

/**
 * 会計 API で「その ID の対象が存在しない」を表す `MfApiError` か。実機（2026-10-08 の S-M5）で、存在しない
 * 仕訳 ID への `GET`・`DELETE` は 404 ではなく **400 `invalid_request_path_parameter`**
 * （"The given id does not exist for this office"）だった。従来どおりの 404 も含める。判定はここに集約する。
 * 形式の誤り（例: 素の base64 `+` を置いた場合の "An invalid value was specified for one of the path
 * parameters"）も同じ code で返るため、ID の表記（`pathWithId`）が正しいことが前提。
 */
export function isMfNotFound(err: unknown): boolean {
  return (
    err instanceof MfApiError &&
    (err.status === 404 || (err.status === 400 && err.code === "invalid_request_path_parameter"))
  );
}
