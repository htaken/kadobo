/**
 * 時間トリガーの登録（実装設計 §7.7、経費フェーズ §5.6）。既存の同名トリガーを削除してから
 * 作り直す（冪等）。
 */
const TRIGGER_FUNCTION_NAMES = [
  "trigMorningCard",
  "trigEveningCheck",
  "trigMonthly",
  "trigWeeklyOrphanCheck",
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
}
