/**
 * app 層が依存するポート（インタフェース）定義（実装設計 §1, §7.5 の WP3 スコープ）。
 *
 * app 層のユースケース（`stamp.ts`/`correction.ts`/`command.ts`/`triggers.ts`/`dispatch.ts`）は
 * このファイルの型だけを介して I/O を行い、GAS API（`SpreadsheetApp`/`UrlFetchApp`/
 * `CacheService`/`LockService`/`PropertiesService`/`CalendarApp`/`Utilities`/`ScriptApp`）に
 * 直接触れない。実装は `gas/src/adapters/*.ts` が行う。Node の Vitest ではこれらのポートを
 * インメモリのフェイクに差し替えてユースケースをテストする。
 */

import type { DailyStatus, UnitPriceRow } from "../core/aggregate";
import type { RecentDay } from "../core/businessDate";
import type { LogEventType } from "../core/state";

// ---------------------------------------------------------------------------
// シート行の型（実装設計 §7.1 の列順そのまま）
// ---------------------------------------------------------------------------

/** 生ログ 1 行（実装設計 §7.1「生ログ」列順）。 */
export interface RawLogRow {
  event_id: string;
  idempotency_key: string;
  /** `YYYY-MM-DD`（JST）。 */
  business_date: string;
  event_type: LogEventType;
  /** UTC epoch ms。 */
  occurred_at: number;
  /** `YYYY-MM-DD HH:mm:ss`（JST）。 */
  occurred_at_jst: string;
  /** UTC epoch ms。Worker 受信時刻。 */
  received_at: number;
  /** UTC epoch ms。GAS 処理時刻。 */
  processed_at: number;
  /** `button` / `modal` / `retry` / `auto`。 */
  source: string;
  /** 当日のセッション番号。`CORRECTION` 行は `null`。 */
  session_no: number | null;
  memo: string;
  /** `CORRECTION` 行のみ: 対象 `event_id`。 */
  correction_of: string | null;
  /** `CORRECTION` 行のみ: 訂正前の `occurred_at`（ms）。 */
  old_value: number | null;
  /** `CORRECTION` 行のみ: 訂正後の `occurred_at`（ms）。 */
  new_value: number | null;
  /** `CORRECTION` 行のみ: 訂正理由。 */
  reason: string;
}

/** 日次集計 1 行（実装設計 §7.1「日次集計」列順）。 */
export interface DailySummaryRow {
  /** `YYYY-MM-DD`（JST）。 */
  business_date: string;
  /** 曜日（`月`〜`日`）。 */
  weekday: string;
  session_count: number;
  first_start_jst: string | null;
  last_end_jst: string | null;
  break_seconds: number;
  worked_seconds: number | null;
  worked_minutes: number | null;
  status: DailyStatus;
  correction_count: number;
  note: string | null;
  /** UTC epoch ms。 */
  updated_at: number;
}

/** 月次請求 1 行（実装設計 §7.1「月次請求」列順）。 */
export interface MonthlyBillRow {
  client: string;
  /** `YYYY-MM`。 */
  month: string;
  worked_minutes: number;
  /** 小数第 2 位。 */
  hours: number;
  unit_price: number;
  amount: number;
  tax_amount: number;
  withholding_amount: number;
  net_amount: number;
  /** `OPEN`/`REVIEWING`/`LOCKED`/... MVP では `OPEN`/`LOCKED` のみ意味を持つ（実装設計 §4.2.4）。 */
  state: string;
  mf_invoice_id: string | null;
  /** UTC epoch ms。 */
  locked_at: number | null;
  note: string | null;
  /** UTC epoch ms。 */
  updated_at: number;
}

// ---------------------------------------------------------------------------
// SheetsPort
// ---------------------------------------------------------------------------

/**
 * スプレッドシート I/O（実装設計 §7.1）。生ログは追記のみ（更新・削除は行わない）。
 * 経費台帳は WP3 では作成のみ（`setupSpreadsheet` 側）で、書込ポートは定義しない。
 */
export interface SheetsPort {
  /** 生ログに 1 行追記する。 */
  appendRawLog(row: RawLogRow): void;
  /** 生ログを `idempotency_key` 列で完全一致検索する（実装設計 §4.2）。無ければ `null`。 */
  findRawLogByIdempotencyKey(idempotencyKey: string): RawLogRow | null;
  /** 対象業務日の生ログ行（`CORRECTION` を含む）を返す。順序は問わない。 */
  getEventsForBusinessDate(businessDate: string): RawLogRow[];
  /**
   * `referenceBusinessDate` より前の直近 `days` 業務日分のイベントを返す
   * （`resolveBusinessDate` 用。実装設計 §7.2 の跨日判定）。
   */
  getRecentDaysEvents(referenceBusinessDate: string, days: number): RecentDay[];
  /** 日次集計を `business_date` で upsert する。 */
  upsertDailySummary(row: DailySummaryRow): void;
  /** 日次集計 1 行を取得する。無ければ `null`。 */
  getDailySummary(businessDate: string): DailySummaryRow | null;
  /** 日次集計を `business_date` 昇順の範囲（両端含む）で取得する。 */
  getDailySummariesInRange(fromDate: string, toDate: string): DailySummaryRow[];
  /** 単価マスタの全行を返す。 */
  getUnitPriceRows(): UnitPriceRow[];
  /** 月次請求を `client + month` で upsert する。 */
  upsertMonthlyBill(row: MonthlyBillRow): void;
  /** 月次請求 1 行を取得する。無ければ `null`。 */
  getMonthlyBill(client: string, month: string): MonthlyBillRow | null;
  /** 内部シートの key-value を取得する（`kind + key`）。無ければ `null`。 */
  getInternalValue(kind: string, key: string): string | null;
  /** 内部シートの key-value を設定する（`kind + key`）。 */
  setInternalValue(kind: string, key: string, value: string): void;
}

// ---------------------------------------------------------------------------
// SlackPort
// ---------------------------------------------------------------------------

export interface SlackBlocksMessage {
  channel: string;
  text: string;
  blocks?: object[];
}

export interface SlackUpdateMessage extends SlackBlocksMessage {
  ts: string;
}

export interface SlackPostMessageResult {
  ts: string;
}

export interface SlackViewsOpenInput {
  trigger_id: string;
  view: object;
}

export interface SlackViewsOpenResult {
  view_id: string;
}

export interface SlackViewsUpdateInput {
  view_id: string;
  view: object;
}

/**
 * Slack Web API 呼び出し（実装設計 §7.9）。`viewsOpen` は Worker が実際に呼ぶ操作だが、
 * 参照実装・対称性のためポートには定義する（GAS の app 層ユースケースからは呼ばれない）。
 */
export interface SlackPort {
  postMessage(input: SlackBlocksMessage): SlackPostMessageResult;
  update(input: SlackUpdateMessage): void;
  viewsOpen(input: SlackViewsOpenInput): SlackViewsOpenResult;
  viewsUpdate(input: SlackViewsUpdateInput): void;
  /** `response_url` への POST（ephemeral）。 */
  postEphemeral(responseUrl: string, text: string): void;
  /** DM 送信（`conversations.open` ＋ `chat.postMessage`、実装設計 §7.9）。 */
  dm(userId: string, text: string): void;
}

// ---------------------------------------------------------------------------
// その他のポート
// ---------------------------------------------------------------------------

/** nonce 管理（実装設計 §3.1）。TTL 600 秒は実装（`CacheService`）側の責務。 */
export interface CachePort {
  nonceSeen(nonce: string): boolean;
  markNonce(nonce: string): void;
}

/** `LockService.getScriptLock()` 相当。取得不可なら {@link LockTimeoutError} を投げる。 */
export interface LockPort {
  withLock<T>(fn: () => T): T;
}

/** {@link LockPort.withLock} が待機タイムアウト時に投げる例外（実装設計 §7.5: `LOCK_TIMEOUT`）。 */
export class LockTimeoutError extends Error {
  constructor() {
    super("LOCK_TIMEOUT");
    this.name = "LockTimeoutError";
  }
}

/** Script Properties（実装設計 §7.8）。 */
export interface PropsPort {
  get(key: string): string | null;
}

/** 日本の祝日カレンダー判定（実装設計 §7.7）。 */
export interface CalendarPort {
  isHoliday(businessDate: string): boolean;
}

export interface ClockPort {
  /** UTC epoch ms。 */
  nowMs(): number;
  /** UTC epoch 秒。 */
  nowSec(): number;
}

/** ULID 用の乱数源（実装設計 §4.3）。 */
export interface RandomPort {
  randomBytes(n: number): Uint8Array;
}

/** 封筒検証・生成用の HMAC（実装設計 §3.1, §7.4）。 */
export interface HmacPort {
  hmacHex(key: string, msg: string): string;
}

/** Worker `/internal/status` から得る受付ジャーナルの状態（実装設計 §3.4）。 */
export interface WorkerStatusInfo {
  pending: number;
  rejected_24h: number;
  oldest_pending_at_ms: number | null;
}

/**
 * Worker `/internal/status` への封筒 POST（実装設計 §3.4, §7.7 `trigEveningCheck`）。
 * 取得できない場合（設定未了・通信失敗等）は `null` を返す（trigEveningCheck は他のチェックを
 * 継続できるよう、この失敗で全体を止めない）。
 */
export interface WorkerStatusPort {
  fetchStatus(): WorkerStatusInfo | null;
}

/** app 層のユースケースに注入するポート一式。 */
export interface AppPorts {
  sheets: SheetsPort;
  slack: SlackPort;
  cache: CachePort;
  lock: LockPort;
  props: PropsPort;
  calendar: CalendarPort;
  clock: ClockPort;
  random: RandomPort;
  hmac: HmacPort;
  workerStatus: WorkerStatusPort;
}
