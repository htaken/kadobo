/**
 * GAS Web アプリ／トリガーのエントリポイント（実装設計 §1, §7.5, §7.7）。
 *
 * ここでは実 adapters を組み立てて app 層（`src/app/*.ts`）へ渡すだけの薄いラッパに徹する。
 * `doPost` のディスパッチ本体は `app/dispatch.ts` の `handlePostBody`（GAS グローバルに依存しない）
 * であり、そちらを Node の Vitest でテストする。
 *
 * `build.mjs` がこの export 群を IIFE（globalName `__kadobo`）にバンドルし、末尾に
 * `function doPost(e){return __kadobo.doPost(e)}` 等のトップレベル関数宣言を出力する
 * （GAS エディタ・トリガー設定画面から見えるようにするため）。
 */
import { handlePostBody } from "./app/dispatch";
import { makeMfAccountingClient } from "./app/mf/accountingClient";
import { makeMfInvoiceClient } from "./app/mf/invoiceClient";
import { runInvoiceSpikeS1 } from "./app/mf/spikeInvoice";
import { runJournalSpikeS5 } from "./app/mf/spikeJournal";
import { runTransactionSpikeS4 } from "./app/mf/spikeTransactions";
import {
  collectTaxIds,
  extractOfficeName,
  extractOffices,
  formatAccountCounts,
  formatAccountLookup,
  formatOffice,
  formatTaxLine,
  lookupAccountsByName,
} from "./app/mf/pingFormat";
import type { AppPorts } from "./app/ports";
import {
  trigEveningCheck as runEveningCheck,
  trigMfSync as runMfSync,
  trigMfSyncSoon as runMfSyncSoon,
  trigMonthly as runMonthly,
  trigMorningCard as runMorningCard,
  trigWeeklyOrphanCheck as runWeeklyOrphanCheck,
} from "./app/triggers";
import { AuthLockAdapter } from "./adapters/authLock";
import { CacheAdapter } from "./adapters/cache";
import { CalendarAdapter } from "./adapters/calendar";
import { ClockAdapter } from "./adapters/clock";
import { DigestAdapter } from "./adapters/digest";
import { DriveAdapter } from "./adapters/drive";
import { HmacAdapter } from "./adapters/hmac";
import { HttpAdapter } from "./adapters/http";
import { LockAdapter } from "./adapters/lock";
import { PropsAdapter } from "./adapters/props";
import { RandomAdapter } from "./adapters/random";
import { SchedulerAdapter } from "./adapters/scheduler";
import { SecretStoreAdapter } from "./adapters/secretStore";
import { SheetsAdapter, setupSpreadsheet as setupSpreadsheetImpl } from "./adapters/sheets";
import { SlackAdapter } from "./adapters/slack";
import { SlackFilesAdapter } from "./adapters/slackFiles";
import { installTriggers as installTriggersImpl } from "./adapters/triggers";
import { TtlCacheAdapter } from "./adapters/ttlCache";
import { WorkerStatusAdapter } from "./adapters/workerStatus";

function buildPorts(): AppPorts {
  const props = new PropsAdapter();
  const spreadsheetId = props.get("SPREADSHEET_ID") ?? "";
  const hmac = new HmacAdapter();
  const random = new RandomAdapter();
  const clock = new ClockAdapter();

  return {
    sheets: new SheetsAdapter(spreadsheetId),
    slack: new SlackAdapter(props),
    cache: new CacheAdapter(),
    lock: new LockAdapter(),
    props,
    calendar: new CalendarAdapter(),
    clock,
    random,
    hmac,
    workerStatus: new WorkerStatusAdapter(props, hmac, random, clock),
    // 経費フェーズ（実装設計 経費フェーズ §5.3, §5.9）。
    slackFiles: new SlackFilesAdapter(props),
    drive: new DriveAdapter(props),
    digest: new DigestAdapter(),
    // MF 連携フェーズ（実装設計 MF連携 §4.1, §8）。
    http: new HttpAdapter(),
    secrets: new SecretStoreAdapter(),
    ttlCache: new TtlCacheAdapter(),
    authLock: new AuthLockAdapter(),
    scheduler: new SchedulerAdapter(),
  };
}

/** GAS Web アプリの POST エントリ（実装設計 §7.5）。常に HTTP 200 で JSON を返す。 */
export function doPost(
  e: GoogleAppsScript.Events.DoPost,
): GoogleAppsScript.Content.TextOutput {
  // `e` はエディタから手動実行すると undefined になる（doPost は HTTP POST でのみ呼ぶ想定）。
  // 実運用の POST には必ず postData があるが、手動実行時に例外を投げず JSON を返せるよう防御する。
  const raw = e?.postData?.contents ?? "";
  const result = handlePostBody(raw, buildPorts());
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(
    ContentService.MimeType.JSON,
  );
}

/** シート初期化（実装設計 §7.1）。不足シート・ヘッダー行のみ作成する冪等な処理。 */
export function setupSpreadsheet(): void {
  const props = new PropsAdapter();
  const spreadsheetId = props.get("SPREADSHEET_ID") ?? "";
  setupSpreadsheetImpl(spreadsheetId);
}

/** 時間トリガーの再設定（実装設計 §7.7）。既存トリガーを削除してから作り直す。 */
export function installTriggers(): void {
  installTriggersImpl();
}

/** 毎日 07 時台トリガー（実装設計 §7.7）。 */
export function trigMorningCard(): void {
  runMorningCard(buildPorts());
}

/** 毎日 22 時台トリガー（実装設計 §7.7）。 */
export function trigEveningCheck(): void {
  runEveningCheck(buildPorts());
}

/** 毎月 1 日 06 時台トリガー（実装設計 §7.7）。 */
export function trigMonthly(): void {
  runMonthly(buildPorts());
}

/** 毎週月曜 07 時台トリガー（実装設計 経費フェーズ §5.6）。 */
export function trigWeeklyOrphanCheck(): void {
  runWeeklyOrphanCheck(buildPorts());
}

/** 毎時トリガー（実装設計 MF連携 §7）。WP-M2 の中身は `evaluateMonthClose` のみ。 */
export function trigMfSync(): void {
  runMfSync(buildPorts());
}

/** 締めボタンから 1 分後に 1 回だけ動く時間トリガー（実装設計 MF連携 §5.3, §7）。 */
export function trigMfSyncSoon(): void {
  runMfSyncSoon(buildPorts());
}

/**
 * 手動実行: 請求書 API（OAuth）の疎通確認（実装設計 MF連携 §7 最後の箇条書き）。
 * `GET /office` を呼び、事業者名だけ Logger に出す。**トークンは出力しない**。
 */
export function mfInvoicePing(): void {
  const client = makeMfInvoiceClient(buildPorts());
  const office = client.request("get", "/office");
  Logger.log(`MF invoice GET /office: ${extractOfficeName(office)}`);
}

/**
 * 手動実行: 会計 API（API キー）の疎通確認と、スパイク S-M3（実装設計 MF連携 §11.1）。
 * `GET /accessible_offices` の事業者（名称・番号・区分）を出し、`MF_OFFICE_CODE` があれば続けて
 * `GET /accounts?available=true`・`GET /accounts`（件数）・`GET /taxes` を呼ぶ。§6.4 の 8 科目が
 * 名前完全一致で 1 件だけ引けるか、その `tax_id` の税区分が何かを Logger に出す
 * （呼び出しは合計 4 回）。**API キー・トークンは出力しない**（整形は `pingFormat.ts` の純関数）。
 */
export function mfAccountingPing(): void {
  const ports = buildPorts();
  const client = makeMfAccountingClient(ports);

  const offices = extractOffices(client.request("get", "/accessible_offices"));
  Logger.log(
    `MF accounting GET /accessible_offices: ${offices.length > 0 ? offices.map(formatOffice).join(", ") : "(0 件)"}`,
  );

  const officeCode = ports.props.get("MF_OFFICE_CODE");
  if (officeCode === null || officeCode === "") {
    Logger.log("MF_OFFICE_CODE が未設定のため、/accounts と /taxes は呼びません。");
    return;
  }

  const availableAccounts = client.request("get", "/accounts", { available: "true" });
  const allAccounts = client.request("get", "/accounts");
  Logger.log(formatAccountCounts(availableAccounts, allAccounts));

  const lookups = lookupAccountsByName(availableAccounts);
  for (const l of lookups) {
    Logger.log(formatAccountLookup(l));
  }

  const taxes = client.request("get", "/taxes");
  const taxIds = collectTaxIds(lookups);
  if (taxIds.length === 0) {
    Logger.log("S-M3 税区分: 見つかった科目に tax_id がありません");
  }
  for (const id of taxIds) {
    Logger.log(formatTaxLine(id, taxes));
  }
}

/**
 * 手動実行: スパイク S-M1・S-M2（実装設計 MF連携 §11.1）。請求書 KD-TEST-S1 を作って金額・設定・
 * 検索の挙動を確かめ、最後に削除する（前回の削除失敗分があれば作らずに回収して使う）。
 * シートには書かず、`MF_*_ENABLED` フラグも見ない。**トークンは出力しない**。
 */
export function mfInvoiceSpikeS1(): void {
  runInvoiceSpikeS1(buildPorts(), (line) => Logger.log(line));
}

/**
 * 手動実行: スパイク S-M5 の `POST /journals` 部分（実装設計 MF連携 §11.1）。テスト仕訳
 * （tags `kadobo-spike-s5`、借方 雑費 1 円／貸方 事業主借 1 円、`tax_id` なし）を作り、免税設定で税区分が
 * どう入ったか・tags 検索で見つかるか・削除できるかを Logger に出して、最後に必ず削除する
 * （前回の削除失敗分があれば作らずに回収して使う）。シートには書かず、`MF_*_ENABLED` フラグも見ない。
 * 連携明細の `journalize` は WP-M5。**API キー・トークンは出力しない**。
 */
export function mfJournalSpikeS5(): void {
  runJournalSpikeS5(buildPorts(), (line) => Logger.log(line));
}

/**
 * 手動実行: スパイク S-M4（実装設計 MF連携 §11.1）。連携サービス・口座の一覧（科目名つき）、
 * `connected_account_id` のクエリ表記の探査、絞り込みなしで取った直近 90 日の明細（最大 3 ページ）を
 * 連携サービスごとに分けた出力（先頭 40 件・口座名・`date` の範囲・`journalizing_status` の集計・
 * NISA・積立・カード・引落しを含む `content`）を Logger に出す。
 * **読み取り専用**（GET だけ）。シートには書かず、`MF_*_ENABLED` フラグも見ない。
 * **API キー・トークンは出力しない**。
 */
export function mfTransactionSpikeS4(): void {
  runTransactionSpikeS4(buildPorts(), (line) => Logger.log(line));
}
