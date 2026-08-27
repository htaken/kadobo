/**
 * 失敗通知（実装設計 §3.3, §6.6）。
 *
 * - `ok:false, retryable:false`（rejected）: 本人へ DM
 * - Cron 再送が RETRY_NOTIFY_AT 回・以後 RETRY_NOTIFY_EVERY 回ごとに失敗: チャンネルへメンション
 *
 * いずれも通知自体の失敗は握りつぶす（journal には既に結果が記録されているため致命的ではない）。
 */
import type { Env } from "./env";
import { chatPostMessage } from "./slack/api";

/** `ok:false, retryable:false` → 本人へ DM（実装設計 §3.3）。`chat.postMessage` の `channel` にユーザー ID を渡す。 */
export async function notifyRejectedDm(
  env: Pick<Env, "SLACK_BOT_TOKEN">,
  userId: string,
  journalId: string,
  error: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const text = `⚠️ 記録に失敗しました（処理ID: ${journalId} / エラー: ${error}）。内容をご確認のうえ、必要であれば操作をやり直してください。`;
  try {
    await chatPostMessage(env.SLACK_BOT_TOKEN, { channel: userId, text }, fetchImpl);
  } catch {
    // 通知の失敗は握りつぶす。
  }
}

/** Cron 再送の N 回失敗メンション（実装設計 §6.6）。`messageTs` があればメッセージリンクを付ける。 */
export async function notifyRetryMention(
  env: Pick<Env, "SLACK_BOT_TOKEN">,
  input: { channelId: string; userId: string; messageTs?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const link = input.messageTs
    ? `\nhttps://slack.com/archives/${input.channelId}/p${input.messageTs.replace(".", "")}`
    : "";
  const text = `<@${input.userId}> ⚠️ 記録待ちの処理が繰り返し失敗しています。ご確認ください。${link}`;
  try {
    await chatPostMessage(env.SLACK_BOT_TOKEN, { channel: input.channelId, text }, fetchImpl);
  } catch {
    // 通知の失敗は握りつぶす。
  }
}
