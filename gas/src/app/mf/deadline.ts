/**
 * `trigMfSync`/`trigMfSyncSoon` の開始時刻を基準にした絶対期限（実装設計 MF連携 §6.8 の「4 分」。
 * GAS の 1 実行 6 分の内側）。トリガーが 1 つ作り、`ensureInvoiceCreated`・`trackBillingStatus`・
 * `syncExpenses` に渡す。各処理は**行・ページ取得の開始前**に {@link RunDeadline.isExpired} を確認し、
 * 期限を過ぎていたら新しい作業に手を付けずに、状態を変えないまま終える（次回のトリガーが続きを処理する）。
 */
import type { ClockPort } from "../ports";

/** 実装設計 §6.8: 実行開始から 4 分。 */
export const MF_RUN_DEADLINE_MS = 4 * 60 * 1000;

export class RunDeadline {
  private readonly startedAtMs: number;

  constructor(
    private readonly clock: Pick<ClockPort, "nowMs">,
    private readonly limitMs: number = MF_RUN_DEADLINE_MS,
    startedAtMs?: number,
  ) {
    this.startedAtMs = startedAtMs ?? clock.nowMs();
  }

  isExpired(): boolean {
    return this.clock.nowMs() - this.startedAtMs >= this.limitMs;
  }
}

/**
 * 期限切れで検索（ページ取得）を打ち切ったことを表す。検索結果が途中までなのに「見つからなかった」と
 * 読むと二重作成になるため、**結果を返さず例外にする**。呼び出し側（`syncExpenses`・`ensureInvoiceCreated`）が
 * 捕まえ、その実行の残りを状態を変えずに終える。
 */
export class RunDeadlineExceededError extends Error {
  constructor() {
    super("MF_RUN_DEADLINE_EXCEEDED");
    this.name = "RunDeadlineExceededError";
  }
}
