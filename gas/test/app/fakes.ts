/**
 * app 層ユースケースのテスト用インメモリフェイク（WP3）。
 * `gas/src/app/ports.ts` の各ポートを Node 上で再現する。GAS API には一切依存しない。
 */
import { createHash, createHmac } from "node:crypto";
import { shiftBusinessDate } from "../../src/app/dateUtil";
import { LockTimeoutError } from "../../src/app/ports";
import type {
  AppPorts,
  CachePort,
  CalendarPort,
  ClockPort,
  DailySummaryRow,
  DigestPort,
  DriveFileInfo,
  DrivePort,
  ExpenseLedgerRow,
  HmacPort,
  LockPort,
  MonthlyBillRow,
  PropsPort,
  RandomPort,
  RawLogRow,
  SheetsPort,
  SlackBlocksMessage,
  SlackFilesPort,
  SlackPort,
  SlackPostMessageResult,
  SlackUpdateMessage,
  SlackViewsOpenInput,
  SlackViewsOpenResult,
  SlackViewsUpdateInput,
  WorkerStatusInfo,
  WorkerStatusPort,
} from "../../src/app/ports";
import { toLoggedEvent } from "../../src/app/rawLog";
import type { RecentDay } from "../../src/core/businessDate";
import type { UnitPriceRow } from "../../src/core/aggregate";

export class FakeSheets implements SheetsPort {
  rawLog: RawLogRow[] = [];
  dailySummaries = new Map<string, DailySummaryRow>();
  monthlyBills = new Map<string, MonthlyBillRow>();
  unitPrices: UnitPriceRow[] = [];
  internal = new Map<string, string>();
  /** 経費台帳（実装設計 経費フェーズ §5.1）。挿入順を保持する配列（実シートの行順に相当）。 */
  expenses: ExpenseLedgerRow[] = [];

  appendRawLog(row: RawLogRow): void {
    this.rawLog.push(row);
  }

  findRawLogByIdempotencyKey(idempotencyKey: string): RawLogRow | null {
    return this.rawLog.find((r) => r.idempotency_key === idempotencyKey) ?? null;
  }

  getEventsForBusinessDate(businessDate: string): RawLogRow[] {
    return this.rawLog.filter((r) => r.business_date === businessDate);
  }

  getRecentDaysEvents(referenceBusinessDate: string, days: number): RecentDay[] {
    const result: RecentDay[] = [];
    for (let i = 1; i <= days; i++) {
      const date = shiftBusinessDate(referenceBusinessDate, -i);
      result.push({
        business_date: date,
        events: this.getEventsForBusinessDate(date).map(toLoggedEvent),
      });
    }
    return result;
  }

  upsertDailySummary(row: DailySummaryRow): void {
    this.dailySummaries.set(row.business_date, row);
  }

  getDailySummary(businessDate: string): DailySummaryRow | null {
    return this.dailySummaries.get(businessDate) ?? null;
  }

  getDailySummariesInRange(fromDate: string, toDate: string): DailySummaryRow[] {
    return [...this.dailySummaries.values()]
      .filter((r) => r.business_date >= fromDate && r.business_date <= toDate)
      .sort((a, b) => (a.business_date < b.business_date ? -1 : a.business_date > b.business_date ? 1 : 0));
  }

  getUnitPriceRows(): UnitPriceRow[] {
    return this.unitPrices;
  }

  upsertMonthlyBill(row: MonthlyBillRow): void {
    this.monthlyBills.set(`${row.client}|${row.month}`, row);
  }

  getMonthlyBill(client: string, month: string): MonthlyBillRow | null {
    return this.monthlyBills.get(`${client}|${month}`) ?? null;
  }

  getInternalValue(kind: string, key: string): string | null {
    return this.internal.get(`${kind}|${key}`) ?? null;
  }

  setInternalValue(kind: string, key: string, value: string): void {
    this.internal.set(`${kind}|${key}`, value);
  }

  appendExpense(row: ExpenseLedgerRow): void {
    this.expenses.push(row);
  }

  findExpenseByIdempotencyKey(idempotencyKey: string): ExpenseLedgerRow | null {
    return this.expenses.find((r) => r.idempotency_key === idempotencyKey) ?? null;
  }

  getExpenseByReceiptId(receiptId: string): ExpenseLedgerRow | null {
    return this.expenses.find((r) => r.receipt_id === receiptId) ?? null;
  }

  updateExpense(receiptId: string, patch: Partial<ExpenseLedgerRow>): void {
    const idx = this.expenses.findIndex((r) => r.receipt_id === receiptId);
    if (idx === -1) {
      throw new Error(`expense_not_found:${receiptId}`);
    }
    this.expenses[idx] = { ...this.expenses[idx]!, ...patch };
  }

  getAllExpenses(): ExpenseLedgerRow[] {
    return [...this.expenses];
  }
}

export class FakeSlack implements SlackPort {
  posted: SlackBlocksMessage[] = [];
  updated: SlackUpdateMessage[] = [];
  viewsUpdated: SlackViewsUpdateInput[] = [];
  ephemeral: { responseUrl: string; text: string }[] = [];
  dms: { userId: string; text: string }[] = [];
  deleted: { channel: string; ts: string }[] = [];

  nextPostTs = "1756260000.000001";
  failNextUpdate = false;
  /**
   * `true` にすると次回の `deleteMessage()` がエラーを投げる。実 `SlackAdapter` は
   * `message_not_found`/`cant_delete_message` をここで握りつぶすため呼び出し側には届かないが、
   * フェイクではあえて届く形にして `cardHelpers.pushCard` 側の best-effort な try/catch
   * （どんな理由の失敗でも `/kado` 全体を壊さない）を直接検証できるようにする。
   */
  failNextDelete = false;
  failNextDeleteError = "slack_api_error:chat.delete:message_not_found";
  /**
   * `failNextUpdate` が true のとき `update()` が投げるエラーメッセージ。既定は一般的な
   * Slack API エラー（`SlackAdapter` が投げる `slack_api_error:chat.update:<error>` 相当）。
   * `message_not_found`/`cant_update_message` を含む文字列を渡すと `cardHelpers.pushCard` の
   * postMessage フォールバック分岐をテストできる。
   */
  failNextUpdateError = "slack_api_error:chat.update";
  failNextPostMessage = false;

  postMessage(input: SlackBlocksMessage): SlackPostMessageResult {
    if (this.failNextPostMessage) {
      this.failNextPostMessage = false;
      throw new Error("slack_api_error:chat.postMessage");
    }
    this.posted.push(input);
    return { ts: this.nextPostTs };
  }

  update(input: SlackUpdateMessage): void {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      throw new Error(this.failNextUpdateError);
    }
    this.updated.push(input);
  }

  viewsOpen(_input: SlackViewsOpenInput): SlackViewsOpenResult {
    return { view_id: "V1" };
  }

  viewsUpdate(input: SlackViewsUpdateInput): void {
    this.viewsUpdated.push(input);
  }

  postEphemeral(responseUrl: string, text: string): void {
    this.ephemeral.push({ responseUrl, text });
  }

  dm(userId: string, text: string): void {
    this.dms.push({ userId, text });
  }

  deleteMessage(input: { channel: string; ts: string }): void {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error(this.failNextDeleteError);
    }
    this.deleted.push(input);
  }
}

export class FakeCache implements CachePort {
  seen = new Set<string>();

  nonceSeen(nonce: string): boolean {
    return this.seen.has(nonce);
  }

  markNonce(nonce: string): void {
    this.seen.add(nonce);
  }
}

export class FakeLock implements LockPort {
  /** `true` にすると次回の `withLock` 呼び出しで `LockTimeoutError` を投げる（テスト用）。 */
  throwTimeoutOnce = false;

  withLock<T>(fn: () => T): T {
    if (this.throwTimeoutOnce) {
      this.throwTimeoutOnce = false;
      throw new LockTimeoutError();
    }
    return fn();
  }
}

export class FakeProps implements PropsPort {
  values = new Map<string, string>();

  get(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.values.set(key, value);
  }
}

export class FakeCalendar implements CalendarPort {
  holidays = new Set<string>();

  isHoliday(businessDate: string): boolean {
    return this.holidays.has(businessDate);
  }
}

export class FakeClock implements ClockPort {
  currentMs: number;

  constructor(initialMs: number) {
    this.currentMs = initialMs;
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowSec(): number {
    return Math.floor(this.currentMs / 1000);
  }
}

export class FakeRandom implements RandomPort {
  private counter = 0;

  // アロー関数のクラスフィールドにする: `ulid(nowMs, ports.random.randomBytes)` のように
  // メソッド参照だけを切り離して渡しても（`this` を失っても）正しく動くようにするため
  // （実 GAS アダプタの `randomBytes` は `this` に依存しないため元々問題にならないが、
  // フェイクの `this.counter` はこの対策が無いと壊れる）。
  randomBytes = (n: number): Uint8Array => {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      this.counter = (this.counter + 1) % 256;
      bytes[i] = this.counter;
    }
    return bytes;
  };
}

/** GAS の `Utilities.computeHmacSha256Signature` 相当を Node の `crypto` で代替する（テスト専用）。 */
export class FakeHmac implements HmacPort {
  hmacHex(key: string, msg: string): string {
    return createHmac("sha256", key).update(msg, "utf8").digest("hex");
  }
}

export class FakeWorkerStatus implements WorkerStatusPort {
  status: WorkerStatusInfo | null = null;

  fetchStatus(): WorkerStatusInfo | null {
    return this.status;
  }
}

/**
 * `SlackFilesPort` のフェイク（経費フェーズ WP8a）。WP8b の故障注入テスト
 * （`FILE_NOT_FOUND`/`FILE_FORBIDDEN`/`FILE_FETCH_FAILED` 等の 6 分岐）で使うため、
 * `nextError` に任意の例外（{@link SlackFileNotFoundError} 等）を積んでおけるようにする。
 */
export class FakeSlackFiles implements SlackFilesPort {
  /** `download` に渡された `url_private` の呼び出し履歴。 */
  downloads: string[] = [];
  /** 設定されていれば次回の `download` 呼び出しでこれを投げる（1 回限りで自動的にクリアされる）。 */
  nextError: Error | null = null;
  /** `nextError` が無いときに `download` が返す内容。既定はダミーの JPEG 相当。 */
  nextResult: { bytes: number[]; contentType: string } = {
    bytes: [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0],
    contentType: "image/jpeg",
  };

  download(urlPrivate: string): { bytes: number[]; contentType: string } {
    this.downloads.push(urlPrivate);
    if (this.nextError !== null) {
      const err = this.nextError;
      this.nextError = null;
      throw err;
    }
    return this.nextResult;
  }
}

/**
 * `DrivePort` のフェイク（経費フェーズ WP8a）。`folderPath + "/" + filename` をキーに
 * ファイル一覧を保持する（同名複数件を再現できるよう配列で持つ。`DRIVE_CONFLICT` の
 * 故障注入テスト用）。`plantFile` で「既に保存済み」の状態をテスト側から事前登録できる。
 * `next*Error` に任意の例外を積んで各メソッドの失敗を注入できる。
 */
export class FakeDrive implements DrivePort {
  private readonly files = new Map<string, DriveFileInfo[]>();
  private nextFileSeq = 1;
  /** `saveFile` が実際に呼ばれた回数（「Drive 書込は 1 回だけ」を検証する故障注入テスト用）。 */
  saveCount = 0;
  nextFindByNameError: Error | null = null;
  nextSaveError: Error | null = null;
  nextGetByIdError: Error | null = null;

  private key(folderPath: string, filename: string): string {
    return `${folderPath}/${filename}`;
  }

  /** テスト側から「Drive に既に保存済み」のファイルを 1 件登録する（`findByName` が返せるようにする）。 */
  plantFile(folderPath: string, filename: string, info: Partial<DriveFileInfo> = {}): DriveFileInfo {
    const fileInfo: DriveFileInfo = {
      id: info.id ?? `fake-drive-file-${this.nextFileSeq++}`,
      name: filename,
      size: info.size ?? 0,
      createdAtMs: info.createdAtMs ?? Date.now(),
      trashed: info.trashed ?? false,
      url: info.url ?? `https://drive.example.test/${folderPath}/${filename}`,
    };
    const list = this.files.get(this.key(folderPath, filename)) ?? [];
    list.push(fileInfo);
    this.files.set(this.key(folderPath, filename), list);
    return fileInfo;
  }

  findByName(folderPath: string, filename: string): DriveFileInfo[] {
    if (this.nextFindByNameError !== null) {
      const err = this.nextFindByNameError;
      this.nextFindByNameError = null;
      throw err;
    }
    return [...(this.files.get(this.key(folderPath, filename)) ?? [])];
  }

  saveFile(input: { folderPath: string; filename: string; bytes: number[]; mimeType: string }): DriveFileInfo {
    if (this.nextSaveError !== null) {
      const err = this.nextSaveError;
      this.nextSaveError = null;
      throw err;
    }
    this.saveCount++;
    return this.plantFile(input.folderPath, input.filename, { size: input.bytes.length });
  }

  getById(fileId: string): DriveFileInfo | null {
    if (this.nextGetByIdError !== null) {
      const err = this.nextGetByIdError;
      this.nextGetByIdError = null;
      throw err;
    }
    for (const list of this.files.values()) {
      const found = list.find((f) => f.id === fileId);
      if (found !== undefined) {
        return found;
      }
    }
    return null;
  }
}

/**
 * `DigestPort` のフェイク。`FakeHmac` と同じ方針で Node の `crypto` に本物の SHA-256 を
 * 計算させる（テスト用の擬似ハッシュではなく実際のダイジェストにすることで、既知のテスト
 * ベクタとの突き合わせや「同一バイト列は同一ハッシュ」の検証にそのまま使える）。
 */
export class FakeDigest implements DigestPort {
  sha256Hex(bytes: number[]): string {
    return createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");
  }
}

export interface FakePorts extends AppPorts {
  sheets: FakeSheets;
  slack: FakeSlack;
  cache: FakeCache;
  lock: FakeLock;
  props: FakeProps;
  calendar: FakeCalendar;
  clock: FakeClock;
  random: FakeRandom;
  hmac: FakeHmac;
  workerStatus: FakeWorkerStatus;
  slackFiles: FakeSlackFiles;
  drive: FakeDrive;
  digest: FakeDigest;
}

/** 既定値入りのフェイク一式を作る。`nowMs` は固定時刻（既定は 2026-09-01 12:00 JST 相当）。 */
export function makeFakePorts(nowMs = Date.parse("2026-09-01T12:00:00+09:00")): FakePorts {
  return {
    sheets: new FakeSheets(),
    slack: new FakeSlack(),
    cache: new FakeCache(),
    lock: new FakeLock(),
    props: new FakeProps(),
    calendar: new FakeCalendar(),
    clock: new FakeClock(nowMs),
    random: new FakeRandom(),
    hmac: new FakeHmac(),
    workerStatus: new FakeWorkerStatus(),
    slackFiles: new FakeSlackFiles(),
    drive: new FakeDrive(),
    digest: new FakeDigest(),
  };
}
