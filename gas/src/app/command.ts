/**
 * `command`（`/kado` の 3 種）ユースケース（実装設計 §7.5, §2.1）。
 */
import { businessDateOf } from "@kadobo/shared/time";
import type { GasRequest, GasResponse } from "@kadobo/shared/protocol";
import { redrawCardForBusinessDate } from "./cardHelpers";
import { startOfMonth, startOfWeek } from "./dateUtil";
import type { AppPorts, DailySummaryRow } from "./ports";

type CommandRequest = Extract<GasRequest, { kind: "command" }>;

function sumWorkedMinutes(rows: DailySummaryRow[]): number {
  return rows.reduce((sum, r) => sum + (r.worked_minutes ?? 0), 0);
}

function formatHoursMinutes(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

/**
 * `''`/`refresh` → 当日カードを再描画（無ければ投稿）。`status` → 今週・今月の累計を
 * `response_url` へ ephemeral 表示。`command`/`open_correction` は本質的に冪等なので
 * 重複判定は行わない（実装設計 §4.2）。
 */
export function handleCommand(req: CommandRequest, ports: AppPorts): GasResponse {
  const today = businessDateOf(ports.clock.nowMs());

  if (req.text === "" || req.text === "refresh") {
    redrawCardForBusinessDate(today, req.channel_id, ports);
    return { ok: true, applied: true };
  }

  // text === "status"
  const weekStart = startOfWeek(today);
  const monthStart = startOfMonth(today);
  const weekMinutes = sumWorkedMinutes(ports.sheets.getDailySummariesInRange(weekStart, today));
  const monthMinutes = sumWorkedMinutes(ports.sheets.getDailySummariesInRange(monthStart, today));
  const text = `今週の稼働: ${formatHoursMinutes(weekMinutes)} ／ 今月の稼働: ${formatHoursMinutes(monthMinutes)}`;

  try {
    ports.slack.postEphemeral(req.response_url, text);
  } catch {
    // response_url は短命なため失敗し得る。command は記録を伴わないので握りつぶして良い。
  }

  return { ok: true, applied: true };
}
