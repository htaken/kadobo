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

/** `response_url` への ephemeral 応答（失敗は握りつぶす）。`postEphemeral` は `replace_original:
 * true` を伴うため、スラッシュコマンドが直後に返す「⏳ 処理中…」を置き換えて解決する。
 * `response_url` は短命なため失敗し得るが、command は記録を伴わないので握りつぶして良い。
 */
function resolveEphemeral(responseUrl: string, text: string, ports: AppPorts): void {
  try {
    ports.slack.postEphemeral(responseUrl, text);
  } catch {
    // 握りつぶす（コメント参照）。
  }
}

/**
 * `''` → 当日カードを再投稿（既存カードは削除して新規投稿。稼働終了後に再実行してもカードが
 * 見える位置に出るようにするための UX 修正）。`refresh` → 当日カードをその場更新（従来どおり）。
 * `status` → 今週・今月の累計を `response_url` へ ephemeral 表示。いずれも最後に
 * `postEphemeral` でスラッシュコマンドの「⏳ 処理中…」を解決する。`command`/`open_correction`
 * は本質的に冪等なので重複判定は行わない（実装設計 §4.2）。
 */
export function handleCommand(req: CommandRequest, ports: AppPorts): GasResponse {
  const today = businessDateOf(ports.clock.nowMs());

  if (req.text === "") {
    redrawCardForBusinessDate(today, req.channel_id, ports, { repost: true });
    resolveEphemeral(req.response_url, "✅ 本日の稼働カードを表示しました。", ports);
    return { ok: true, applied: true };
  }

  if (req.text === "refresh") {
    redrawCardForBusinessDate(today, req.channel_id, ports);
    resolveEphemeral(req.response_url, "✅ 稼働カードを更新しました。", ports);
    return { ok: true, applied: true };
  }

  // text === "status"
  const weekStart = startOfWeek(today);
  const monthStart = startOfMonth(today);
  const weekMinutes = sumWorkedMinutes(ports.sheets.getDailySummariesInRange(weekStart, today));
  const monthMinutes = sumWorkedMinutes(ports.sheets.getDailySummariesInRange(monthStart, today));
  const text = `今週の稼働: ${formatHoursMinutes(weekMinutes)} ／ 今月の稼働: ${formatHoursMinutes(monthMinutes)}`;

  resolveEphemeral(req.response_url, text, ports);

  return { ok: true, applied: true };
}
