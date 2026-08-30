/**
 * Worker ↔ GAS プロトコル（実装設計 MVP §3）。
 *
 * このモジュールは Worker（Cloudflare Workers ランタイム）と GAS（Apps Script V8 ランタイム）の
 * 両方で読み込まれるため、DOM・Node 固有 API・`crypto` に依存しない。乱数生成やハッシュ計算は
 * 呼び出し側から注入する（`shared/src/ids.ts` 参照）。
 */

/** 封筒のプロトコルバージョン（実装設計 §3.1）。 */
export const ENVELOPE_VERSION = 1;

/** 封筒の受付窓（秒）。`|now - ts| <= ENVELOPE_WINDOW_SEC` を許容する（実装設計 §3.1）。 */
export const ENVELOPE_WINDOW_SEC = 300;

/**
 * GAS 側で `LockService.getScriptLock()` を待つ最大時間（ms）（実装設計 §4.2）。
 *
 * {@link GAS_TIMEOUT_MS} より十分短くなければならない。同値だと「ロックを待たされた
 * リクエスト」が GAS の処理へ進む前に Worker 側でタイムアウトし、GAS が適用したのか
 * どうか Worker から判別できない灰色の結果だけが残る。短くしておけば、待たされた
 * リクエストは `{ok:false, error:'LOCK_TIMEOUT', retryable:true}` として素早く
 * 「確実に未適用」と分かる形で返り、Cron 再送に安全に回せる。
 */
export const GAS_LOCK_WAIT_MS = 10000;

/**
 * Worker → GAS 呼び出しのタイムアウト（ms）（実装設計 §3.3）。
 *
 * 内訳は「{@link GAS_LOCK_WAIT_MS}（最大 10 秒のロック待ち）＋ GAS 本体の処理（目標 5 秒、
 * Sheets/Slack が遅い日で 10 秒程度）」。`waitUntil()` の 30 秒上限の内側に収める。
 */
export const GAS_TIMEOUT_MS = 25000;

/** Cron 再送が何回連続失敗したら本人へメンション通知するか（実装設計 §6.6）。 */
export const RETRY_NOTIFY_AT = 6;

/** 初回通知以降、何回ごとに再通知するか（実装設計 §6.6）。 */
export const RETRY_NOTIFY_EVERY = 72;

/** D1 受付ジャーナルの保持日数（実装設計 §5）。 */
export const JOURNAL_RETENTION_DAYS = 30;

/**
 * Worker → GAS、GAS → Worker `/internal/status` の双方向で使う封筒形式（実装設計 §3.1）。
 * `payload` は送信側が `JSON.stringify` した文字列そのもの（正規化の問題を避けるため、
 * オブジェクトのまま入れない）。
 */
export interface Envelope {
  /** プロトコルバージョン。常に {@link ENVELOPE_VERSION}。 */
  v: 1;
  /** 送信時刻（UNIX 秒、整数）。 */
  ts: number;
  /** 16 バイト乱数の hex（32 文字）。 */
  nonce: string;
  /** JSON 文字列化済みのペイロード。 */
  payload: string;
  /** `hex(HMAC-SHA256(secret, `${ts}.${nonce}.${payload}`))`。 */
  sig: string;
}

/** stamp（打刻）の対象となるボタンの `action_id`（実装設計 §2.3）。 */
export type StampActionId =
  | "kado_start"
  | "kado_break_start"
  | "kado_break_end"
  | "kado_end";

/** `source` は再送時に Worker が `'retry'` へ書き換える（実装設計 §3.2）。 */
export type StampSource = "button" | "retry";
export type CorrectionSubmitSource = "modal" | "retry";
export type CommandSource = "command" | "retry";

/** スラッシュコマンドの正規化済み引数（実装設計 §2.1）。 */
export type CommandText = "" | "status";

/**
 * Worker → GAS のペイロード種別（実装設計 §3.2）。4 種の判別共用体（`kind` で判別）。
 */
export type GasRequest =
  | {
      kind: "stamp";
      idempotency_key: string;
      user_id: string;
      channel_id: string;
      message_ts: string;
      action_id: StampActionId;
      /** Slack action_ts を ms に変換した値（実装設計 §4.1）。 */
      occurred_at_ms: number;
      /** Worker 受信時刻（ms）。 */
      received_at_ms: number;
      source: StampSource;
      response_url?: string;
    }
  | {
      kind: "open_correction";
      idempotency_key: string;
      user_id: string;
      channel_id: string;
      message_ts: string;
      view_id: string;
      business_date: string;
      received_at_ms: number;
      source: "button";
    }
  | {
      kind: "correction_submit";
      idempotency_key: string;
      user_id: string;
      view_id: string;
      channel_id: string;
      message_ts: string;
      business_date: string;
      /** 修正対象の event_id、または押し忘れ終了追加を表す `'add_end'`。 */
      target: string;
      /** `YYYY-MM-DD`。 */
      new_date: string;
      /** `HH:mm`。 */
      new_time: string;
      reason: string;
      received_at_ms: number;
      source: CorrectionSubmitSource;
    }
  | {
      kind: "command";
      idempotency_key: string;
      user_id: string;
      channel_id: string;
      text: CommandText;
      response_url: string;
      received_at_ms: number;
      source: CommandSource;
    };

/**
 * 「GAS が生ログ追記・カード再描画のいずれにも触れていないことが確実」なエラーコード。
 *
 * `dispatch()` がユースケース本体（`handleStamp` 等）へ入る**前**に返すものだけを列挙する。
 * Worker はこの判定が真のときに限り、押下時の古い blocks でカードを `chat.update` して
 * よい（GAS 側がカードを描き替えていないと確定しているため、上書き競合が起きない）。
 *
 * 逆に、`dispatch()` の総括 catch が返す例外メッセージ（Sheets 一時エラー等）は
 * 「追記後に落ちた」可能性があるため、ここには含めない。
 */
const GAS_PRE_APPLY_ERRORS: readonly string[] = [
  "UNAUTHORIZED",
  "BAD_REQUEST",
  "MALFORMED_BODY",
  "LOCK_TIMEOUT",
];

/** {@link GAS_PRE_APPLY_ERRORS} に含まれるか（Worker のカード上書き可否判定に使う）。 */
export function isGasPreApplyError(error: string): boolean {
  return GAS_PRE_APPLY_ERRORS.indexOf(error) !== -1;
}

/** GAS 側で `ok:true` を返す際に付与し得る理由コード（実装設計 §3.3）。 */
export type GasResponseReason =
  | "DUPLICATE"
  | "INVALID_TRANSITION"
  | "LOCKED_MONTH"
  | "NOT_FOUND"
  | string;

/**
 * GAS → Worker のレスポンス（実装設計 §3.3）。
 * GAS は常に HTTP 200 で JSON を返すため、Worker 側は `ok` の有無で成否を判定する。
 */
export type GasResponse =
  | { ok: true; applied: boolean; reason?: GasResponseReason }
  | { ok: false; error: string; retryable: boolean };

/**
 * 封筒署名の対象文字列を組み立てる（実装設計 §3.1）。
 * `sig = hex(HMAC-SHA256(secret, envelopeSigningString(ts, nonce, payload)))`。
 */
export function envelopeSigningString(
  ts: number,
  nonce: string,
  payload: string,
): string {
  return `${ts}.${nonce}.${payload}`;
}

/**
 * 定時間文字列比較。タイミング攻撃を避けるため、不一致が判明しても早期 return しない
 * （実装設計 §3.1, §7.4）。長さが異なる場合も最後まで走査する。
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const maxLen = a.length > b.length ? a.length : b.length;
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < maxLen; i++) {
    const ca = i < a.length ? a.charCodeAt(i) : 0;
    const cb = i < b.length ? b.charCodeAt(i) : 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/** `unknown` が {@link GasResponse} の形をしているかを判定する型ガード。 */
export function isGasResponse(x: unknown): x is GasResponse {
  if (typeof x !== "object" || x === null) {
    return false;
  }
  const o = x as Record<string, unknown>;
  if (typeof o.ok !== "boolean") {
    return false;
  }
  if (o.ok === true) {
    return typeof o.applied === "boolean";
  }
  return typeof o.error === "string" && typeof o.retryable === "boolean";
}
