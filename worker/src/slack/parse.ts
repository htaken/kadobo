/**
 * Slack ペイロードの型付きパース（実装設計 §6.1, §2.3, §2.4）。
 *
 * `application/x-www-form-urlencoded` の body を解釈する。interactivity は `payload`
 * フィールドの JSON（`block_actions` / `view_submission`）、slash command は各フィールド。
 * 署名検証（`../slack/verify.ts`）より後に呼ぶこと（raw body はデコード前に検証する）。
 */

/** ボタンの `action_id`（stamp 4 種 + 修正）。実装設計 §2.3。 */
export type ActionId =
  | "kado_start"
  | "kado_break_start"
  | "kado_break_end"
  | "kado_end"
  | "kado_correct";

export const STAMP_ACTION_IDS: readonly ActionId[] = [
  "kado_start",
  "kado_break_start",
  "kado_break_end",
  "kado_end",
];

export function isStampActionId(
  actionId: string,
): actionId is "kado_start" | "kado_break_start" | "kado_break_end" | "kado_end" {
  return (STAMP_ACTION_IDS as readonly string[]).includes(actionId);
}

/** `block_actions` の `actions[]` 要素。実装設計 §2.3。 */
export interface SlackBlockAction {
  action_id: string;
  /** ボタンの `value`（`business_date`、実装設計 §2.3）。 */
  value?: string;
  /** 押下瞬間の Slack タイムスタンプ（`"1756260000.123456"` 形式）。実装設計 §4.1。 */
  action_ts: string;
  block_id?: string;
  /** ボタンの表示ラベル（`chat.update` の ⏳ 表示に使う。実装設計 §6.2）。 */
  text?: { type: string; text: string };
}

/** Block Kit のブロック（`block_id` のみ型付け、他は不問）。 */
export interface SlackBlock {
  block_id?: string;
  [key: string]: unknown;
}

/** `block_actions` interactivity payload（実装設計 §2.3, §6.2, §6.3）。 */
export interface SlackBlockActionsPayload {
  type: "block_actions";
  user: { id: string };
  channel: { id: string };
  message: { ts: string; text?: string; blocks?: SlackBlock[] };
  actions: SlackBlockAction[];
  trigger_id: string;
  response_url?: string;
}

/**
 * `file_input` の 1 ファイル分の値（実装設計 経費フェーズ §3.1, §4.5）。
 *
 * 実際のペイロード形は WP5 の S3（先行スパイク）で未検証のため、この型は「想定される形」を
 * 表すのみ。実データから取り出す際は必ず {@link getStateFiles} を通し、実行時に形を検証すること
 * （欠けたフィールドがあっても例外にせず `null` として扱う）。
 */
export interface SlackFileValue {
  id: string;
  name: string;
  mimetype: string;
  filetype: string;
  size: number;
  url_private: string;
}

/** `view.state.values` の 1 要素（static_select / datepicker / timepicker / plain_text_input / file_input）。実装設計 §2.4, 経費フェーズ §4.5。 */
export interface SlackStateValue {
  type: string;
  value?: string;
  selected_option?: { value: string; text?: { type: string; text: string } };
  selected_date?: string;
  selected_time?: string;
  /** `file_input` の値（経費フェーズ §2.2, §4.5）。実際の形は {@link SlackFileValue} を参照。 */
  files?: SlackFileValue[];
}

export type SlackStateValues = Record<string, Record<string, SlackStateValue>>;

/** `view_submission` interactivity payload（実装設計 §2.4, §6.4）。 */
export interface SlackViewSubmissionPayload {
  type: "view_submission";
  user: { id: string };
  view: {
    id: string;
    callback_id: string;
    private_metadata: string;
    state: { values: SlackStateValues };
  };
}

export type SlackInteractivityPayload = SlackBlockActionsPayload | SlackViewSubmissionPayload;

/** `state.values` から `blockId`/`actionId` の要素を安全に取り出す（`noUncheckedIndexedAccess` 対応）。 */
export function getStateValue(
  values: SlackStateValues,
  blockId: string,
  actionId: string,
): SlackStateValue | undefined {
  return values[blockId]?.[actionId];
}

/**
 * `file_input` の値を安全に取り出す（実装設計 経費フェーズ §3.1, §4.5, WP6）。
 *
 * 実際のペイロード形は WP5 の S3 で未検証のため、`files` が配列であること・各要素が
 * {@link SlackFileValue} の全フィールドを持つことを実行時に検証する。形が想定と違えば
 * （ブロック自体が無い／`files` が配列でない／要素にフィールド欠落がある）`null` を返す。
 * 呼び出し側はこれを「ファイルを認識できませんでした」バリデーションエラーにすること。
 *
 * 空配列（`files: []`）は形としては正しい（添付 0 件）ため `[]` を返す。件数の検証は
 * 呼び出し側（§4.3 の「ちょうど1件」）が行う。
 */
export function getStateFiles(
  values: SlackStateValues,
  blockId: string,
  actionId: string,
): SlackFileValue[] | null {
  const raw = getStateValue(values, blockId, actionId);
  if (raw === undefined || !Array.isArray(raw.files)) {
    return null;
  }
  const files: SlackFileValue[] = [];
  for (const item of raw.files) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Partial<SlackFileValue>).id !== "string" ||
      typeof (item as Partial<SlackFileValue>).name !== "string" ||
      typeof (item as Partial<SlackFileValue>).mimetype !== "string" ||
      typeof (item as Partial<SlackFileValue>).filetype !== "string" ||
      typeof (item as Partial<SlackFileValue>).size !== "number" ||
      typeof (item as Partial<SlackFileValue>).url_private !== "string"
    ) {
      return null;
    }
    files.push(item as SlackFileValue);
  }
  return files;
}

/** スラッシュコマンドのフォーム全体（実装設計 §2.1, §6.5）。 */
export interface SlackSlashCommand {
  command: string;
  text: string;
  user_id: string;
  channel_id: string;
  trigger_id: string;
  response_url: string;
}

/**
 * `application/x-www-form-urlencoded` の interactivity body をパースする。
 * `payload` フィールドが無い・JSON でない・既知の `type` でない場合は `null`。
 */
export function parseInteractivityPayload(body: string): SlackInteractivityPayload | null {
  const params = new URLSearchParams(body);
  const raw = params.get("payload");
  if (raw === null) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const type = (parsed as { type?: unknown }).type;
  if (type === "block_actions" || type === "view_submission") {
    return parsed as SlackInteractivityPayload;
  }
  return null;
}

/**
 * `application/x-www-form-urlencoded` のスラッシュコマンド body をパースする。
 * 必須フィールド（`command`, `user_id`, `channel_id`, `trigger_id`, `response_url`）を欠く場合は `null`。
 */
export function parseSlashCommand(body: string): SlackSlashCommand | null {
  const params = new URLSearchParams(body);
  const command = params.get("command");
  const userId = params.get("user_id");
  const channelId = params.get("channel_id");
  const triggerId = params.get("trigger_id");
  const responseUrl = params.get("response_url");
  if (!command || !userId || !channelId || !triggerId || !responseUrl) {
    return null;
  }
  return {
    command,
    text: params.get("text") ?? "",
    user_id: userId,
    channel_id: channelId,
    trigger_id: triggerId,
    response_url: responseUrl,
  };
}
