/**
 * 経費フェーズ（`/keihi`）の GAS core 純関数（実装設計 経費フェーズ §5.5）。
 * 証憑 ID・保存先フォルダ・保存ファイル名の生成、Sheets 数式インジェクション対策（§4.4）、
 * 同期バリデーションの二重検証（§4.3）、マジックバイト判定を扱う。
 * `SpreadsheetApp`/`UrlFetchApp`/`Utilities`/`DriveApp` 等の GAS グローバルには一切依存しない。
 */

import {
  EXPENSE_ALLOWED_EXTENSIONS,
  EXPENSE_MAX_FILE_BYTES,
  EXPENSE_MEMO_MAX_LENGTH,
  EXPENSE_PARTNER_FILENAME_MAX_LENGTH,
  EXPENSE_PARTNER_MAX_LENGTH,
  extensionOf,
  isAllowedExtension,
  isAllowedSlackFileUrl,
  isExpenseCategory,
  isReceiptType,
  type ReceiptType,
} from "@kadobo/shared/expense";
import type { GasRequest } from "@kadobo/shared/protocol";
import { isValidDateString } from "@kadobo/shared/time";

/** `expense_submit` ペイロード（実装設計 経費フェーズ §3.1）。 */
export type ExpenseSubmitRequest = Extract<GasRequest, { kind: "expense_submit" }>;

// ---------------------------------------------------------------------------
// 証憑 ID・保存先・保存ファイル名（実装設計 §5.5）
// ---------------------------------------------------------------------------

/**
 * 証憑 ID を発番する（実装設計 §5.5）。`R-YYYYMMDD-NNN`（001 始まり、3 桁ゼロ埋め）。
 * `seq` が 999 を超える場合はそのまま桁が伸びる（例: `seq=1000` → `R-20260901-1000`）。
 */
export function makeReceiptId(dateJst: string, seq: number): string {
  const compactDate = dateJst.replace(/-/g, "");
  const seqStr = String(seq).padStart(3, "0");
  return `R-${compactDate}-${seqStr}`;
}

/** 証憑の Drive 保存先フォルダパス（実装設計 §5.5）。`経費証憑/{紙|電子取引}/YYYY/MM`。 */
export function receiptFolderPath(receiptType: ReceiptType, date: string): string {
  const [year, month] = date.split("-");
  const typeLabel = receiptType === "paper" ? "紙" : "電子取引";
  return `経費証憑/${typeLabel}/${year}/${month}`;
}

/**
 * ファイル名に使えない記号（`/ \ : * ? " < > |`）と制御文字を `_` に置換し、連続する `_` を
 * 1 つに畳み、前後の `_` を削る（実装設計 §5.5）。
 */
function sanitizePartnerForFileName(partner: string): string {
  // Windows/Drive のファイル名で使えない記号（`/ \ : * ? " < > |`）と制御文字（0x00-0x1F, 0x7F）。
  const replaced = partner.replace(/[/\\:*?"<>|\x00-\x1f\x7f]/g, "_");
  const collapsed = replaced.replace(/_+/g, "_");
  return collapsed.replace(/^_+|_+$/g, "");
}

/**
 * 証憑ファイルの保存ファイル名を生成する（実装設計 §5.5）。
 * `YYYYMMDD_金額円_取引先_証憑ID.拡張子`。
 *
 * 取引先は {@link sanitizePartnerForFileName} でサニタイズしたのち、**コードポイント単位**で
 * {@link EXPENSE_PARTNER_FILENAME_MAX_LENGTH} 字に切り詰める（`Array.from` を使い、絵文字等の
 * サロゲートペアを途中で壊さない）。切り詰めた末尾がちょうど `_` になると、ファイル名の
 * 区切りの `_` と連続して `__` になってしまうため、切り詰め後にもう一度前後の `_` を削る。
 * その結果空文字になった場合（サニタイズ後がそもそも空だった場合を含む）は `取引先不明` と
 * する。拡張子は小文字化する。
 */
export function receiptFileName(input: {
  date: string;
  amount: number;
  partner: string;
  receiptId: string;
  extension: string;
}): string {
  const compactDate = input.date.replace(/-/g, "");
  const sanitized = sanitizePartnerForFileName(input.partner);
  const truncated = Array.from(sanitized)
    .slice(0, EXPENSE_PARTNER_FILENAME_MAX_LENGTH)
    .join("");
  const trimmed = truncated.replace(/^_+|_+$/g, "");
  const partner = trimmed === "" ? "取引先不明" : trimmed;
  const extension = input.extension.toLowerCase();
  return `${compactDate}_${input.amount}円_${partner}_${input.receiptId}.${extension}`;
}

// ---------------------------------------------------------------------------
// Sheets 数式インジェクション対策（実装設計 §4.4）
// ---------------------------------------------------------------------------

/**
 * Sheets 数式インジェクション対策（実装設計 §4.4）。
 * 先頭が `=` `+` `-` `@` のいずれかであれば `'`（アポストロフィ）を前置してテキストとして
 * 固定する。それ以外はそのまま返す。
 */
export function escapeSheetFormula(s: string): string {
  const head = s.charAt(0);
  if (head === "=" || head === "+" || head === "-" || head === "@") {
    return `'${s}`;
  }
  return s;
}

// ---------------------------------------------------------------------------
// 同期バリデーション（実装設計 §4.3）— Worker と GAS の二重検証
// ---------------------------------------------------------------------------

/**
 * `/keihi` モーダル送信内容の業務検証（実装設計 §4.3）。エラーメッセージの配列を返す
 * （空配列なら OK）。Worker の同期バリデーションと**同じ判定**を GAS 側でも行う二重検証で、
 * フェーズ 1 の台帳追記より前に呼ぶこと（§5.5 の 🔄 変更点）。Cron 再送で古い・壊れた
 * ペイロードが来る可能性があるため、`datepicker` 等 Worker 側の入力保証を信用しない。
 *
 * `req.amount` は Worker が既にカンマ・空白除去のうえ整数へ変換済みの値が渡ってくる想定の
 * ため、ここでは「整数かつ 1 以上」のみを再検証する。`date` の形式・実在性チェックは
 * Worker と GAS の二重検証で同じ判定を 2 箇所に書くと片方だけ直る事故が起きるため、
 * `@kadobo/shared/time` の {@link isValidDateString} を共通で使う。
 */
export function validateExpenseInput(req: ExpenseSubmitRequest, todayJst: string): string[] {
  const errors: string[] = [];

  if (!isReceiptType(req.receipt_type)) {
    errors.push("証憑区分を選択してください");
  }

  if (req.date === "" || !isValidDateString(req.date)) {
    // 空・形式不正・実在しない日付（§4.3 の `date` ブロックのメッセージを流用）。
    // 形式不正を先に弾くことで、後続の「未来日」判定へ壊れた値のまま進めない。
    errors.push("日付を選択してください");
  } else if (req.date > todayJst) {
    errors.push("未来の日付は登録できません");
  }

  if (!Number.isInteger(req.amount) || req.amount < 1) {
    errors.push("金額を半角数字で入力してください");
  }

  if (!isExpenseCategory(req.category)) {
    errors.push("カテゴリを選択してください");
  }

  if (req.partner.trim() === "" || Array.from(req.partner).length > EXPENSE_PARTNER_MAX_LENGTH) {
    errors.push(`取引先を入力してください（${EXPENSE_PARTNER_MAX_LENGTH} 字以内）`);
  }

  if (Array.from(req.memo).length > EXPENSE_MEMO_MAX_LENGTH) {
    errors.push(`メモは ${EXPENSE_MEMO_MAX_LENGTH} 字以内で入力してください`);
  }

  if (!req.file) {
    errors.push("証憑ファイルを 1 つ添付してください");
  } else {
    const nameExt = extensionOf(req.file.name);
    const filetypeExt = req.file.filetype.toLowerCase();
    const extensionOk =
      nameExt !== null && isAllowedExtension(nameExt) && isAllowedExtension(filetypeExt);
    if (!extensionOk) {
      errors.push("jpg / jpeg / png / heic / pdf のいずれかを添付してください");
    }
    if (req.file.size > EXPENSE_MAX_FILE_BYTES) {
      errors.push(`ファイルは ${EXPENSE_MAX_FILE_BYTES / (1024 * 1024)}MB 以内にしてください`);
    }
    if (!isAllowedSlackFileUrl(req.file.url_private)) {
      errors.push("添付ファイルを認識できませんでした");
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// マジックバイト判定（実装設計 §5.5）
// ---------------------------------------------------------------------------

/**
 * ISO BMFF（HEIC/HEIF）の `ftyp` ボックスに現れるブランド（実装設計 §5.5 の「等」の範囲）。
 * メジャーブランドがこの中のいずれかなら HEIC 系とみなす。
 */
const HEIC_BRANDS = [
  "heic",
  "heix",
  "hevc",
  "hevx",
  "mif1",
  "msf1",
  "heim",
  "heis",
  "hevm",
  "hevs",
];

/**
 * GAS の byte array を 0〜255 の符号なしバイト値へ正規化して読む。
 * `Utilities` 由来の byte array は環境により -128〜127 の符号付きで返ることがあるため、
 * 負値は `+256` して正規化する。配列の範囲外は `-1`（どの符号にも一致しない番兵）を返す。
 */
function byteAt(bytes: number[], index: number): number {
  const v = bytes[index];
  if (v === undefined) {
    return -1;
  }
  return v < 0 ? v + 256 : v;
}

function matchesSignature(bytes: number[], offset: number, signature: number[]): boolean {
  return signature.every((expected, i) => byteAt(bytes, offset + i) === expected);
}

/**
 * マジックバイトでファイル形式を判定する（実装設計 §5.5）。Slack が申告する Content-Type を
 * 信用せず、実バイト列から判定するための関数。該当しなければ `null`。
 *
 * - jpg: 先頭 `FF D8 FF`
 * - png: 先頭 `89 50 4E 47 0D 0A 1A 0A`
 * - pdf: 先頭 `%PDF-`（`25 50 44 46 2D`）
 * - heic: ISO BMFF。オフセット 4 から `ftyp`（`66 74 79 70`）、続く 4 バイトのブランドが
 *   {@link HEIC_BRANDS} のいずれか
 */
export function sniffFileType(bytes: number[]): "jpg" | "png" | "pdf" | "heic" | null {
  if (matchesSignature(bytes, 0, [0xff, 0xd8, 0xff])) {
    return "jpg";
  }
  if (matchesSignature(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return "png";
  }
  if (matchesSignature(bytes, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])) {
    return "pdf";
  }
  if (matchesSignature(bytes, 4, [0x66, 0x74, 0x79, 0x70])) {
    const brand = String.fromCharCode(
      byteAt(bytes, 8),
      byteAt(bytes, 9),
      byteAt(bytes, 10),
      byteAt(bytes, 11),
    );
    if (HEIC_BRANDS.includes(brand)) {
      return "heic";
    }
  }
  return null;
}
