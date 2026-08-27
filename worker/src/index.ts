/**
 * Cloudflare Worker エントリポイント（実装設計 §6）。
 *
 * `fetch`: POST のみ受け付ける。パスは `/slack/interactivity` `/slack/commands` `/internal/status`
 * の 3 つのみ（それ以外・POST 以外は 404）。Slack の 2 パスは raw body に対して署名検証してから
 * パースする（デコード・再シリアライズ前に検証する）。`/internal/status` は Slack 署名ではなく
 * Worker↔GAS 封筒（実装設計 §3.1, §3.4）で認証する。
 *
 * `scheduled`: `controller.cron` で `*\/5 * * * *`（pending 再送）と `17 3 * * *`（30 日削除）を分岐する。
 */
import { runCleanupCron, runRetryCron } from "./cron";
import type { Env } from "./env";
import { handleKadoCorrect } from "./handlers/correct";
import { handleSlashCommand } from "./handlers/command";
import { handleInternalStatus } from "./handlers/status";
import { handleStamp } from "./handlers/stamp";
import { handleViewSubmission } from "./handlers/view_submission";
import { isStampActionId, parseInteractivityPayload, parseSlashCommand } from "./slack/parse";
import { verifySlackSignature } from "./slack/verify";

export type { Env } from "./env";

const CRON_RETRY = "*/5 * * * *";
const CRON_CLEANUP = "17 3 * * *";

async function handleSlackRoute(pathname: string, rawBody: string, request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const nowSec = Math.floor(Date.now() / 1000);
  const verified = await verifySlackSignature({
    signingSecret: env.SLACK_SIGNING_SECRET,
    body: rawBody,
    timestampHeader: request.headers.get("X-Slack-Request-Timestamp"),
    signatureHeader: request.headers.get("X-Slack-Signature"),
    nowSec,
  });
  if (!verified) {
    console.warn("slack signature verification failed");
    return new Response("Unauthorized", { status: 401 });
  }

  if (pathname === "/slack/interactivity") {
    const parsed = parseInteractivityPayload(rawBody);
    if (!parsed) {
      return new Response("Bad Request", { status: 400 });
    }
    if (parsed.type === "block_actions") {
      const action = parsed.actions[0];
      if (!action) {
        return new Response("Bad Request", { status: 400 });
      }
      if (action.action_id === "kado_correct") {
        return handleKadoCorrect({ env, ctx, action, payload: parsed });
      }
      if (isStampActionId(action.action_id)) {
        return handleStamp({ env, ctx, action, payload: parsed });
      }
      // 未知の action_id: ACK のみ返し無視する。
      return new Response(null, { status: 200 });
    }
    // view_submission
    return handleViewSubmission({ env, ctx, payload: parsed });
  }

  // /slack/commands
  const command = parseSlashCommand(rawBody);
  if (!command) {
    return new Response("Bad Request", { status: 400 });
  }
  return handleSlashCommand({ env, ctx, command });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Not Found", { status: 404 });
    }
    const url = new URL(request.url);
    const rawBody = await request.text();

    if (url.pathname === "/internal/status") {
      return handleInternalStatus(env, rawBody);
    }
    if (url.pathname === "/slack/interactivity" || url.pathname === "/slack/commands") {
      return handleSlackRoute(url.pathname, rawBody, request, env, ctx);
    }
    return new Response("Not Found", { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (controller.cron === CRON_RETRY) {
      ctx.waitUntil(runRetryCron(env));
      return;
    }
    if (controller.cron === CRON_CLEANUP) {
      ctx.waitUntil(runCleanupCron(env));
    }
  },
} satisfies ExportedHandler<Env>;
