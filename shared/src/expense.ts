/**
 * 経費フェーズの共有定数（実装設計 経費フェーズ §2.3）。
 *
 * Worker（モーダル生成・同期バリデーション）と GAS（二重検証）の**両方**が読む。
 * `protocol.ts` と同じく DOM・Node 固有 API・`crypto` に依存しない。
 */

/** 経費カテゴリ（要件定義 §4.3.1）。モーダルの `static_select` の選択肢そのもの。 */
export const EXPENSE_CATEGORIES = [
  "通信費",
  "消耗品費",
  "旅費交通費",
  "新聞図書費",
  "会議費",
  "支払手数料",
  "その他",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/**
 * 証憑区分（要件定義 §9 v1.1 の決定「証憑区分（紙／電子取引）を必須化」）。
 *
 * 値は MF クラウド経費 API の `receipt_type`（`paper` / `e_doc`）と同じ語を使う。
 * 将来 MF 側へ寄せる場合の変換を不要にするため（`docs/未決事項・デプロイ前確認.md` §6.7-2）。
 */
export const RECEIPT_TYPES = ["paper", "e_doc"] as const;

export type ReceiptType = (typeof RECEIPT_TYPES)[number];

/** 証憑ファイルの許可拡張子（すべて小文字。比較前に入力を小文字化すること）。 */
export const EXPENSE_ALLOWED_EXTENSIONS = ["jpg", "jpeg", "png", "heic", "pdf"] as const;

export type ExpenseExtension = (typeof EXPENSE_ALLOWED_EXTENSIONS)[number];

/**
 * 証憑ファイルの業務上限（10MB）。
 *
 * Slack の `file_input` 自体は 100MB まで受け付け、GAS の `UrlFetchApp` のレスポンス上限は
 * 50MB だが、GAS の処理時間・メモリと Worker のタイムアウト（{@link GAS_TIMEOUT_MS}）に
 * 収めるため業務上限を別に設ける（要件定義 §4.3.1）。実測は WP5 の S4 で行う。
 */
export const EXPENSE_MAX_FILE_BYTES = 10 * 1024 * 1024;

/** 取引先の最大文字数（コードポイント単位）。 */
export const EXPENSE_PARTNER_MAX_LENGTH = 100;

/** メモの最大文字数（コードポイント単位）。 */
export const EXPENSE_MEMO_MAX_LENGTH = 200;

/**
 * Drive 上のファイル名に埋め込む取引先の最大長（コードポイント単位）。
 * ファイル名全体を 255 バイトに収めるための切り詰め長（実装設計 経費フェーズ §5.5）。
 */
export const EXPENSE_PARTNER_FILENAME_MAX_LENGTH = 32;

/**
 * `url_private` の取得を許可するホスト（実装設計 経費フェーズ §5.5 の SSRF 対策）。
 *
 * GAS は Bot トークンを `Authorization` ヘッダーに付けて GET するため、任意のホストへ
 * リクエストできてしまうとトークン漏えいになる。Worker と GAS の**両方**で検証する。
 */
export const SLACK_FILE_ALLOWED_HOSTS = ["files.slack.com", "slack.com"] as const;

/** 経費台帳の処理状態（実装設計 経費フェーズ §5.1）。 */
export const EXPENSE_STATES = [
  /** 台帳行を確保した。Drive 未保存。 */
  "RECEIVED",
  /** Drive 保存が完了し、リンク・ハッシュ・サイズを台帳へ書いた。 */
  "FILE_SAVED",
  /** 全項目が揃い確定した。 */
  "COMPLETED",
  /** 再試行しても直らないエラーで確定失敗。`/keihi` からやり直す。 */
  "ERROR",
  /** 訂正され、後続の証憑 ID に引き継がれた。 */
  "CORRECTED",
  /** 誤登録・重複として取り消した。 */
  "VOID",
] as const;

export type ExpenseState = (typeof EXPENSE_STATES)[number];

/** {@link EXPENSE_CATEGORIES} に含まれるか。 */
export function isExpenseCategory(v: unknown): v is ExpenseCategory {
  return typeof v === "string" && (EXPENSE_CATEGORIES as readonly string[]).includes(v);
}

/** {@link RECEIPT_TYPES} に含まれるか。 */
export function isReceiptType(v: unknown): v is ReceiptType {
  return typeof v === "string" && (RECEIPT_TYPES as readonly string[]).includes(v);
}

/**
 * ファイル名から拡張子を取り出して小文字で返す（`.` は含まない）。
 * `.` を含まない・末尾が `.` の場合は `null`。
 */
export function extensionOf(filename: string): string | null {
  const idx = filename.lastIndexOf(".");
  if (idx < 0 || idx === filename.length - 1) {
    return null;
  }
  return filename.slice(idx + 1).toLowerCase();
}

/** {@link EXPENSE_ALLOWED_EXTENSIONS} に含まれるか（呼び出し側で小文字化済みであること）。 */
export function isAllowedExtension(ext: string): ext is ExpenseExtension {
  return (EXPENSE_ALLOWED_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * `url_private` のホストが {@link SLACK_FILE_ALLOWED_HOSTS} に含まれるか。
 *
 * `URL` に依存せず手で解析する（GAS の V8 ランタイムでも同じ実装が動くようにするため）。
 * `https://` 以外のスキームは常に `false`。
 */
export function isAllowedSlackFileUrl(url: string): boolean {
  const prefix = "https://";
  if (!url.startsWith(prefix)) {
    return false;
  }
  const rest = url.slice(prefix.length);
  // authority は次の `/`, `?`, `#` のいずれかまで。
  let end = rest.length;
  for (const sep of ["/", "?", "#"]) {
    const i = rest.indexOf(sep);
    if (i >= 0 && i < end) {
      end = i;
    }
  }
  const authority = rest.slice(0, end);
  // userinfo（`user@host`）を使った偽装を弾くため、`@` を含むものは拒否する。
  if (authority.includes("@")) {
    return false;
  }
  // ポート指定は許可しない（Slack の URL には現れない）。
  const host = authority.toLowerCase();
  return (SLACK_FILE_ALLOWED_HOSTS as readonly string[]).includes(host);
}
