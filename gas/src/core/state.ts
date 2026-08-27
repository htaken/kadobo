/**
 * 稼働記録の状態機械（実装設計 §7.2、要件定義 §4.1.2）。純関数のみ。
 * GAS API・Node/DOM API に依存しない。
 *
 * 永続状態＝生ログ（イベント列）のみが真実。現在状態は「対象業務日のイベント
 * （訂正適用後）を occurred_at 昇順に再生」して求める（{@link replay}）。
 */

/** 稼働状態（未稼働 / 稼働中 / 休憩中 / 確定）。 */
export type State = "IDLE" | "WORKING" | "ON_BREAK" | "CLOSED";

/** 打刻として記録され得るイベント種別（実装設計 §7.2）。 */
export type EventType = "START" | "BREAK_START" | "BREAK_END" | "END";

/** 生ログの `event_type`（打刻 4 種 ＋ 訂正）。 */
export type LogEventType = EventType | "CORRECTION";

/**
 * core が扱うイベントの最小フィールド（実装設計 §7.2）。
 * 生ログの行そのものではなく、状態機械・集計に必要な最小フィールドのみを持つ。
 * `CORRECTION` 行では `occurred_at` は訂正操作自体の時刻、`correction_of` は対象
 * `event_id`、`new_value` は訂正後の `occurred_at`（ms）を表す（実装設計 §4.1.4）。
 */
export interface LoggedEvent {
  event_id: string;
  event_type: LogEventType;
  /** UTC epoch ms。`CORRECTION` 行では訂正操作自体の時刻。 */
  occurred_at: number;
  /** `CORRECTION` 行のみ: 対象イベントの `event_id`。 */
  correction_of?: string;
  /** `CORRECTION` 行のみ: 訂正後の `occurred_at`（UTC epoch ms）。 */
  new_value?: number;
}

/** 状態機械の遷移表（実装設計 §7.2 の表そのまま）。`undefined` = 不正遷移。 */
const TRANSITIONS: Record<State, Partial<Record<EventType, State>>> = {
  IDLE: { START: "WORKING" },
  WORKING: { BREAK_START: "ON_BREAK", END: "CLOSED" },
  ON_BREAK: { BREAK_END: "WORKING", END: "CLOSED" },
  CLOSED: { START: "WORKING" },
};

/**
 * 状態遷移を検証する（実装設計 §7.2）。表に無い遷移は `null`（不正遷移）。
 */
export function transition(state: State, eventType: EventType): State | null {
  return TRANSITIONS[state][eventType] ?? null;
}

/** `LoggedEvent` が打刻 4 種（`CORRECTION` 以外）かどうかを判定する型ガード。 */
export function isStampEvent(
  event: LoggedEvent,
): event is LoggedEvent & { event_type: EventType } {
  return event.event_type !== "CORRECTION";
}

/** {@link replay} の結果。 */
export interface ReplayResult {
  /** 再生後の現在状態。 */
  state: State;
  /** 再生された（有効な）`START` の回数＝当日のセッション番号（0 始まり=未開始）。 */
  sessionNo: number;
}

/**
 * 対象業務日の打刻イベントを `occurred_at` 昇順に再生し、現在状態とセッション番号を求める
 * （実装設計 §7.2）。呼び出し側は `CORRECTION` 適用済み・当該業務日に絞り込んだ
 * {@link EventType} のイベントを渡す想定（`applyCorrections` → `isStampEvent` でフィルタ）。
 *
 * 入力配列は破壊しない。`occurred_at` が同値の場合は入力順を保つ安定ソートで並べる。
 *
 * 不正な遷移（表に無い遷移）に当たった場合は、その 1 件を無視して次のイベントへ進む
 * （壊れたデータでも `replay` は常に何らかの状態を返す total function とする）。
 * ペアリング不能の検出・「要修正」判定は集計側（`aggregate.ts`）の責務であり、
 * `replay` 自体はエラーを報告しない。
 */
export function replay(events: LoggedEvent[]): ReplayResult {
  const sorted = [...events].sort((a, b) => a.occurred_at - b.occurred_at);
  let state: State = "IDLE";
  let sessionNo = 0;
  for (const event of sorted) {
    const next = transition(state, event.event_type as EventType);
    if (next === null) {
      continue;
    }
    if (event.event_type === "START") {
      sessionNo += 1;
    }
    state = next;
  }
  return { state, sessionNo };
}
