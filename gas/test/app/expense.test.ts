/**
 * `handleExpenseSubmit` のテスト（実装設計 経費フェーズ §5.4, §9 WP8b の受入条件）。
 * 正常系だけでなく**故障注入**（Drive 保存後の台帳更新失敗、FILE_SAVED 後の停止、
 * 同名2件、Slack ファイル取得の各エラー、ロック分割）が本 WP の核心。
 */
import { EXPENSE_MAX_FILE_BYTES } from "@kadobo/shared/expense";
import type { GasRequest } from "@kadobo/shared/protocol";
import { describe, expect, it } from "vitest";
import { handleExpenseSubmit } from "../../src/app/expense";
import {
  ConfigMissingError,
  SlackFileFetchError,
  SlackFileForbiddenError,
  SlackFileNotFoundError,
  SlackFileUnavailableError,
} from "../../src/app/ports";
import { makeReceiptId, receiptFileName, receiptFolderPath } from "../../src/core/expense";
import { makeFakePorts } from "./fakes";

type ExpenseSubmitRequest = Extract<GasRequest, { kind: "expense_submit" }>;

const NOW_MS = Date.parse("2026-09-01T12:00:00+09:00");

/** JPEG のマジックバイト（先頭 `FF D8 FF`）を含む最小のダミーバイト列。 */
const VALID_JPEG_BYTES = [0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0];

function makeExpenseRequest(overrides: Partial<ExpenseSubmitRequest> = {}): ExpenseSubmitRequest {
  const base: ExpenseSubmitRequest = {
    kind: "expense_submit",
    idempotency_key: "V1:0123456789abcdef",
    user_id: "U1",
    view_id: "V1",
    channel_id: "C1",
    receipt_type: "paper",
    date: "2026-09-01",
    amount: 1200,
    category: "消耗品費",
    partner: "○○商店",
    memo: "",
    file: {
      id: "F1",
      name: "receipt.jpg",
      mimetype: "image/jpeg",
      filetype: "jpg",
      size: VALID_JPEG_BYTES.length,
      url_private: "https://files.slack.com/files-pri/T1-F1/receipt.jpg",
    },
    received_at_ms: NOW_MS,
    source: "modal",
  };
  return { ...base, ...overrides };
}

const RECEIPT_ID_1 = makeReceiptId("2026-09-01", 1);
const FOLDER = receiptFolderPath("paper", "2026-09-01");
const FILENAME = receiptFileName({
  date: "2026-09-01",
  amount: 1200,
  partner: "○○商店",
  receiptId: RECEIPT_ID_1,
  extension: "jpg",
});

describe("handleExpenseSubmit — 正常系", () => {
  it("RECEIVED → FILE_SAVED → COMPLETED、Drive に1件保存、DM 送信", () => {
    const ports = makeFakePorts(NOW_MS);
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.expenses).toHaveLength(1);
    const row = ports.sheets.expenses[0]!;
    expect(row.receipt_id).toBe(RECEIPT_ID_1);
    expect(row.state).toBe("COMPLETED");
    expect(row.drive_file_id).not.toBe("");
    expect(row.file_hash).not.toBe("");
    expect(row.mime_type).toBe("image/jpeg");
    expect(row.size).toBe(VALID_JPEG_BYTES.length);
    expect(row.last_error).toBeNull();
    expect(ports.drive.saveCount).toBe(1);
    expect(ports.slack.dms).toHaveLength(1);
    expect(ports.slack.dms[0]!.userId).toBe("U1");
    expect(ports.slack.dms[0]!.text).toContain(RECEIPT_ID_1);
    expect(ports.slack.dms[0]!.text).toContain("2026-09-01");
    expect(ports.slack.dms[0]!.text).toContain("¥1,200");
    expect(ports.slack.dms[0]!.text).toContain("消耗品費");
    expect(ports.slack.dms[0]!.text).toContain("○○商店");
  });
});

describe("handleExpenseSubmit — DUPLICATE", () => {
  it("既に COMPLETED の行があれば再送は DUPLICATE を返し、Drive へ書き込まない", () => {
    const ports = makeFakePorts(NOW_MS);
    const req = makeExpenseRequest();
    handleExpenseSubmit(req, ports);
    const savedBefore = ports.drive.saveCount;

    const result = handleExpenseSubmit({ ...req, source: "retry" }, ports);

    expect(result).toEqual({ ok: true, applied: false, reason: "DUPLICATE" });
    expect(ports.drive.saveCount).toBe(savedBefore);
    expect(ports.sheets.expenses).toHaveLength(1);
  });
});

describe("handleExpenseSubmit — 故障注入: Drive 保存成功後の台帳更新失敗", () => {
  it("Drive 書込は1回だけ（再送時に既存ファイルが検索・再利用される）", () => {
    const ports = makeFakePorts(NOW_MS);
    const req = makeExpenseRequest();

    // FILE_SAVED への updateExpense だけを1回失敗させる（Drive 保存自体は成功させる）。
    const originalUpdate = ports.sheets.updateExpense.bind(ports.sheets);
    let failNext = true;
    ports.sheets.updateExpense = (receiptId, patch) => {
      if (failNext && patch.state === "FILE_SAVED") {
        failNext = false;
        throw new Error("sheets_temporary_error");
      }
      originalUpdate(receiptId, patch);
    };

    // 総括 catch（例外→retryable:true への変換）は dispatch.ts の責務なので、ユースケース
    // 本体（handleExpenseSubmit）を直接呼ぶここでは例外がそのまま伝播する（実装設計 §7.5 と
    // 同じ設計。他のユースケースの「Sheets 等の例外」も dispatch.test.ts 側でのみ検証している）。
    expect(() => handleExpenseSubmit(req, ports)).toThrow("sheets_temporary_error");
    expect(ports.drive.saveCount).toBe(1);
    expect(ports.sheets.expenses[0]!.state).toBe("RECEIVED");

    const result = handleExpenseSubmit({ ...req, source: "retry" }, ports);

    expect(result).toEqual({ ok: true, applied: true });
    // 核心: 2回目でも Drive への書込は増えない（既存ファイルが再利用される）。
    expect(ports.drive.saveCount).toBe(1);
    expect(ports.sheets.expenses[0]!.state).toBe("COMPLETED");
  });
});

describe("handleExpenseSubmit — 故障注入: FILE_SAVED 後に停止", () => {
  it("再送でダウンロードが走らない（Drive 書込も増えない）", () => {
    const ports = makeFakePorts(NOW_MS);
    const req = makeExpenseRequest();

    const originalUpdate = ports.sheets.updateExpense.bind(ports.sheets);
    let failNext = true;
    ports.sheets.updateExpense = (receiptId, patch) => {
      if (failNext && patch.state === "COMPLETED") {
        failNext = false;
        throw new Error("stopped_after_file_saved");
      }
      originalUpdate(receiptId, patch);
    };

    expect(() => handleExpenseSubmit(req, ports)).toThrow("stopped_after_file_saved");
    expect(ports.sheets.expenses[0]!.state).toBe("FILE_SAVED");
    expect(ports.slackFiles.downloads).toHaveLength(1);
    expect(ports.drive.saveCount).toBe(1);

    const result = handleExpenseSubmit({ ...req, source: "retry" }, ports);

    expect(result).toEqual({ ok: true, applied: true });
    // 核心: FILE_SAVED から再開するときダウンロードは走らない。
    expect(ports.slackFiles.downloads).toHaveLength(1);
    expect(ports.drive.saveCount).toBe(1);
    expect(ports.sheets.expenses[0]!.state).toBe("COMPLETED");
  });
});

describe("handleExpenseSubmit — 故障注入: 同名2件", () => {
  it("DRIVE_CONFLICT（retryable:false）で ERROR になる", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.drive.plantFile(FOLDER, FILENAME, { size: VALID_JPEG_BYTES.length });
    ports.drive.plantFile(FOLDER, FILENAME, { size: VALID_JPEG_BYTES.length });
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "DRIVE_CONFLICT", retryable: false });
    expect(ports.sheets.expenses[0]!.state).toBe("ERROR");
    expect(ports.sheets.expenses[0]!.last_error).toBe("DRIVE_CONFLICT");
    expect(ports.drive.saveCount).toBe(0);
  });

  it("同名1件だがサイズ不一致でも DRIVE_CONFLICT", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.drive.plantFile(FOLDER, FILENAME, { size: VALID_JPEG_BYTES.length + 1 });
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "DRIVE_CONFLICT", retryable: false });
  });
});

describe("handleExpenseSubmit — Slack ファイル取得エラーの分岐（§3.2）", () => {
  it("FILE_NOT_FOUND（retryable:false）: 404", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.slackFiles.nextError = new SlackFileNotFoundError();
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "FILE_NOT_FOUND", retryable: false });
    expect(ports.sheets.expenses[0]!.state).toBe("ERROR");
    expect(ports.sheets.expenses[0]!.last_error).toBe("FILE_NOT_FOUND");
  });

  it("FILE_FORBIDDEN（retryable:false）: 401/403", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.slackFiles.nextError = new SlackFileForbiddenError();
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "FILE_FORBIDDEN", retryable: false });
    expect(ports.sheets.expenses[0]!.state).toBe("ERROR");
  });

  it("FILE_UNAVAILABLE（retryable:false）: 429 を除く未分類の 4xx", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.slackFiles.nextError = new SlackFileUnavailableError();
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "FILE_UNAVAILABLE", retryable: false });
    expect(ports.sheets.expenses[0]!.state).toBe("ERROR");
  });

  it("FILE_FETCH_FAILED（retryable:true）: 429・5xx・通信失敗 → 台帳は RECEIVED のまま", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.slackFiles.nextError = new SlackFileFetchError();
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "FILE_FETCH_FAILED", retryable: true });
    expect(ports.sheets.expenses[0]!.state).toBe("RECEIVED");
    expect(ports.sheets.expenses[0]!.last_error).toBeNull();
  });

  it("FILE_TOO_LARGE（retryable:false）: 実ダウンロードサイズが業務上限超過", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.slackFiles.nextResult = {
      bytes: new Array(EXPENSE_MAX_FILE_BYTES + 1).fill(0),
      contentType: "image/jpeg",
    };
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "FILE_TOO_LARGE", retryable: false });
    expect(ports.sheets.expenses[0]!.state).toBe("ERROR");
  });

  it("FILE_INVALID（retryable:false）: マジックバイト不一致", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.slackFiles.nextResult = { bytes: [0, 0, 0, 0], contentType: "image/jpeg" };
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "FILE_INVALID", retryable: false });
    expect(ports.sheets.expenses[0]!.state).toBe("ERROR");
  });

  it("Content-Type がマジックバイトと食い違っても受理される（実装設計 §5.4 の改訂: 判定はマジックバイトのみ）", () => {
    const ports = makeFakePorts(NOW_MS);
    // マジックバイトは正真の JPEG だが、Slack が返す Content-Type は不一致（HEIC で実際に
    // 起こりうる application/octet-stream 等を想定）。これは拒否せず受理し、Content-Type は
    // そのまま 元MIME 列に記録する。
    ports.slackFiles.nextResult = { bytes: VALID_JPEG_BYTES, contentType: "application/octet-stream" };
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    const row = ports.sheets.expenses[0]!;
    expect(row.state).toBe("COMPLETED");
    expect(row.mime_type).toBe("application/octet-stream");
  });
});

describe("handleExpenseSubmit — 故障注入: Drive の一時失敗", () => {
  it("DRIVE_FAILED（retryable:true）: findByName の失敗 → 台帳は RECEIVED のまま", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.drive.nextFindByNameError = new Error("drive_temporary_error");
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "DRIVE_FAILED", retryable: true });
    expect(ports.sheets.expenses[0]!.state).toBe("RECEIVED");
    expect(ports.sheets.expenses[0]!.last_error).toBeNull();
  });

  it("DRIVE_FAILED（retryable:true）: saveFile の失敗 → 台帳は RECEIVED のまま", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.drive.nextSaveError = new Error("drive_temporary_error");
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "DRIVE_FAILED", retryable: true });
    expect(ports.sheets.expenses[0]!.state).toBe("RECEIVED");
  });
});

describe("handleExpenseSubmit — 故障注入: ConfigMissingError（DRIVE_RECEIPT_ROOT_ID 未設定、実装設計 §3.2, §5.9 の改訂）", () => {
  // `gas/src/adapters/drive.ts`（WP8a）が実際に投げる専用の例外クラス。メッセージ文字列には
  // 依存せず、`instanceof ConfigMissingError` と `propertyKey` だけをテストの根拠にする。
  function makeConfigMissingError(): ConfigMissingError {
    return new ConfigMissingError(
      "DRIVE_RECEIPT_ROOT_ID",
      "DRIVE_RECEIPT_ROOT_ID が未設定です（実装設計 経費フェーズ §5.9）。",
    );
  }

  it("findByName 由来: CONFIG_MISSING（retryable:false）で ERROR になり、運用者へ DM する", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.props.set("SLACK_USER_ID", "U_OPS");
    ports.drive.nextFindByNameError = makeConfigMissingError();
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "CONFIG_MISSING", retryable: false });
    expect(ports.sheets.expenses[0]!.state).toBe("ERROR");
    // last_error は propertyKey を併記する（運用者が台帳だけで何を設定すべきか分かるように）。
    expect(ports.sheets.expenses[0]!.last_error).toBe("CONFIG_MISSING:DRIVE_RECEIPT_ROOT_ID");
    expect(ports.slack.dms).toHaveLength(1);
    expect(ports.slack.dms[0]!.userId).toBe("U_OPS");
    expect(ports.slack.dms[0]!.text).toContain("DRIVE_RECEIPT_ROOT_ID");
  });

  it("saveFile 由来: CONFIG_MISSING（retryable:false）で ERROR になる", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.drive.nextSaveError = makeConfigMissingError();
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "CONFIG_MISSING", retryable: false });
    expect(ports.sheets.expenses[0]!.state).toBe("ERROR");
    expect(ports.sheets.expenses[0]!.last_error).toBe("CONFIG_MISSING:DRIVE_RECEIPT_ROOT_ID");
  });

  it("Cron 再送しても直らない（同じ設定不備で再度 retryable:false を返す。台帳は1行のまま）", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.drive.nextFindByNameError = makeConfigMissingError();
    const req = makeExpenseRequest();
    handleExpenseSubmit(req, ports);

    // 再送: phase1 は既存行が ERROR なので即座に last_error を返す（Drive には触れない）。
    const retryResult = handleExpenseSubmit({ ...req, source: "retry" }, ports);

    expect(retryResult).toEqual({
      ok: false,
      error: "CONFIG_MISSING:DRIVE_RECEIPT_ROOT_ID",
      retryable: false,
    });
    expect(ports.sheets.expenses).toHaveLength(1);
  });

  it("SLACK_USER_ID 未設定でも DM 送信をスキップして通常どおり ERROR を返す（通知はベストエフォート）", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.drive.nextFindByNameError = makeConfigMissingError();
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: false, error: "CONFIG_MISSING", retryable: false });
    expect(ports.slack.dms).toHaveLength(0);
  });
});

describe("handleExpenseSubmit — DM 失敗", () => {
  it("DM 送信が失敗しても ok:true,applied:true。last_error に記録し COMPLETED のまま", () => {
    const ports = makeFakePorts(NOW_MS);
    ports.slack.dm = () => {
      throw new Error("slack_api_error:conversations.open");
    };
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    const row = ports.sheets.expenses[0]!;
    expect(row.state).toBe("COMPLETED");
    expect(row.last_error).toContain("DM_FAILED");
  });
});

describe("handleExpenseSubmit — ロック分割（実装設計 経費フェーズ §5.8）", () => {
  it("フェーズ2はロックを保持しない（フェーズ2の最中に別のロック取得が成功する）", () => {
    const ports = makeFakePorts(NOW_MS);
    let concurrentLockSucceeded = false;
    const originalDownload = ports.slackFiles.download.bind(ports.slackFiles);
    ports.slackFiles.download = (url: string) => {
      // フェーズ2（ロック外の重い I/O）の最中に、別のリクエスト（例: 打刻）が
      // ロックを取得できることを確認する。もしフェーズ1のロックを持ったまま
      // ダウンロードしていれば、この withLock はネストして LockTimeoutError を投げる。
      ports.lock.withLock(() => {
        concurrentLockSucceeded = true;
      });
      return originalDownload(url);
    };
    const req = makeExpenseRequest();

    const result = handleExpenseSubmit(req, ports);

    expect(concurrentLockSucceeded).toBe(true);
    expect(result).toEqual({ ok: true, applied: true });
  });
});

describe("handleExpenseSubmit — Sheets 数式インジェクション対策（実装設計 §4.4）", () => {
  it("取引先が `=SUM(A1)` なら台帳には `'=SUM(A1)` として入る（数式にならない）", () => {
    const ports = makeFakePorts(NOW_MS);
    const req = makeExpenseRequest({ partner: "=SUM(A1)" });

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.expenses[0]!.partner).toBe("'=SUM(A1)");
  });

  it("メモが `+1+1` なら台帳には `'+1+1` として入る", () => {
    const ports = makeFakePorts(NOW_MS);
    const req = makeExpenseRequest({ memo: "+1+1" });

    const result = handleExpenseSubmit(req, ports);

    expect(result).toEqual({ ok: true, applied: true });
    expect(ports.sheets.expenses[0]!.memo).toBe("'+1+1");
  });
});
