/**
 * スラッシュコマンドハンドラ（実装設計 §6.5, §2.1、経費フェーズ §4.1）。
 *
 * 1. 🔄 `/keihi` → 実装設計 経費フェーズ §4.1: §2.2 の経費モーダルを組み立て、
 *    `views.open` の完了を待たずに `ctx.waitUntil` へ渡して直ちに 200 空ボディを返す
 *    （`trigger_id` は 3 秒で失効するため）。`views.open` 失敗時のみ `response_url` へ
 *    ephemeral でエラーを返す。GAS へは転送せず、D1 ジャーナルにも書かない
 * 2. `/kado …` → 引数を `''|'status'` に正規化（それ以外は ephemeral で使い方を返す）
 *    → D1 INSERT → 200 `{response_type:'ephemeral', text:'⏳ 処理中…'}` → `waitUntil` で GAS へ POST
 */
import { commandIdempotencyKey, ulid } from "@kadobo/shared/ids";
import type { CommandText, GasRequest } from "@kadobo/shared/protocol";
import { businessDateOf } from "@kadobo/shared/time";
import type { Env } from "../env";
import { sendToGas } from "../gas";
import * as journal from "../journal";
import { postResponseUrl, viewsOpen } from "../slack/api";
import type { SlackSlashCommand } from "../slack/parse";
import { randomBytes } from "../webcrypto";
import { buildExpenseModalView } from "./expense";

const KADO_USAGE_TEXT =
  "使い方: `/kado`（当日の稼働カードを表示） / `/kado status`（今週・今月の累計を表示）";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeKadoText(text: string): CommandText | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "status") {
    return trimmed;
  }
  return null;
}

export interface HandleSlashCommandInput {
  env: Env;
  ctx: ExecutionContext;
  command: SlackSlashCommand;
  fetchImpl?: typeof fetch;
}

export async function handleSlashCommand(input: HandleSlashCommandInput): Promise<Response> {
  const { env, ctx, command } = input;
  const fetchImpl = input.fetchImpl ?? fetch;

  if (command.command === "/keihi") {
    ctx.waitUntil(openExpenseModal({ env, command, fetchImpl }));
    return new Response(null, { status: 200 });
  }

  if (command.command !== "/kado") {
    return new Response("Not Found", { status: 404 });
  }

  const normalized = normalizeKadoText(command.text);
  if (normalized === null) {
    return jsonResponse({ response_type: "ephemeral", text: KADO_USAGE_TEXT });
  }

  const now = Date.now();
  const idempotencyKey = commandIdempotencyKey(command.user_id, command.trigger_id);
  const journalId = ulid(now, randomBytes);
  const gasRequest: GasRequest = {
    kind: "command",
    idempotency_key: idempotencyKey,
    user_id: command.user_id,
    channel_id: command.channel_id,
    text: normalized,
    response_url: command.response_url,
    received_at_ms: now,
    source: "command",
  };
  const insertResult = await journal.insertJournal(env.DB, {
    id: journalId,
    idempotency_key: idempotencyKey,
    kind: "command",
    payload: JSON.stringify(gasRequest),
    now,
  });

  ctx.waitUntil(
    (async () => {
      if (!insertResult.inserted) {
        return;
      }
      const forwardingEnabled = await journal.isForwardingEnabled(env.DB);
      if (!forwardingEnabled) {
        return;
      }
      const outcome = await sendToGas(env, gasRequest, { fetchImpl });
      await journal.recordAttemptResult(env.DB, journalId, outcome, Date.now());
      if (outcome.status === "rejected") {
        await postResponseUrl(
          command.response_url,
          { response_type: "ephemeral", text: `⚠️ 処理に失敗しました（エラー: ${outcome.error}）` },
          fetchImpl,
        ).catch(() => {});
      }
    })(),
  );

  return jsonResponse({ response_type: "ephemeral", text: "⏳ 処理中…" });
}

/**
 * `/keihi` の `views.open`（実装設計 経費フェーズ §4.1）。
 *
 * `view.private_metadata` に `command.channel_id` を積んで送る。`GasRequest.expense_submit`
 * の `channel_id`（cron.ts が全 pending で参照する通知先。経費フェーズ §3.1）が必須である一方、
 * `view_submission` ペイロード自体には投稿元チャンネルの情報が含まれないため、モーダルの
 * 往復でチャンネルを運ぶ以外に手段が無かった（`buildExpenseModalView` 自体の契約は
 * `private_metadata: ''` のままなので、ここで上書きする）。
 */
async function openExpenseModal(input: {
  env: Env;
  command: SlackSlashCommand;
  fetchImpl: typeof fetch;
}): Promise<void> {
  const { env, command, fetchImpl } = input;
  const todayJst = businessDateOf(Date.now());
  const view = buildExpenseModalView(todayJst);
  view.private_metadata = JSON.stringify({ channel_id: command.channel_id });
  try {
    await viewsOpen(env.SLACK_BOT_TOKEN, { trigger_id: command.trigger_id, view }, fetchImpl);
  } catch {
    await postResponseUrl(
      command.response_url,
      { response_type: "ephemeral", text: "モーダルを開けませんでした。もう一度 `/keihi` をお試しください。" },
      fetchImpl,
    ).catch(() => {});
  }
}
