/**
 * `SchedulerPort` の GAS 実装（実装設計 MF連携 §7, §8）。`ScriptApp` の時間トリガーを動的に
 * 作成・確認・削除する。WP-M2 では `trigMfSyncSoon`（締めボタンから 1 分後に 1 回）にのみ使う。
 */
import type { SchedulerHandler, SchedulerPort } from "../app/ports";

export class SchedulerAdapter implements SchedulerPort {
  scheduleOnce(handler: SchedulerHandler, afterMs: number): void {
    if (this.hasPending(handler)) {
      // 既に同名のトリガーが残っていれば作らない（GAS のトリガー数上限を消費し続けないため。
      // 実装設計 §7）。
      return;
    }
    ScriptApp.newTrigger(handler).timeBased().after(afterMs).create();
  }

  hasPending(handler: SchedulerHandler): boolean {
    return ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === handler);
  }

  clear(handler: SchedulerHandler): void {
    for (const trigger of ScriptApp.getProjectTriggers()) {
      if (trigger.getHandlerFunction() === handler) {
        ScriptApp.deleteTrigger(trigger);
      }
    }
  }
}
