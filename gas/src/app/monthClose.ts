/**
 * 月次締め（実装設計 MF連携 §5.1〜§5.3, §5.8）。
 *
 * `evaluateMonthClose`: `trigMonthly`（毎月1日）と `trigMfSync`（毎時）から呼ばれる。対象月を
 * 集計し直し、状態機械（`core/monthClose.ts`）に従って `state` を進め、締め確認カードを
 * 投稿・描き直しする。MF は一切呼ばない（M9）。
 *
 * `handleMonthClose`: 締め確認カードの `[締めて請求書を作成]` ボタン（`month_close` ペイロード）
 * の処理。`dispatch.ts` の `routeRequest` から `withLock` の中で呼ばれる。ここでも MF は呼ばない
 * （請求書の作成はトリガー側 `trigMfSyncSoon`／WP-M3 の `ensureInvoiceCreated` に寄せる）。
 */
import { businessDateOf } from "@kadobo/shared/time";
import type { GasRequest, GasResponse } from "@kadobo/shared/protocol";
import {
  renderMonthCloseBlockedCard,
  renderMonthCloseCard,
  renderMonthCloseInvoiceStatusCard,
  renderMonthCloseLockedCard,
  type MonthCloseCardInput,
} from "../core/card";
import { DEFAULT_EXTRA_HOLIDAYS, dueDateOf } from "../core/invoice";
import { isMonthFrozen, nextStateOnEvaluate, type InvoiceState, type MonthCloseState } from "../core/monthClose";
import { lastDayOfMonthStr, monthsInRange } from "./dateUtil";
import { isInvoiceEnabled } from "./mf/flags";
import { recomputeMonthly } from "./monthly";
import type { AppPorts, MonthlyBillRow } from "./ports";

type MonthCloseRequest = Extract<GasRequest, { kind: "month_close" }>;

/**
 * 対象月に締め判定を阻むもの（blockers）があるか（実装設計 §5.1 末尾）。
 * 「対象月の日次集計に `要修正` か `進行中` がある」、または
 * 「`recomputeMonthly` が単価エラーを `note` に書いた」。
 */
export function hasMonthBlockers(bill: MonthlyBillRow, ports: AppPorts): boolean {
  const fromDate = `${bill.month}-01`;
  const toDate = lastDayOfMonthStr(bill.month);
  const summaries = ports.sheets.getDailySummariesInRange(fromDate, toDate);
  if (summaries.some((s) => s.status === "要修正" || s.status === "進行中")) {
    return true;
  }
  return bill.note !== null && bill.note !== "";
}

/**
 * `MF_EXTRA_HOLIDAYS`（`MM-DD` のカンマ区切り）。未設定・空なら既定値（実装設計 §5.6）。
 * `app/invoice.ts`（WP-M3 の `ensureInvoiceCreated`）も同じ支払期日計算に使うため export する
 * （休日設定のパース処理を 2 箇所に重複させないため）。
 */
export function extraHolidaysOf(ports: AppPorts): readonly string[] {
  const raw = ports.props.get("MF_EXTRA_HOLIDAYS");
  if (raw === null || raw.trim() === "") {
    return DEFAULT_EXTRA_HOLIDAYS;
  }
  const parsed = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return parsed.length > 0 ? parsed : DEFAULT_EXTRA_HOLIDAYS;
}

function reviewingCardBlocks(bill: MonthlyBillRow, ports: AppPorts, amountChanged: boolean): object[] {
  const input: MonthCloseCardInput = {
    client: bill.client,
    month: bill.month,
    hours: bill.hours,
    unit_price: bill.unit_price,
    amount: bill.amount,
    tax_amount: bill.tax_amount,
    withholding_amount: bill.withholding_amount,
    net_amount: bill.net_amount,
    due_date: dueDateOf(bill.month, (d) => ports.calendar.isHoliday(d), extraHolidaysOf(ports)),
    invoiceEnabled: isInvoiceEnabled(ports.props),
    amountChanged,
  };
  return renderMonthCloseCard(input);
}

function fallbackText(month: string): string {
  return `📅 ${month} 分の締め確認`;
}

/** カードを新規投稿する（ベストエフォート。失敗したら `null` を返し、例外は投げない）。 */
function postCard(ports: AppPorts, channelId: string, month: string, blocks: object[]): string | null {
  try {
    const posted = ports.slack.postMessage({ channel: channelId, text: fallbackText(month), blocks });
    return posted.ts;
  } catch (e) {
    console.error("monthClose postCard failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
    return null;
  }
}

/** 既存カードを描き直す（ベストエフォート。失敗しても例外を投げない）。 */
function updateCard(ports: AppPorts, channelId: string, ts: string, month: string, blocks: object[]): void {
  try {
    ports.slack.update({ channel: channelId, ts, text: fallbackText(month), blocks });
  } catch (e) {
    console.error("monthClose updateCard failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)));
  }
}

function hasCard(bill: MonthlyBillRow): bill is MonthlyBillRow & { close_card_ts: string } {
  return bill.close_card_ts !== null && bill.close_card_ts !== "";
}

// ---------------------------------------------------------------------------
// evaluateMonthClose（実装設計 §5.2）
// ---------------------------------------------------------------------------

/**
 * カードの表示に影響する数値列（実装設計 §5.2 のコーディネーターレビュー指摘対応）。
 * これらと `state` のどちらも変わっていなければ、カードの内容は前回描いたものと同じになる
 * ため `chat.update` を呼ばない（毎時のトリガーで変化が無いのに「編集済み」表示が積み重なる
 * のを防ぐ）。
 */
const NUMERIC_DISPLAY_KEYS = [
  "hours",
  "unit_price",
  "amount",
  "tax_amount",
  "withholding_amount",
  "net_amount",
] as const satisfies readonly (keyof MonthlyBillRow)[];

function displayNumbersChanged(before: MonthlyBillRow, after: MonthlyBillRow): boolean {
  return NUMERIC_DISPLAY_KEYS.some((key) => before[key] !== after[key]);
}

interface EvaluateOneResult {
  bill: MonthlyBillRow;
  /**
   * この評価で `state` または表示用の数値列が変わったか。`false` なら（カードが既にあれば）
   * 描き直しをスキップする。行が新規作成された場合は常に `true`。
   */
  changed: boolean;
}

/**
 * 1 か月分の「再集計 → 状態の判定 → 書込み」を 1 回の短いスクリプトロックの中で行う
 * （実装設計 §5.2, B1）。ロックの外でカードの投稿・描き直しを行う。
 */
function evaluateOneMonth(client: string, month: string, ports: AppPorts): EvaluateOneResult | null {
  return ports.lock.withLock<EvaluateOneResult | null>(() => {
    const before = ports.sheets.getMonthlyBill(client, month);
    recomputeMonthly(client, month, ports);
    const current = ports.sheets.getMonthlyBill(client, month);
    if (current === null) {
      return null;
    }
    const blockers = hasMonthBlockers(current, ports);
    const nextState = nextStateOnEvaluate(current.state as MonthCloseState, blockers);
    if (nextState !== current.state) {
      ports.sheets.updateMonthlyBillColumns(client, month, { state: nextState });
    }
    const changed =
      before === null || nextState !== before.state || displayNumbersChanged(before, current);
    return { bill: { ...current, state: nextState }, changed };
  });
}

/**
 * ロックの外: `REVIEWING` ならカードを投稿／描き直し、`OPEN` に戻っていれば既存カードを警告に
 * 描き直す。カードが既にある場合、`state`・表示数値のどちらも変わっていなければ
 * `chat.update` を呼ばない（`result.changed` が `false`）。カード未投稿（`close_card_ts` 空）の
 * `REVIEWING` は変化の有無によらず投稿する。
 */
function redrawAfterEvaluate(client: string, month: string, result: EvaluateOneResult, ports: AppPorts): void {
  const { bill, changed } = result;
  const channelId = ports.props.get("SLACK_CHANNEL_ID");
  if (channelId === null) {
    return;
  }

  if (bill.state === "REVIEWING") {
    if (!hasCard(bill)) {
      const blocks = reviewingCardBlocks(bill, ports, false);
      const ts = postCard(ports, channelId, month, blocks);
      if (ts !== null) {
        ports.lock.withLock(() => {
          ports.sheets.updateMonthlyBillColumns(client, month, { close_card_ts: ts });
        });
      }
      return;
    }
    if (!changed) {
      return;
    }
    const blocks = reviewingCardBlocks(bill, ports, false);
    updateCard(ports, channelId, bill.close_card_ts as string, month, blocks);
    return;
  }

  if (bill.state === "OPEN" && hasCard(bill)) {
    if (!changed) {
      return;
    }
    updateCard(
      ports,
      channelId,
      bill.close_card_ts as string,
      month,
      renderMonthCloseBlockedCard({ client, month }),
    );
  }
}

/**
 * 締め確認の評価（実装設計 §5.2）。`MF_BILLING_START_MONTH` 以降・当月より前で `state` が
 * `OPEN`・`REVIEWING` のすべての月を対象にする（締め忘れが翌々月まで続いても拾う）。
 * `MF_BILLING_START_MONTH` が未設定なら何もしない。`client` は `CLIENT_DEFAULT`（既定 `A社`）。
 */
export function evaluateMonthClose(ports: AppPorts): void {
  const startMonth = ports.props.get("MF_BILLING_START_MONTH");
  if (startMonth === null || startMonth === "") {
    return;
  }
  const client = ports.props.get("CLIENT_DEFAULT") ?? "A社";
  const currentMonth = businessDateOf(ports.clock.nowMs()).slice(0, 7);

  for (const month of monthsInRange(startMonth, currentMonth)) {
    const before = ports.sheets.getMonthlyBill(client, month);
    if (before !== null && before.state !== "OPEN" && before.state !== "REVIEWING") {
      continue;
    }

    const result = evaluateOneMonth(client, month, ports);
    if (result === null) {
      continue;
    }
    redrawAfterEvaluate(client, month, result, ports);
  }
}

// ---------------------------------------------------------------------------
// handleMonthClose（実装設計 §5.3）
// ---------------------------------------------------------------------------

type CloseOutcome =
  | { kind: "NOT_READY" }
  | { kind: "BLOCKED"; bill: MonthlyBillRow }
  | { kind: "AMOUNT_CHANGED"; bill: MonthlyBillRow }
  | { kind: "LOCKED"; bill: MonthlyBillRow };

/**
 * 🔄 ここでは `ports.lock.withLock` を**呼ばない**。`handleMonthClose` は `dispatch.ts` の
 * `routeRequest` が既に `withLock` で包んだ中から呼ばれる（実装設計 §5.3 冒頭）。
 * `LockPort.withLock` は入れ子にできない（`adapters/lock.ts`・`app/dispatch.ts` の注記と同じ理由）
 * ため、ここで二重にロックを取ると `LockTimeoutError`（フェイクは即座に、実 GAS は
 * `tryLock` のタイムアウト後に）になる。`evaluateOneMonth`（トリガー起点、外側にロックが無い）
 * とはこの点だけが違う。
 */
function closeOneMonth(req: MonthCloseRequest, ports: AppPorts): CloseOutcome {
  recomputeMonthly(req.client, req.month, ports);
  const current = ports.sheets.getMonthlyBill(req.client, req.month);
  if (current === null) {
    return { kind: "NOT_READY" };
  }
  if (hasMonthBlockers(current, ports)) {
    ports.sheets.updateMonthlyBillColumns(req.client, req.month, { state: "OPEN" });
    return { kind: "BLOCKED", bill: { ...current, state: "OPEN" } };
  }
  if (current.net_amount !== req.shown_net_amount) {
    return { kind: "AMOUNT_CHANGED", bill: current };
  }
  const invoiceState: InvoiceState = isInvoiceEnabled(ports.props) ? "PENDING" : "MANUAL";
  const patch: Partial<MonthlyBillRow> = {
    state: "LOCKED",
    locked_at: ports.clock.nowMs(),
    invoice_state: invoiceState,
  };
  ports.sheets.updateMonthlyBillColumns(req.client, req.month, patch);
  return { kind: "LOCKED", bill: { ...current, ...patch } };
}

/**
 * 既に凍結済み（DUPLICATE）のときの再描画。`LOCKED` は {@link renderMonthCloseLockedCard}、
 * `MF_CREATED`/`SENT`/`PAID`（WP-M3）は {@link renderMonthCloseInvoiceStatusCard} を使う。
 * `VOID` は人手のみ（実装設計 §5.1）のため描き直さない。
 */
function redrawFrozenCard(req: MonthCloseRequest, bill: MonthlyBillRow, ports: AppPorts): void {
  if (!hasCard(bill)) {
    return;
  }
  if (bill.state === "LOCKED") {
    const invoiceState: "MANUAL" | "PENDING" = bill.invoice_state === "PENDING" ? "PENDING" : "MANUAL";
    updateCard(
      ports,
      req.channel_id,
      bill.close_card_ts as string,
      req.month,
      renderMonthCloseLockedCard({ client: req.client, month: req.month, invoiceState }),
    );
    return;
  }
  if (bill.state === "MF_CREATED" || bill.state === "SENT" || bill.state === "PAID") {
    updateCard(
      ports,
      req.channel_id,
      bill.close_card_ts as string,
      req.month,
      renderMonthCloseInvoiceStatusCard({
        client: req.client,
        month: req.month,
        state: bill.state,
        invoiceState: bill.invoice_state,
      }),
    );
  }
}

/**
 * `[締めて請求書を作成]` の処理（実装設計 §5.3 手順1〜6）。`dispatch.ts` の `routeRequest` から
 * 既に `withLock` で包まれた中で呼ばれる（この関数自身・`closeOneMonth` はロックを取らない。
 * `evaluateOneMonth` とはその点だけが異なる）。読み・判定・書込みはすべてこの 1 回のロックの
 * 中で行われ、Slack へのカード投稿・更新はロックを気にせず行ってよい（Slack 呼出しの遅延は
 * ここでは問題にならない。§5.3 の応答は数秒で終わる想定）。
 */
export function handleMonthClose(req: MonthCloseRequest, ports: AppPorts): GasResponse {
  const bill = ports.sheets.getMonthlyBill(req.client, req.month);
  if (bill === null) {
    return { ok: true, applied: false, reason: "NOT_READY" };
  }

  if (isMonthFrozen(bill.state)) {
    redrawFrozenCard(req, bill, ports);
    return { ok: true, applied: false, reason: "DUPLICATE" };
  }

  if (bill.state === "OPEN") {
    return { ok: true, applied: false, reason: "NOT_READY" };
  }

  // 残る可能性は state === "REVIEWING" のみ。
  if (req.message_ts !== bill.close_card_ts) {
    return { ok: true, applied: false, reason: "STALE_CARD" };
  }

  const outcome = closeOneMonth(req, ports);

  switch (outcome.kind) {
    case "NOT_READY":
      return { ok: true, applied: false, reason: "NOT_READY" };

    case "BLOCKED": {
      if (hasCard(outcome.bill)) {
        updateCard(
          ports,
          req.channel_id,
          outcome.bill.close_card_ts as string,
          req.month,
          renderMonthCloseBlockedCard({ client: req.client, month: req.month }),
        );
      }
      return { ok: true, applied: false, reason: "BLOCKED" };
    }

    case "AMOUNT_CHANGED": {
      if (hasCard(outcome.bill)) {
        updateCard(
          ports,
          req.channel_id,
          outcome.bill.close_card_ts as string,
          req.month,
          reviewingCardBlocks(outcome.bill, ports, true),
        );
      }
      return { ok: true, applied: false, reason: "AMOUNT_CHANGED" };
    }

    case "LOCKED": {
      const invoiceState: "MANUAL" | "PENDING" = outcome.bill.invoice_state === "PENDING" ? "PENDING" : "MANUAL";
      if (invoiceState === "PENDING" && !ports.scheduler.hasPending("trigMfSyncSoon")) {
        try {
          ports.scheduler.scheduleOnce("trigMfSyncSoon", 60000);
        } catch (e) {
          console.error(
            "monthClose scheduleOnce failed: " + (e instanceof Error ? (e.stack || e.message) : String(e)),
          );
        }
      }
      if (hasCard(outcome.bill)) {
        updateCard(
          ports,
          req.channel_id,
          outcome.bill.close_card_ts as string,
          req.month,
          renderMonthCloseLockedCard({ client: req.client, month: req.month, invoiceState }),
        );
      }
      return { ok: true, applied: true };
    }
  }
}
