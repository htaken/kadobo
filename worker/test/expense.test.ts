/**
 * 経費モーダル（実装設計 経費フェーズ §2.2, §4.1〜§4.3）のテスト。
 *
 * `validateExpenseSubmission`・`buildExpenseModalView` は純粋関数なので DB 無しで検証する。
 * `handleExpenseSubmission`・`/keihi`（`handleSlashCommand`）は `handlers.test.ts` と同じく
 * `createTestHarness` の実 D1 バインディングに対して呼び出し、外部通信は `fetchImpl` スタブで
 * 完結させる。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { EXPENSE_CATEGORIES, EXPENSE_MAX_FILE_BYTES } from "@kadobo/shared/expense";
import type { Env } from "../src/index";
import { handleSlashCommand } from "../src/handlers/command";
import {
  buildExpenseModalView,
  EXPENSE_CALLBACK_ID,
  handleExpenseSubmission,
  validateExpenseSubmission,
} from "../src/handlers/expense";
import { sha256Hex } from "../src/webcrypto";
import { getStateFiles, type SlackSlashCommand, type SlackStateValues, type SlackViewSubmissionPayload } from "../src/slack/parse";
import { createTestCtx, jsonResponse, makeEnv, createFetchStub } from "./support";

const TODAY_JST = "2099-12-31"; // validateExpenseSubmission の純粋テストでは固定の「当日」を注入する。
const PAST_DATE = "2020-01-01"; // handleExpenseSubmission は Date.now() の実時刻を使うため、常に過去の日付を使う。

function baseValues(): SlackStateValues {
  return {
    receipt_type: {
      receipt_type_select: { type: "static_select", selected_option: { value: "paper" } },
    },
    date: { date_pick: { type: "datepicker", selected_date: PAST_DATE } },
    amount: { amount_input: { type: "plain_text_input", value: "1200" } },
    category: { category_select: { type: "static_select", selected_option: { value: "消耗品費" } } },
    partner: { partner_input: { type: "plain_text_input", value: "○○商店" } },
    memo: { memo_input: { type: "plain_text_input", value: "" } },
    file: {
      file_upload: {
        type: "file_input",
        files: [
          {
            id: "F1",
            name: "receipt.pdf",
            mimetype: "application/pdf",
            filetype: "pdf",
            size: 1000,
            url_private: "https://files.slack.com/files-pri/T1-F1/receipt.pdf",
          },
        ],
      },
    },
  };
}

/**
 * 本番実測（コーディネーターからの指摘）で確認された、Slack の生 file object の実物大の例。
 * サムネイル画像の Base64（`thumb_tiny` 等）や `permalink`・`shares` など、
 * {@link SlackFileValue} の 6 フィールド以外に数十のフィールドが載っている。
 * `getStateFiles` はこれらを詰め直しの過程で必ず捨てなければならない。
 */
function makeBloatedRawFile(overrides?: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "F1",
    name: "receipt.pdf",
    mimetype: "application/pdf",
    filetype: "pdf",
    size: 1000,
    url_private: "https://files.slack.com/files-pri/T1-F1/receipt.pdf",
    // ↓ ここから先が本番で混入していた余剰フィールド（一部を抜粋）。
    thumb_64: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_64.jpg",
    thumb_80: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_80.jpg",
    thumb_360: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_360.jpg",
    thumb_360_w: 360,
    thumb_360_h: 480,
    thumb_480: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_480.jpg",
    thumb_160: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_160.jpg",
    thumb_720: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_720.jpg",
    thumb_800: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_800.jpg",
    thumb_960: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_960.jpg",
    thumb_1024: "https://files.slack.com/files-tmb/T1-F1-abc/receipt_1024.jpg",
    original_w: 1200,
    original_h: 1600,
    thumb_tiny: "AwAwACGSMJ5algSeeelP8iLBJT8iajjP7pdoyQCcDqeen0OKsZ3KwHXkdf8",
    permalink: "https://kadobo-ws.slack.com/files/U1/F1/receipt.pdf",
    permalink_public: "https://slack-files.com/T1-F1-abcdef0123",
    shares: { public: {}, private: {} },
    channels: ["C1"],
    groups: [],
    ims: [],
    user_team: "T1",
    editable: false,
    mode: "hosted",
    is_external: false,
    pretty_type: "PDF",
    created: 1756260000,
    timestamp: 1756260000,
    ...overrides,
  };
}

const EXPECTED_FILE_KEYS = ["filetype", "id", "mimetype", "name", "size", "url_private"].sort();

// --- buildExpenseModalView（実装設計 経費フェーズ §2.2） ---

describe("buildExpenseModalView", () => {
  it("callback_id・title・submit・close・private_metadata が契約どおり", () => {
    const view = buildExpenseModalView("2026-09-01");
    expect(view.callback_id).toBe("kado_expense");
    expect(view.callback_id).toBe(EXPENSE_CALLBACK_ID);
    expect(view.title.text).toBe("経費の登録");
    expect(view.submit?.text).toBe("登録");
    expect(view.close?.text).toBe("キャンセル");
    expect(view.private_metadata).toBe("");
  });

  it("§2.2 の 7 ブロックが順序どおりに揃っている", () => {
    const view = buildExpenseModalView("2026-09-01");
    expect(view.blocks).toHaveLength(7);
    expect(view.blocks.map((b) => b.block_id)).toEqual([
      "receipt_type",
      "date",
      "amount",
      "category",
      "partner",
      "memo",
      "file",
    ]);
  });

  it("receipt_type: static_select、paper/e_doc の2択、初期選択は置かない（§7 #E3）", () => {
    const view = buildExpenseModalView("2026-09-01");
    const block = view.blocks.find((b) => b.block_id === "receipt_type") as any;
    expect(block.element.type).toBe("static_select");
    expect(block.element.action_id).toBe("receipt_type_select");
    expect(block.element.options.map((o: any) => o.value)).toEqual(["paper", "e_doc"]);
    expect(block.element.initial_option).toBeUndefined();
  });

  it("date: datepicker、initial_date が引数の todayJst", () => {
    const view = buildExpenseModalView("2026-09-01");
    const block = view.blocks.find((b) => b.block_id === "date") as any;
    expect(block.element.type).toBe("datepicker");
    expect(block.element.action_id).toBe("date_pick");
    expect(block.element.initial_date).toBe("2026-09-01");
  });

  it("category: EXPENSE_CATEGORIES の7種すべてが選択肢に入っている", () => {
    const view = buildExpenseModalView("2026-09-01");
    const block = view.blocks.find((b) => b.block_id === "category") as any;
    expect(block.element.action_id).toBe("category_select");
    expect(block.element.options.map((o: any) => o.value)).toEqual([...EXPENSE_CATEGORIES]);
  });

  it("memo: optional かつ multiline", () => {
    const view = buildExpenseModalView("2026-09-01");
    const block = view.blocks.find((b) => b.block_id === "memo") as any;
    expect(block.optional).toBe(true);
    expect(block.element.multiline).toBe(true);
  });

  it("file: file_input、filetypes 5種、max_files:1、hint に案内文", () => {
    const view = buildExpenseModalView("2026-09-01");
    const block = view.blocks.find((b) => b.block_id === "file") as any;
    expect(block.element.type).toBe("file_input");
    expect(block.element.action_id).toBe("file_upload");
    expect(block.element.filetypes).toEqual(["jpg", "jpeg", "png", "heic", "pdf"]);
    expect(block.element.max_files).toBe(1);
    expect(block.hint.text).toContain("原本");
    expect(block.hint.text).toContain("スクリーンショット");
  });
});

// --- validateExpenseSubmission（実装設計 経費フェーズ §4.3 の全 11 検証） ---

describe("validateExpenseSubmission", () => {
  it("フルに正しい入力は ok:true で値を返す（カンマ入り金額もパースされる）", () => {
    const values = baseValues();
    values.amount = { amount_input: { type: "plain_text_input", value: "1,200" } };
    const result = validateExpenseSubmission(values, TODAY_JST);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        receipt_type: "paper",
        date: PAST_DATE,
        amount: 1200,
        category: "消耗品費",
        partner: "○○商店",
        memo: "",
        file: {
          id: "F1",
          name: "receipt.pdf",
          mimetype: "application/pdf",
          filetype: "pdf",
          size: 1000,
          url_private: "https://files.slack.com/files-pri/T1-F1/receipt.pdf",
        },
      });
    }
  });

  // 1. receipt_type: 未選択でない。値が paper / e_doc のいずれか。
  describe("#1 receipt_type", () => {
    it("OK: e_doc も許可される", () => {
      const values = baseValues();
      values.receipt_type = { receipt_type_select: { type: "static_select", selected_option: { value: "e_doc" } } };
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("NG: 未選択", () => {
      const values = baseValues();
      values.receipt_type = { receipt_type_select: { type: "static_select" } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.receipt_type).toBe("証憑区分を選択してください");
    });
    it("NG: paper/e_doc 以外の値", () => {
      const values = baseValues();
      values.receipt_type = { receipt_type_select: { type: "static_select", selected_option: { value: "invalid" } } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.receipt_type).toBe("証憑区分を選択してください");
    });
  });

  // 2. date: 未選択でない。
  describe("#2 date 未選択", () => {
    it("OK: 選択済み", () => {
      expect(validateExpenseSubmission(baseValues(), TODAY_JST).ok).toBe(true);
    });
    it("NG: 未選択", () => {
      const values = baseValues();
      values.date = { date_pick: { type: "datepicker" } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.date).toBe("日付を選択してください");
    });
  });

  // date: 形式・実在チェック（設計 §5.5 追記。isValidDateString を空 → 未来日の間で適用する）。
  describe("date 形式・実在チェック", () => {
    it.each(["not-a-date", "2026-8-1", "2026-13-01", "2026-00-99", "2026-02-29"])(
      "NG: %s は形式不正／実在しない日付 → 日付を選択してください（未来の日付エラーにはしない）",
      (value) => {
        const values = baseValues();
        values.date = { date_pick: { type: "datepicker", selected_date: value } };
        const result = validateExpenseSubmission(values, TODAY_JST);
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.date).toBe("日付を選択してください");
      },
    );
    it("OK: 2024-02-29（うるう年）はエラーにならない", () => {
      const values = baseValues();
      values.date = { date_pick: { type: "datepicker", selected_date: "2024-02-29" } };
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("OK: 正常な日付はエラーにならない", () => {
      expect(validateExpenseSubmission(baseValues(), TODAY_JST).ok).toBe(true);
    });
  });

  // 3. date: 未来日でない（JST の当日まで）。
  describe("#3 date 未来日", () => {
    it("OK: 当日はOK（境界値）", () => {
      const values = baseValues();
      values.date = { date_pick: { type: "datepicker", selected_date: TODAY_JST } };
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("NG: 翌日以降はエラー", () => {
      const values = baseValues();
      values.date = { date_pick: { type: "datepicker", selected_date: "2100-01-01" } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.date).toBe("未来の日付は登録できません");
    });
  });

  // 4. amount: カンマ・空白除去後に /^[0-9]+$/、1以上の整数。
  describe("#4 amount", () => {
    it.each(["1200", "1,200", "1 200", "007"])("OK: %s は半角数字として受理される", (value) => {
      const values = baseValues();
      values.amount = { amount_input: { type: "plain_text_input", value } };
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it.each(["", "0", "-5", "12.5", "abc", "１２００"])("NG: %s は不正な金額", (value) => {
      const values = baseValues();
      values.amount = { amount_input: { type: "plain_text_input", value } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.amount).toBe("金額を半角数字で入力してください");
    });
  });

  // 5. category: EXPENSE_CATEGORIES に含まれる。
  describe("#5 category", () => {
    it.each([...EXPENSE_CATEGORIES])("OK: %s は許可されたカテゴリ", (category) => {
      const values = baseValues();
      values.category = { category_select: { type: "static_select", selected_option: { value: category } } };
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("NG: 未選択", () => {
      const values = baseValues();
      values.category = { category_select: { type: "static_select" } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.category).toBe("カテゴリを選択してください");
    });
    it("NG: 許可されていない値", () => {
      const values = baseValues();
      values.category = { category_select: { type: "static_select", selected_option: { value: "交際費" } } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.category).toBe("カテゴリを選択してください");
    });
  });

  // 6. partner: 非空（空白のみ不可）、100字以内。
  describe("#6 partner", () => {
    it("OK: 100字ちょうど", () => {
      const values = baseValues();
      values.partner = { partner_input: { type: "plain_text_input", value: "あ".repeat(100) } };
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("NG: 未入力", () => {
      const values = baseValues();
      values.partner = { partner_input: { type: "plain_text_input", value: "" } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.partner).toBe("取引先を入力してください（100 字以内）");
    });
    it("NG: 空白のみ", () => {
      const values = baseValues();
      values.partner = { partner_input: { type: "plain_text_input", value: "　  " } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.partner).toBe("取引先を入力してください（100 字以内）");
    });
    it("NG: 101字", () => {
      const values = baseValues();
      values.partner = { partner_input: { type: "plain_text_input", value: "あ".repeat(101) } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.partner).toBe("取引先を入力してください（100 字以内）");
    });
  });

  // 7. memo: 200字以内。
  describe("#7 memo", () => {
    it("OK: 200字ちょうど", () => {
      const values = baseValues();
      values.memo = { memo_input: { type: "plain_text_input", value: "あ".repeat(200) } };
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("OK: 未入力（optional）", () => {
      const values = baseValues();
      values.memo = { memo_input: { type: "plain_text_input" } };
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("NG: 201字", () => {
      const values = baseValues();
      values.memo = { memo_input: { type: "plain_text_input", value: "あ".repeat(201) } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.memo).toBe("メモは 200 字以内で入力してください");
    });
  });

  // 8. file: ちょうど1件。
  describe("#8 file 件数", () => {
    it("NG: 0件", () => {
      const values = baseValues();
      values.file = { file_upload: { type: "file_input", files: [] } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.file).toBe("証憑ファイルを1つ添付してください");
    });
    it("NG: 2件", () => {
      const values = baseValues();
      const file = values.file?.file_upload?.files?.[0];
      values.file = { file_upload: { type: "file_input", files: [file!, { ...file!, id: "F2" }] } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.file).toBe("証憑ファイルを1つ添付してください");
    });
  });

  // 9. file: 拡張子（小文字化）が許可形式。filetype と name の両方で判定。
  describe("#9 file 拡張子", () => {
    it.each(["jpg", "jpeg", "png", "heic", "pdf", "PDF"])("OK: 拡張子 %s は許可される", (ext) => {
      const values = baseValues();
      const file = values.file!.file_upload!;
      file.files = [{ ...file.files![0]!, name: `receipt.${ext}`, filetype: ext.toLowerCase() }];
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("NG: name の拡張子が許可外", () => {
      const values = baseValues();
      const file = values.file!.file_upload!;
      file.files = [{ ...file.files![0]!, name: "receipt.exe", filetype: "pdf" }];
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.file).toBe("jpg / jpeg / png / heic / pdf のいずれかを添付してください");
    });
    it("NG: filetype が許可外（name の拡張子は許可されていても）", () => {
      const values = baseValues();
      const file = values.file!.file_upload!;
      file.files = [{ ...file.files![0]!, name: "receipt.pdf", filetype: "exe" }];
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.file).toBe("jpg / jpeg / png / heic / pdf のいずれかを添付してください");
    });
  });

  // 10. file: size <= EXPENSE_MAX_FILE_BYTES。
  describe("#10 file サイズ", () => {
    it("OK: ちょうど10MB", () => {
      const values = baseValues();
      const file = values.file!.file_upload!;
      file.files = [{ ...file.files![0]!, size: EXPENSE_MAX_FILE_BYTES }];
      expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
    });
    it("NG: 10MB超", () => {
      const values = baseValues();
      const file = values.file!.file_upload!;
      file.files = [{ ...file.files![0]!, size: EXPENSE_MAX_FILE_BYTES + 1 }];
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.file).toBe("ファイルは 10MB 以内にしてください");
    });
  });

  // 11. file: url_private のホストが SLACK_FILE_ALLOWED_HOSTS。
  describe("#11 file url_private のホスト", () => {
    it.each(["https://files.slack.com/files-pri/T1-F1/x.pdf", "https://slack.com/files-pri/T1-F1/x.pdf"])(
      "OK: %s は許可ホスト",
      (url) => {
        const values = baseValues();
        const file = values.file!.file_upload!;
        file.files = [{ ...file.files![0]!, url_private: url }];
        expect(validateExpenseSubmission(values, TODAY_JST).ok).toBe(true);
      },
    );
    it("NG: 許可外ホスト", () => {
      const values = baseValues();
      const file = values.file!.file_upload!;
      file.files = [{ ...file.files![0]!, url_private: "https://evil.example.com/x.pdf" }];
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.file).toBe("添付ファイルを認識できませんでした");
    });
  });

  // 実データの形が想定と違う場合の防御（実装設計 経費フェーズ §4.5, WP6 の指示。11検証には含めない）。
  describe("file ペイロードの形が想定と異なる場合（防御）", () => {
    it("NG: files キー自体が無い", () => {
      const values = baseValues();
      values.file = { file_upload: { type: "file_input" } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.file).toBe("ファイルを認識できませんでした");
    });
    it("NG: files の要素にフィールドが欠けている", () => {
      const values = baseValues();
      values.file = { file_upload: { type: "file_input", files: [{ id: "F1" } as any] } };
      const result = validateExpenseSubmission(values, TODAY_JST);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.file).toBe("ファイルを認識できませんでした");
    });
  });
});

// --- getStateFiles: 余剰フィールドの除去（本番実測で発覚した D1 肥大化バグの修正確認） ---

describe("getStateFiles", () => {
  it("実物大の生 file object（サムネイル Base64・permalink 等を含む）から6フィールドだけを詰め直す", () => {
    const values: SlackStateValues = {
      file: { file_upload: { type: "file_input", files: [makeBloatedRawFile() as any] } },
    };

    const result = getStateFiles(values, "file", "file_upload");
    expect(result).toHaveLength(1);
    const file = result?.[0];
    expect(file && Object.keys(file).sort()).toEqual(EXPECTED_FILE_KEYS);
    expect(file).toEqual({
      id: "F1",
      name: "receipt.pdf",
      mimetype: "application/pdf",
      filetype: "pdf",
      size: 1000,
      url_private: "https://files.slack.com/files-pri/T1-F1/receipt.pdf",
    });
    // thumb_tiny（Base64 のサムネイル画像）が確実に落ちていることを明示的に確認する。
    expect(file).not.toHaveProperty("thumb_tiny");
    expect(file).not.toHaveProperty("permalink");
  });
});

// --- handleExpenseSubmission / handleSlashCommand（DB を使う統合テスト） ---

const server = createTestHarness({ workers: [{ configPath: "./wrangler.jsonc" }] });

let db: D1Database;

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  db = (await worker.getEnv()).DB;
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM journal");
  await db.exec("DELETE FROM nonces");
  await db.exec("UPDATE settings SET value = '1' WHERE key = 'forwarding_enabled'");
});

async function allJournalRows() {
  return (await db.prepare("SELECT * FROM journal ORDER BY created_at").all<any>()).results;
}

function makeExpensePayload(
  values: SlackStateValues,
  overrides?: Partial<SlackViewSubmissionPayload["view"]>,
): SlackViewSubmissionPayload {
  return {
    type: "view_submission",
    user: { id: "U1" },
    view: {
      id: "V1",
      callback_id: "kado_expense",
      private_metadata: JSON.stringify({ channel_id: "C1" }),
      state: { values },
      ...overrides,
    },
  };
}

/** `prepare().bind().run()` が必ず例外を投げる D1Database もどき（INSERT 失敗のシミュレーション用）。 */
function makeFailingDb(): D1Database {
  return {
    prepare() {
      return {
        bind() {
          return {
            run() {
              throw new Error("d1_unavailable");
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

describe("handleExpenseSubmission", () => {
  it("必須項目欠落: response_action:errors を同期で返し、journal には記録しない", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub();
    const payload = makeExpensePayload({});

    const res = await handleExpenseSubmission({ env, ctx, payload, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_action).toBe("errors");
    expect(body.errors.receipt_type).toBeDefined();
    expect(body.errors.date).toBeDefined();
    expect(body.errors.amount).toBeDefined();
    expect(body.errors.category).toBeDefined();
    expect(body.errors.partner).toBeDefined();
    expect(body.errors.file).toBeDefined();

    await flush();
    expect(await allJournalRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("D1 INSERT 自体が失敗した場合: clear を返さず errors を返す（入力内容を失わせない）", async () => {
    const failingEnv = makeEnv(makeFailingDb());
    const { ctx } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub();
    const payload = makeExpensePayload(baseValues());

    const res = await handleExpenseSubmission({ env: failingEnv, ctx, payload, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_action).toBe("errors");
    expect(Object.values(body.errors)).toContain("受け付けに失敗しました。もう一度お試しください");
    expect(calls).toHaveLength(0); // GAS へは送っていない
  });

  it("正常送信: clear を返し、GasRequest が §3.1 のとおり組み立てられる（channel_id を含む）", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: true, applied: true });
      }
      return undefined;
    });
    const values = baseValues();
    const payload = makeExpensePayload(values);

    const res = await handleExpenseSubmission({ env, ctx, payload, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_action).toBe("clear");

    await flush();
    const rows = await allJournalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("expense_submit");
    expect(rows[0].status).toBe("done");

    const sent = JSON.parse(rows[0].payload);
    expect(sent.kind).toBe("expense_submit");
    expect(sent.user_id).toBe("U1");
    expect(sent.view_id).toBe("V1");
    expect(sent.channel_id).toBe("C1");
    expect(sent.receipt_type).toBe("paper");
    expect(sent.date).toBe(PAST_DATE);
    expect(sent.amount).toBe(1200);
    expect(sent.category).toBe("消耗品費");
    expect(sent.partner).toBe("○○商店");
    expect(sent.memo).toBe("");
    expect(sent.file).toEqual({
      id: "F1",
      name: "receipt.pdf",
      mimetype: "application/pdf",
      filetype: "pdf",
      size: 1000,
      url_private: "https://files.slack.com/files-pri/T1-F1/receipt.pdf",
    });
    expect(sent.source).toBe("modal");
    expect(typeof sent.received_at_ms).toBe("number");
    expect(calls.some((c) => c.url === env.GAS_URL)).toBe(true);
  });

  it("正常送信（実物大の生 file object）: journal に保存される GasRequest.file のキーがちょうど6個（本番実測で発覚した D1 肥大化の回帰確認）", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: true, applied: true });
      }
      return undefined;
    });
    const values = baseValues();
    values.file = { file_upload: { type: "file_input", files: [makeBloatedRawFile() as any] } };
    const payload = makeExpensePayload(values);

    const res = await handleExpenseSubmission({ env, ctx, payload, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_action).toBe("clear");

    await flush();
    const rows = await allJournalRows();
    const sent = JSON.parse(rows[0].payload);
    expect(Object.keys(sent.file).sort()).toEqual(EXPECTED_FILE_KEYS);
    expect(sent.file).toEqual({
      id: "F1",
      name: "receipt.pdf",
      mimetype: "application/pdf",
      filetype: "pdf",
      size: 1000,
      url_private: "https://files.slack.com/files-pri/T1-F1/receipt.pdf",
    });
  });

  it("冪等キーが `${view_id}:${sha256hex(state.values).slice(0,16)}` である", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl } = createFetchStub();
    const values = baseValues();
    const payload = makeExpensePayload(values, { id: "V_XYZ" });

    await handleExpenseSubmission({ env, ctx, payload, fetchImpl });
    await flush();

    const expectedHash16 = (await sha256Hex(JSON.stringify(values))).slice(0, 16);
    const rows = await allJournalRows();
    expect(rows[0].idempotency_key).toBe(`V_XYZ:${expectedHash16}`);
  });

  it("GAS: ok:false,retryable:false → 本人へ DM で通知する", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "FILE_NOT_FOUND", retryable: false });
      }
      return undefined;
    });
    const payload = makeExpensePayload(baseValues());

    await handleExpenseSubmission({ env, ctx, payload, fetchImpl });
    await flush();

    const rows = await allJournalRows();
    expect(rows[0].status).toBe("rejected");
    const dmCall = calls.find((c) => c.url.endsWith("/chat.postMessage"));
    expect(dmCall).toBeDefined();
    expect((dmCall?.body as any).channel).toBe("U1");
  });
});

// --- /keihi（handleSlashCommand、実装設計 経費フェーズ §4.1） ---

describe("handleSlashCommand /keihi", () => {
  function makeCommand(overrides?: Partial<SlackSlashCommand>): SlackSlashCommand {
    return {
      command: "/keihi",
      text: "",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "T1",
      response_url: "https://hooks.slack.test/resp",
      ...overrides,
    };
  }

  it("モーダルを開き、200 空ボディを直ちに返す（GAS へは転送しない）", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub();
    const command = makeCommand();

    const res = await handleSlashCommand({ env, ctx, command, fetchImpl });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");

    await flush();
    const viewsOpenCall = calls.find((c) => c.url.endsWith("/views.open"));
    expect(viewsOpenCall).toBeDefined();
    const sentView = (viewsOpenCall?.body as any).view;
    expect(sentView.callback_id).toBe("kado_expense");
    expect(JSON.parse(sentView.private_metadata)).toEqual({ channel_id: "C1" });
    expect(calls.some((c) => c.url === env.GAS_URL)).toBe(false);
    expect(await allJournalRows()).toHaveLength(0);
  });

  it("views.open が失敗: response_url へ ephemeral でエラーを返す", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url.endsWith("/views.open")) {
        return jsonResponse({ ok: false, error: "expired_trigger_id" });
      }
      return undefined;
    });
    const command = makeCommand();

    const res = await handleSlashCommand({ env, ctx, command, fetchImpl });
    expect(res.status).toBe(200);

    await flush();
    const notifyCall = calls.find((c) => c.url === command.response_url);
    expect(notifyCall).toBeDefined();
    expect((notifyCall?.body as any).response_type).toBe("ephemeral");
    expect(await allJournalRows()).toHaveLength(0);
  });
});
