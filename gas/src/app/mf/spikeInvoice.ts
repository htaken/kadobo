/**
 * スパイク S-M1・S-M2 の本体（実装設計 MF連携 §11.1）。`entry.ts` の `mfInvoiceSpikeS1` から
 * 手動実行で 1 回だけ呼ぶ。シートには一切書かず、`MF_*_ENABLED` フラグも見ない。
 *
 * - S-M1: 小数数量（160.01 × 1800、課税 10%）のテスト請求書を作り、`subtotal_price`・
 *   `excise_price`・`total_price` が単価マスタの計算（切捨）と一致するかを `compareAmounts` で確かめる。
 * - S-M2: `GET /billings?document_number=` が完全一致か部分一致か、作成直後の検索で見つかるか。
 *
 * 作ったテスト請求書は最後に必ず削除を試みる（途中で例外が起きた場合も試みる）。出力は `log` だけで、
 * トークン・API キーは扱わない（`MfInvoiceClient` が持つのみで、この関数には渡らない）。
 */
import { businessDateOf } from "@kadobo/shared/time";
import { compareAmounts } from "../../core/invoice";
import { shiftBusinessDate } from "../dateUtil";
import {
  documentNumberOf,
  extractBillingDetail,
  extractBillingsArray,
  extractId,
  requireDepartmentId,
  searchBillingsByDocumentNumber,
} from "../invoice";
import { MfApiError } from "./errors";
import { makeMfInvoiceClient, type MfInvoiceClient, type MfInvoiceClientPorts } from "./invoiceClient";

/** スパイク用請求書の請求書番号（実装設計 §11.1）。`document_number` の部分文字列検索にも使う。 */
export const SPIKE_BILLING_NUMBER = "KD-TEST-S1";
/** S-M2 の部分文字列検索に使う接頭辞。 */
export const SPIKE_PARTIAL_QUERY = "KD-TEST";

const SPIKE_QUANTITY = 160.01;
/** 浮動小数の誤差を避けるため、期待値は 1/100 単位の整数で計算する。 */
const SPIKE_QUANTITY_HUNDREDTHS = 16001;
const SPIKE_PRICE = 1800;
const DUE_DAYS = 30;
const PER_PAGE = 100;

/** 単価マスタの計算（切捨）で期待する金額。`amount = floor(160.01 × 1800)`、`tax = floor(amount × 0.1)`。 */
export function expectedSpikeAmounts(): {
  amount: number;
  tax_amount: number;
  withholding_amount: number;
  net_amount: number;
} {
  const amount = Math.floor((SPIKE_QUANTITY_HUNDREDTHS * SPIKE_PRICE) / 100);
  const tax = Math.floor(amount / 10);
  return { amount, tax_amount: tax, withholding_amount: 0, net_amount: amount + tax };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** 文字列・数値・真偽値だけを表示用文字列にする。無ければ `(なし)`。 */
function show(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "(なし)";
}

interface RawSearch {
  /** 返ってきた行（1 ページ目）。 */
  rows: Record<string, unknown>[];
  /** `pagination.total_count`（数値で取れたときだけ。無ければ `rows.length`）。 */
  totalCount: number;
}

/** `GET /billings?document_number=<q>` を 1 ページ分だけ取得し、絞り込みはせずそのまま返す。 */
function searchRaw(client: MfInvoiceClient, documentNumber: string): RawSearch {
  const res = client.request(
    "get",
    `/billings?document_number=${encodeURIComponent(documentNumber)}&page=1&per_page=${PER_PAGE}`,
  );
  const rows = extractBillingsArray(res);
  const total = asRecord(asRecord(res).pagination).total_count;
  return { rows, totalCount: typeof total === "number" ? total : rows.length };
}

function exactCount(rows: readonly Record<string, unknown>[]): number {
  return rows.filter((r) => documentNumberOf(r) === SPIKE_BILLING_NUMBER).length;
}

function describeSearch(label: string, s: RawSearch): string {
  return `${label}: 返却 ${s.rows.length} 件（total_count ${s.totalCount}）/ billing_number が ${SPIKE_BILLING_NUMBER} と完全一致 ${exactCount(s.rows)} 件`;
}

function buildSpikeBody(departmentId: string, today: string): Record<string, unknown> {
  return {
    department_id: departmentId,
    billing_number: SPIKE_BILLING_NUMBER,
    title: "【テスト・削除予定】kadobo S-M1",
    billing_date: today,
    sales_date: today,
    due_date: shiftBusinessDate(today, DUE_DAYS),
    memo: "kadobo spike S-M1",
    items: [
      {
        name: "テスト（削除予定）",
        unit: "時間",
        quantity: SPIKE_QUANTITY,
        price: SPIKE_PRICE,
        excise: "ten_percent",
        is_deduct_withholding_tax: false,
      },
    ],
  };
}

/** 読み直した請求書の各項目を 1 行ずつ出す（手順 4）。 */
function logBillingDetail(detail: Record<string, unknown>, log: (line: string) => void): void {
  const config = asRecord(detail.config);
  const items = Array.isArray(detail.items) ? (detail.items as unknown[]) : [];
  const quantity = asRecord(items[0]).quantity;
  const quantityKept = Number(quantity) === SPIKE_QUANTITY;

  log(`S-M1 subtotal_price: ${show(detail.subtotal_price)}`);
  log(`S-M1 excise_price: ${show(detail.excise_price)}`);
  log(`S-M1 total_price: ${show(detail.total_price)}`);
  log(`S-M1 deduct_price: ${show(detail.deduct_price)}`);
  log(`S-M1 config.rounding: ${show(config.rounding)}`);
  log(`S-M1 config.rounding_consumption_tax: ${show(config.rounding_consumption_tax)}`);
  log(`S-M1 config.consumption_tax_display_type: ${show(config.consumption_tax_display_type)}`);
  log(`S-M1 payment_status: ${show(detail.payment_status)}`);
  log(`S-M1 email_status: ${show(detail.email_status)}`);
  log(`S-M1 posting_status: ${show(detail.posting_status)}`);
  log(
    `S-M1 items[0].quantity: ${show(quantity)}（小数 ${SPIKE_QUANTITY} が${quantityKept ? "保持されている" : "保持されていない"}）`,
  );
  log(`S-M1 billing_number: ${show(detail.billing_number)}`);
}

/** 期待値との比較（手順 5）。 */
function logAmountComparison(detail: Record<string, unknown>, log: (line: string) => void): void {
  const expected = expectedSpikeAmounts();
  const str = (k: string): string | undefined => (typeof detail[k] === "string" ? (detail[k] as string) : undefined);
  const cmp = compareAmounts(expected, {
    subtotal_price: str("subtotal_price"),
    excise_price: str("excise_price"),
    total_price: str("total_price"),
    deduct_price: str("deduct_price"),
  });
  log(
    `S-M1 期待値（単価マスタの切捨）: 報酬額 ${expected.amount} / 消費税 ${expected.tax_amount} / 税込 ${expected.amount + expected.tax_amount} / 源泉 ${expected.withholding_amount} / 差引 ${expected.net_amount}`,
  );
  if (cmp.match) {
    log("S-M1 金額照合: 一致");
    return;
  }
  const config = asRecord(detail.config);
  log(`S-M1 金額照合: 不一致（${cmp.summary}）`);
  log(
    `S-M1 対応: MF 側の config.rounding（現在 ${show(config.rounding)}）と rounding_consumption_tax（現在 ${show(config.rounding_consumption_tax)}）を単価マスタの切捨に合わせて変更してください。`,
  );
}

/** S-M2: 作成直後以外の検索（手順 6）。 */
function logSearchSpike(client: MfInvoiceClient, log: (line: string) => void): void {
  const exact = searchRaw(client, SPIKE_BILLING_NUMBER);
  log(describeSearch(`S-M2 document_number=${SPIKE_BILLING_NUMBER}（完全一致の検索）`, exact));

  const partial = searchRaw(client, SPIKE_PARTIAL_QUERY);
  log(describeSearch(`S-M2 document_number=${SPIKE_PARTIAL_QUERY}（部分文字列の検索）`, partial));
  log(
    exactCount(partial.rows) > 0
      ? `S-M2 結論: 部分文字列 ${SPIKE_PARTIAL_QUERY} の検索で ${SPIKE_BILLING_NUMBER} が返った（document_number は部分一致）。`
      : `S-M2 結論: 部分文字列 ${SPIKE_PARTIAL_QUERY} の検索で ${SPIKE_BILLING_NUMBER} は返らなかった（document_number は完全一致、または検索対象外）。`,
  );
}

/** 手順 7: 削除して、読み直しが 404 になることを確かめる。失敗は呼び出し側で案内して再スローする。 */
function deleteAndVerify(client: MfInvoiceClient, id: string, log: (line: string) => void): void {
  const path = `/billings/${encodeURIComponent(id)}`;
  client.request("delete", path);
  try {
    client.request("get", path);
  } catch (e) {
    if (e instanceof MfApiError && e.status === 404) {
      log(`S-M1 削除済み: DELETE 後の GET /billings/${id} が 404 を返した。`);
      return;
    }
    throw e;
  }
  throw new Error(`SPIKE_DELETE_NOT_EFFECTIVE:${id}`);
}

/**
 * S-M1・S-M2 を 1 回実行する。`log` には 1 行ずつ渡す（`Logger.log` を想定）。
 *
 * 途中（読み直し・照合・検索）で例外が起きても、削除は試みる。例外はそのまま再スローし、
 * 削除にも失敗した場合は請求書 ID と手動削除の案内を `log` に出す。
 */
export function runInvoiceSpikeS1(ports: MfInvoiceClientPorts, log: (line: string) => void): void {
  const departmentId = requireDepartmentId(ports);
  const client = makeMfInvoiceClient(ports);

  // 前回の実行で削除に失敗した請求書の回収（新規作成しない）。
  const existing = searchBillingsByDocumentNumber(client, SPIKE_BILLING_NUMBER);
  let id: string;
  let created: boolean;
  if (existing.length > 0) {
    const firstId = extractId(existing[0]);
    if (firstId === null) {
      throw new Error("SPIKE_EXISTING_BILLING_HAS_NO_ID");
    }
    id = firstId;
    created = false;
    log(`S-M1 既存の ${SPIKE_BILLING_NUMBER} を ${existing.length} 件検出したため新規作成しない。id=${id} を使う。`);
    if (existing.length > 1) {
      const rest = existing.slice(1).map((r) => show(extractId(r)));
      log(`S-M1 注意: ${SPIKE_BILLING_NUMBER} が複数あります。2 件目以降（id=${rest.join(", ")}）は MF 画面で手動削除してください。`);
    }
  } else {
    const today = businessDateOf(ports.clock.nowMs());
    const res = client.request("post", "/invoice_template_billings", buildSpikeBody(departmentId, today), {
      create: true,
    });
    const newId = extractId(res);
    if (newId === null) {
      throw new Error(`SPIKE_CREATE_RESPONSE_HAS_NO_ID（${SPIKE_BILLING_NUMBER} が MF 側に作られている可能性があります。MF 画面で確認してください）`);
    }
    id = newId;
    created = true;
    log(`S-M1 作成した: id=${id}`);
  }

  let primaryError: unknown = null;
  try {
    if (created) {
      // S-M2: 作成直後の完全一致検索で見つかるか。
      const right = searchRaw(client, SPIKE_BILLING_NUMBER);
      log(describeSearch("S-M2 作成直後の検索", right));
    } else {
      log("S-M2 作成直後の検索: 既存を回収したため今回は行わない（未確認）。");
    }

    const detail = extractBillingDetail(client.request("get", `/billings/${encodeURIComponent(id)}`));
    logBillingDetail(detail, log);
    logAmountComparison(detail, log);
    logSearchSpike(client, log);
  } catch (e) {
    primaryError = e;
  }

  try {
    deleteAndVerify(client, id, log);
  } catch (e) {
    log(`S-M1 削除の失敗理由: ${e instanceof Error ? `${e.name}:${e.message}` : "(不明)"}`);
    log(
      `S-M1 削除に失敗しました。請求書 id=${id}（${SPIKE_BILLING_NUMBER}）が MF に残っている可能性があります。MF 画面で手動削除してください。`,
    );
    throw primaryError ?? e;
  }
  if (primaryError !== null) {
    throw primaryError;
  }
}
