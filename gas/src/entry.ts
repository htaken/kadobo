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
import type { AppPorts } from "./app/ports";
import {
  trigEveningCheck as runEveningCheck,
  trigMonthly as runMonthly,
  trigMorningCard as runMorningCard,
} from "./app/triggers";
import { CacheAdapter } from "./adapters/cache";
import { CalendarAdapter } from "./adapters/calendar";
import { ClockAdapter } from "./adapters/clock";
import { HmacAdapter } from "./adapters/hmac";
import { LockAdapter } from "./adapters/lock";
import { PropsAdapter } from "./adapters/props";
import { RandomAdapter } from "./adapters/random";
import { SheetsAdapter, setupSpreadsheet as setupSpreadsheetImpl } from "./adapters/sheets";
import { SlackAdapter } from "./adapters/slack";
import { installTriggers as installTriggersImpl } from "./adapters/triggers";
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
