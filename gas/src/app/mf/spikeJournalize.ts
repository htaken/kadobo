/**
 * スパイク S-M5 の後半の本体（実装設計 MF連携 §11.1）。`entry.ts` の `mfJournalizeSpikeS5b` から手動実行で 1 回だけ呼ぶ。
 * シートには一切書かず、`MF_*_ENABLED` フラグも見ない。
 *
 * Script Property `MF_SPIKE_TRANSACTION_ID`（MF が返した文字列そのまま。raw）で指定した**開業日以降の未仕訳の
 * 支出明細 1 件**を、`事業主貸` で `journalize` し、次を確かめる:
 * 1. `POST /transactions/journalize`（`remark: 私用: S-M5b`、`tags: ["kadobo-spike-s5b"]`、`tax_id` なし）が 201 になるか
 * 2. `GET /journals?transaction_ids={raw}` で、作った仕訳を引けるか（クエリの ID は `{ raw }`。§6.5 の回収の前提）
 * 3. `PUT /journals/{id}` で `remark` を `私用: S-M5b（PUT 確認）` に書き換えられ、読み直すと反映されているか
 *    （§6.7 の訂正・取消を PUT で行う前提）。PUT の前後で**貸方（科目・金額・補助科目）と明細との紐付き
 *    （`transaction_id`）が保たれている**ことも比べる
 * 4. **同じ明細にもう一度 `journalize` を送ったとき**の応答（§6.5 の「未仕訳なら送り直してよい」の前提）。
 *    400 等で拒否されれば二重作成されない。201 なら二重作成されたので仕訳 ID を出して失敗にする
 *    （人が MF 画面で不要な方を削除する）
 *
 * 1・3・4 の前提が崩れていれば、最後まで確認したうえで失敗（例外）にする。
 *
 * **仕訳は削除しない**（連携明細から作った仕訳を削除すると明細が対象外になるため。本番の仕訳として残る）。
 * このため、明細の `date` が `MF_SYNC_START_DATE` より前なら実行を拒否する（開業前の明細は事業の取引ではない。
 * runbook 04 §H）。未仕訳でない明細・支出でない明細・見つからない明細も拒否する。
 * 出力は `log` だけで、API キー・JWT は扱わない。
 */
import { businessDateOf } from "@kadobo/shared/time";
import {
  PRIVATE_ACCOUNT_NAME,
  buildJournalUpdateBody,
  extractJournalItem,
  extractJournalList,
  journalIdOf,
  parseTransactions,
  shiftDate,
  singleBranchOf,
  splitDateRangeBySpan,
  totalPagesOf,
  transactionKey,
  type MfTransaction,
} from "../../core/journalSync";
import { makeMfAccountingClient, pathWithId, type MfAccountingClient, type MfAccountingClientPorts } from "./accountingClient";
import { MfApiError, MfOutcomeUnknownError } from "./errors";
import { lookupAccountsByName } from "./pingFormat";

/** スパイク仕訳の `tags`。 */
export const SPIKE_S5B_TAG = "kadobo-spike-s5b";
/** `journalize` 時の `remark`。 */
export const SPIKE_S5B_REMARK = "私用: S-M5b";
/** PUT で書き換える `remark`。 */
export const SPIKE_S5B_REMARK_AFTER_PUT = "私用: S-M5b（PUT 確認）";
/** 明細を探す期間（今日から遡る日数）。`GET /transactions` の 366 日制限の内側。 */
export const SPIKE_S5B_LOOKBACK_DAYS = 365;

const PER_PAGE = 500;
const MAX_PAGES = 20;

function show(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "(なし)";
}

/** 全ステータス・全収支の明細から `id`（`transactionKey` で比較）を探す。連携サービスは絞らない。 */
function findTransaction(client: MfAccountingClient, id: string, from: string, to: string): MfTransaction | null {
  const key = transactionKey(id);
  for (const range of splitDateRangeBySpan(from, to)) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const res = client.request("get", "/transactions", {
        start_date: range.start,
        end_date: range.end,
        order: "desc",
        page: String(page),
        per_page: String(PER_PAGE),
      });
      const items = parseTransactions(res, "card");
      const hit = items.find((t) => transactionKey(t.id) === key);
      if (hit !== undefined) {
        return hit;
      }
      const totalPages = totalPagesOf(res);
      if (totalPages !== null ? page >= totalPages : items.length < PER_PAGE) {
        break;
      }
    }
  }
  return null;
}

function resolvePrivateAccount(client: MfAccountingClient): string {
  const res = client.request("get", "/accounts", { available: "true" });
  const l = lookupAccountsByName(res, [PRIVATE_ACCOUNT_NAME])[0];
  const m = l?.matches[0];
  if (l === undefined || l.status !== "one" || m === undefined) {
    throw new Error(`SPIKE_ACCOUNT_NOT_RESOLVED:${PRIVATE_ACCOUNT_NAME}:${l?.status ?? "none"}`);
  }
  return m.id;
}

function logJournal(prefix: string, journal: Record<string, unknown>, log: (line: string) => void): void {
  log(`${prefix} id=${show(journalIdOf(journal))} transaction_date=${show(journal.transaction_date)} transaction_id=${show(journal.transaction_id)}`);
  log(`${prefix} tags: ${Array.isArray(journal.tags) ? JSON.stringify(journal.tags) : "(なし)"} memo: ${show(journal.memo)}`);
  const branches = Array.isArray(journal.branches) ? (journal.branches as unknown[]) : [];
  branches.forEach((b, i) => {
    const br = typeof b === "object" && b !== null ? (b as Record<string, unknown>) : {};
    log(`${prefix} branches[${i}].remark: ${show(br.remark)}`);
    for (const side of ["debitor", "creditor"] as const) {
      const s = typeof br[side] === "object" && br[side] !== null ? (br[side] as Record<string, unknown>) : {};
      log(
        `${prefix} branches[${i}].${side}: account_name=${show(s.account_name)} value=${show(s.value)} ` +
          `tax_name=${show(s.tax_name)} invoice_kind=${show(s.invoice_kind)}`,
      );
    }
  });
}

/**
 * S-M5 の後半を 1 回実行する。拒否する場合・失敗した場合は例外を投げる（理由は例外メッセージと `log`）。
 */
export function runJournalizeSpikeS5b(ports: MfAccountingClientPorts, log: (line: string) => void): void {
  const txIdRaw = ports.props.get("MF_SPIKE_TRANSACTION_ID");
  if (txIdRaw === null || txIdRaw.trim() === "") {
    throw new Error("SPIKE_TRANSACTION_ID_NOT_SET（Script Property MF_SPIKE_TRANSACTION_ID に明細 ID を設定してください）");
  }
  const txId = txIdRaw.trim();
  const startDate = ports.props.get("MF_SYNC_START_DATE");
  if (startDate === null || startDate === "") {
    throw new Error("SPIKE_SYNC_START_DATE_NOT_SET（開業日 MF_SYNC_START_DATE が未設定のため、開業前の明細かを判定できず実行しません）");
  }
  const client = makeMfAccountingClient(ports);
  const today = businessDateOf(ports.clock.nowMs());

  // 1. 明細を探して、仕訳してよいか確かめる（開業日以降・支出・未仕訳）。
  const tx = findTransaction(client, txId, shiftDate(today, -SPIKE_S5B_LOOKBACK_DAYS), today);
  if (tx === null) {
    throw new Error(`SPIKE_TRANSACTION_NOT_FOUND（直近 ${SPIKE_S5B_LOOKBACK_DAYS} 日の明細に MF_SPIKE_TRANSACTION_ID が見つかりません）`);
  }
  log(`S-M5b 対象の明細: date=${tx.date} value=${tx.value} side=${tx.side} status=${tx.status} content=${tx.content}`);
  if (tx.date < startDate) {
    log(`S-M5b 拒否: 明細の date ${tx.date} が開業日 ${startDate} より前です。開業前の明細は仕訳しません（runbook 04 §H）。`);
    throw new Error(`SPIKE_TRANSACTION_BEFORE_START:${tx.date}<${startDate}`);
  }
  if (tx.side !== "EXPENSE") {
    log(`S-M5b 拒否: 明細の side が ${tx.side} です（EXPENSE の明細だけ扱います）。`);
    throw new Error(`SPIKE_TRANSACTION_NOT_EXPENSE:${tx.side}`);
  }
  if (tx.status !== "none") {
    log(`S-M5b 拒否: 明細の journalizing_status が ${tx.status} です（未仕訳の明細だけ扱います）。`);
    throw new Error(`SPIKE_TRANSACTION_NOT_UNJOURNALIZED:${tx.status}`);
  }

  // 2. journalize（`tax_id` なし）。
  const accountId = resolvePrivateAccount(client);
  const journalizeBody = {
    transaction_id: tx.id,
    transaction_date: tx.date,
    account_id: accountId,
    remark: SPIKE_S5B_REMARK,
    tags: [SPIKE_S5B_TAG],
  };
  const created = extractJournalItem(client.request("post", "/transactions/journalize", {}, journalizeBody, { create: true }));
  const id = created === null ? null : journalIdOf(created);
  if (id === null) {
    throw new Error(
      `SPIKE_JOURNALIZE_RESPONSE_HAS_NO_ID（${SPIKE_S5B_TAG} の仕訳が MF 側に作られている可能性があります。MF 画面で確認してください）`,
    );
  }
  log(`S-M5b journalize 201: id=${id}`);
  if (created !== null) {
    logJournal("S-M5b 作成直後", created, log);
  }

  // 3. GET /journals?transaction_ids={raw} で引けるか。
  const listRes = client.request("get", "/journals", {
    start_date: shiftDate(tx.date, -1),
    end_date: shiftDate(tx.date, 1),
    transaction_ids: { raw: tx.id },
    page: "1",
    per_page: "100",
  });
  const found = extractJournalList(listRes);
  const hit = found.some((j) => journalIdOf(j) === id);
  log(
    `S-M5b GET /journals?transaction_ids={raw}（${shiftDate(tx.date, -1)}〜${shiftDate(tx.date, 1)}）: ${found.length} 件` +
      `（今回作った仕訳が${hit ? "見つかった" : "見つからなかった"}）`,
  );
  const failures: string[] = [];
  if (!hit) {
    failures.push("SPIKE_NOT_FOUND_BY_TRANSACTION_IDS（transaction_ids の検索で作った仕訳を引けません。§6.5 の回収の前提が成立しません）");
  }

  // 4. PUT で remark を書き換え、読み直して反映を確認する。
  const path = pathWithId("/journals", id);
  const existing = extractJournalItem(client.request("get", path));
  if (existing === null) {
    throw new Error(`SPIKE_GET_JOURNAL_FAILED（GET ${path} の応答に仕訳がありません）`);
  }
  const single = singleBranchOf(existing);
  if (single === null) {
    throw new Error("SPIKE_JOURNAL_SHAPE_UNEXPECTED（1 行の借方・貸方の形ではありません）");
  }
  const built = buildJournalUpdateBody(existing, {
    debitAccountId: single.debitor.account_id as string,
    remark: SPIKE_S5B_REMARK_AFTER_PUT,
    tags: [SPIKE_S5B_TAG],
    memo: typeof existing.memo === "string" && existing.memo !== "" ? existing.memo : undefined,
  });
  if (!built.ok) {
    throw new Error(`SPIKE_PUT_BODY_FAILED:${built.reason}`);
  }
  client.request("put", path, {}, built.body);
  log("S-M5b PUT /journals/{id}: 成功");
  const after = extractJournalItem(client.request("get", path));
  if (after === null) {
    throw new Error(`SPIKE_GET_AFTER_PUT_FAILED（GET ${path} の応答に仕訳がありません）`);
  }
  logJournal("S-M5b PUT 後の読み直し", after, log);
  const branches = Array.isArray(after.branches) ? (after.branches as unknown[]) : [];
  const b0 = typeof branches[0] === "object" && branches[0] !== null ? (branches[0] as Record<string, unknown>) : {};
  const reflected = b0.remark === SPIKE_S5B_REMARK_AFTER_PUT;
  log(`S-M5b PUT の反映: remark が「${SPIKE_S5B_REMARK_AFTER_PUT}」に${reflected ? "なっていた" : "なっていなかった"}。`);
  if (!reflected) {
    failures.push("SPIKE_PUT_NOT_REFLECTED（PUT した remark が読み直しに反映されていません）");
  }

  // PUT の前後で、貸方（科目・金額・補助科目）と明細との紐付きが保たれているか。
  const afterSingle = singleBranchOf(after);
  const changes: string[] = [];
  const subOf = (side: Record<string, unknown>): string => (typeof side.sub_account_id === "string" ? side.sub_account_id : "");
  if (afterSingle === null) {
    changes.push("読み直した仕訳が 1 行の借方・貸方の形ではない");
  } else {
    if (afterSingle.creditor.account_id !== single.creditor.account_id) {
      changes.push("貸方の科目が変わった");
    }
    if (afterSingle.creditValue !== single.creditValue) {
      changes.push(`貸方の金額が変わった（${single.creditValue}→${afterSingle.creditValue}）`);
    }
    if (subOf(afterSingle.creditor) !== subOf(single.creditor)) {
      changes.push("貸方の補助科目が変わった");
    }
    if (afterSingle.debitValue !== single.debitValue) {
      changes.push(`借方の金額が変わった（${single.debitValue}→${afterSingle.debitValue}）`);
    }
  }
  const txBefore = typeof existing.transaction_id === "string" ? existing.transaction_id : "";
  const txAfter = typeof after.transaction_id === "string" ? after.transaction_id : "";
  if (txBefore === "" || transactionKey(txBefore) !== transactionKey(tx.id)) {
    changes.push("PUT の前から、仕訳が明細に紐づいていない（transaction_id が明細 ID と一致しない）");
  } else if (txAfter === "" || transactionKey(txAfter) !== transactionKey(txBefore)) {
    changes.push("PUT で明細との紐付き（transaction_id）が外れた");
  }
  log(
    `S-M5b PUT の前後の比較（貸方の科目・金額・補助科目、借方の金額、transaction_id）: ${changes.length === 0 ? "変わらなかった" : changes.join("、")}`,
  );
  if (changes.length > 0) {
    failures.push(`SPIKE_PUT_CHANGED_UNEXPECTED:${changes.join("、")}`);
  }

  // 同じ明細にもう一度 journalize を送ったときの応答（二重作成されないか）。
  try {
    const dup = extractJournalItem(client.request("post", "/transactions/journalize", {}, journalizeBody, { create: true }));
    const dupId = dup === null ? null : journalIdOf(dup);
    log(
      `S-M5b 同じ明細への 2 回目の journalize: 201 が返った。二重作成された（仕訳 id=${show(dupId)}）。` +
        "MF 画面で不要な方の仕訳を削除してください（削除すると明細は対象外になる点に注意）。",
    );
    failures.push(`SPIKE_DUPLICATE_JOURNALIZE_CREATED:${show(dupId)}`);
  } catch (e) {
    if (e instanceof MfApiError) {
      log(
        `S-M5b 同じ明細への 2 回目の journalize: 拒否された（status=${e.status} code=${show(e.code)}）。二重作成されない。` +
          "（§6.5 の「未仕訳なら journalize を送り直してよい」の前提が成立）",
      );
    } else if (e instanceof MfOutcomeUnknownError) {
      log("S-M5b 同じ明細への 2 回目の journalize: 結果不明（5xx・通信失敗）。MF 画面で仕訳が二重になっていないか確認してください。");
      failures.push("SPIKE_DUPLICATE_JOURNALIZE_UNKNOWN");
    } else {
      throw e;
    }
  }
  log(
    `S-M5b 完了。仕訳 id=${id}（tags=${SPIKE_S5B_TAG}）は削除せず残しています（私用の仕訳として本番の帳簿に入っています）。` +
      "MF 画面で内容を確認してください。",
  );
  if (failures.length > 0) {
    log(`S-M5b 失敗: ${failures.join(" ／ ")}`);
    throw new Error(failures[0] as string);
  }
}
