/**
 * 稼働カード・修正モーダルの Block Kit 生成（実装設計 §2.2〜§2.4, §7.6）。純関数のみ。
 * Slack への送信（`UrlFetchApp` 等）は行わない。ブロック配列・モーダル定義のオブジェクトを
 * 返すだけ。
 */

import { jstToMs, toJst } from "@kadobo/shared/time";
import { applyCorrections } from "./correction";
import { isStampEvent, replay, type EventType, type LoggedEvent, type State } from "./state";
import type { SessionSummary } from "./aggregate";

/** `actions` ブロックのボタン `action_id`（実装設計 §2.3）。 */
export type CardActionId =
  | "kado_start"
  | "kado_break_start"
  | "kado_break_end"
  | "kado_end"
  | "kado_correct";

const STATE_LABEL_JA: Record<State, string> = {
  IDLE: "未稼働",
  WORKING: "稼働中",
  ON_BREAK: "休憩中",
  CLOSED: "確定",
};

const WEEKDAY_LABEL_JA = ["日", "月", "火", "水", "木", "金", "土"];

const EVENT_LABEL_JA: Record<EventType, string> = {
  START: "開始",
  BREAK_START: "休憩開始",
  BREAK_END: "休憩終了",
  END: "終了",
};

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** JST の `HH:mm` 表記（`shared/src/time.ts` の `formatHm` 相当をローカルでも使う）。 */
function hm(ms: number): string {
  const t = toJst(ms);
  return `${pad2(t.hour)}:${pad2(t.minute)}`;
}

/** `YYYY-MM-DD` の曜日を JST で求める（正午を基準にすれば日付境界の丸め誤差が無い）。 */
function weekdayLabel(businessDate: string): string {
  const noonMs = jstToMs(businessDate, "12:00");
  return WEEKDAY_LABEL_JA[toJst(noonMs).weekday] ?? "";
}

/** `H:MM`（コロン区切り、時は 0 埋めなし）。休憩時間の表示用（例: `0:30`）。 */
function formatDurationColon(totalSeconds: number): string {
  const totalMinutes = Math.floor(totalSeconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}:${pad2(m)}`;
}

/** `XhYm`（本日累計の表示用。例: `2h 28m`）。 */
function formatDurationLetters(totalSeconds: number): string {
  const totalMinutes = Math.floor(totalSeconds / 60);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

function button(actionId: CardActionId, label: string, value: string): object {
  return {
    type: "button",
    action_id: actionId,
    text: { type: "plain_text", text: label, emoji: true },
    value,
  };
}

/** 現在状態で有効なボタンのみを返す（実装設計 §2.3、要件定義 §4.1.2）。 */
function actionsForState(state: State, businessDate: string): object[] {
  switch (state) {
    case "IDLE":
      return [button("kado_start", "▶️開始", businessDate)];
    case "WORKING":
      return [
        button("kado_break_start", "☕休憩", businessDate),
        button("kado_end", "⏹️終了", businessDate),
        button("kado_correct", "✏️修正", businessDate),
      ];
    case "ON_BREAK":
      return [
        button("kado_break_end", "▶️再開", businessDate),
        button("kado_end", "⏹️終了", businessDate),
        button("kado_correct", "✏️修正", businessDate),
      ];
    case "CLOSED":
      return [
        button("kado_start", "▶️再開", businessDate),
        button("kado_correct", "✏️修正", businessDate),
      ];
  }
}

function sessionLine(session: SessionSummary): string {
  const start = hm(session.start_at);
  const breakSuffix =
    session.break_seconds > 0 ? `（休憩 ${formatDurationColon(session.break_seconds)}）` : "";
  if (session.end_at === null) {
    return `#${session.session_no} ${start} –`;
  }
  return `#${session.session_no} ${start} – ${hm(session.end_at)}${breakSuffix}`;
}

/** カード警告ブロック（前日が稼働中／休憩中のまま等）の入力（実装設計 §2.2, §4.1.1）。 */
export interface CardWarning {
  /** 警告文の本文（絵文字・接頭辞は付けない）。 */
  text: string;
  /** 警告に付随する「✏️ 修正」ボタンの対象業務日（前日警告なら前日の日付）。 */
  business_date: string;
}

/**
 * 「本日累計」表示の区分（実装設計 §7.3 の日次 `status` に対応）。
 * - `ok`: 確定済み（`daily.status === 'OK'`）。通常どおり合計時間を表示する。
 * - `in_progress`: 進行中（`daily.status === '進行中'`＝ WORKING/ON_BREAK）。完了済み
 *   セッションの合計時間を「計測中」の注記付きで表示する（要修正ではない）。
 * - `needs_fix`: 要修正（`daily.status === '要修正'`）。合計時間は表示せず警告のみ。
 */
export type TotalStatus = "ok" | "in_progress" | "needs_fix";

export interface RenderCardInput {
  /** `YYYY-MM-DD`（JST）。 */
  business_date: string;
  state: State;
  sessions: SessionSummary[];
  /**
   * 完了済みセッションの合計秒。進行中（`totalStatus: 'in_progress'`）でも、完了済み分は
   * 算出できるためここに渡す。`totalStatus: 'needs_fix'` のときは表示に使われない（`0` でよい）。
   */
  totalSeconds: number;
  /** 本日累計表示の区分。{@link TotalStatus} 参照。 */
  totalStatus: TotalStatus;
  /** `status` context ブロックの文言（{@link renderStatusLine} で生成）。`null`/未指定ならブロックを省略。 */
  statusLine?: string | null;
  warning?: CardWarning;
}

/**
 * 稼働カードの Block Kit `blocks[]` を生成する（実装設計 §2.2, §7.6）。
 * `block_id` は header / warning（任意） / sessions / total / actions / status（任意）。
 */
export function renderCard(input: RenderCardInput): object[] {
  const blocks: object[] = [];

  blocks.push({
    type: "section",
    block_id: "header",
    text: {
      type: "mrkdwn",
      text: `*📋 稼働記録 ${input.business_date}（${weekdayLabel(input.business_date)}）*\n状態: ${STATE_LABEL_JA[input.state]}`,
    },
  });

  if (input.warning !== undefined) {
    blocks.push({
      type: "section",
      block_id: "warning",
      text: { type: "mrkdwn", text: `⚠️ ${input.warning.text}` },
      accessory: button("kado_correct", "✏️修正", input.warning.business_date),
    });
  }

  const sessionsText =
    input.sessions.length > 0
      ? input.sessions.map(sessionLine).join("\n")
      : "本日はまだ記録がありません";
  blocks.push({
    type: "section",
    block_id: "sessions",
    text: { type: "mrkdwn", text: sessionsText },
  });

  const totalText = ((): string => {
    switch (input.totalStatus) {
      case "needs_fix":
        return "本日累計 ⚠️ 要修正";
      case "in_progress":
        return `本日累計 ${formatDurationLetters(input.totalSeconds)}（計測中）`;
      case "ok":
        return `本日累計 ${formatDurationLetters(input.totalSeconds)}`;
    }
  })();
  blocks.push({
    type: "section",
    block_id: "total",
    text: { type: "mrkdwn", text: totalText },
  });

  blocks.push({
    type: "actions",
    block_id: "actions",
    elements: actionsForState(input.state, input.business_date),
  });

  if (input.statusLine !== undefined && input.statusLine !== null) {
    blocks.push({
      type: "context",
      block_id: "status",
      elements: [{ type: "mrkdwn", text: input.statusLine }],
    });
  }

  return blocks;
}

/**
 * `status` context ブロックの 3 文言を生成する（実装設計 §2.2）。
 * `⏳ {ラベル} {HH:mm} 記録中…` / `⚠️ 記録待ち（自動再試行中）` / `✅ {ラベル} {HH:mm} 記録済み`。
 */
export function renderStatusLine(
  input:
    | { kind: "processing" | "done"; label: string; occurredAtMs: number }
    | { kind: "pending" },
): string {
  if (input.kind === "pending") {
    return "⚠️ 記録待ち（自動再試行中）";
  }
  const mark = input.kind === "processing" ? "⏳" : "✅";
  const suffix = input.kind === "processing" ? "記録中…" : "記録済み";
  return `${mark} ${input.label} ${hm(input.occurredAtMs)} ${suffix}`;
}

/**
 * Worker が `views.open` で開くローディングビュー（実装設計 §2.4）。
 * GAS 側の参照実装・テスト用。`callback_id: kado_correction`、`private_metadata` に
 * `channel_id`/`message_ts`/`business_date` を JSON で埋め込む。submit ボタンは無い。
 */
export function renderLoadingModal(input: {
  channel_id: string;
  message_ts: string;
  business_date: string;
}): object {
  return {
    type: "modal",
    callback_id: "kado_correction",
    title: { type: "plain_text", text: "稼働記録の修正" },
    private_metadata: JSON.stringify({
      channel_id: input.channel_id,
      message_ts: input.message_ts,
      business_date: input.business_date,
    }),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "⏳ 読み込み中…" },
      },
    ],
  };
}

/**
 * GAS が `views.update` で差し替える本ビュー（実装設計 §2.4）。
 *
 * `events` は当該業務日の生ログ（`CORRECTION` 行を含んでよい。内部で訂正を適用してから
 * 選択肢を構築する）。`target_select` の各選択肢は「訂正適用後の現在値」を表示する。
 * `add_end`（終了イベントを追加＝押し忘れ）は現在状態が稼働中／休憩中のときのみ追加する。
 *
 * `private_metadata` はこの関数の引数に含まれないため設定しない。呼び出し側
 * （app 層）が `view_submission`／`open_correction` で受け取った値をそのまま
 * `views.update` 呼び出しに載せること（WP3 への申し送り）。
 */
export function renderCorrectionModal(events: LoggedEvent[], businessDate: string): object {
  const corrected = applyCorrections(events).filter(isStampEvent);
  const sorted = [...corrected].sort((a, b) => a.occurred_at - b.occurred_at);
  const state = replay(sorted).state;

  const options: object[] = sorted.map((event) => ({
    text: {
      type: "plain_text",
      text: `${EVENT_LABEL_JA[event.event_type]} ${hm(event.occurred_at)}`,
    },
    value: event.event_id,
  }));

  if (state === "WORKING" || state === "ON_BREAK") {
    options.push({
      text: { type: "plain_text", text: "終了イベントを追加（押し忘れ）" },
      value: "add_end",
    });
  }

  return {
    type: "modal",
    callback_id: "kado_correction",
    title: { type: "plain_text", text: "稼働記録の修正" },
    submit: { type: "plain_text", text: "保存" },
    blocks: [
      {
        type: "input",
        block_id: "target",
        label: { type: "plain_text", text: "対象" },
        element: {
          type: "static_select",
          action_id: "target_select",
          options,
        },
      },
      {
        type: "input",
        block_id: "date",
        label: { type: "plain_text", text: "日付" },
        element: {
          type: "datepicker",
          action_id: "date_pick",
          initial_date: businessDate,
        },
      },
      {
        type: "input",
        block_id: "time",
        label: { type: "plain_text", text: "時刻" },
        element: {
          type: "timepicker",
          action_id: "time_pick",
        },
      },
      {
        type: "input",
        block_id: "reason",
        label: { type: "plain_text", text: "理由" },
        element: {
          type: "plain_text_input",
          action_id: "reason_input",
          max_length: 200,
        },
      },
    ],
  };
}
