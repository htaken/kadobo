/**
 * スパイク S-M5 の `POST /journals` 部分の本体（実装設計 MF連携 §11.1）。`entry.ts` の `mfJournalSpikeS5` から
 * 手動実行で 1 回だけ呼ぶ。シートには一切書かず、`MF_*_ENABLED` フラグも見ない。
 * 連携明細の `journalize`（S-M5 の後半）は WP-M5 の範囲で、ここでは行わない。
 *
 * 目的は「**免税事業者の設定で、`tax_id` を送らずに作った仕訳の税区分がどう入るか**」を見ること
 * （§3.2 🔄。`tax_name`・`tax_value` を Logger に出す）。あわせて次を確かめる:
 * - `tags`・`remark`・`memo` が保存されるか
 * - 作成直後の `GET /journals?start_date&end_date` の tags 検索で見つかるか（§6.4 の回収の前提）
 * - `DELETE /journals/{id}` が効き、削除後の `GET` が 404 になるか（§6.7 の前提）
 *
 * 借方 雑費 1 円／貸方 事業主借 1 円で作る。**作ったテスト仕訳は最後に必ず削除する**（会計帳簿に残ると
 * 決算に影響する）。先に同じタグの既存（前回の削除失敗分）を検索し、あれば作らずに回収する。
 * ID は MF が返したパーセントエンコード済みの文字列をそのまま使う（パスにも `encodeURIComponent` を重ねない）。
 * 出力は `log` だけで、API キー・JWT は扱わない。
 */
import { businessDateOf } from "@kadobo/shared/time";
import { extractJournalItem, journalIdOf } from "../../core/journalSync";
import { findJournalsByTag } from "../journalSync";
import { MfApiError } from "./errors";
import { makeMfAccountingClient, type MfAccountingClient, type MfAccountingClientPorts } from "./accountingClient";
import { lookupAccountsByName } from "./pingFormat";

/** スパイク仕訳の `tags`（検索キー）。 */
export const SPIKE_JOURNAL_TAG = "kadobo-spike-s5";
/** スパイク仕訳の `remark`（摘要）。 */
export const SPIKE_JOURNAL_REMARK = "kadobo S-M5 テスト（削除予定）";
const SPIKE_JOURNAL_MEMO = "kadobo spike S-M5 のメモ（削除予定）";
const SPIKE_DEBIT_ACCOUNT = "雑費";
const SPIKE_CREDIT_ACCOUNT = "事業主借";

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** 文字列・数値・真偽値だけを表示用文字列にする。無ければ `(なし)`。 */
function show(v: unknown): string {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "(なし)";
}

function resolveSpikeAccounts(client: MfAccountingClient): { debit: string; credit: string } {
  const res = client.request("get", "/accounts", { available: "true" });
  const lookups = lookupAccountsByName(res, [SPIKE_DEBIT_ACCOUNT, SPIKE_CREDIT_ACCOUNT]);
  const ids: string[] = [];
  for (const l of lookups) {
    const m = l.matches[0];
    if (l.status !== "one" || m === undefined) {
      throw new Error(`SPIKE_ACCOUNT_NOT_RESOLVED:${l.name}:${l.status}`);
    }
    ids.push(m.id);
  }
  return { debit: ids[0] as string, credit: ids[1] as string };
}

/** `tax_id`・`invoice_kind` を送らない本文（§3.2）。 */
function buildSpikeBody(today: string, accounts: { debit: string; credit: string }): Record<string, unknown> {
  return {
    journal: {
      transaction_date: today,
      journal_type: "journal_entry",
      branches: [
        {
          debitor: { account_id: accounts.debit, value: 1 },
          creditor: { account_id: accounts.credit, value: 1 },
          remark: SPIKE_JOURNAL_REMARK,
        },
      ],
      memo: SPIKE_JOURNAL_MEMO,
      tags: [SPIKE_JOURNAL_TAG],
    },
  };
}

/** 読み直した仕訳の各項目を 1 行ずつ出す（`tax_name`・`tax_value` が目的）。 */
function logJournalDetail(journal: Record<string, unknown>, log: (line: string) => void): void {
  log(`S-M5 tags: ${Array.isArray(journal.tags) ? JSON.stringify(journal.tags) : "(なし)"}`);
  log(`S-M5 memo: ${show(journal.memo)}`);
  log(`S-M5 transaction_date: ${show(journal.transaction_date)}`);
  const branches = Array.isArray(journal.branches) ? (journal.branches as unknown[]) : [];
  branches.forEach((b, i) => {
    const br = asRecord(b);
    log(`S-M5 branches[${i}].remark: ${show(br.remark)}`);
    for (const side of ["debitor", "creditor"] as const) {
      const s = asRecord(br[side]);
      log(
        `S-M5 branches[${i}].${side}: account_name=${show(s.account_name)} value=${show(s.value)} ` +
          `tax_name=${show(s.tax_name)} tax_value=${show(s.tax_value)} invoice_kind=${show(s.invoice_kind)}`,
      );
    }
  });
  if (branches.length === 0) {
    log("S-M5 branches: (なし)");
  }
}

/** 削除して、読み直しが 404 になることを確かめる。失敗は呼び出し側で案内して再スローする。 */
function deleteAndVerify(client: MfAccountingClient, id: string, log: (line: string) => void): void {
  client.request("delete", `/journals/${id}`);
  try {
    client.request("get", `/journals/${id}`);
  } catch (e) {
    if (e instanceof MfApiError && e.status === 404) {
      log(`S-M5 削除済み: DELETE 後の GET /journals/${id} が 404 を返した。`);
      return;
    }
    throw e;
  }
  throw new Error(`SPIKE_DELETE_NOT_EFFECTIVE:${id}`);
}

/**
 * S-M5（`POST /journals` 部分）を 1 回実行する。`log` には 1 行ずつ渡す（`Logger.log` を想定）。
 *
 * 途中（読み直し・検索）で例外が起きても、削除は試みる。例外はそのまま再スローし、削除にも失敗した
 * 場合は仕訳 ID と手動削除の案内を `log` に出す。
 */
export function runJournalSpikeS5(ports: MfAccountingClientPorts, log: (line: string) => void): void {
  const client = makeMfAccountingClient(ports);
  const today = businessDateOf(ports.clock.nowMs());
  const yearStart = `${today.slice(0, 4)}-01-01`;

  // 前回の実行で削除に失敗した仕訳の回収（新規作成しない）。
  const existing = findJournalsByTag(client, SPIKE_JOURNAL_TAG, yearStart, today);
  let id: string;
  let created: boolean;
  if (existing.length > 0) {
    const firstId = journalIdOf(existing[0] as Record<string, unknown>);
    if (firstId === null) {
      throw new Error("SPIKE_EXISTING_JOURNAL_HAS_NO_ID");
    }
    id = firstId;
    created = false;
    log(`S-M5 既存の ${SPIKE_JOURNAL_TAG} を ${existing.length} 件検出したため新規作成しない。id=${id} を使う。`);
    if (existing.length > 1) {
      const rest = existing.slice(1).map((j) => show(journalIdOf(j)));
      log(`S-M5 注意: ${SPIKE_JOURNAL_TAG} が複数あります。2 件目以降（id=${rest.join(", ")}）は MF 画面で手動削除してください。`);
    }
  } else {
    const accounts = resolveSpikeAccounts(client);
    const res = client.request("post", "/journals", {}, buildSpikeBody(today, accounts), { create: true });
    const item = extractJournalItem(res);
    const newId = item === null ? null : journalIdOf(item);
    if (newId === null) {
      throw new Error(
        `SPIKE_CREATE_RESPONSE_HAS_NO_ID（${SPIKE_JOURNAL_TAG} が MF 側に作られている可能性があります。MF 画面で確認してください）`,
      );
    }
    id = newId;
    created = true;
    log(`S-M5 作成した: id=${id}`);
  }

  let primaryError: unknown = null;
  try {
    const detail = extractJournalItem(client.request("get", `/journals/${id}`));
    if (detail === null) {
      log("S-M5 GET /journals/{id}: 応答に journal がありません。");
    } else {
      logJournalDetail(detail, log);
    }

    if (created) {
      // 作成直後に tags で見つかるか（§6.4 の回収の前提）。
      const found = findJournalsByTag(client, SPIKE_JOURNAL_TAG, today, today);
      const hit = found.some((j) => journalIdOf(j) === id);
      log(
        `S-M5 作成直後の検索 GET /journals?start_date=${today}&end_date=${today}: tags=${SPIKE_JOURNAL_TAG} の仕訳 ${found.length} 件` +
          `（今回作った仕訳が${hit ? "見つかった" : "見つからなかった"}）`,
      );
    } else {
      log("S-M5 作成直後の検索: 既存を回収したため今回は行わない（未確認）。");
    }
  } catch (e) {
    primaryError = e;
  }

  try {
    deleteAndVerify(client, id, log);
  } catch (e) {
    log(`S-M5 削除の失敗理由: ${e instanceof Error ? `${e.name}:${e.message}` : "(不明)"}`);
    log(
      `S-M5 削除に失敗しました。仕訳 id=${id}（tags=${SPIKE_JOURNAL_TAG}、摘要「${SPIKE_JOURNAL_REMARK}」）が MF に残っている可能性があります。` +
        "MF 画面で手動削除してください（会計帳簿に残ると決算に影響します）。",
    );
    throw primaryError ?? e;
  }
  if (primaryError !== null) {
    throw primaryError;
  }
}
