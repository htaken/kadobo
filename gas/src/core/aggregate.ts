/**
 * 日次・月次集計（実装設計 §7.3、要件定義 §4.2.2, §4.2.3, §4.2.4）。純関数のみ。
 */

import { formatJst } from "@kadobo/shared/time";
import { applyCorrections } from "./correction";
import { isStampEvent, transition, type EventType, type LoggedEvent, type State } from "./state";

/** 日次集計のステータス（要件定義 §4.2.1「日次集計」シート）。 */
export type DailyStatus = "OK" | "要修正" | "進行中";

/** 1 セッション分の集計結果。 */
export interface SessionSummary {
  session_no: number;
  /** UTC epoch ms。 */
  start_at: number;
  /**
   * 実効終了時刻（UTC epoch ms）。休憩中に `END` された場合は直前 `BREAK_START` の時刻
   * （実装設計 §7.2）。まだ稼働中／休憩中で当日進行中のセッションは `null`。
   */
  end_at: number | null;
  /** このセッション内で確定した休憩秒（開いたままの休憩は含めない。実効終了で 0 秒になる分は含む）。 */
  break_seconds: number;
  /** `end_at === null` のときは `null`（算出不能）。 */
  worked_seconds: number | null;
}

/** 業務日 1 日分の集計結果。 */
export interface DailySummary {
  status: DailyStatus;
  /** 当日に開始された（有効な）セッション数。 */
  session_count: number;
  /** JST `YYYY-MM-DD HH:mm:ss`。イベントが 1 件も無ければ `null`。 */
  first_start_jst: string | null;
  /** JST `YYYY-MM-DD HH:mm:ss`。完了したセッションが 1 つも無ければ `null`。 */
  last_end_jst: string | null;
  /** 当日合計の休憩秒（確定分のみ）。 */
  break_seconds: number;
  /** `status !== 'OK'` のときは `null`（要件定義 §4.2.1: 要修正・進行中の行は worked_* を空にする）。 */
  worked_seconds: number | null;
  /** `worked_seconds` が算出できるときのみ `floor(worked_seconds/60)`。それ以外は `null`。 */
  worked_minutes: number | null;
  /** 当日に適用された `CORRECTION` の件数。 */
  correction_count: number;
  /** セッション明細（カード表示等に利用。`status` に関わらず算出できた分を返す）。 */
  sessions: SessionSummary[];
  /** 要修正の理由等（任意）。 */
  note: string | null;
}

interface OpenBreak {
  start_at: number;
  end_at: number | null;
}

interface OpenSession {
  session_no: number;
  start_at: number;
  breaks: OpenBreak[];
}

function finalizeSession(session: OpenSession, effectiveEnd: number): SessionSummary {
  let breakSeconds = 0;
  for (const b of session.breaks) {
    const end = b.end_at ?? effectiveEnd;
    breakSeconds += Math.max(0, (end - b.start_at) / 1000);
  }
  const workedSeconds = (effectiveEnd - session.start_at) / 1000 - breakSeconds;
  return {
    session_no: session.session_no,
    start_at: session.start_at,
    end_at: effectiveEnd,
    break_seconds: breakSeconds,
    worked_seconds: workedSeconds,
  };
}

function openSessionSummary(session: OpenSession): SessionSummary {
  let breakSeconds = 0;
  for (const b of session.breaks) {
    if (b.end_at !== null) {
      breakSeconds += Math.max(0, (b.end_at - b.start_at) / 1000);
    }
  }
  return {
    session_no: session.session_no,
    start_at: session.start_at,
    end_at: null,
    break_seconds: breakSeconds,
    worked_seconds: null,
  };
}

interface PairingResult {
  sessions: SessionSummary[];
  sessionCount: number;
  /** 遷移表に無い遷移（順序矛盾・単独 BREAK_END・単独 END 等）に当たったら true。 */
  structurallyBroken: boolean;
  /** 最終状態が `WORKING`/`ON_BREAK`（未終了のセッションが残っている）なら true。 */
  openAtEnd: boolean;
}

/**
 * 訂正適用・時刻順ソート済みの打刻イベント列を状態機械に沿って再生し、セッションへ対応付ける
 * （実装設計 §7.3 手順2〜4）。
 */
function pairDay(sortedStampEvents: (LoggedEvent & { event_type: EventType })[]): PairingResult {
  let state: State = "IDLE";
  let sessionCounter = 0;
  const sessions: SessionSummary[] = [];
  let current: OpenSession | null = null;

  for (const event of sortedStampEvents) {
    const next = transition(state, event.event_type);
    if (next === null) {
      if (current !== null) {
        sessions.push(openSessionSummary(current));
      }
      return {
        sessions,
        sessionCount: sessionCounter,
        structurallyBroken: true,
        openAtEnd: state === "WORKING" || state === "ON_BREAK",
      };
    }

    switch (event.event_type) {
      case "START": {
        sessionCounter += 1;
        current = { session_no: sessionCounter, start_at: event.occurred_at, breaks: [] };
        break;
      }
      case "BREAK_START": {
        current!.breaks.push({ start_at: event.occurred_at, end_at: null });
        break;
      }
      case "BREAK_END": {
        const openBreak = current!.breaks[current!.breaks.length - 1]!;
        openBreak.end_at = event.occurred_at;
        break;
      }
      case "END": {
        const effectiveEnd =
          state === "ON_BREAK"
            ? current!.breaks[current!.breaks.length - 1]!.start_at
            : event.occurred_at;
        sessions.push(finalizeSession(current!, effectiveEnd));
        current = null;
        break;
      }
    }
    state = next;
  }

  if (current !== null) {
    sessions.push(openSessionSummary(current));
  }

  return {
    sessions,
    sessionCount: sessionCounter,
    structurallyBroken: false,
    openAtEnd: state === "WORKING" || state === "ON_BREAK",
  };
}

/**
 * 業務日 1 日分を集計する（実装設計 §7.3）。
 *
 * `events` はその業務日に属する生ログ（`CORRECTION` 行を含んでよい。訂正適用は内部で行う）。
 * `isToday`: この業務日が「当日」（＝まだ記録が続き得る日）かどうか。過去日で未終了なら
 * `要修正`、当日で未終了なら `進行中` になる。
 */
export function aggregateDay(
  events: LoggedEvent[],
  opts: { isToday: boolean },
): DailySummary {
  const correctionCount = events.filter((e) => e.event_type === "CORRECTION").length;
  const corrected = applyCorrections(events).filter(isStampEvent);
  const sorted = [...corrected].sort((a, b) => a.occurred_at - b.occurred_at);

  const pairing = pairDay(sorted);

  let status: DailyStatus;
  let workedSeconds: number | null;
  let note: string | null = null;

  if (pairing.structurallyBroken) {
    status = "要修正";
    workedSeconds = null;
    note = "イベントの順序が不整合、または対応しないイベントがあります";
  } else if (pairing.openAtEnd) {
    if (opts.isToday) {
      status = "進行中";
      workedSeconds = null;
    } else {
      status = "要修正";
      workedSeconds = null;
      note = "終了（END）が記録されていません";
    }
  } else {
    status = "OK";
    workedSeconds = pairing.sessions.reduce((sum, s) => sum + (s.worked_seconds ?? 0), 0);
  }

  const workedMinutes = workedSeconds === null ? null : Math.floor(workedSeconds / 60);
  const breakSecondsTotal = pairing.sessions.reduce((sum, s) => sum + s.break_seconds, 0);

  const firstStart = sorted[0];
  const closedSessions = pairing.sessions.filter((s) => s.end_at !== null);
  const lastClosed = closedSessions[closedSessions.length - 1];

  return {
    status,
    session_count: pairing.sessionCount,
    first_start_jst: firstStart !== undefined ? formatJst(firstStart.occurred_at) : null,
    last_end_jst: lastClosed !== undefined ? formatJst(lastClosed.end_at as number) : null,
    break_seconds: breakSecondsTotal,
    worked_seconds: workedSeconds,
    worked_minutes: workedMinutes,
    correction_count: correctionCount,
    sessions: pairing.sessions,
    note,
  };
}

// ---------------------------------------------------------------------------
// 月次（単価計算）
// ---------------------------------------------------------------------------

/** 端数処理の方式（要件定義 §4.2.3、実装設計 §7.1 単価マスタ）。 */
export type Rounding = "切捨" | "四捨五入" | "切上";

/** 源泉徴収区分（実装設計 §7.1 単価マスタ）。率はここに列挙された 2 値のみ。 */
export type Withholding = "なし" | "10.21%";

/** 税区分（要件定義 §4.2.3、実装設計 §7.1 単価マスタ）。 */
export type TaxCategory = "課税" | "不課税";

/** 単価マスタの 1 行（実装設計 §7.1）。 */
export interface UnitPriceRow {
  client: string;
  unit_price: number;
  tax_category: TaxCategory;
  tax_inclusive: boolean;
  tax_display: "区分記載" | "内税" | "なし";
  rounding: Rounding;
  withholding: Withholding;
  /** `YYYY-MM-DD`。 */
  valid_from: string;
  /** `YYYY-MM-DD`。空文字・`null` は無期限。 */
  valid_to: string | null;
}

/**
 * MVP で仮定する消費税相当額の税率（標準税率 10%）。
 *
 * 要件定義 §7 の未確認事項 6・7（消費税相当額の請求可否・記載方法、課税/免税の確認）が
 * A社・税理士との確認待ちのため、design doc（実装設計 §7.3 手順6）には具体的な税率の記載が
 * 無い。本 MVP 実装では「課税」区分のとき標準税率 10% を仮定して `tax_amount` を計算する
 * （`tax_inclusive`/`tax_display` は現時点では計算に用いず、記録・表示用のメタ情報として
 * 単価マスタに保持するのみ）。要確認・要修正の可能性がある点は最終報告に明記する。
 */
export const ASSUMED_CONSUMPTION_TAX_RATE = 0.1;

/** 源泉徴収率（`withholding === '10.21%'` のとき。実装設計 §7.1 単価マスタで明示された値）。 */
export const WITHHOLDING_RATE = 0.1021;

function applyRounding(value: number, rounding: Rounding): number {
  switch (rounding) {
    case "切捨":
      return Math.floor(value);
    case "切上":
      return Math.ceil(value);
    case "四捨五入":
      return Math.round(value);
  }
}

/** 月次請求の集計結果（実装設計 §7.1 月次請求シートの数値列に対応）。 */
export interface MonthlySummary {
  worked_minutes: number;
  /** 小数第 2 位（`Math.round(x*100)/100`）。 */
  hours: number;
  amount: number;
  tax_amount: number;
  withholding_amount: number;
  net_amount: number;
}

/**
 * 日次集計の配列から月次を計算する（実装設計 §7.3 手順6）。
 *
 * `unitMasterRow` は呼び出し側が {@link selectUnitPrice} 等で事前に選択した、当月に適用する
 * 単価マスタの 1 行。`dailySummaries` は `worked_minutes` が `null` の日（要修正・進行中）を
 * 含んでいても構わないが、それらは合計に寄与しない（`0` として扱う）。月次締め前チェック
 * （要修正が無いこと）は呼び出し側の責務。
 */
export function aggregateMonth(
  dailySummaries: DailySummary[],
  unitMasterRow: UnitPriceRow,
): MonthlySummary {
  const workedMinutes = dailySummaries.reduce(
    (sum, d) => sum + (d.worked_minutes ?? 0),
    0,
  );
  const hours = Math.round((workedMinutes / 60) * 100) / 100;
  const amount = applyRounding(hours * unitMasterRow.unit_price, unitMasterRow.rounding);

  const taxAmount =
    unitMasterRow.tax_category === "課税"
      ? applyRounding(amount * ASSUMED_CONSUMPTION_TAX_RATE, unitMasterRow.rounding)
      : 0;

  const withholdingAmount =
    unitMasterRow.withholding === "10.21%"
      ? applyRounding(amount * WITHHOLDING_RATE, unitMasterRow.rounding)
      : 0;

  const netAmount = amount + taxAmount - withholdingAmount;

  return {
    worked_minutes: workedMinutes,
    hours,
    amount,
    tax_amount: taxAmount,
    withholding_amount: withholdingAmount,
    net_amount: netAmount,
  };
}

export type UnitPriceSelection = UnitPriceRow | { error: "NOT_FOUND" | "MULTIPLE_MATCHES" };

/**
 * 業務日時点で有効な単価マスタ行を選ぶ（要件定義 §4.2.3、実装設計 §7.1）。
 * `valid_from <= businessDate <= valid_to`（`valid_to` が空/`null` なら無期限）。
 * 該当無し・複数該当はエラー。
 */
export function selectUnitPrice(
  rows: UnitPriceRow[],
  businessDate: string,
): UnitPriceSelection {
  const matches = rows.filter(
    (r) =>
      r.valid_from <= businessDate &&
      (r.valid_to === null || r.valid_to === "" || r.valid_to >= businessDate),
  );
  if (matches.length === 0) {
    return { error: "NOT_FOUND" };
  }
  if (matches.length > 1) {
    return { error: "MULTIPLE_MATCHES" };
  }
  return matches[0]!;
}
