/**
 * app 層ユースケースのテスト用インメモリフェイク（WP3）。
 * `gas/src/app/ports.ts` の各ポートを Node 上で再現する。GAS API には一切依存しない。
 */
import { createHmac } from "node:crypto";
import { shiftBusinessDate } from "../../src/app/dateUtil";
import { LockTimeoutError } from "../../src/app/ports";
import type {
  AppPorts,
  CachePort,
  CalendarPort,
  ClockPort,
  DailySummaryRow,
  HmacPort,
  LockPort,
  MonthlyBillRow,
  PropsPort,
  RandomPort,
  RawLogRow,
  SheetsPort,
  SlackBlocksMessage,
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
}

export class FakeSlack implements SlackPort {
  posted: SlackBlocksMessage[] = [];
  updated: SlackUpdateMessage[] = [];
  viewsUpdated: SlackViewsUpdateInput[] = [];
  ephemeral: { responseUrl: string; text: string }[] = [];
  dms: { userId: string; text: string }[] = [];

  nextPostTs = "1756260000.000001";
  failNextUpdate = false;
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
  };
}
