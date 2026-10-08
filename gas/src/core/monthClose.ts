/**
 * 月次締めの状態機械（実装設計 MF連携 §5.1）。純関数のみ。
 *
 * 「締めの状態」（`月次請求.state`）と「請求書作成の進み具合」（`invoice_state`）を分ける。
 * MF の呼び出しが失敗しても、締めの状態（`state`）は凍結されたまま変わらない。
 */

/**
 * 締めの状態（`月次請求.state`）。要件定義 §4.2.4 の `APPROVED` は削除した（実装設計 §5.1）:
 * 送付判断は MF 画面で人が行い、kadobo が観測できるのは送付の結果（`SENT`）だけのため。
 *
 * ```
 * OPEN ⇄ REVIEWING ──[締める]──▶ LOCKED ──▶ MF_CREATED ──▶ SENT ──▶ PAID
 *                                  └───────────────────────────────▶ PAID（送付を経ず入金）
 * VOID: 人手のみ（シート編集）。
 * ```
 */
export type MonthCloseState =
  | "OPEN"
  | "REVIEWING"
  | "LOCKED"
  | "MF_CREATED"
  | "SENT"
  | "PAID"
  | "VOID";

/**
 * 請求書の進み具合（`invoice_state`）。`LOCKED` 以降だけ意味を持つ。空文字列は未締め
 * （`state` が `OPEN`/`REVIEWING` の間）を表す。
 *
 * - `MANUAL`: 締めた時点で `MF_INVOICE_ENABLED` が無効だった。kadobo は作らない（B7）。
 * - `PENDING`: 作成待ち。
 * - `UNKNOWN`: 作成の POST の結果が分からない（回収だけ行い、作り直さない）。
 * - `CREATED`: 作成済み・金額一致。
 * - `MISMATCH`: 作成済みだが金額が一致しない。
 * - `ERROR`: 業務エラー（作られていない）。
 */
export type InvoiceState = "" | "MANUAL" | "PENDING" | "UNKNOWN" | "CREATED" | "MISMATCH" | "ERROR";

/** `isMonthFrozen` が `true` を返す状態（実装設計 §5.1 の表）。 */
const FROZEN_STATES: readonly string[] = ["LOCKED", "MF_CREATED", "SENT", "PAID", "VOID"];

/**
 * 月次行が凍結済み（金額を固定し、集計・訂正の対象外にする）かどうか（実装設計 §5.1）。
 *
 * `recomputeMonthly`（`app/monthly.ts`）と `correction_submit` の凍結判定
 * （`app/correction.ts`）はどちらもこの関数を使う。`LOCKED` だけを見ていた旧実装では、
 * 請求書を作成した後（`MF_CREATED`）の月に訂正が通り、請求書とシートの金額がずれる
 * 不具合があった（実装設計 §5.1 の必須修正）。
 */
export function isMonthFrozen(state: string): boolean {
  return FROZEN_STATES.includes(state);
}

/**
 * 締め確認の評価（`evaluateMonthClose` から呼ぶ。実装設計 §5.1 の状態遷移表）。
 * `OPEN` かつ blockers 無し → `REVIEWING`。`REVIEWING` かつ blockers あり → `OPEN`。
 * それ以外（`LOCKED` 以降・`VOID` 等）は変えない。
 */
export function nextStateOnEvaluate(state: MonthCloseState, hasBlockers: boolean): MonthCloseState {
  if (state === "OPEN" && !hasBlockers) {
    return "REVIEWING";
  }
  if (state === "REVIEWING" && hasBlockers) {
    return "OPEN";
  }
  return state;
}

/** `GET /billings/{id}` の応答を正規化した結果（実装設計 §5.7、`normalizeBillingStatus` が作る）。 */
export interface NormalizedBillingStatus {
  sent: boolean;
  paid: boolean;
}

/**
 * 送付・入金の追跡（`trackBillingStatus` から呼ぶ。WP-M3 で使うが、純関数なので状態機械の一部
 * として WP-M2 のうちに定義・テストする。実装設計 §5.1）。
 *
 * `MF_CREATED` かつ入金済み → `PAID`（送付を経ずに入金済みになった場合も `PAID`。入金判定を
 * 送付判定より先に見る）。`MF_CREATED` かつ送付済み（未入金）→ `SENT`。
 * `SENT` かつ入金済み → `PAID`。それ以外は変えない。
 */
export function nextStateOnBillingStatus(
  state: MonthCloseState,
  billing: NormalizedBillingStatus,
): MonthCloseState {
  if (state === "MF_CREATED") {
    if (billing.paid) {
      return "PAID";
    }
    if (billing.sent) {
      return "SENT";
    }
    return state;
  }
  if (state === "SENT" && billing.paid) {
    return "PAID";
  }
  return state;
}
