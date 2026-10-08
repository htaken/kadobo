/**
 * 時間トリガーの登録（実装設計 §7.7、経費フェーズ §5.6、MF連携 §7）。既存の同名トリガーを
 * 削除してから作り直す（冪等）。
 *
 * 🔄 `trigMfSyncSoon` は締めボタン押下時に `SchedulerAdapter.scheduleOnce` が動的に作る
 * 1 回限りのトリガーで、`installTriggers` では作り直さない（毎時等の定期実行ではないため）。
 * ここに含めるのはあくまで「作り直しの際に古いものを消す」ため（実装設計 §7）。
 */
const TRIGGER_FUNCTION_NAMES = [
  "trigMorningCard",
  "trigEveningCheck",
  "trigMonthly",
  "trigWeeklyOrphanCheck",
  "trigMfSync",
  "trigMfSyncSoon",
] as const;

export function installTriggers(): void {
  const existing = ScriptApp.getProjectTriggers();
  for (const trigger of existing) {
    if ((TRIGGER_FUNCTION_NAMES as readonly string[]).includes(trigger.getHandlerFunction())) {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  ScriptApp.newTrigger("trigMorningCard").timeBased().everyDays(1).atHour(7).create();
  ScriptApp.newTrigger("trigEveningCheck").timeBased().everyDays(1).atHour(22).create();
  ScriptApp.newTrigger("trigMonthly").timeBased().onMonthDay(1).atHour(6).create();
  // 経費フェーズ §5.6: 毎週月曜 07 時台。
  ScriptApp.newTrigger("trigWeeklyOrphanCheck")
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(7)
    .create();
  // MF連携 §7: 毎時。
  ScriptApp.newTrigger("trigMfSync").timeBased().everyHours(1).create();
}
