/**
 * 経費モーダル（`callback_id: kado_expense`）まわりのハンドラ（実装設計 経費フェーズ §2.2, §4.1〜§4.3）。
 *
 * - {@link buildExpenseModalView}: §2.2 の 7 ブロックのモーダル JSON を組み立てる（静的）
 * - {@link validateExpenseSubmission}: §4.3 の全 11 検証（純粋関数、テストしやすいよう分離）
 * - {@link handleExpenseSubmission}: §4.2 の `view_submission` 処理本体。
 *   `worker/src/handlers/view_submission.ts` と同じ構造（`jsonResponse`・冪等キー・
 *   `journal.insertJournal`・`ctx.waitUntil` で `sendToGas`・`notifyRejectedDm`）に揃えるが、
 *   🔄 D1 INSERT 自体が失敗した場合は `clear` せず `errors` を返す点だけが異なる（§4.2）。
 */
import {
  EXPENSE_ALLOWED_EXTENSIONS,
  EXPENSE_CATEGORIES,
  EXPENSE_MAX_FILE_BYTES,
  EXPENSE_MEMO_MAX_LENGTH,
  EXPENSE_PARTNER_MAX_LENGTH,
  extensionOf,
  isAllowedExtension,
  isAllowedSlackFileUrl,
  isExpenseCategory,
  isReceiptType,
  type ExpenseCategory,
  type ReceiptType,
} from "@kadobo/shared/expense";
import { modalIdempotencyKey, ulid } from "@kadobo/shared/ids";
import type { ExpenseSubmitFile, GasRequest } from "@kadobo/shared/protocol";
import { businessDateOf, isValidDateString } from "@kadobo/shared/time";
import type { Env } from "../env";
import { sendToGas } from "../gas";
import * as journal from "../journal";
import { notifyRejectedDm } from "../notify";
import type { SlackModalView } from "../slack/api";
import { getStateFiles, getStateValue, type SlackStateValues, type SlackViewSubmissionPayload } from "../slack/parse";
import { randomBytes, sha256Hex } from "../webcrypto";

/** 経費モーダルの `callback_id`（実装設計 経費フェーズ §2.2）。 */
export const EXPENSE_CALLBACK_ID = "kado_expense";

/** §2.2 の `file` ブロック `hint`（案内文。検査ではない）。 */
const EXPENSE_FILE_HINT =
  "ダウンロードできる原本（PDF 等）があるときは原本を添付してください。Web やアプリでしか表示されない場合は、" +
  "日付・取引先・金額が判読できるスクリーンショットで構いません。";

const RECEIPT_TYPE_LABELS: Record<ReceiptType, string> = {
  paper: "紙",
  e_doc: "電子取引",
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/**
 * 経費モーダルの JSON を組み立てる（実装設計 経費フェーズ §2.2）。データ参照は不要な静的な内容。
 * `private_metadata` は既定で空文字列（経費は稼働カードに紐づかないため）。
 * `/keihi` の呼び出し元がチャンネル通知先を積む必要がある場合は、呼び出し側で
 * `view.private_metadata` を上書きすること。
 *
 * 🔄 実装設計 経費フェーズ §5.9.2 (WP9c): `enableEDoc`（第 2 引数、既定 `true`）が `false` の
 * とき、証憑区分の選択肢から `e_doc` を出さない（`paper` のみになる）。既存の呼び出し・
 * テストを壊さないよう省略可能にしてある。
 */
export function buildExpenseModalView(todayJst: string, enableEDoc = true): SlackModalView {
  const receiptTypeOptions = [
    { text: { type: "plain_text" as const, text: RECEIPT_TYPE_LABELS.paper }, value: "paper" },
    ...(enableEDoc
      ? [{ text: { type: "plain_text" as const, text: RECEIPT_TYPE_LABELS.e_doc }, value: "e_doc" }]
      : []),
  ];
  return {
    type: "modal",
    callback_id: EXPENSE_CALLBACK_ID,
    title: { type: "plain_text", text: "経費の登録" },
    submit: { type: "plain_text", text: "登録" },
    close: { type: "plain_text", text: "キャンセル" },
    private_metadata: "",
    blocks: [
      {
        type: "input",
        block_id: "receipt_type",
        label: { type: "plain_text", text: "証憑区分" },
        // §7 #E3: 初期選択は置かない（推定値を確定させない）。
        element: {
          type: "static_select",
          action_id: "receipt_type_select",
          options: receiptTypeOptions,
        },
      },
      {
        type: "input",
        block_id: "date",
        label: { type: "plain_text", text: "日付" },
        element: {
          type: "datepicker",
          action_id: "date_pick",
          initial_date: todayJst,
        },
      },
      {
        type: "input",
        block_id: "amount",
        label: { type: "plain_text", text: "金額" },
        element: {
          type: "plain_text_input",
          action_id: "amount_input",
        },
      },
      {
        type: "input",
        block_id: "category",
        label: { type: "plain_text", text: "カテゴリ" },
        element: {
          type: "static_select",
          action_id: "category_select",
          options: EXPENSE_CATEGORIES.map((c) => ({ text: { type: "plain_text", text: c }, value: c })),
        },
      },
      {
        type: "input",
        block_id: "partner",
        label: { type: "plain_text", text: "取引先" },
        element: {
          type: "plain_text_input",
          action_id: "partner_input",
          max_length: EXPENSE_PARTNER_MAX_LENGTH,
        },
      },
      {
        type: "input",
        block_id: "memo",
        optional: true,
        label: { type: "plain_text", text: "メモ" },
        element: {
          type: "plain_text_input",
          action_id: "memo_input",
          multiline: true,
          max_length: EXPENSE_MEMO_MAX_LENGTH,
        },
      },
      {
        type: "input",
        block_id: "file",
        label: { type: "plain_text", text: "証憑ファイル" },
        hint: { type: "plain_text", text: EXPENSE_FILE_HINT },
        element: {
          type: "file_input",
          action_id: "file_upload",
          filetypes: [...EXPENSE_ALLOWED_EXTENSIONS],
          max_files: 1,
        },
      },
    ],
  };
}

/** コードポイント単位の文字数（サロゲートペアを 1 字として数える）。共有定数が「コードポイント単位」と定義しているため。 */
function codePointLength(s: string): number {
  return [...s].length;
}

export interface ValidatedExpenseSubmission {
  receipt_type: ReceiptType;
  date: string;
  amount: number;
  category: ExpenseCategory;
  partner: string;
  memo: string;
  file: ExpenseSubmitFile;
}

export type ExpenseValidationResult =
  | { ok: true; value: ValidatedExpenseSubmission }
  | { ok: false; errors: Record<string, string> };

/**
 * `state.values` を実装設計 経費フェーズ §4.3 の全 11 検証に従って検証する（純粋関数）。
 * ブロックごとにエラーは 1 つまで（Slack の `errors` は block_id をキーにした Map のため）。
 */
export function validateExpenseSubmission(
  values: SlackStateValues,
  todayJst: string,
): ExpenseValidationResult {
  const errors: Record<string, string> = {};

  // 1. receipt_type: 未選択でない。値が paper / e_doc のいずれか。
  const receiptTypeRaw = getStateValue(values, "receipt_type", "receipt_type_select")?.selected_option?.value;
  if (!isReceiptType(receiptTypeRaw)) {
    errors.receipt_type = "証憑区分を選択してください";
  }

  // 2. date: 未選択でない。 2.5 date: 形式・実在チェック（設計 §5.5 追記）。 3. date: 未来日でない（JST の当日まで）。
  // 判定順は「空 → 形式・実在 → 未来日」。形式不正時は §4.3 表の「日付を選択してください」を流用する
  // （新しい文言は作らない。datepicker が返すはずのない値なので、未選択と同じ扱いにする）。
  const date = getStateValue(values, "date", "date_pick")?.selected_date;
  if (!date) {
    errors.date = "日付を選択してください";
  } else if (!isValidDateString(date)) {
    errors.date = "日付を選択してください";
  } else if (date > todayJst) {
    errors.date = "未来の日付は登録できません";
  }

  // 4. amount: カンマ・空白除去後に /^[0-9]+$/、1 以上の整数。
  const amountRaw = getStateValue(values, "amount", "amount_input")?.value ?? "";
  const amountCleaned = amountRaw.replace(/[,\s]/g, "");
  let amount = 0;
  if (!/^[0-9]+$/.test(amountCleaned) || Number(amountCleaned) < 1) {
    errors.amount = "金額を半角数字で入力してください";
  } else {
    amount = Number(amountCleaned);
  }

  // 5. category: EXPENSE_CATEGORIES に含まれる。
  const categoryRaw = getStateValue(values, "category", "category_select")?.selected_option?.value;
  if (!isExpenseCategory(categoryRaw)) {
    errors.category = "カテゴリを選択してください";
  }

  // 6. partner: 非空（空白のみ不可）、100 字以内。
  const partnerRaw = getStateValue(values, "partner", "partner_input")?.value ?? "";
  if (partnerRaw.trim() === "" || codePointLength(partnerRaw) > EXPENSE_PARTNER_MAX_LENGTH) {
    errors.partner = `取引先を入力してください（${EXPENSE_PARTNER_MAX_LENGTH} 字以内）`;
  }

  // 7. memo: 200 字以内（未入力可）。
  const memo = getStateValue(values, "memo", "memo_input")?.value ?? "";
  if (codePointLength(memo) > EXPENSE_MEMO_MAX_LENGTH) {
    errors.memo = `メモは ${EXPENSE_MEMO_MAX_LENGTH} 字以内で入力してください`;
  }

  // 8〜11. file: ちょうど 1 件／拡張子（filetype と name の両方）／サイズ／url_private のホスト。
  const files = getStateFiles(values, "file", "file_upload");
  let file: ExpenseSubmitFile | undefined;
  if (files === null) {
    // ペイロードの形が想定と違う（WP5 S3 未検証のため防御的に扱う）。
    errors.file = "ファイルを認識できませんでした";
  } else if (files.length !== 1) {
    errors.file = "証憑ファイルを1つ添付してください";
  } else {
    const candidate = files[0];
    if (!candidate) {
      // files.length === 1 で到達しないはずだが、noUncheckedIndexedAccess 対応の防御。
      errors.file = "ファイルを認識できませんでした";
    } else {
      const extFromName = extensionOf(candidate.name);
      const filetypeLower = candidate.filetype.toLowerCase();
      if (extFromName === null || !isAllowedExtension(extFromName) || !isAllowedExtension(filetypeLower)) {
        errors.file = "jpg / jpeg / png / heic / pdf のいずれかを添付してください";
      } else if (candidate.size > EXPENSE_MAX_FILE_BYTES) {
        errors.file = `ファイルは ${EXPENSE_MAX_FILE_BYTES / 1024 / 1024}MB 以内にしてください`;
      } else if (!isAllowedSlackFileUrl(candidate.url_private)) {
        errors.file = "添付ファイルを認識できませんでした";
      } else {
        file = candidate;
      }
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    value: {
      // 上の検証をすべて通過しているため、以下のキャストは安全。
      receipt_type: receiptTypeRaw as ReceiptType,
      date: date as string,
      amount,
      category: categoryRaw as ExpenseCategory,
      partner: partnerRaw,
      memo,
      file: file as ExpenseSubmitFile,
    },
  };
}

interface ExpensePrivateMetadata {
  channel_id: string;
}

/**
 * `private_metadata` から通知先チャンネルを取り出す（実装設計 経費フェーズ §3.1）。
 *
 * 契約上 `private_metadata` は「空文字列でよい」とされているが、`GasRequest.expense_submit`
 * の `channel_id` は必須であり、`view_submission` ペイロード自体には投稿元チャンネルの情報が
 * 含まれない。そのため `/keihi` 実行時に `command.channel_id` を `private_metadata` に積んで
 * 往復させる実装にしている（`handlers/command.ts` 参照）。この判断は契約に明記されていない
 * ため、既知の食い違いとして報告済み。形が壊れている場合は空文字列にフォールバックする
 * （`sendToGas` 自体は失敗しないが、Worker 側のチャンネル通知が届かなくなるだけに留める）。
 */
function parseExpensePrivateMetadata(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as ExpensePrivateMetadata).channel_id === "string"
    ) {
      return (parsed as ExpensePrivateMetadata).channel_id;
    }
  } catch {
    // 空文字列（既定）・不正な JSON はいずれもフォールバックする。
  }
  return "";
}

export interface HandleExpenseSubmissionInput {
  env: Env;
  ctx: ExecutionContext;
  payload: SlackViewSubmissionPayload;
  fetchImpl?: typeof fetch;
}

/**
 * `enable_expense`/`enable_e_doc` 無効時の `view_submission` エラー文言（実装設計 経費フェーズ §5.9.2）。
 * 🔄 コーディネーターのレビュー指摘: フラグ無効は**設定状態**であり時間経過では直らないため、
 * 一時障害を思わせる文言（「しばらくしてから」「現在停止中」）にしない。利用者は運用者
 * 本人 1 名のため、内部の設定名（フラグ名）を出して構わない（§3.2 の `CONFIG_MISSING` と同じ
 * 論点）。
 *
 * 🔄 二度目のレビュー指摘（Blocker）: `E_DOC_DISABLED_ERROR` に「紙の証憑として登録してください」
 * と書いていたのは**誤り**。要件定義 §4.3.3 のとおり電子取引は受領した電磁的記録そのものを
 * 保存する義務があり、書面出力で電子データの保存に**代えることは不可**。区分を `paper` に
 * 変えて登録すると、紙の運用（`経費証憑/紙/...`）に入ってしまい電子取引としての保存になら
 * ない＝電帳法違反になりうる。よって「紙へ変更するな」を明示し、要件定義 §4.3.3 末尾の
 * **暫定運用**（電子取引の元データは Drive の所定フォルダに手動保存し、台帳には手入力する）
 * へ誘導する。また、停止理由を「法令ゲート G-2・G-3 の完了待ち」のように固定断定しない
 * （フラグはロールバック中や D1 読み取り失敗でも無効になりうるため、理由を決め打ちできない）。
 */
const EXPENSE_DISABLED_ERROR = "経費機能は無効になっています（フラグ `enable_expense`）。有効化してから登録してください";
const E_DOC_DISABLED_ERROR =
  "電子取引の証憑はいま受け付けていません。区分を「紙」に変えて登録しないでください" +
  "（電子取引データは電子のまま保存する必要があります）。" +
  "元データは暫定運用のとおり Drive の所定フォルダへ手動保存し、台帳に手入力してください";

/**
 * `view_submission`（`callback_id: kado_expense`）ハンドラ（実装設計 経費フェーズ §4.2, §4.3, §5.9.2）。
 *
 * 0. 🔄 §4.3 の検証より**前**に `enable_expense` を判定する。無効なら `{response_action:'errors'}`
 *    を返す（D1 に INSERT しない・GAS へ送らない）
 * 1. `state.values` を §4.3 に従って検証 → NG なら `{response_action:'errors'}` を同期で返す
 * 1.5 🔄 検証が通ったあと、`receipt_type==='e_doc'` かつ `enable_e_doc` が無効なら同じく
 *    `{response_action:'errors'}` を返す（INSERT しない）
 * 2. 冪等キー生成 → D1 INSERT
 *    - 成功／重複 → `{response_action:'clear'}` を返す
 *    - 🔄 INSERT 自体が失敗 → `clear` せず `{response_action:'errors'}` で
 *      「受け付けに失敗しました。もう一度お試しください」を返す（入力内容を失わせない）
 * 3. `waitUntil`: GAS へ POST（§3）。失敗は `pending` のまま Cron 再送
 *
 * いずれのフラグエラーも `errors` のキーは `receipt_type`（実在する block_id）を使う。
 */
export async function handleExpenseSubmission(input: HandleExpenseSubmissionInput): Promise<Response> {
  const { env, ctx, payload } = input;
  const fetchImpl = input.fetchImpl ?? fetch;

  const enableExpense = await journal.isSettingEnabled(env.DB, "enable_expense");
  if (!enableExpense) {
    return jsonResponse({
      response_action: "errors",
      errors: { receipt_type: EXPENSE_DISABLED_ERROR },
    });
  }

  const values = payload.view.state.values;
  const now = Date.now();
  const todayJst = businessDateOf(now);
  const validated = validateExpenseSubmission(values, todayJst);
  if (!validated.ok) {
    return jsonResponse({ response_action: "errors", errors: validated.errors });
  }

  if (validated.value.receipt_type === "e_doc") {
    const enableEDoc = await journal.isSettingEnabled(env.DB, "enable_e_doc");
    if (!enableEDoc) {
      return jsonResponse({
        response_action: "errors",
        errors: { receipt_type: E_DOC_DISABLED_ERROR },
      });
    }
  }

  const channelId = parseExpensePrivateMetadata(payload.view.private_metadata);
  const stateHash16 = (await sha256Hex(JSON.stringify(values))).slice(0, 16);
  const idempotencyKey = modalIdempotencyKey(payload.view.id, stateHash16);
  const gasRequest: GasRequest = {
    kind: "expense_submit",
    idempotency_key: idempotencyKey,
    user_id: payload.user.id,
    view_id: payload.view.id,
    channel_id: channelId,
    receipt_type: validated.value.receipt_type,
    date: validated.value.date,
    amount: validated.value.amount,
    category: validated.value.category,
    partner: validated.value.partner,
    memo: validated.value.memo,
    file: validated.value.file,
    received_at_ms: now,
    source: "modal",
  };

  const journalId = ulid(now, randomBytes);
  let insertResult: { inserted: boolean };
  try {
    insertResult = await journal.insertJournal(env.DB, {
      id: journalId,
      idempotency_key: idempotencyKey,
      kind: "expense_submit",
      payload: JSON.stringify(gasRequest),
      now,
    });
  } catch {
    // 🔄 実装設計 経費フェーズ §4.2: INSERT 自体が失敗した場合は `clear` にしない
    // （握り潰すと入力内容が失われるため、モーダルを開いたまま再送を促す）。
    return jsonResponse({
      response_action: "errors",
      errors: { file: "受け付けに失敗しました。もう一度お試しください" },
    });
  }

  ctx.waitUntil(
    (async () => {
      if (!insertResult.inserted) {
        return;
      }
      const forwardingEnabled = await journal.isForwardingEnabled(env.DB);
      if (!forwardingEnabled) {
        return;
      }
      const outcome = await sendToGas(env, gasRequest, { fetchImpl });
      await journal.recordAttemptResult(env.DB, journalId, outcome, Date.now());
      if (outcome.status === "rejected") {
        await notifyRejectedDm(env, payload.user.id, journalId, outcome.error, fetchImpl);
      }
    })(),
  );

  return jsonResponse({ response_action: "clear" });
}
