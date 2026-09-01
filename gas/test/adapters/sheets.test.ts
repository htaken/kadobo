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
import type { AppPorts, ExpenseLedgerRow } from "../../src/app/ports";
import { SheetsAdapter, setupSpreadsheet } from "../../src/adapters/sheets";
import { applyCorrections } from "../../src/core/correction";
import { isStampEvent, replay } from "../../src/core/state";
import {
  FakeCache,
  FakeCalendar,
  FakeClock,
  FakeDigest,
  FakeDrive,
  FakeHmac,
  FakeLock,
  FakeProps,
  FakeRandom,
  FakeSlack,
  FakeSlackFiles,
  FakeWorkerStatus,
} from "../app/fakes";
import {
  TEXT_FORMAT,
  installFakeSpreadsheetApp,
  simulateSheetsCoercion,
  type FakeSheet,
  type FakeSpreadsheet,
} from "./fakeSpreadsheetApp";

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

// 経費台帳（実装設計 経費フェーズ §5.1）。
const EXPENSE_SHEET = "経費台帳";

// 経費台帳の列番号（1-based、実装設計 §5.1 の 24 列の並び）。
const EXPENSE_COL = {
  receipt_id: 1,
  receipt_type: 2,
  date: 3,
  amount: 4,
  partner: 5,
  category: 6,
  memo: 7,
  drive_link: 8,
  file_hash: 9,
  mime_type: 10,
  size: 11,
  input_at: 12,
  state: 13,
  mf_journal_id: 14,
  idempotency_key: 15,
  slack_file_id: 16,
  drive_file_id: 17,
  original_file_name: 18,
  last_error: 19,
  state_updated_at: 20,
  tax_category: 21,
  business_use_ratio: 22,
  correction_of_receipt_id: 23,
  correction_reason: 24,
} as const;

/** 移行前（MVP §7.1）の経費台帳ヘッダー 14 列。`sheets.ts` の同名の定数と同じ値。 */
const EXPENSE_HEADERS_V1 = [
  "証憑ID",
  "証憑区分",
  "日付",
  "金額",
  "取引先",
  "カテゴリ",
  "メモ",
  "Driveリンク",
  "ファイルハッシュ",
  "元MIME",
  "サイズ",
  "入力日時",
  "処理状態",
  "MF仕訳ID",
] as const;

/** 移行後（実装設計 経費フェーズ §5.1）の経費台帳ヘッダー 24 列。 */
const EXPENSE_HEADERS_V2 = [
  ...EXPENSE_HEADERS_V1,
  "idempotency_key",
  "slack_file_id",
  "drive_file_id",
  "元ファイル名",
  "last_error",
  "state_updated_at",
  "税区分",
  "事業使用割合",
  "訂正元証憑ID",
  "訂正理由",
] as const;

// 訂正削除申請シート（事務処理規程・電子取引 第2条）。国税庁ひな形の「取引情報訂正・削除
// 申請書」の 8 項目をそのまま列名にする。`sheets.ts` の同名の定数と同じ値。
const CORRECTION_REQUEST_SHEET = "訂正削除申請";
const CORRECTION_REQUEST_HEADERS = [
  "申請日",
  "取引伝票番号",
  "取引件名",
  "取引先名",
  "訂正・削除日付",
  "訂正・削除内容",
  "訂正・削除理由",
  "処理担当者名",
] as const;

// 既存 6 シート（訂正削除申請シート追加前から存在するシート）の名称一覧。
const EXISTING_SHEET_NAMES = [RAW_LOG_SHEET, "日次集計", "単価マスタ", "月次請求", EXPENSE_SHEET, INTERNAL_SHEET];

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
      slackFiles: new FakeSlackFiles(),
      drive: new FakeDrive(),
      digest: new FakeDigest(),
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

// =============================================================================
// 経費台帳（実装設計 経費フェーズ §5.1, §5.3, §9 WP8a 受入条件）
// =============================================================================

/** MVP（14 列）の経費台帳シートを直接作る（本番相当のヘッダーのみ・データ行任意）。 */
function plantLegacyExpenseLedgerSheet(
  spreadsheet: FakeSpreadsheet,
  dataRow?: unknown[],
): FakeSheet {
  const sheet = spreadsheet.insertSheet(EXPENSE_SHEET);
  EXPENSE_HEADERS_V1.forEach((h, i) => sheet.setCell(1, i + 1, h));
  if (dataRow !== undefined) {
    dataRow.forEach((v, i) => sheet.setCell(2, i + 1, v));
  }
  return sheet;
}

/** 24 列（移行済み）の経費台帳ヘッダーを直接作る。 */
function plantMigratedExpenseLedgerSheet(spreadsheet: FakeSpreadsheet): FakeSheet {
  const sheet = spreadsheet.insertSheet(EXPENSE_SHEET);
  EXPENSE_HEADERS_V2.forEach((h, i) => sheet.setCell(1, i + 1, h));
  return sheet;
}

function makeExpenseRow(overrides: Partial<ExpenseLedgerRow> = {}): ExpenseLedgerRow {
  return {
    receipt_id: "R-20260901-001",
    receipt_type: "paper",
    date: "2026-09-01",
    amount: 1200,
    partner: "○○商店",
    category: "消耗品費",
    memo: "",
    drive_link: "https://drive.example.test/x",
    file_hash: "abcdef0123456789",
    mime_type: "image/jpeg",
    size: 123456,
    input_at: Date.parse("2026-09-01T09:00:00+09:00"),
    state: "RECEIVED",
    mf_journal_id: null,
    idempotency_key: "V1:2026-09-01T09:00:00+09:00abcdef",
    slack_file_id: "F0123456789",
    drive_file_id: "",
    original_file_name: "receipt.jpg",
    last_error: null,
    state_updated_at: Date.parse("2026-09-01T09:00:00+09:00"),
    tax_category: "",
    business_use_ratio: 100,
    correction_of_receipt_id: null,
    correction_reason: null,
    ...overrides,
  };
}

describe("経費台帳の列マイグレーション（実装設計 経費フェーズ §5.1 の 🔄、§9 WP8a 受入条件）", () => {
  it("新規シート（データ無し）は最初から 24 列ヘッダーで作成される", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    expect(sheet).not.toBeNull();
    const header = EXPENSE_HEADERS_V2.map((_, i) => sheet?.getCell(1, i + 1));
    expect(header).toEqual([...EXPENSE_HEADERS_V2]);
  });

  it("MVP の 14 列ヘッダーから 24 列へ拡張し、既存 14 列のデータには一切触れない", () => {
    const legacyRow = [
      "R-20260801-001",
      "paper",
      "2026-08-01",
      1200,
      "○○商店",
      "消耗品費",
      "",
      "https://drive.example.test/legacy",
      "hash-legacy",
      "image/jpeg",
      12345,
      Date.parse("2026-08-01T09:00:00+09:00"),
      "COMPLETED",
      "",
    ];
    const sheet = plantLegacyExpenseLedgerSheet(harness.spreadsheet, legacyRow);

    setupSpreadsheet(SPREADSHEET_ID);

    const header = EXPENSE_HEADERS_V2.map((_, i) => sheet.getCell(1, i + 1));
    expect(header).toEqual([...EXPENSE_HEADERS_V2]);

    // 既存 14 列のデータ（ヘッダー行・データ行とも）は変更されていない。
    legacyRow.forEach((v, i) => {
      expect(sheet.getCell(2, i + 1)).toBe(v);
    });
    // 追加された 15〜24 列目（データ行）はまだ空。
    for (let col = 15; col <= 24; col++) {
      expect(sheet.getCell(2, col)).toBe("");
    }
  });

  it("2 回実行しても壊れない（冪等）。移行後に書き込んだ内容も保持される", () => {
    plantLegacyExpenseLedgerSheet(harness.spreadsheet);
    setupSpreadsheet(SPREADSHEET_ID);

    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    adapter.appendExpense(makeExpenseRow());

    expect(() => setupSpreadsheet(SPREADSHEET_ID)).not.toThrow();

    const found = adapter.getExpenseByReceiptId("R-20260901-001");
    expect(found).toEqual(makeExpenseRow());

    const sheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    const header = EXPENSE_HEADERS_V2.map((_, i) => sheet?.getCell(1, i + 1));
    expect(header).toEqual([...EXPENSE_HEADERS_V2]);
  });

  it("既に 24 列（移行済み）なら何もしない", () => {
    const sheet = plantMigratedExpenseLedgerSheet(harness.spreadsheet);

    expect(() => setupSpreadsheet(SPREADSHEET_ID)).not.toThrow();

    const header = EXPENSE_HEADERS_V2.map((_, i) => sheet.getCell(1, i + 1));
    expect(header).toEqual([...EXPENSE_HEADERS_V2]);
  });

  it("ヘッダーが 14 列とも 24 列とも一致しない場合、何も書き換えず例外を投げて中断する", () => {
    const sheet = harness.spreadsheet.insertSheet(EXPENSE_SHEET);
    const brokenHeaders = ["証憑ID", "日付", "金額"];
    brokenHeaders.forEach((h, i) => sheet.setCell(1, i + 1, h));
    sheet.setCell(2, 1, "R-BROKEN");

    expect(() => setupSpreadsheet(SPREADSHEET_ID)).toThrow(/経費台帳のヘッダーが想定と一致しません/);

    // 中断後もヘッダー・データ行は一切書き換えられていない。
    expect(sheet.getCell(1, 1)).toBe("証憑ID");
    expect(sheet.getCell(1, 2)).toBe("日付");
    expect(sheet.getCell(1, 4)).toBe("");
    expect(sheet.getCell(2, 1)).toBe("R-BROKEN");
  });

  it("14 列と部分的に一致するが 15 列目以降に想定外の値がある場合も中断する（部分的に壊れたシート）", () => {
    const sheet = plantLegacyExpenseLedgerSheet(harness.spreadsheet);
    // 15 列目（idempotency_key の位置）に想定外の値が入っている＝安全に移行できない状態。
    sheet.setCell(1, 15, "何か別の列");

    expect(() => setupSpreadsheet(SPREADSHEET_ID)).toThrow(/経費台帳のヘッダーが想定と一致しません/);
  });

  it("シートの実列数が 24 未満（列削除等）でも「範囲の列数が多すぎます」内部エラーにならず 24 列へ拡張される（列数ガード）", () => {
    // 本番シートは既定 26 列だが、誰かが余分な列を削除してちょうど 14 列にした状態を再現する。
    // これをガードせずに 24 列ぶんの getRange を呼ぶと、フェイクは実 GAS と同じく
    // 「範囲の列数が多すぎます」相当の内部エラーを投げる（`fakeSpreadsheetApp.ts` の `getRange`）。
    const sheet = plantLegacyExpenseLedgerSheet(harness.spreadsheet);
    sheet.setMaxColumnsForTest(14);

    expect(() => setupSpreadsheet(SPREADSHEET_ID)).not.toThrow();

    expect(sheet.getMaxColumns()).toBeGreaterThanOrEqual(EXPENSE_HEADERS_V2.length);
    const header = EXPENSE_HEADERS_V2.map((_, i) => sheet.getCell(1, i + 1));
    expect(header).toEqual([...EXPENSE_HEADERS_V2]);
  });

  it("シートの実列数が 24 未満でも「既に 24 列（移行済み）」の判定・保護・非表示が壊れない", () => {
    const sheet = plantMigratedExpenseLedgerSheet(harness.spreadsheet);
    sheet.setMaxColumnsForTest(24);

    expect(() => setupSpreadsheet(SPREADSHEET_ID)).not.toThrow();

    for (let col = 15; col <= 20; col++) {
      expect(sheet.isColumnHiddenByUser(col)).toBe(true);
    }
  });
});

describe("経費台帳のシステム列の保護・既定非表示（実装設計 §5.1 の 🔄）", () => {
  it("idempotency_key〜state_updated_at（15〜20 列）を既定で非表示にする。業務列は非表示にしない", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    if (sheet === null) {
      throw new Error("expense ledger sheet missing");
    }

    for (let col = 15; col <= 20; col++) {
      expect(sheet.isColumnHiddenByUser(col)).toBe(true);
    }
    // 税区分・事業使用割合・訂正元証憑ID・訂正理由（21〜24 列）は非表示にしない。
    for (let col = 21; col <= 24; col++) {
      expect(sheet.isColumnHiddenByUser(col)).toBe(false);
    }
    // 証憑ID〜MF仕訳ID（1〜14 列）も非表示にしない。
    for (let col = 1; col <= 14; col++) {
      expect(sheet.isColumnHiddenByUser(col)).toBe(false);
    }
  });

  it("システム列に警告付きの範囲保護をかける。2 回実行しても重複しない", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    if (sheet === null) {
      throw new Error("expense ledger sheet missing");
    }

    const protections = sheet.getProtections("RANGE");
    expect(protections).toHaveLength(1);
    expect(protections[0]?.getDescription()).toContain("システム列");
  });

  it("14→24 列への移行後もシステム列が非表示・保護される", () => {
    plantLegacyExpenseLedgerSheet(harness.spreadsheet);
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    if (sheet === null) {
      throw new Error("expense ledger sheet missing");
    }

    expect(sheet.isColumnHiddenByUser(EXPENSE_COL.idempotency_key)).toBe(true);
    expect(sheet.getProtections("RANGE")).toHaveLength(1);
  });
});

describe("経費台帳の型自動変換バグ対策（読み書きラウンドトリップ）", () => {
  it("appendExpense → getExpenseByReceiptId が完全に往復する。日付は Date 化されず文字列のまま", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    const row = makeExpenseRow();
    adapter.appendExpense(row);

    const found = adapter.getExpenseByReceiptId(row.receipt_id);
    expect(found).toEqual(row);

    const sheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    if (sheet === null) {
      throw new Error("expense ledger sheet missing");
    }
    expect(sheet.getCell(2, EXPENSE_COL.date)).toBe("2026-09-01");
    expect(typeof sheet.getCell(2, EXPENSE_COL.date)).toBe("string");
    expect(typeof sheet.getCell(2, EXPENSE_COL.receipt_id)).toBe("string");
    expect(typeof sheet.getCell(2, EXPENSE_COL.idempotency_key)).toBe("string");
    expect(typeof sheet.getCell(2, EXPENSE_COL.file_hash)).toBe("string");
  });

  it("金額・サイズ・事業使用割合・state_updated_at・入力日時は text 化されず数値のまま。それ以外は text 化される", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    if (sheet === null) {
      throw new Error("expense ledger sheet missing");
    }

    expect(sheet.getFormat(2, EXPENSE_COL.amount)).not.toBe(TEXT_FORMAT);
    expect(sheet.getFormat(2, EXPENSE_COL.size)).not.toBe(TEXT_FORMAT);
    expect(sheet.getFormat(2, EXPENSE_COL.business_use_ratio)).not.toBe(TEXT_FORMAT);
    expect(sheet.getFormat(2, EXPENSE_COL.state_updated_at)).not.toBe(TEXT_FORMAT);
    expect(sheet.getFormat(2, EXPENSE_COL.input_at)).not.toBe(TEXT_FORMAT);

    expect(sheet.getFormat(2, EXPENSE_COL.date)).toBe(TEXT_FORMAT);
    expect(sheet.getFormat(2, EXPENSE_COL.receipt_id)).toBe(TEXT_FORMAT);
    expect(sheet.getFormat(2, EXPENSE_COL.file_hash)).toBe(TEXT_FORMAT);
    expect(sheet.getFormat(2, EXPENSE_COL.idempotency_key)).toBe(TEXT_FORMAT);
  });

  it("findExpenseByIdempotencyKey が idempotency_key 列で完全一致検索する", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    adapter.appendExpense(makeExpenseRow({ receipt_id: "R-1", idempotency_key: "KEY-1" }));
    adapter.appendExpense(makeExpenseRow({ receipt_id: "R-2", idempotency_key: "KEY-2" }));

    expect(adapter.findExpenseByIdempotencyKey("KEY-2")?.receipt_id).toBe("R-2");
    expect(adapter.findExpenseByIdempotencyKey("KEY-9")).toBeNull();
  });

  it("updateExpense は対象行だけを部分更新し、パッチ対象外のフィールド・他の行には影響しない", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    adapter.appendExpense(makeExpenseRow({ receipt_id: "R-1" }));
    adapter.appendExpense(makeExpenseRow({ receipt_id: "R-2", partner: "△△商事" }));

    adapter.updateExpense("R-1", { state: "COMPLETED", drive_file_id: "FILE1", state_updated_at: 999 });

    const r1 = adapter.getExpenseByReceiptId("R-1");
    expect(r1?.state).toBe("COMPLETED");
    expect(r1?.drive_file_id).toBe("FILE1");
    expect(r1?.state_updated_at).toBe(999);
    expect(r1?.partner).toBe("○○商店");

    const r2 = adapter.getExpenseByReceiptId("R-2");
    expect(r2?.state).toBe("RECEIVED");
    expect(r2?.partner).toBe("△△商事");
  });

  it("updateExpense は対象行が無ければ例外を投げる", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    expect(() => adapter.updateExpense("R-NOT-FOUND", { state: "ERROR" })).toThrow(/expense_not_found/);
  });

  it("getAllExpenses は挿入順で全行を返す", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    adapter.appendExpense(makeExpenseRow({ receipt_id: "R-1" }));
    adapter.appendExpense(makeExpenseRow({ receipt_id: "R-2" }));

    expect(adapter.getAllExpenses().map((r) => r.receipt_id)).toEqual(["R-1", "R-2"]);
  });

  it("レガシー破損データ（日付が Date 化された行）でも読み取り側で JST 文字列に復元する（対策B）", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    if (sheet === null) {
      throw new Error("expense ledger sheet missing");
    }
    const row = makeExpenseRow();
    const values: unknown[] = [
      row.receipt_id,
      row.receipt_type,
      simulateSheetsCoercion(row.date, "General"), // text 書式適用前に書かれた想定＝ Date 化
      row.amount,
      row.partner,
      row.category,
      row.memo,
      row.drive_link,
      row.file_hash,
      row.mime_type,
      row.size,
      row.input_at,
      row.state,
      "",
      row.idempotency_key,
      row.slack_file_id,
      row.drive_file_id,
      row.original_file_name,
      "",
      row.state_updated_at,
      row.tax_category,
      row.business_use_ratio,
      "",
      "",
    ];
    values.forEach((v, i) => sheet.setCell(2, i + 1, v));
    expect(sheet.getCell(2, EXPENSE_COL.date) instanceof Date).toBe(true);

    const adapter = new SheetsAdapter(SPREADSHEET_ID);
    const found = adapter.getExpenseByReceiptId(row.receipt_id);
    expect(found?.date).toBe("2026-09-01");
  });
});

describe("訂正削除申請シート（事務処理規程・電子取引 第2条、runbook §H.2）", () => {
  it("setupSpreadsheet で「訂正削除申請」シートが 8 列のヘッダー付きで作成される", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(CORRECTION_REQUEST_SHEET);
    expect(sheet).not.toBeNull();

    const header = CORRECTION_REQUEST_HEADERS.map((_, i) => sheet?.getCell(1, i + 1));
    expect(header).toEqual([...CORRECTION_REQUEST_HEADERS]);
  });

  it("2 回実行してもヘッダーが壊れない・重複しない（冪等）", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(CORRECTION_REQUEST_SHEET);
    expect(sheet).not.toBeNull();

    const header = CORRECTION_REQUEST_HEADERS.map((_, i) => sheet?.getCell(1, i + 1));
    expect(header).toEqual([...CORRECTION_REQUEST_HEADERS]);
    // ヘッダー行が 2 回書き足されて増えていないこと（「空なら書く」ガードによる冪等性）。
    expect(sheet?.getLastRow()).toBe(1);
  });

  it("全 8 列に text 書式が適用され、伝票番号・日付列が Date 化・数値化されない", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(CORRECTION_REQUEST_SHEET);
    if (sheet === null) {
      throw new Error("correction request sheet missing");
    }

    for (let col = 1; col <= CORRECTION_REQUEST_HEADERS.length; col++) {
      expect(sheet.getFormat(2, col)).toBe(TEXT_FORMAT);
    }

    // 実機挙動の再現（fakeSpreadsheetApp の coerce）: text 書式が既に適用されたセルに
    // 「取引伝票番号」（証憑ID `R-YYYYMMDD-NNN`）・日付 2 列を書いても Date 化・数値化されない。
    const manualRow = [
      "2026-09-01", // 申請日
      "R-20260901-001", // 取引伝票番号（証憑ID）
      "作業委託費 訂正", // 取引件名
      "○○商事", // 取引先名
      "2026-09-01", // 訂正・削除日付
      "金額誤り 12,000円→11,000円へ訂正", // 訂正・削除内容
      "入力誤り", // 訂正・削除理由
      "竹之内治日", // 処理担当者名
    ];
    sheet.getRange(2, 1, 1, manualRow.length).setValues([manualRow]);

    expect(sheet.getCell(2, 1)).toBe("2026-09-01");
    expect(sheet.getCell(2, 1) instanceof Date).toBe(false);
    expect(sheet.getCell(2, 2)).toBe("R-20260901-001");
    expect(sheet.getCell(2, 5)).toBe("2026-09-01");
    expect(sheet.getCell(2, 5) instanceof Date).toBe(false);
  });

  it("保護（PROTECTED_SHEETS）はかけない。人手で記入するシートのため", () => {
    setupSpreadsheet(SPREADSHEET_ID);
    const sheet = harness.spreadsheet.getSheetByName(CORRECTION_REQUEST_SHEET);
    if (sheet === null) {
      throw new Error("correction request sheet missing");
    }
    expect(sheet.getProtections("SHEET")).toHaveLength(0);
  });

  it("既存 6 シートの生成・経費台帳の 24 列移行に影響しない", () => {
    setupSpreadsheet(SPREADSHEET_ID);

    for (const name of EXISTING_SHEET_NAMES) {
      expect(harness.spreadsheet.getSheetByName(name)).not.toBeNull();
    }

    const expenseSheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    const expenseHeader = EXPENSE_HEADERS_V2.map((_, i) => expenseSheet?.getCell(1, i + 1));
    expect(expenseHeader).toEqual([...EXPENSE_HEADERS_V2]);

    const rawLog = harness.spreadsheet.getSheetByName(RAW_LOG_SHEET);
    expect(rawLog?.getFormat(2, COL.business_date)).toBe(TEXT_FORMAT);
  });

  it("MVP の 14 列から 24 列への経費台帳マイグレーションと共存しても壊れない", () => {
    plantLegacyExpenseLedgerSheet(harness.spreadsheet);

    expect(() => setupSpreadsheet(SPREADSHEET_ID)).not.toThrow();

    const expenseSheet = harness.spreadsheet.getSheetByName(EXPENSE_SHEET);
    const expenseHeader = EXPENSE_HEADERS_V2.map((_, i) => expenseSheet?.getCell(1, i + 1));
    expect(expenseHeader).toEqual([...EXPENSE_HEADERS_V2]);

    const correctionSheet = harness.spreadsheet.getSheetByName(CORRECTION_REQUEST_SHEET);
    expect(correctionSheet).not.toBeNull();
    const header = CORRECTION_REQUEST_HEADERS.map((_, i) => correctionSheet?.getCell(1, i + 1));
    expect(header).toEqual([...CORRECTION_REQUEST_HEADERS]);
  });
});
