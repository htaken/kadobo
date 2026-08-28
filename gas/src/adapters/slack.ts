/**
 * `SlackPort` の GAS 実装（実装設計 §7.9）。`UrlFetchApp` で Slack Web API を呼ぶ。
 * `muteHttpExceptions: true`、`ok:false` は例外化。トークン・`response_url` はログに出さない。
 */
import type {
  PropsPort,
  SlackBlocksMessage,
  SlackPort,
  SlackPostMessageResult,
  SlackUpdateMessage,
  SlackViewsOpenInput,
  SlackViewsOpenResult,
  SlackViewsUpdateInput,
} from "../app/ports";

const SLACK_API_BASE = "https://slack.com/api";

function callSlackApi(token: string, method: string, body: unknown): Record<string, unknown> {
  const res = UrlFetchApp.fetch(`${SLACK_API_BASE}/${method}`, {
    method: "post",
    contentType: "application/json; charset=utf-8",
    headers: { Authorization: `Bearer ${token}` },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });

  let json: unknown;
  try {
    json = JSON.parse(res.getContentText());
  } catch {
    throw new Error(`slack_api_error:${method}:non_json_response`);
  }
  if (typeof json !== "object" || json === null || (json as { ok?: unknown }).ok !== true) {
    const err = typeof json === "object" && json !== null ? (json as { error?: unknown }).error : undefined;
    throw new Error(`slack_api_error:${method}${typeof err === "string" ? `:${err}` : ""}`);
  }
  return json as Record<string, unknown>;
}

/** `response_url` への POST（実装設計 §7.9）。`response_url` はそれ自体が認可情報のためログに出さない。 */
function postToResponseUrl(responseUrl: string, body: unknown): void {
  const res = UrlFetchApp.fetch(responseUrl, {
    method: "post",
    contentType: "application/json; charset=utf-8",
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`response_url_error:http_${code}`);
  }
}

export class SlackAdapter implements SlackPort {
  constructor(private readonly props: PropsPort) {}

  private token(): string {
    const token = this.props.get("SLACK_BOT_TOKEN");
    if (token === null) {
      throw new Error("missing_slack_bot_token");
    }
    return token;
  }

  postMessage(input: SlackBlocksMessage): SlackPostMessageResult {
    const json = callSlackApi(this.token(), "chat.postMessage", input);
    return { ts: String(json.ts) };
  }

  update(input: SlackUpdateMessage): void {
    callSlackApi(this.token(), "chat.update", input);
  }

  viewsOpen(input: SlackViewsOpenInput): SlackViewsOpenResult {
    const json = callSlackApi(this.token(), "views.open", input);
    const view = json.view as { id: string };
    return { view_id: view.id };
  }

  viewsUpdate(input: SlackViewsUpdateInput): void {
    callSlackApi(this.token(), "views.update", { view_id: input.view_id, view: input.view });
  }

  postEphemeral(responseUrl: string, text: string): void {
    postToResponseUrl(responseUrl, { replace_original: true, response_type: "ephemeral", text });
  }

  dm(userId: string, text: string): void {
    const opened = callSlackApi(this.token(), "conversations.open", { users: userId });
    const channel = opened.channel as { id: string };
    callSlackApi(this.token(), "chat.postMessage", { channel: channel.id, text });
  }

  deleteMessage(input: { channel: string; ts: string }): void {
    try {
      callSlackApi(this.token(), "chat.delete", input);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("message_not_found") || message.includes("cant_delete_message")) {
        return;
      }
      throw e;
    }
  }
}
