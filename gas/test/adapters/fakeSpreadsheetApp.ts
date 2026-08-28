/**
 * 実 Google Sheets の `SpreadsheetApp`/`Spreadsheet`/`Sheet`/`Range`/`TextFinder` を模した
 * 最小フェイク（`gas/src/adapters/sheets.ts` の型自動変換バグ回帰テスト専用）。
 *
 * 目的は「文字列として書いた値が Sheets によって数値・日付へ自動変換される」という実機の
 * 挙動を Node 上で再現すること（実機ログ: `"1787820585.021000"` → `1787820585.021`、
 * `"2026-08-27"` → `Date` オブジェクト）。`setValues` で書き込まれた文字列値は、対象セルの
 * number format が `"@"`（text）でない限り、数値・日付に「見える」パターンにマッチしたら
 * number / Date へ変換して格納する。逆に `setNumberFormat("@")` 済みのセルは変換しない。
 * これにより `sheets.ts` の書き込み側修正（text 書式で自動変換を防ぐ対策）の効果を
 * Node 上でも検証できる。
 *
 * `SpreadsheetApp` 以外の GAS API は `sheets.ts` が使わないため実装しない。
 */

const JST_OFFSET_MS = 9 * 3600 * 1000;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const NUMBER_LIKE_RE = /^-?\d+(\.\d+)?$/;

export const TEXT_FORMAT = "@";
const DEFAULT_FORMAT = "General";

/**
 * Sheets の自動型変換を模した coerce 関数（実機挙動の再現）。`format` が `"@"` なら変換しない。
 * 文字列以外（すでに number/boolean/Date の値）はそのまま返す。テストからも直接呼び、
 * 「既に壊れたデータ」（対策Aが効く前に書かれたレガシー行）を再現するのに使う。
 */
export function simulateSheetsCoercion(value: unknown, format: string = DEFAULT_FORMAT): unknown {
  if (typeof value !== "string" || format === TEXT_FORMAT) {
    return value;
  }
  if (DATE_ONLY_RE.test(value)) {
    const [yearStr, monthStr, dayStr] = value.split("-");
    const y = Number(yearStr);
    const m = Number(monthStr);
    const d = Number(dayStr);
    return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - JST_OFFSET_MS);
  }
  if (DATE_TIME_RE.test(value)) {
    const parts = value.split(" ");
    const [yearStr, monthStr, dayStr] = (parts[0] ?? "").split("-");
    const [hourStr, minuteStr, secondStr] = (parts[1] ?? "").split(":");
    const y = Number(yearStr);
    const m = Number(monthStr);
    const d = Number(dayStr);
    const h = Number(hourStr);
    const mi = Number(minuteStr);
    const s = Number(secondStr);
    return new Date(Date.UTC(y, m - 1, d, h, mi, s, 0) - JST_OFFSET_MS);
  }
  if (NUMBER_LIKE_RE.test(value)) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      return n;
    }
  }
  return value;
}

export class FakeTextFinderMatch {
  constructor(private readonly row: number) {}
  getRow(): number {
    return this.row;
  }
}

export class FakeTextFinder {
  private entireCell = false;

  constructor(
    private readonly range: FakeRange,
    private readonly text: string,
  ) {}

  matchEntireCell(entireCell: boolean): FakeTextFinder {
    this.entireCell = entireCell;
    return this;
  }

  findNext(): FakeTextFinderMatch | null {
    const values = this.range.getValues();
    for (let i = 0; i < values.length; i++) {
      const cell = values[i]?.[0];
      const s = cell === null || cell === undefined ? "" : String(cell);
      const matched = this.entireCell ? s === this.text : s.includes(this.text);
      if (matched) {
        return new FakeTextFinderMatch(this.range.rowAt(i));
      }
    }
    return null;
  }
}

export class FakeRange {
  constructor(
    private readonly sheet: FakeSheet,
    private readonly row: number,
    private readonly col: number,
    private readonly numRows: number,
    private readonly numCols: number,
  ) {}

  /** レンジ内の相対行 `offset`（0-based）に対応するシート絶対行番号（1-based）。 */
  rowAt(offset: number): number {
    return this.row + offset;
  }

  getValues(): unknown[][] {
    const out: unknown[][] = [];
    for (let r = 0; r < this.numRows; r++) {
      const rowArr: unknown[] = [];
      for (let c = 0; c < this.numCols; c++) {
        rowArr.push(this.sheet.getCell(this.row + r, this.col + c));
      }
      out.push(rowArr);
    }
    return out;
  }

  setValues(values: unknown[][]): FakeRange {
    for (let r = 0; r < this.numRows; r++) {
      const rowValues = values[r] ?? [];
      for (let c = 0; c < this.numCols; c++) {
        const format = this.sheet.getFormat(this.row + r, this.col + c);
        this.sheet.setCell(this.row + r, this.col + c, simulateSheetsCoercion(rowValues[c], format));
      }
    }
    return this;
  }

  setNumberFormat(format: string): FakeRange {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) {
        this.sheet.setFormat(this.row + r, this.col + c, format);
      }
    }
    return this;
  }

  createTextFinder(text: string): FakeTextFinder {
    return new FakeTextFinder(this, text);
  }
}

export interface FakeProtection {
  setDescription(description: string): FakeProtection;
  setWarningOnly(warningOnly: boolean): FakeProtection;
}

export class FakeSheet {
  readonly name: string;
  private readonly cells = new Map<string, unknown>();
  private readonly formats = new Map<string, string>();
  private lastRow = 0;
  private lastCol = 0;
  private maxRows: number;
  private readonly protections: FakeProtection[] = [];

  constructor(name: string, initialMaxRows = 1000) {
    this.name = name;
    this.maxRows = initialMaxRows;
  }

  private key(row: number, col: number): string {
    return `${row}:${col}`;
  }

  /** テスト専用: レンジ API を経由せずセルへ直接値を置く（レガシー破損データの再現用）。 */
  getCell(row: number, col: number): unknown {
    return this.cells.get(this.key(row, col)) ?? "";
  }

  setCell(row: number, col: number, value: unknown): void {
    this.cells.set(this.key(row, col), value);
    if (row > this.lastRow) {
      this.lastRow = row;
    }
    if (col > this.lastCol) {
      this.lastCol = col;
    }
    if (row > this.maxRows) {
      this.maxRows = row;
    }
  }

  getFormat(row: number, col: number): string {
    return this.formats.get(this.key(row, col)) ?? DEFAULT_FORMAT;
  }

  setFormat(row: number, col: number, format: string): void {
    this.formats.set(this.key(row, col), format);
    if (row > this.maxRows) {
      this.maxRows = row;
    }
  }

  getLastRow(): number {
    return this.lastRow;
  }

  getLastColumn(): number {
    return this.lastCol;
  }

  getMaxRows(): number {
    return this.maxRows;
  }

  getRange(row: number, col: number, numRows = 1, numCols = 1): FakeRange {
    return new FakeRange(this, row, col, numRows, numCols);
  }

  /** 実 GAS の `appendRow` 相当（sheets.ts はもう使わないが、参考実装として用意しておく）。 */
  appendRow(values: unknown[]): void {
    const rowIndex = this.lastRow + 1;
    this.getRange(rowIndex, 1, 1, values.length).setValues([values]);
  }

  getProtections(_type: unknown): FakeProtection[] {
    return this.protections;
  }

  protect(): FakeProtection {
    const protection: FakeProtection = {
      setDescription: () => protection,
      setWarningOnly: () => protection,
    };
    this.protections.push(protection);
    return protection;
  }
}

export class FakeSpreadsheet {
  private readonly sheets = new Map<string, FakeSheet>();

  getSheetByName(name: string): FakeSheet | null {
    return this.sheets.get(name) ?? null;
  }

  insertSheet(name: string): FakeSheet {
    const sheet = new FakeSheet(name);
    this.sheets.set(name, sheet);
    return sheet;
  }
}

export interface FakeSpreadsheetAppGlobal {
  openById(id: string): FakeSpreadsheet;
  ProtectionType: { SHEET: string };
}

function makeFakeSpreadsheetApp(): { app: FakeSpreadsheetAppGlobal; spreadsheet: FakeSpreadsheet } {
  const spreadsheet = new FakeSpreadsheet();
  const app: FakeSpreadsheetAppGlobal = {
    openById: () => spreadsheet,
    ProtectionType: { SHEET: "SHEET" },
  };
  return { app, spreadsheet };
}

/**
 * `globalThis.SpreadsheetApp` にフェイクをインストールする。`gas/src/adapters/sheets.ts` は
 * GAS のグローバル `SpreadsheetApp` を直接参照するため、Node/Vitest 上で動かすにはテスト側で
 * このグローバルを用意する必要がある。返り値の `restore()` で元に戻す（他テストへの汚染防止。
 * `afterEach` などで必ず呼ぶこと）。
 */
export function installFakeSpreadsheetApp(): {
  spreadsheet: FakeSpreadsheet;
  restore: () => void;
} {
  const { app, spreadsheet } = makeFakeSpreadsheetApp();
  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const previous = globalRecord.SpreadsheetApp;
  globalRecord.SpreadsheetApp = app;
  return {
    spreadsheet,
    restore: () => {
      globalRecord.SpreadsheetApp = previous;
    },
  };
}
