/**
 * スラッシュコマンドハンドラ（実装設計 §6.5, §2.1）。
 *
 * 1. `/keihi` → 200 `{response_type:'ephemeral', text:…}` で終了（転送しない）
 * 2. `/kado …` → 引数を `''|'refresh'|'status'` に正規化（それ以外は ephemeral で使い方を返す）
 *    → D1 INSERT → 200 `{response_type:'ephemeral', text:'⏳ 処理中…'}` → `waitUntil` で GAS へ POST
 */
import { commandIdempotencyKey, ulid } from "@kadobo/shared/ids";
import type { CommandText, GasRequest } from "@kadobo/shared/protocol";
import type { Env } from "../env";
import { sendToGas } from "../gas";
import * as journal from "../journal";
import { postResponseUrl } from "../slack/api";
import type { SlackSlashCommand } from "../slack/parse";
import { randomBytes } from "../webcrypto";

const KEIHI_EPHEMERAL_TEXT =
  "経費機能は自動化フェーズで提供予定です（暫定運用: 紙原本保管＋Drive手動保存）。";

const KADO_USAGE_TEXT =
  "使い方: `/kado`（当日カードを投稿・再描画） / `/kado refresh`（再描画） / `/kado status`（今週・今月の累計を表示）";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeKadoText(text: string): CommandText | null {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === "refresh" || trimmed === "status") {
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
    return jsonResponse({ response_type: "ephemeral", text: KEIHI_EPHEMERAL_TEXT });
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
