/**
 * `expense_submit` ユースケース（実装設計 経費フェーズ §5.4）— saga 本体。**経費フェーズの中核**。
 *
 * 3 フェーズに分割する。フェーズ分割と検索順序は Codex レビューで潰した 2 つの Blocker——
 * (a) Drive 保存後に台帳更新が失敗すると再送で重複ファイルができる、
 * (b) 10MB の外部 I/O をロック内で行うと本番稼働中の打刻が `LOCK_TIMEOUT` になる——
 * を再発させないための構造なので、変えないこと。
 *
 * 【フェーズ1】短いロック — 受付と再開点の決定（`idempotency_key` で重複判定・証憑ID採番・
 *              台帳行の先行作成）
 * 【フェーズ2】ロック外 — 重い I/O（Slack ファイルのダウンロード・実サイズ/マジックバイト
 *              検証・SHA-256）。10MB で数秒〜十数秒かかる（実装設計 §8 S4）ため、
 *              ここでロックを持つと打刻が待たされてしまう
 * 【フェーズ3】短いロック — 状態再確認 → Drive（保存前に必ず `findByName` で検索）→ 確定
 *
 * **なぜ冪等になるか**: 保存ファイル名には**その台帳行にしか割り当てられない証憑ID**が
 * 含まれる（`core/expense.ts` の `receiptFileName`）。したがって `folderPath` に同名ファイルが
 * あれば、それは「この行の過去の試行が作ったもの」以外にありえない。「Drive 保存は成功したが
 * 直後の `updateExpense` が失敗 → 再送」でも、再送時のフェーズ3で 1 件見つかり**再利用**される
 * ため、Drive への書込みは高々1回になる。サイズ一致は同一性の証明ではないが、証憑IDがファイル名
 * に入っている以上、別内容の同名ファイルは「過去の試行で別のバイト列を保存した」場合しか起こらず、
 * それは異常として `DRIVE_CONFLICT` で人手に回すのが正しい（実装設計 §5.4 の注記）。
 */
import { EXPENSE_MAX_FILE_BYTES } from "@kadobo/shared/expense";
import type { GasResponse } from "@kadobo/shared/protocol";
import { businessDateOf } from "@kadobo/shared/time";
import {
  escapeSheetFormula,
  makeReceiptId,
  receiptFileName,
  receiptFolderPath,
  sniffFileType,
  validateExpenseInput,
  type ExpenseSubmitRequest,
} from "../core/expense";
import { formatYen } from "./monthly";
import {
  ConfigMissingError,
  SlackFileFetchError,
  SlackFileForbiddenError,
  SlackFileNotFoundError,
  SlackFileUnavailableError,
  type AppPorts,
  type DriveFileInfo,
  type ExpenseLedgerRow,
} from "./ports";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// フェーズ1: 短いロック — 受付と再開点の決定
// ---------------------------------------------------------------------------

type Phase1Outcome =
  | { kind: "response"; response: GasResponse }
  | { kind: "resume"; receiptId: string; needsDownload: boolean };

/** `内部` シートの `receipt_seq`（実装設計 §5.2）。日付ごとに発行済み連番の最大値を管理する。 */
function nextReceiptSeq(dateJst: string, ports: AppPorts): number {
  const compactDate = dateJst.replace(/-/g, "");
  const current = ports.sheets.getInternalValue("receipt_seq", compactDate);
  const next = current === null ? 1 : parseInt(current, 10) + 1;
  ports.sheets.setInternalValue("receipt_seq", compactDate, String(next));
  return next;
}

function phase1(req: ExpenseSubmitRequest, ports: AppPorts): Phase1Outcome {
  return ports.lock.withLock((): Phase1Outcome => {
    const existing = ports.sheets.findExpenseByIdempotencyKey(req.idempotency_key);

    if (existing !== null) {
      if (existing.state === "COMPLETED") {
        return { kind: "response", response: { ok: true, applied: false, reason: "DUPLICATE" } };
      }
      if (existing.state === "ERROR" || existing.state === "VOID") {
        return {
          kind: "response",
          response: { ok: false, error: existing.last_error ?? existing.state, retryable: false },
        };
      }
      // RECEIVED / FILE_SAVED → 再開。証憑IDを引き継ぐ。
      // （`CORRECTED` はこの分岐に来ない: 訂正フロー(WP8c)は別の証憑IDへ新規行を作る際に
      //   「旧行」へ設定するものであり、旧行の idempotency_key で expense_submit が
      //   再送されることは無い。）
      return {
        kind: "resume",
        receiptId: existing.receipt_id,
        needsDownload: existing.state === "RECEIVED",
      };
    }

    // 新規受付。`validateExpenseInput` は台帳追記より前に呼ぶ（実装設計 §5.5 の 🔄 変更点）。
    // Worker が既に同期検証済みだが、Cron 再送で古い・壊れたペイロードが来る経路があるため
    // GAS 側でも二重検証する。
    const todayJst = businessDateOf(ports.clock.nowMs());
    const errors = validateExpenseInput(req, todayJst);
    if (errors.length > 0) {
      return { kind: "response", response: { ok: false, error: "BAD_REQUEST", retryable: false } };
    }

    const seq = nextReceiptSeq(req.date, ports);
    const receiptId = makeReceiptId(req.date, seq);
    const nowMs = ports.clock.nowMs();
    const row: ExpenseLedgerRow = {
      receipt_id: receiptId,
      receipt_type: req.receipt_type,
      date: req.date,
      amount: req.amount,
      // Sheets 数式インジェクション対策（実装設計 §4.4）。台帳に書く直前に通す。
      partner: escapeSheetFormula(req.partner),
      category: req.category,
      memo: escapeSheetFormula(req.memo),
      drive_link: "",
      file_hash: "",
      mime_type: "",
      size: 0,
      input_at: req.received_at_ms,
      state: "RECEIVED",
      mf_journal_id: null,
      idempotency_key: req.idempotency_key,
      slack_file_id: req.file.id,
      drive_file_id: "",
      original_file_name: req.file.name,
      last_error: null,
      state_updated_at: nowMs,
      tax_category: "",
      business_use_ratio: 100,
      correction_of_receipt_id: null,
      correction_reason: null,
    };
    ports.sheets.appendExpense(row);
    return { kind: "resume", receiptId, needsDownload: true };
  });
}

// ---------------------------------------------------------------------------
// フェーズ2: ロック外 — 重い I/O（ダウンロード・検証・ハッシュ）
// ---------------------------------------------------------------------------

interface DownloadOk {
  kind: "ok";
  bytes: number[];
  contentType: string;
  hash: string;
  sniffedExt: "jpg" | "png" | "pdf" | "heic";
}

interface DownloadErr {
  kind: "error";
  error: string;
  retryable: boolean;
}

type DownloadResult = DownloadOk | DownloadErr;

/** `SlackFilesPort.download` の例外を §3.2 のエラーコードへ写像する。 */
function mapSlackFileError(err: unknown): DownloadErr {
  if (err instanceof SlackFileNotFoundError) {
    return { kind: "error", error: "FILE_NOT_FOUND", retryable: false };
  }
  if (err instanceof SlackFileForbiddenError) {
    return { kind: "error", error: "FILE_FORBIDDEN", retryable: false };
  }
  if (err instanceof SlackFileUnavailableError) {
    return { kind: "error", error: "FILE_UNAVAILABLE", retryable: false };
  }
  if (err instanceof SlackFileFetchError) {
    return { kind: "error", error: "FILE_FETCH_FAILED", retryable: true };
  }
  // 未分類の例外はここでは判定できないため、そのまま上位（dispatch）へ伝播させ、
  // 総括 catch により retryable:true として扱わせる。
  throw err;
}

/**
 * フェーズ2本体（ロックを持たない）。ダウンロード → 実サイズ・マジックバイト検証 → SHA-256。
 * `resume=='FILE_SAVED'` のとき（呼び出し側で `needsDownload=false` の場合）は呼ばれない。
 *
 * 🔄 Content-Type は検証に使わない（設計 §5.4 の改訂）。Slack が付けるラベルにすぎず実バイト列
 * と食い違いうるため（`image/jpg` のような非標準値、HEIC に対する `application/octet-stream`
 * 等）、厳密な対応表で弾くと正当な証憑を非再試行で拒否してしまう。実バイト列を見る
 * マジックバイト判定（`sniffFileType`）がすでに通っている以上、ラベルの不一致で経費登録を
 * 失敗させる利益はない。受け取った Content-Type は監査証跡として `元MIME` 列にそのまま記録する
 * （`downloaded.contentType` → `mime_type`。判定には使わない）。
 */
function downloadAndValidateFile(req: ExpenseSubmitRequest, ports: AppPorts): DownloadResult {
  let bytes: number[];
  let contentType: string;
  try {
    const result = ports.slackFiles.download(req.file.url_private);
    bytes = result.bytes;
    contentType = result.contentType;
  } catch (err) {
    return mapSlackFileError(err);
  }

  // 実サイズ検証（Slack の申告値 `req.file.size` ではなく実ダウンロードサイズで判定する）。
  if (bytes.length > EXPENSE_MAX_FILE_BYTES) {
    return { kind: "error", error: "FILE_TOO_LARGE", retryable: false };
  }

  const sniffed = sniffFileType(bytes);
  if (sniffed === null) {
    return { kind: "error", error: "FILE_INVALID", retryable: false };
  }

  const hash = ports.digest.sha256Hex(bytes);
  return { kind: "ok", bytes, contentType, hash, sniffedExt: sniffed };
}

/** 非再試行エラーの記録（実装設計 §5.4）: `処理状態` を `ERROR` にし `last_error` に記録する。 */
function markExpenseError(receiptId: string, code: string, ports: AppPorts): void {
  ports.lock.withLock(() => {
    ports.sheets.updateExpense(receiptId, {
      state: "ERROR",
      last_error: code,
      state_updated_at: ports.clock.nowMs(),
    });
  });
}

// ---------------------------------------------------------------------------
// Drive 設定不備（`DRIVE_RECEIPT_ROOT_ID` 未設定、実装設計 §3.2, §5.9 の改訂）
// ---------------------------------------------------------------------------

/**
 * 設定不備（`ConfigMissingError`。実装設計 §3.2, §5.9）を運用者へ通知する。**利用者向けでは
 * なく運用者向け**の文面にする（`/keihi` からやり直しても直らない不具合のため）。宛先は
 * `SLACK_USER_ID`（実装設計 §7.8。`trigEveningCheck` 等、既存の運用通知と同じ宛先）。
 * 未設定で送りようが無い場合、および DM 自体の送信失敗はベストエフォート（台帳の
 * `last_error` に `propertyKey` を含めて記録済みなので、運用者はそこからも気づける）。
 */
function notifyConfigMissing(propertyKey: string, ports: AppPorts): void {
  const operatorId = ports.props.get("SLACK_USER_ID");
  if (operatorId === null) {
    return;
  }
  try {
    ports.slack.dm(
      operatorId,
      `⚠️ 経費機能の設定が未完了です（${propertyKey} が未設定）。` +
        "証憑ルートフォルダを作成し、Script Property に ID を設定してから経費機能を有効化してください。",
    );
  } catch {
    // 通知自体の失敗は握りつぶす（ベストエフォート）。
  }
}

/**
 * `ports.drive.findByName`/`saveFile` の例外を写像する（**phase3 のロック内から呼ぶ前提**。
 * ここで追加のロックは取得しない）。`ConfigMissingError`（Script Property 未設定。`ports.ts`
 * が定義する専用の例外クラスで判定する。メッセージの部分一致に頼らない）は**時間経過では
 * 直らない設定不備**のため `CONFIG_MISSING`（retryable:false。§3.2 の未分類4xxと同じ理由で
 * 非再試行に倒す。Cron 再送に上限が無いため retryable のままだと無限に再送され続ける）。
 * それ以外は Drive の一時失敗として `DRIVE_FAILED`（retryable:true。台帳は変更せず
 * `RECEIVED` のまま再送で再試行させる）。
 */
function handleDriveError(err: unknown, receiptId: string, ports: AppPorts): GasResponse {
  if (err instanceof ConfigMissingError) {
    // レスポンスの `error` は §3.2 の固定コード `CONFIG_MISSING` のまま返す（Worker 側が
    // 判定に使う固定語彙のため）。`last_error`（台帳・運用者向け）だけは `propertyKey` を
    // 併記し、運用者が台帳を見るだけで「何を設定すべきか」分かるようにする。
    const lastError = `CONFIG_MISSING:${err.propertyKey}`;
    ports.sheets.updateExpense(receiptId, {
      state: "ERROR",
      last_error: lastError,
      state_updated_at: ports.clock.nowMs(),
    });
    notifyConfigMissing(err.propertyKey, ports);
    return { ok: false, error: "CONFIG_MISSING", retryable: false };
  }
  return { ok: false, error: "DRIVE_FAILED", retryable: true };
}

// ---------------------------------------------------------------------------
// 完了通知（実装設計 §5.4）
// ---------------------------------------------------------------------------

/**
 * 本人へ DM で完了を通知する。**DM 失敗は握り潰さず** `last_error` に記録するが、
 * `処理状態` は `COMPLETED` のままにする（利用者が「登録されていない」と誤解して
 * 二重入力する誘因を残さないため。通知漏れは週次照合（WP8c）で報告する）。
 */
function notifyCompletion(
  receiptId: string,
  driveLink: string,
  req: ExpenseSubmitRequest,
  ports: AppPorts,
): void {
  const text =
    `✅ 経費を登録しました \`${receiptId}\` / ${req.date} / ${formatYen(req.amount)} / ` +
    `${req.category} / ${req.partner}\n${driveLink}`;
  try {
    ports.slack.dm(req.user_id, text);
  } catch (err) {
    ports.sheets.updateExpense(receiptId, {
      last_error: `DM_FAILED:${errorMessage(err)}`,
      state_updated_at: ports.clock.nowMs(),
    });
  }
}

// ---------------------------------------------------------------------------
// フェーズ3: 短いロック — 状態再確認 → Drive → 確定
// ---------------------------------------------------------------------------

function phase3(
  receiptId: string,
  req: ExpenseSubmitRequest,
  downloaded: DownloadOk | null,
  ports: AppPorts,
): GasResponse {
  return ports.lock.withLock((): GasResponse => {
    // フェーズ1で必ず先にこの証憑IDの行を作っているため、無ければ呼び出し順序の誤り。
    const row = ports.sheets.getExpenseByReceiptId(receiptId);
    if (row === null) {
      throw new Error(`expense_submit_internal_error:row_not_found:${receiptId}`);
    }

    // フェーズ2の間に（自分自身の別試行、または並行する再送が）先に完了させた可能性を
    // 再確認する（実装設計 §5.4 フェーズ3冒頭）。
    if (row.state === "COMPLETED") {
      return { ok: true, applied: false, reason: "DUPLICATE" };
    }

    let current: ExpenseLedgerRow = row;

    if (current.state === "RECEIVED") {
      if (downloaded === null) {
        // `needsDownload===true` のときのみ phase1 は RECEIVED による resume を返し、
        // そのときは必ず downloadAndValidateFile を呼んでいるので通常は起こらない
        // （防御的チェック）。
        throw new Error(`expense_submit_internal_error:missing_download:${receiptId}`);
      }

      // フォルダ・ファイル名は req（利用者入力そのもの）から組み立てる。台帳の `partner` は
      // Sheets 数式インジェクション対策で `escapeSheetFormula` 済み（先頭に `'` が付き得る）の
      // ため、ファイル名生成には使わない。
      const folderPath = receiptFolderPath(req.receipt_type, req.date);
      const filename = receiptFileName({
        date: req.date,
        amount: req.amount,
        partner: req.partner,
        receiptId,
        extension: downloaded.sniffedExt,
      });

      // ★ 保存前に必ず検索する（実装設計 §5.4 フェーズ3の核心。冒頭のコメント参照）。
      let existingFiles: DriveFileInfo[];
      try {
        existingFiles = ports.drive.findByName(folderPath, filename);
      } catch (err) {
        return handleDriveError(err, receiptId, ports);
      }

      let info: DriveFileInfo;
      if (existingFiles.length === 0) {
        try {
          info = ports.drive.saveFile({
            folderPath,
            filename,
            bytes: downloaded.bytes,
            mimeType: downloaded.contentType,
          });
        } catch (err) {
          return handleDriveError(err, receiptId, ports);
        }
      } else if (existingFiles.length === 1 && existingFiles[0]!.size === downloaded.bytes.length) {
        // 再利用（保存しない）。「Drive 保存は成功したが直後の updateExpense が失敗 → 再送」
        // をここで吸収し、Drive への書込みを高々1回にする。
        info = existingFiles[0]!;
      } else {
        // 同名2件以上、またはサイズ不一致。人手確認が必要な異常。
        ports.sheets.updateExpense(receiptId, {
          state: "ERROR",
          last_error: "DRIVE_CONFLICT",
          state_updated_at: ports.clock.nowMs(),
        });
        return { ok: false, error: "DRIVE_CONFLICT", retryable: false };
      }

      const filePatch: Partial<ExpenseLedgerRow> = {
        drive_file_id: info.id,
        drive_link: info.url,
        file_hash: downloaded.hash,
        mime_type: downloaded.contentType,
        size: downloaded.bytes.length,
        state: "FILE_SAVED",
        state_updated_at: ports.clock.nowMs(),
      };
      ports.sheets.updateExpense(receiptId, filePatch);
      current = { ...current, ...filePatch };
    }

    // 全必須項目の充足を検証（実装設計 §5.4）。RECEIVED→FILE_SAVED の更新が中断した場合の
    // 防御的チェック（通常は起こらない。起きた場合は総括 catch で retryable:true にする）。
    if (
      current.drive_file_id === "" ||
      current.file_hash === "" ||
      current.mime_type === "" ||
      current.size <= 0
    ) {
      throw new Error(`expense_submit_internal_error:incomplete_before_complete:${receiptId}`);
    }

    ports.sheets.updateExpense(receiptId, {
      state: "COMPLETED",
      state_updated_at: ports.clock.nowMs(),
    });

    notifyCompletion(receiptId, current.drive_link, req, ports);

    return { ok: true, applied: true };
  });
}

// ---------------------------------------------------------------------------
// エントリポイント
// ---------------------------------------------------------------------------

/**
 * `expense_submit` ユースケース本体（実装設計 §5.4）。`dispatch.ts` から
 * **ロック外**（`ports.lock.withLock` に包まれない状態）で呼ばれる（実装設計 §5.8）。
 * フェーズ1・フェーズ3で自前にロックを取得・解放するのはこの関数の内部。
 */
export function handleExpenseSubmit(req: ExpenseSubmitRequest, ports: AppPorts): GasResponse {
  const phase1Result = phase1(req, ports);
  if (phase1Result.kind === "response") {
    return phase1Result.response;
  }
  const { receiptId, needsDownload } = phase1Result;

  let downloaded: DownloadOk | null = null;
  if (needsDownload) {
    const result = downloadAndValidateFile(req, ports);
    if (result.kind === "error") {
      if (!result.retryable) {
        markExpenseError(receiptId, result.error, ports);
      }
      // retryable な場合は台帳を変更しない（RECEIVED のまま。Cron 再送でフェーズ2から再開する）。
      return { ok: false, error: result.error, retryable: result.retryable };
    }
    downloaded = result;
  }

  return phase3(receiptId, req, downloaded, ports);
}
