/**
 * app 層が依存するポート（インタフェース）定義（実装設計 §1, §7.5 の WP3 スコープ）。
 *
 * app 層のユースケース（`stamp.ts`/`correction.ts`/`command.ts`/`triggers.ts`/`dispatch.ts`）は
 * このファイルの型だけを介して I/O を行い、GAS API（`SpreadsheetApp`/`UrlFetchApp`/
 * `CacheService`/`LockService`/`PropertiesService`/`CalendarApp`/`Utilities`/`ScriptApp`）に
 * 直接触れない。実装は `gas/src/adapters/*.ts` が行う。Node の Vitest ではこれらのポートを
 * インメモリのフェイクに差し替えてユースケースをテストする。
 */

import type { ExpenseCategory, ExpenseState, ReceiptType } from "@kadobo/shared/expense";
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

/**
 * 経費台帳 1 行（実装設計 経費フェーズ §5.1 の 24 列）。プロパティ名は既存の `RawLogRow` 等と
 * 同じ英語 snake_case（シート上の見出しは日本語だが、TS 側は他シートと同じ命名規約に揃える）。
 * コメントに対応するシート見出し（日本語）を併記する。
 */
export interface ExpenseLedgerRow {
  /** 証憑ID。`R-YYYYMMDD-NNN`（実装設計 §5.5 `makeReceiptId`）。 */
  receipt_id: string;
  /** 証憑区分。 */
  receipt_type: ReceiptType;
  /** 日付。`YYYY-MM-DD`（JST、取引年月日）。 */
  date: string;
  /** 金額。税込円。 */
  amount: number;
  /** 取引先。 */
  partner: string;
  /** カテゴリ。 */
  category: ExpenseCategory;
  /** メモ。未入力は `''`。 */
  memo: string;
  /** Driveリンク。 */
  drive_link: string;
  /** ファイルハッシュ。SHA-256 の hex 文字列。 */
  file_hash: string;
  /** 元MIME。ダウンロード時の Content-Type。 */
  mime_type: string;
  /** サイズ。実ダウンロードのバイト数。 */
  size: number;
  /** 入力日時。UTC epoch ms。 */
  input_at: number;
  /** 処理状態。`RECEIVED | FILE_SAVED | COMPLETED | ERROR | CORRECTED | VOID`（実装設計 §5.1）。 */
  state: ExpenseState;
  /** MF仕訳ID。月次で人手記入するため既定は `null`。 */
  mf_journal_id: string | null;
  /** idempotency_key（システム列。実装設計 §5.1 #E6。保護・非表示）。 */
  idempotency_key: string;
  /** slack_file_id（システム列）。元ファイルの特定・再取得に使う。 */
  slack_file_id: string;
  /** drive_file_id（システム列）。Drive 側の存在確認に使う（実装設計 §5.6）。 */
  drive_file_id: string;
  /** 元ファイル名（システム列）。Drive 上のファイル名は規約で付け替えるため監査用に残す。 */
  original_file_name: string;
  /** last_error（システム列）。システムエラーを `メモ`（利用者入力）に混ぜないための列。 */
  last_error: string | null;
  /** state_updated_at（システム列）。UTC epoch ms。停滞行の検出に使う。 */
  state_updated_at: number;
  /** 税区分。要件定義 §4.3.1 の任意項目（列のみ用意）。 */
  tax_category: string;
  /** 事業使用割合。既定値 100（実装設計 §7 #E5）。 */
  business_use_ratio: number;
  /** 訂正元証憑ID。訂正・取消フロー（実装設計 §5.7）で使う。無ければ `null`。 */
  correction_of_receipt_id: string | null;
  /** 訂正理由。実装設計 §5.7。無ければ `null`。 */
  correction_reason: string | null;
}

// ---------------------------------------------------------------------------
// SheetsPort
// ---------------------------------------------------------------------------

/**
 * スプレッドシート I/O（実装設計 §7.1, 経費フェーズ §5.1・§5.3）。生ログは追記のみ
 * （更新・削除は行わない）。経費台帳は `handleExpenseSubmit`（WP8b）から使われる書込ポートを持つ。
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

  // -------------------------------------------------------------------------
  // 経費台帳（実装設計 経費フェーズ §5.3）
  // -------------------------------------------------------------------------

  /** 経費台帳の末尾に 1 行追記する（実装設計 §5.4 フェーズ 1）。 */
  appendExpense(row: ExpenseLedgerRow): void;
  /**
   * 経費台帳を `idempotency_key` 列で完全一致検索する（実装設計 §5.4 フェーズ 1 の再開判定）。
   * 無ければ `null`。
   */
  findExpenseByIdempotencyKey(idempotencyKey: string): ExpenseLedgerRow | null;
  /** 経費台帳を `証憑ID` 列で完全一致検索する（実装設計 §5.4 フェーズ 3 の状態再確認）。無ければ `null`。 */
  getExpenseByReceiptId(receiptId: string): ExpenseLedgerRow | null;
  /**
   * `証憑ID` に一致する行を部分更新する（実装設計 §5.4）。対象行が無い場合は例外を投げる
   * （フェーズ 1 で必ず先に行を作ってから呼ぶ設計のため、無いのは呼び出し順序の誤り）。
   */
  updateExpense(receiptId: string, patch: Partial<ExpenseLedgerRow>): void;
  /** 全行を返す（週次照合用。月数十件規模なので全件で足りる）。 */
  getAllExpenses(): ExpenseLedgerRow[];
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
  /**
   * `response_url` への POST（ephemeral）。`replace_original: true` を付与するため、
   * スラッシュコマンドが最初に返す「⏳ 処理中…」等の暫定エフェメラル応答をこの呼び出しの
   * 内容で置き換える。
   */
  postEphemeral(responseUrl: string, text: string): void;
  /** DM 送信（`conversations.open` ＋ `chat.postMessage`、実装設計 §7.9）。 */
  dm(userId: string, text: string): void;
  /**
   * `chat.delete` でメッセージを削除する（Bot 自身の投稿のみ、既存 `chat:write` スコープで可）。
   * 対象がすでに無い/削除できない（`message_not_found`/`cant_delete_message`）場合は
   * 呼び出し側が best-effort で使えるよう例外にせず握りつぶす。それ以外のエラーは例外を投げる。
   */
  deleteMessage(input: { channel: string; ts: string }): void;
}

// ---------------------------------------------------------------------------
// SlackFilesPort（実装設計 経費フェーズ §5.3, §5.5, §3.2）
// ---------------------------------------------------------------------------

/**
 * `SlackFilesPort.download` が 404 を受け取ったときに投げる例外（`url_private` が指す
 * ファイルが既に無い＝ユーザーがファイルを削除した）。`FILE_NOT_FOUND`（`retryable:false`）に
 * 対応する。
 */
export class SlackFileNotFoundError extends Error {
  constructor() {
    super("SLACK_FILE_NOT_FOUND");
    this.name = "SlackFileNotFoundError";
  }
}

/**
 * `SlackFilesPort.download` が 401/403 を受け取ったとき、またはホスト検証
 * （`SLACK_FILE_ALLOWED_HOSTS`、§5.5 の SSRF 対策）に失敗したときに投げる例外。
 * `FILE_FORBIDDEN`（`retryable:false`）に対応する。スコープ未付与・トークン失効等の
 * **設定エラー**を示すため、Worker 側は運用者向けの警告文言にする（§3.2）。
 */
export class SlackFileForbiddenError extends Error {
  constructor(message = "SLACK_FILE_FORBIDDEN") {
    super(message);
    this.name = "SlackFileForbiddenError";
  }
}

/**
 * 🔄 `SlackFilesPort.download` が 429 を除く未分類の 4xx（例: 400・410）を受け取ったときに
 * 投げる例外。`FILE_UNAVAILABLE`（`retryable:false`）に対応する（実装設計 経費フェーズ §3.2 の
 * 改訂で追加）。
 *
 * Cron 再送には回数上限が無く（`RETRY_NOTIFY_AT` 到達後も `RETRY_NOTIFY_EVERY` ごとに通知する
 * だけで諦めない）、恒久的な 4xx を `retryable:true` にすると無限に再送され続け、行が永久に
 * `pending` のまま残ってしまう。HTTP のセマンティクス（4xx＝クライアント誤りで自然には
 * 直らない）に従い、429（レート制限。時間経過で直る）と 401・403・404（別の専用例外）を除く
 * 4xx はここに分類する。
 */
export class SlackFileUnavailableError extends Error {
  constructor(message = "SLACK_FILE_UNAVAILABLE") {
    super(message);
    this.name = "SlackFileUnavailableError";
  }
}

/**
 * `SlackFilesPort.download` が 429・5xx・通信失敗、および 3xx 等それ以外の未分類コードを
 * 受け取ったときに投げる例外。`FILE_FETCH_FAILED`（`retryable:true`。Cron 再送の対象）に
 * 対応する。429 の場合は `Retry-After` をメッセージに含める（§3.2）。
 */
export class SlackFileFetchError extends Error {
  constructor(message = "SLACK_FILE_FETCH_FAILED") {
    super(message);
    this.name = "SlackFileFetchError";
  }
}

/**
 * Slack の `url_private` からファイル本体を取得するポート（実装設計 §5.3, §5.5）。
 * `handleExpenseSubmit`（WP8b）のフェーズ 2（ロック外の重い I/O）から呼ばれる。
 */
export interface SlackFilesPort {
  /**
   * `url_private` を `Authorization: Bearer <SLACK_BOT_TOKEN>` 付きで取得する。
   *
   * - ホストが `SLACK_FILE_ALLOWED_HOSTS`（`@kadobo/shared/expense` の
   *   `isAllowedSlackFileUrl`）以外 → {@link SlackFileForbiddenError}
   * - 404 → {@link SlackFileNotFoundError}
   * - 401・403 → {@link SlackFileForbiddenError}
   * - 429・5xx・通信失敗・3xx 等その他の未分類コード → {@link SlackFileFetchError}
   *   （429 は `Retry-After` をメッセージに含める）
   * - 🔄 429 を除く未分類の 4xx（例: 400・410）→ {@link SlackFileUnavailableError}
   *   （`retryable:false`。恒久的なクライアントエラーを無限に再送しないため）
   *
   * 戻り値の `bytes` は `Uint8Array` ではなく `number[]`（GAS の `Utilities`/`Blob` の byte array
   * に合わせる。実装は符号なし 0〜255 に正規化して返す）。
   */
  download(urlPrivate: string): { bytes: number[]; contentType: string };
}

// ---------------------------------------------------------------------------
// DrivePort（実装設計 経費フェーズ §5.3, §5.9）
// ---------------------------------------------------------------------------

/** Drive 上のファイル情報（実装設計 §5.3）。存在確認・再利用判断に必要な項目のみ。 */
export interface DriveFileInfo {
  id: string;
  name: string;
  size: number;
  /** UTC epoch ms。 */
  createdAtMs: number;
  trashed: boolean;
  url: string;
}

/**
 * Drive I/O（実装設計 §5.3, §5.9）。`DRIVE_RECEIPT_ROOT_ID`（Script Property）を起点に
 * `folderPath`（`/` 区切り、例 `経費証憑/紙/2026/09`）を辿る。ルートフォルダ自体の自動作成は
 * しない（§5.9: 未設定なら fail closed で例外を投げる）。
 */
export interface DrivePort {
  /**
   * `folderPath` 配下を `filename` 完全一致で検索する（実装設計 §5.4 フェーズ 3。
   * Drive 保存前に必ず呼ぶことで冪等性を保証する）。`folderPath` の途中フォルダが
   * 1 つでも存在しなければ `[]`（未作成のフォルダを検索した場合はまだ何も保存されていない
   * という意味なので、これは正常系）。
   */
  findByName(folderPath: string, filename: string): DriveFileInfo[];
  /** `folderPath` を辿り、無ければ作成したうえでファイルを保存する。 */
  saveFile(input: { folderPath: string; filename: string; bytes: number[]; mimeType: string }): DriveFileInfo;
  /** `drive_file_id` から現在の情報を引く（週次照合用、実装設計 §5.6）。無ければ `null`。 */
  getById(fileId: string): DriveFileInfo | null;
}

// ---------------------------------------------------------------------------
// DigestPort（実装設計 経費フェーズ §5.3, §5.9）
// ---------------------------------------------------------------------------

/** ハッシュ計算ポート（実装設計 §5.3）。証憑ファイルの同一性確認（§5.6）に使う。 */
export interface DigestPort {
  /**
   * SHA-256 を計算し hex 文字列で返す。`Utilities.computeDigest` の入出力に合わせ
   * `number[]`（byte array）を扱う（`Uint8Array` ではない）。
   */
  sha256Hex(bytes: number[]): string;
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

/**
 * 必須の設定（Script Property）が未設定であることを表す例外（実装設計 経費フェーズ §5.9, §3.2）。
 *
 * アダプタが投げ、app 層が `instanceof` で識別して `CONFIG_MISSING`（**非再試行**）へ写像する。
 * 設定不備は時間では直らないため、再試行に倒すと Cron が無限に再送し、行が永久に `pending` の
 * まま残る。**メッセージの部分一致で識別してはならない**（アダプタ側の文言を変えた瞬間に識別が
 * 外れ、無限再送へサイレントに退行するため）。
 */
export class ConfigMissingError extends Error {
  constructor(
    /** 未設定だった Script Property のキー（例: `DRIVE_RECEIPT_ROOT_ID`）。 */
    readonly propertyKey: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigMissingError";
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
  /** 経費フェーズ（実装設計 経費フェーズ §5.3）。 */
  slackFiles: SlackFilesPort;
  drive: DrivePort;
  digest: DigestPort;
}
