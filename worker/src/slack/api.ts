/**
 * Slack Web API 呼び出し（実装設計 §6.1）。
 *
 * `chat.update` / `views.open` / `views.update` / `chat.postMessage` / `response_url` への POST。
 * Bot トークンは `Authorization: Bearer`。`ok:false` はエラーとして扱う。
 * `fetchImpl` は既定で グローバル `fetch`（本番挙動）。テストではスタブを注入する。
 *
 * トークン・response_url・署名の値そのものはログに出さない。
 */
import type { SlackBlock } from "./parse";

const SLACK_API_BASE = "https://slack.com/api";

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string | undefined,
  ) {
    super(`slack_api_error:${method}${slackError ? `:${slackError}` : ""}`);
  }
}

async function callSlackApi(
  method: string,
  token: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new SlackApiError(method, "non_json_response");
  }
  if (typeof json !== "object" || json === null || (json as { ok?: unknown }).ok !== true) {
    const err = typeof json === "object" && json !== null ? (json as { error?: unknown }).error : undefined;
    throw new SlackApiError(method, typeof err === "string" ? err : `http_${res.status}`);
  }
  return json as Record<string, unknown>;
}

export interface ChatUpdateInput {
  channel: string;
  ts: string;
  text: string;
  blocks: SlackBlock[];
}

export async function chatUpdate(
  token: string,
  input: ChatUpdateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await callSlackApi("chat.update", token, input, fetchImpl);
}

export interface ChatPostMessageInput {
  /** チャンネル ID、またはユーザー ID（DM。実装設計は Worker の DM 送信に `chat.postMessage` を使う）。 */
  channel: string;
  text: string;
  blocks?: SlackBlock[];
}

export async function chatPostMessage(
  token: string,
  input: ChatPostMessageInput,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ts: string }> {
  const json = await callSlackApi("chat.postMessage", token, input, fetchImpl);
  return { ts: String(json.ts) };
}

export interface SlackModalView {
  type: "modal";
  callback_id: string;
  title: { type: "plain_text"; text: string };
  private_metadata: string;
  blocks: SlackBlock[];
  submit?: { type: "plain_text"; text: string };
  close?: { type: "plain_text"; text: string };
}

export async function viewsOpen(
  token: string,
  input: { trigger_id: string; view: SlackModalView },
  fetchImpl: typeof fetch = fetch,
): Promise<{ view: { id: string } }> {
  const json = await callSlackApi("views.open", token, input, fetchImpl);
  const view = json.view as { id: string };
  return { view };
}

export async function viewsUpdate(
  token: string,
  input: { view_id: string; view: SlackModalView },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  await callSlackApi("views.update", token, input, fetchImpl);
}

/**
 * `response_url` への POST（実装設計 §6.5。30 分・5 回制限があるため短期の受付通知にのみ使う）。
 * Slack の `response_url` はトークン不要（URL 自体が認可情報のため、ログに出さない）。
 */
export async function postResponseUrl(
  responseUrl: string,
  body: { response_type: "ephemeral" | "in_channel"; text: string; replace_original?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(responseUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`response_url_error:http_${res.status}`);
  }
}
