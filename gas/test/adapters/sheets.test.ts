/**
 * `gas/src/adapters/sheets.ts` の型自動変換バグ回帰テスト。
 *
 * 実機で確認された 2 件のバグ（デプロイ中のログで確定）:
 *   1. 内部シートの `value`（カードの Slack ts）が Sheets の自動型変換で数値化され、
 *      末尾ゼロを含む ts（例 `"1787820585.021000"`）が桁落ちする → `chat.update` が
 *      `message_not_found` で失敗しカードが更新されない。
 *   2. 生ログ・日次集計等の `business_date`（`"YYYY-MM-DD"`）が自動的に `Date` 型に変換され、
 *      `getEventsForBusinessDate` の文字列比較が常に不一致になる → 2 回目以降の打刻で状態が
 *      常に IDLE と誤判定され、休憩/終了が弾かれる。
 *
 * `SpreadsheetApp` を丸ごとフェイク（`./fakeSpreadsheetApp.ts`）に差し替え、実際の
 * `SheetsAdapter`/`setupSpreadsheet`（本番コードそのもの）に対してテストする。
 * フェイクは「文字列として書いた値が Sheets によって数値・日付へ自動変換される」実機の挙動を
 * 模倣する coerce モードを持つ（`setNumberFormat("@")` 済みのセルは変換しない）。
 */
import { buttonIdempotencyKey } from "@kadobo/shared/ids";
import type { GasRequest } from "@kadobo/shared/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleStamp } from "../../src/app/stamp";
import { toLoggedEvent } from "../../src/app/rawLog";
import type { AppPorts } from "../../src/app/ports";
import { SheetsAdapter, setupSpreadsheet } from "../../src/adapters/sheets";
import { applyCorrections } from "../../src/core/correction";
import { isStampEvent, replay } from "../../src/core/state";
import {
  FakeCache,
  FakeCalendar,
  FakeClock,
  FakeHmac,
  FakeLock,
  FakeProps,
  FakeRandom,
  FakeSlack,
  FakeWorkerStatus,
} from "../app/fakes";
import { TEXT_FORMAT, installFakeSpreadsheetApp, simulateSheetsCoercion, type FakeSpreadsheet } from "./fakeSpreadsheetApp";

// sheets.ts の SHEET_NAMES/列順（実装設計 §7.1）をテスト側でも直接参照する必要があるため、
// シート名・列番号（1-based）はここに固定値として再掲する（sheets.ts 側は export していない）。
const RAW_LOG_SHEET = "生ログ";
const INTERNAL_SHEET = "内部";
const SPREADSHEET_ID = "fake-spreadsheet-id";

// 生ログの列番号（1-based、RAW_LOG_HEADERS の並び）。
const COL = {
  event_id: 1,
  idempotency_key: 2,
  business_date: 3,
  event_type: 4,
  occurred_at: 5,
  occurred_at_jst: 6,
  received_at: 7,
  processed_at: 8,
  source: 9,
  session_no: 10,
  memo: 11,
  correction_of: 12,
  old_value: 13,
  new_value: 14,
  reason: 15,
} as const;

// 内部シートの列番号（1-based、INTERNAL_HEADERS の並び）。
const INTERNAL_COL = { kind: 1, key: 2, value: 3, updated_at: 4 } as const;

let harness: ReturnType<typeof installFakeSpreadsheetApp>;

beforeEach(() => {
  harness = installFakeSpreadsheetApp();
});

afterEach(() => {
  harness.restore();
});

describe("フェイクの coerce（自己検証）", () => {
  it("実機ログで観測された変換をそのまま再現する", () => {
    // 実機ログ: Number("1787820585.021000") → "1787820585.021"（末尾ゼロ消失）。
    expect(simulateSheetsCoercion("1787820585.021000")).toBe(1787820585.021);
    // 実機ログ: business_date が Date 型（isDate=true）に変換される。
    const coerced = simulateSheetsCoercion("2026-08-27");
    expect(coerced instanceof Date).toBe(true);
    // "@"（text）書式が設定済みのセルは変換しない（対策Aの効果を模す）。
    expect(simulateSheetsCoercion("2026-08-27", TEXT_FORMAT)).toBe("2026-08-27");
    expect(simulateSheetsCoercion("1787820585.021000", TEXT_FORMAT)).toBe("1787820585.021000");
  });
});

describe("setupSpreadsheet: text 書式の適用（対策A）", () => {
  it("business_date 列・内部シートの value 列を text 化し、数値列は text 化しない", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const rawLog = harness.spreadsheet.getSheetByName(RAW_LOG_SHEET);
    const internal = harness.spreadsheet.getSheetByName(INTERNAL_SHEET);
    expect(rawLog).not.toBeNull();
    expect(internal).not.toBeNull();

    // 文字列列は "@"。
    expect(rawLog?.getFormat(2, COL.business_date)).toBe(TEXT_FORMAT);
    expect(rawLog?.getFormat(2, COL.occurred_at_jst)).toBe(TEXT_FORMAT);
    expect(internal?.getFormat(2, INTERNAL_COL.value)).toBe(TEXT_FORMAT);
    expect(internal?.getFormat(2, INTERNAL_COL.key)).toBe(TEXT_FORMAT);

    // 本来数値の列は "@" にしない（既定の "General" のまま）。
    expect(rawLog?.getFormat(2, COL.occurred_at)).not.toBe(TEXT_FORMAT);
    expect(rawLog?.getFormat(2, COL.session_no)).not.toBe(TEXT_FORMAT);
    expect(internal?.getFormat(2, INTERNAL_COL.updated_at)).not.toBe(TEXT_FORMAT);
  });

  it("既存シートでも再実行のたびに冪等に書式を再適用する", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    setupSpreadsheet(SPREADSHEET_ID); // 2 回目（既存シート）でも例外を投げず、書式は維持される。
    const rawLog = harness.spreadsheet.getSheetByName(RAW_LOG_SHEET);
    expect(rawLog?.getFormat(2, COL.business_date)).toBe(TEXT_FORMAT);
  });
});

describe("内部シートの value（カード ts）往復一致（対策A: バグ①の回帰テスト）", () => {
  it("末尾ゼロを含む ts が setInternalValue → getInternalValue で完全一致する", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    const ts = "1787820585.021000"; // 実機ログで確定した壊れ方: 末尾ゼロが消える typeの値
    adapter.setInternalValue("card", "C1:2026-08-27", ts);

    expect(adapter.getInternalValue("card", "C1:2026-08-27")).toBe(ts);

    // 裏付け: セルに実際に格納されている生の値が number ではなく string であること
    // （text 書式のおかげで自動変換されていない）。
    const internal = harness.spreadsheet.getSheetByName(INTERNAL_SHEET);
    const rawValue = internal?.getCell(2, INTERNAL_COL.value);
    expect(typeof rawValue).toBe("string");
    expect(rawValue).toBe(ts);
  });

  it("2 回目の書き込み（上書き upsert）でも精度が保たれる", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    adapter.setInternalValue("card", "C1:2026-08-27", "1756260000.000100");
    adapter.setInternalValue("card", "C1:2026-08-27", "1787820585.021000");

    expect(adapter.getInternalValue("card", "C1:2026-08-27")).toBe("1787820585.021000");
  });
});

describe("business_date の Date 化に対する読み取り側の防御（対策B: バグ②の回帰テスト）", () => {
  /** レガシー破損データ（対策A適用前に書かれ、business_date が Date 化された行）を直接注入する。 */
  function plantCorruptedRawLogRow(
    sheet: NonNullable<ReturnType<FakeSpreadsheet["getSheetByName"]>>,
    rowIndex: number,
    args: { eventId: string; eventType: string; businessDate: string; occurredAtMs: number },
  ): void {
    sheet.setCell(rowIndex, COL.event_id, args.eventId);
    sheet.setCell(rowIndex, COL.idempotency_key, `idem-${args.eventId}`);
    // ここが本バグの核心: text 書式が無かった時代に書かれ、Sheets が Date 型へ自動変換した想定。
    sheet.setCell(rowIndex, COL.business_date, simulateSheetsCoercion(args.businessDate, "General"));
    sheet.setCell(rowIndex, COL.event_type, args.eventType);
    sheet.setCell(rowIndex, COL.occurred_at, args.occurredAtMs);
    sheet.setCell(rowIndex, COL.occurred_at_jst, "");
    sheet.setCell(rowIndex, COL.received_at, args.occurredAtMs);
    sheet.setCell(rowIndex, COL.processed_at, args.occurredAtMs);
    sheet.setCell(rowIndex, COL.source, "button");
    sheet.setCell(rowIndex, COL.session_no, 1);
    sheet.setCell(rowIndex, COL.memo, "");
    sheet.setCell(rowIndex, COL.correction_of, "");
    sheet.setCell(rowIndex, COL.old_value, "");
    sheet.setCell(rowIndex, COL.new_value, "");
    sheet.setCell(rowIndex, COL.reason, "");
  }

  it("START の後に BREAK_START: business_date が Date 化されていても getEventsForBusinessDate が突き合わせ、状態は ON_BREAK", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const rawLog = harness.spreadsheet.getSheetByName(RAW_LOG_SHEET);
    if (rawLog === null) {
      throw new Error("rawLog sheet missing");
    }

    // 裏付け: 実際に Date 型として格納されていることを確認してからテストする。
    plantCorruptedRawLogRow(rawLog, 2, {
      eventId: "EV1",
      eventType: "START",
      businessDate: "2026-08-27",
      occurredAtMs: Date.parse("2026-08-27T09:00:00+09:00"),
    });
    plantCorruptedRawLogRow(rawLog, 3, {
      eventId: "EV2",
      eventType: "BREAK_START",
      businessDate: "2026-08-27",
      occurredAtMs: Date.parse("2026-08-27T12:00:00+09:00"),
    });
    expect(rawLog.getCell(2, COL.business_date) instanceof Date).toBe(true);
    expect(rawLog.getCell(3, COL.business_date) instanceof Date).toBe(true);

    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    const rows = adapter.getEventsForBusinessDate("2026-08-27");

    // 文字列比較が壊れていれば（修正前は）ここが 0 件になる。
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.business_date)).toEqual(["2026-08-27", "2026-08-27"]);

    const events = rows.map(toLoggedEvent);
    const corrected = applyCorrections(events).filter(isStampEvent);
    const sorted = [...corrected].sort((a, b) => a.occurred_at - b.occurred_at);
    const { state } = replay(sorted);
    expect(state).toBe("ON_BREAK");
  });

  it("START→BREAK_START→BREAK_END→END の 4 イベントすべてが Date 化されていても最終状態は CLOSED", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const rawLog = harness.spreadsheet.getSheetByName(RAW_LOG_SHEET);
    if (rawLog === null) {
      throw new Error("rawLog sheet missing");
    }
    const plan: { eventType: string; hm: string }[] = [
      { eventType: "START", hm: "09:00:00" },
      { eventType: "BREAK_START", hm: "12:00:00" },
      { eventType: "BREAK_END", hm: "13:00:00" },
      { eventType: "END", hm: "18:00:00" },
    ];
    plan.forEach((p, i) => {
      plantCorruptedRawLogRow(rawLog, i + 2, {
        eventId: `EV${i + 1}`,
        eventType: p.eventType,
        businessDate: "2026-08-27",
        occurredAtMs: Date.parse(`2026-08-27T${p.hm}+09:00`),
      });
    });

    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    const rows = adapter.getEventsForBusinessDate("2026-08-27");
    expect(rows).toHaveLength(4);

    const events = rows.map(toLoggedEvent);
    const corrected = applyCorrections(events).filter(isStampEvent);
    const sorted = [...corrected].sort((a, b) => a.occurred_at - b.occurred_at);
    const { state } = replay(sorted);
    expect(state).toBe("CLOSED");
  });
});

describe("handleStamp を SheetsAdapter（実アダプタ）に通した end-to-end 回帰テスト", () => {
  interface RealSheetsAppPorts extends AppPorts {
    sheets: SheetsAdapter;
    slack: FakeSlack;
  }

  function makePorts(): RealSheetsAppPorts {
    return {
      sheets: new SheetsAdapter(SPREADSHEET_ID),
      slack: new FakeSlack(),
      cache: new FakeCache(),
      lock: new FakeLock(),
      props: new FakeProps(),
      calendar: new FakeCalendar(),
      clock: new FakeClock(Date.parse("2026-08-27T09:00:00+09:00")),
      random: new FakeRandom(),
      hmac: new FakeHmac(),
      workerStatus: new FakeWorkerStatus(),
    };
  }

  function makeStampRequest(overrides: Partial<Extract<GasRequest, { kind: "stamp" }>> = {}) {
    const messageTs = "1756260000.000100";
    const actionId = overrides.action_id ?? "kado_start";
    const occurredAtMs = overrides.occurred_at_ms ?? Date.parse("2026-08-27T09:00:00+09:00");
    // action_ts はボタン押下時刻相当。イベントごとに action_id が異なるため衝突しないが、
    // occurred_at_ms から一意に導出しておく（実運用の action_ts に近い値にする）。
    const actionTs = `${Math.floor(occurredAtMs / 1000)}.000100`;
    const base: Extract<GasRequest, { kind: "stamp" }> = {
      kind: "stamp",
      idempotency_key: buttonIdempotencyKey({
        user_id: "U1",
        message_ts: messageTs,
        action_id: actionId,
        action_ts: actionTs,
      }),
      user_id: "U1",
      channel_id: "C1",
      message_ts: messageTs,
      action_id: actionId,
      occurred_at_ms: occurredAtMs,
      received_at_ms: occurredAtMs + 400,
      source: "button",
    };
    return { ...base, ...overrides };
  }

  it("START → BREAK_START の連続打刻が、実アダプタ経由でも INVALID_TRANSITION にならない", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const ports = makePorts();

    const startResult = handleStamp(makeStampRequest(), ports);
    expect(startResult).toEqual({ ok: true, applied: true });

    const breakResult = handleStamp(
      makeStampRequest({
        action_id: "kado_break_start",
        occurred_at_ms: Date.parse("2026-08-27T12:00:00+09:00"),
        received_at_ms: Date.parse("2026-08-27T12:00:00+09:00") + 400,
      }),
      ports,
    );

    // 修正前は business_date が Date 化され、2 回目の getEventsForBusinessDate が
    // 1 回目の START を見つけられず IDLE と誤判定 → INVALID_TRANSITION になっていた。
    expect(breakResult).toEqual({ ok: true, applied: true });

    // 生ログ列の実体が string のままであること（対策Aが効いている裏付け）。
    const rawLog = harness.spreadsheet.getSheetByName(RAW_LOG_SHEET);
    expect(rawLog?.getCell(2, COL.business_date)).toBe("2026-08-27");
    expect(typeof rawLog?.getCell(2, COL.business_date)).toBe("string");

    // stamp リクエストは常に message_ts（押されたカードの実際の ts）を preferredMessageTs として
    // 渡すため、内部シートの card ts が未設定でも 1 回目から chat.update が使われる
    // （実装設計の自己修復ロジック。内部シートには 1 回目の成功時に message_ts が書き戻される）。
    expect(ports.slack.posted).toHaveLength(0);
    expect(ports.slack.updated).toHaveLength(2);
    expect(ports.slack.updated.every((u) => u.ts === "1756260000.000100")).toBe(true);
  });

  it("START→BREAK_START→BREAK_END→END の 4 連続打刻が全て applied:true になる", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const ports = makePorts();

    const steps: { action_id: Extract<GasRequest, { kind: "stamp" }>["action_id"]; hm: string }[] = [
      { action_id: "kado_start", hm: "09:00:00" },
      { action_id: "kado_break_start", hm: "12:00:00" },
      { action_id: "kado_break_end", hm: "13:00:00" },
      { action_id: "kado_end", hm: "18:00:00" },
    ];

    for (const step of steps) {
      const ms = Date.parse(`2026-08-27T${step.hm}+09:00`);
      const result = handleStamp(
        makeStampRequest({ action_id: step.action_id, occurred_at_ms: ms, received_at_ms: ms + 400 }),
        ports,
      );
      expect(result).toEqual({ ok: true, applied: true });
    }
  });
});
