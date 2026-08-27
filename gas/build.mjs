// GAS ビルドスクリプト（実装設計 §1, §8 WP0）。
//
// src/entry.ts を esbuild で IIFE（globalName `__kadobo`）にバンドルして dist/Code.js を生成し、
// 末尾に `function doPost(e) { return __kadobo.doPost(e); }` 等のトップレベル `function` 宣言を
// 追記する（GAS のスクリプトエディタ・トリガー設定画面はトップレベル関数しか認識しないため）。
// appsscript.json も dist にコピーする。

import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, "dist");
const outfile = path.join(outdir, "Code.js");

mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: [path.join(here, "src/entry.ts")],
  outfile,
  bundle: true,
  format: "iife",
  globalName: "__kadobo",
  // GAS の V8 ランタイムを想定した控えめなターゲット。
  target: "es2020",
  platform: "neutral",
  legalComments: "none",
  logLevel: "info",
});

/**
 * GAS から直接呼ばれるエントリ関数（doPost・setupSpreadsheet・トリガー関数）。
 * `doPost` のみイベントオブジェクト `e` を受け取る。
 */
const entryFns = [
  { name: "doPost", args: "e" },
  { name: "setupSpreadsheet", args: "" },
  { name: "installTriggers", args: "" },
  { name: "trigMorningCard", args: "" },
  { name: "trigEveningCheck", args: "" },
  { name: "trigMonthly", args: "" },
];

const wrappers = entryFns
  .map(({ name, args }) => `function ${name}(${args}) { return __kadobo.${name}(${args}); }`)
  .join("\n");

const bundled = readFileSync(outfile, "utf8");
writeFileSync(outfile, `${bundled}\n${wrappers}\n`);

copyFileSync(path.join(here, "appsscript.json"), path.join(outdir, "appsscript.json"));

console.log(`[gas/build.mjs] wrote ${path.relative(here, outfile)} and dist/appsscript.json`);
