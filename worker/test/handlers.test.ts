/**
 * ハンドラのテスト（実装設計 §6.2〜§6.5）。
 *
 * `createTestHarness` で得た実 D1 バインディングに対し、ハンドラ関数を直接呼び出す
 * （`index.ts` の `fetch()` は経由しない）。Slack API・GAS への外部通信は `fetchImpl`
 * を注入したスタブで完結させ、実ネットワークには一切アクセスしない。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import type { Env } from "../src/index";
import { handleKadoCorrect } from "../src/handlers/correct";
import { handleSlashCommand } from "../src/handlers/command";
import { handleStamp, isCardSafeToOverwrite, withStatusBlock } from "../src/handlers/stamp";
import { handleViewSubmission } from "../src/handlers/view_submission";
import * as journal from "../src/journal";
import type { SlackBlockAction, SlackBlockActionsPayload, SlackSlashCommand, SlackViewSubmissionPayload } from "../src/slack/parse";
import { createTestCtx, jsonResponse, makeEnv, createFetchStub } from "./support";

const server = createTestHarness({ workers: [{ configPath: "./wrangler.jsonc" }] });

let db: D1Database;

beforeAll(async () => {
  await server.listen();
  const worker = server.getWorker<Env>();
  await worker.applyD1Migrations("DB");
  db = (await worker.getEnv()).DB;
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  await db.exec("DELETE FROM journal");
  await db.exec("DELETE FROM nonces");
  await db.exec("UPDATE settings SET value = '1' WHERE key = 'forwarding_enabled'");
});

async function allJournalRows() {
  return (await db.prepare("SELECT * FROM journal ORDER BY created_at").all<any>()).results;
}

// --- handleStamp（実装設計 §6.2） ---

function makeStampPayload(overrides?: Partial<SlackBlockActionsPayload>): SlackBlockActionsPayload {
  return {
    type: "block_actions",
    user: { id: "U1" },
    channel: { id: "C1" },
    message: {
      ts: "1756260000.000100",
      text: "稼働記録",
      blocks: [
        { block_id: "header", type: "section" },
        { block_id: "actions", type: "actions", elements: [{ type: "button", action_id: "kado_start" }] },
        { block_id: "status", type: "context" },
      ],
    },
    actions: [],
    trigger_id: "T1",
    response_url: "https://hooks.slack.test/resp",
    ...overrides,
  };
}

function makeStampAction(overrides?: Partial<SlackBlockAction>): SlackBlockAction {
  return { action_id: "kado_start", action_ts: "1756260000.123456", value: "2026-09-01", text: { type: "plain_text", text: "開始" }, ...overrides };
}

describe("handleStamp", () => {
  it("成功（ok:true）: journal は done、chat.update は ⏳ のみで ⚠️ は出さない", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub();
    const payload = makeStampPayload();
    const action = makeStampAction();

    const res = await handleStamp({ env, ctx, action, payload, fetchImpl });
    expect(res.status).toBe(200);
    await flush();

    const rows = await allJournalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
    expect(rows[0].kind).toBe("stamp");

    const chatUpdateCalls = calls.filter((c) => c.url.endsWith("/chat.update"));
    expect(chatUpdateCalls).toHaveLength(1); // ⏳ の 1 回のみ（失敗していないので ⚠️ は無い）
    const blocks = (chatUpdateCalls[0]?.body as any).blocks;
    expect(blocks.find((b: any) => b.block_id === "status").elements[0].text).toContain("⏳ 開始");
    expect(blocks.filter((b: any) => b.block_id === "status")).toHaveLength(1);
    // ⏳ 表示中は actions を外して二度押しを防ぐ（ボタンは GAS の再描画で戻る）。
    expect(blocks.some((b: any) => b.block_id === "actions")).toBe(false);
  });

  it("重複押下: 2 回目は journal 追加なしで即 200", async () => {
    const env = makeEnv(db);
    const payload = makeStampPayload();
    const action = makeStampAction();

    const first = createTestCtx();
    const stub1 = createFetchStub();
    await handleStamp({ env, ctx: first.ctx, action, payload, fetchImpl: stub1.fetchImpl });
    await first.flush();

    const second = createTestCtx();
    const stub2 = createFetchStub();
    const res2 = await handleStamp({ env, ctx: second.ctx, action, payload, fetchImpl: stub2.fetchImpl });
    await second.flush();

    expect(res2.status).toBe(200);
    expect(stub2.calls).toHaveLength(0); // 2 回目は chat.update も GAS も呼ばない
    const rows = await allJournalRows();
    expect(rows).toHaveLength(1);
  });

  it("GAS: ok:false,retryable:true → pending・attempts++・カードは ⚠️", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "LOCK_TIMEOUT", retryable: true });
      }
      return undefined;
    });
    const payload = makeStampPayload();
    const action = makeStampAction({ action_id: "kado_break_start", text: { type: "plain_text", text: "休憩" } });

    await handleStamp({ env, ctx, action, payload, fetchImpl });
    await flush();

    const rows = await allJournalRows();
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(1);
    expect(rows[0].last_error).toBe("LOCK_TIMEOUT");

    const chatUpdateCalls = calls.filter((c) => c.url.endsWith("/chat.update"));
    expect(chatUpdateCalls).toHaveLength(2); // ⏳ → ⚠️
    const lastBlocks = (chatUpdateCalls[chatUpdateCalls.length - 1]?.body as any).blocks;
    expect(lastBlocks.find((b: any) => b.block_id === "status").elements[0].text).toBe(
      "⚠️ 記録待ち（自動再試行中）",
    );
    // LOCK_TIMEOUT は GAS がカードに触れる前のエラー。⏳ で外したボタンをここで戻す。
    expect(lastBlocks.some((b: any) => b.block_id === "actions")).toBe(true);
    // rejected ではないので DM (chat.postMessage 宛先=user_id) は送らない
    const dm = calls.find((c) => c.url.endsWith("/chat.postMessage") && (c.body as any).channel === "U1");
    expect(dm).toBeUndefined();
  });

  it("GAS: ok:false,retryable:false → rejected・本人へ DM", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "SCHEMA_ERROR", retryable: false });
      }
      return undefined;
    });
    const payload = makeStampPayload();
    const action = makeStampAction({ action_id: "kado_end", text: { type: "plain_text", text: "終了" } });

    await handleStamp({ env, ctx, action, payload, fetchImpl });
    await flush();

    const rows = await allJournalRows();
    expect(rows[0].status).toBe("rejected");
    expect(rows[0].last_error).toBe("SCHEMA_ERROR");

    const dm = calls.find((c) => c.url.endsWith("/chat.postMessage") && (c.body as any).channel === "U1");
    expect(dm).toBeDefined();
    expect((dm?.body as any).text).toContain("SCHEMA_ERROR");

    // rejected は Cron 再送されない終局状態。ここでカードを戻さないとボタンが消えたままになる。
    const lastUpdate = calls.filter((c) => c.url.endsWith("/chat.update")).pop();
    const lastBlocks = (lastUpdate?.body as any).blocks;
    expect(lastBlocks.some((b: any) => b.block_id === "actions")).toBe(true);
    expect(lastBlocks.find((b: any) => b.block_id === "status").elements[0].text).toBe(
      "⚠️ 記録に失敗しました（DM をご確認ください）",
    );
  });

  it("timeout: 適用有無が不明なのでカードは ⏳ のまま。⚠️ 上書きせず response_url へ ephemeral", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        // AbortController によるタイムアウトと同じ結果（例外）を再現する。
        throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
      }
      return undefined;
    });
    const payload = makeStampPayload();

    await handleStamp({ env, ctx, action: makeStampAction(), payload, fetchImpl });
    await flush();

    const rows = await allJournalRows();
    expect(rows[0].status).toBe("pending");

    // ⏳ の 1 回だけ。GAS がすでにカードを描き替えている可能性があるため上書きしない。
    const chatUpdateCalls = calls.filter((c) => c.url.endsWith("/chat.update"));
    expect(chatUpdateCalls).toHaveLength(1);
    expect((chatUpdateCalls[0]?.body as any).blocks.find((b: any) => b.block_id === "status").elements[0].text)
      .toContain("⏳");

    // 代わりに本人へ ephemeral。カード自体を差し替えないよう replace_original は付けない。
    const ephemeral = calls.find((c) => c.url === payload.response_url);
    expect(ephemeral).toBeDefined();
    expect((ephemeral?.body as any).response_type).toBe("ephemeral");
    expect((ephemeral?.body as any).replace_original).toBeUndefined();
    expect((ephemeral?.body as any).text).toContain("確認できませんでした");
  });

  it("GAS が HTTP 500: 同じく不明扱い。カードは ⏳ のままで ephemeral", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return new Response("boom", { status: 500 });
      }
      return undefined;
    });
    const payload = makeStampPayload();

    await handleStamp({ env, ctx, action: makeStampAction(), payload, fetchImpl });
    await flush();

    const rows = await allJournalRows();
    expect(rows[0].status).toBe("pending");
    expect(rows[0].last_error).toBe("http_500");
    expect(calls.filter((c) => c.url.endsWith("/chat.update"))).toHaveLength(1);
    expect(calls.some((c) => c.url === payload.response_url)).toBe(true);
  });

  it("response_url が無い状態で不明終了: ephemeral の代わりに DM で知らせる", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "Service Spreadsheets timed out", retryable: true });
      }
      return undefined;
    });
    const payload = makeStampPayload({ response_url: undefined });

    await handleStamp({ env, ctx, action: makeStampAction(), payload, fetchImpl });
    await flush();

    // GAS の総括 catch 由来のエラーは「追記後に落ちた」可能性があるため上書きしない。
    expect(calls.filter((c) => c.url.endsWith("/chat.update"))).toHaveLength(1);
    const dm = calls.find((c) => c.url.endsWith("/chat.postMessage") && (c.body as any).channel === "U1");
    expect((dm?.body as any).text).toContain("確認できませんでした");
  });

  it("forwarding_enabled='0': GAS へ送らず journal は pending のまま、カードは ⚠️", async () => {
    await db.exec("UPDATE settings SET value = '0' WHERE key = 'forwarding_enabled'");
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub();
    const payload = makeStampPayload();
    const action = makeStampAction();

    await handleStamp({ env, ctx, action, payload, fetchImpl });
    await flush();

    expect(calls.some((c) => c.url === env.GAS_URL)).toBe(false);
    const rows = await allJournalRows();
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(0);
  });
});

describe("withStatusBlock", () => {
  it("既存の status ブロックを除去してから新しいものを末尾に足す", () => {
    const blocks = withStatusBlock(
      [{ block_id: "header" }, { block_id: "status", elements: [{ type: "mrkdwn", text: "old" }] }],
      "⏳ test",
    );
    expect(blocks.filter((b) => b.block_id === "status")).toHaveLength(1);
    expect(blocks[blocks.length - 1]).toEqual({
      type: "context",
      block_id: "status",
      elements: [{ type: "mrkdwn", text: "⏳ test" }],
    });
  });

  it("既定では actions ブロックを残す", () => {
    const blocks = withStatusBlock([{ block_id: "header" }, { block_id: "actions" }], "⚠️ test");
    expect(blocks.some((b) => b.block_id === "actions")).toBe(true);
  });

  it("removeActions: actions ブロックも除去する（⏳ 中の二度押し防止）", () => {
    const blocks = withStatusBlock([{ block_id: "header" }, { block_id: "actions" }], "⏳ test", {
      removeActions: true,
    });
    expect(blocks.some((b) => b.block_id === "actions")).toBe(false);
    expect(blocks.some((b) => b.block_id === "header")).toBe(true);
  });
});

describe("isCardSafeToOverwrite", () => {
  it("rejected と GAS の適用前エラーだけ true", () => {
    expect(isCardSafeToOverwrite({ status: "rejected", error: "BAD_REQUEST" })).toBe(true);
    expect(isCardSafeToOverwrite({ status: "rejected", error: "SCHEMA_ERROR" })).toBe(true);
    expect(isCardSafeToOverwrite({ status: "pending", error: "LOCK_TIMEOUT" })).toBe(true);
  });

  it("適用有無が不明な結果は false（GAS が描いたカードを壊さない）", () => {
    expect(isCardSafeToOverwrite({ status: "pending", error: "timeout" })).toBe(false);
    expect(isCardSafeToOverwrite({ status: "pending", error: "http_500" })).toBe(false);
    expect(isCardSafeToOverwrite({ status: "pending", error: "invalid_response_shape" })).toBe(false);
    expect(isCardSafeToOverwrite({ status: "pending", error: "Service Spreadsheets timed out" })).toBe(false);
    expect(isCardSafeToOverwrite({ status: "done" })).toBe(false);
  });
});

// --- handleKadoCorrect（実装設計 §6.3） ---

describe("handleKadoCorrect", () => {
  function makeCorrectPayload(): SlackBlockActionsPayload {
    return {
      type: "block_actions",
      user: { id: "U1" },
      channel: { id: "C1" },
      message: { ts: "1756260000.000100", text: "稼働記録", blocks: [] },
      actions: [],
      trigger_id: "T1",
    };
  }
  function makeCorrectAction(): SlackBlockAction {
    return { action_id: "kado_correct", action_ts: "1756260000.999999", value: "2026-09-01" };
  }

  it("成功（ok:true）: journal は open_correction/done、views.update は呼ばない", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: true, applied: true });
      }
      return undefined;
    });

    await handleKadoCorrect({ env, ctx, action: makeCorrectAction(), payload: makeCorrectPayload(), fetchImpl });
    await flush();

    expect(calls.some((c) => c.url.endsWith("/views.open"))).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/views.update"))).toBe(false);
    const rows = await allJournalRows();
    expect(rows[0].kind).toBe("open_correction");
    expect(rows[0].status).toBe("done");
  });

  it("失敗（retryable:true でも）: open_correction は再送しないため rejected として記録し、views.update でエラー表示", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "LOCK_TIMEOUT", retryable: true });
      }
      return undefined;
    });

    await handleKadoCorrect({ env, ctx, action: makeCorrectAction(), payload: makeCorrectPayload(), fetchImpl });
    await flush();

    const rows = await allJournalRows();
    expect(rows[0].status).toBe("rejected"); // pending ではなく rejected（再送しない）

    const viewsUpdateCall = calls.find((c) => c.url.endsWith("/views.update"));
    expect(viewsUpdateCall).toBeDefined();
    expect((viewsUpdateCall?.body as any).view.blocks[0].text.text).toContain("接続できませんでした");
  });

  it("views.open 自体が失敗: journal に何も記録しない", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl } = createFetchStub((url) => {
      if (url.endsWith("/views.open")) {
        return jsonResponse({ ok: false, error: "expired_trigger_id" });
      }
      return undefined;
    });

    await handleKadoCorrect({ env, ctx, action: makeCorrectAction(), payload: makeCorrectPayload(), fetchImpl });
    await flush();

    const rows = await allJournalRows();
    expect(rows).toHaveLength(0);
  });
});

// --- handleViewSubmission（実装設計 §6.4） ---

describe("handleViewSubmission", () => {
  function makeSubmissionPayload(values: SlackViewSubmissionPayload["view"]["state"]["values"]): SlackViewSubmissionPayload {
    return {
      type: "view_submission",
      user: { id: "U1" },
      view: {
        id: "V1",
        callback_id: "kado_correction",
        private_metadata: JSON.stringify({ channel_id: "C1", message_ts: "1756260000.000100", business_date: "2026-09-01" }),
        state: { values },
      },
    };
  }

  it("必須項目欠落: response_action:errors を同期で返し、journal には記録しない", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub();
    const payload = makeSubmissionPayload({});

    const res = await handleViewSubmission({ env, ctx, payload, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_action).toBe("errors");
    expect(body.errors.target).toBeDefined();
    expect(body.errors.date).toBeDefined();
    expect(body.errors.time).toBeDefined();
    expect(body.errors.reason).toBeDefined();

    await flush();
    expect(await allJournalRows()).toHaveLength(0);
    expect(calls).toHaveLength(0); // GAS へは一切送らない
  });

  it("reason が200文字超なら errors", async () => {
    const env = makeEnv(db);
    const { ctx } = createTestCtx();
    const { fetchImpl } = createFetchStub();
    const payload = makeSubmissionPayload({
      target: { target_select: { type: "static_select", selected_option: { value: "add_end" } } },
      date: { date_pick: { type: "datepicker", selected_date: "2026-09-01" } },
      time: { time_pick: { type: "timepicker", selected_time: "18:00" } },
      reason: { reason_input: { type: "plain_text_input", value: "あ".repeat(201) } },
    });

    const res = await handleViewSubmission({ env, ctx, payload, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_action).toBe("errors");
    expect(body.errors.reason).toContain("200文字以内");
  });

  it("全て揃っていれば clear を返し journal に INSERT・GAS へ転送する", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: true, applied: true });
      }
      return undefined;
    });
    const payload = makeSubmissionPayload({
      target: { target_select: { type: "static_select", selected_option: { value: "EVT1" } } },
      date: { date_pick: { type: "datepicker", selected_date: "2026-09-01" } },
      time: { time_pick: { type: "timepicker", selected_time: "18:00" } },
      reason: { reason_input: { type: "plain_text_input", value: "押し忘れ修正" } },
    });

    const res = await handleViewSubmission({ env, ctx, payload, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_action).toBe("clear");

    await flush();
    const rows = await allJournalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("correction_submit");
    expect(rows[0].status).toBe("done");
    const sentPayload = JSON.parse(rows[0].payload);
    expect(sentPayload.target).toBe("EVT1");
    expect(sentPayload.new_date).toBe("2026-09-01");
    expect(sentPayload.new_time).toBe("18:00");
    expect(sentPayload.reason).toBe("押し忘れ修正");
    expect(sentPayload.source).toBe("modal");
    expect(calls.some((c) => c.url === env.GAS_URL)).toBe(true);
  });
});

// --- handleSlashCommand（実装設計 §6.5） ---

describe("handleSlashCommand", () => {
  function makeCommand(overrides?: Partial<SlackSlashCommand>): SlackSlashCommand {
    return {
      command: "/kado",
      text: "",
      user_id: "U1",
      channel_id: "C1",
      trigger_id: "T1",
      response_url: "https://hooks.slack.test/resp",
      ...overrides,
    };
  }

  it("/keihi: 定型 ephemeral を返し GAS へ転送しない", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub();
    const command = makeCommand({ command: "/keihi", text: "1000円 交通費" });

    const res = await handleSlashCommand({ env, ctx, command, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_type).toBe("ephemeral");
    expect(body.text).toContain("経費機能");

    await flush();
    expect(await allJournalRows()).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it.each(["", "status"])("/kado %s: 正規化して journal に INSERT・GAS へ転送する", async (text) => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: true, applied: true });
      }
      return undefined;
    });
    const command = makeCommand({ text });

    const res = await handleSlashCommand({ env, ctx, command, fetchImpl });
    const body = (await res.json()) as any;
    expect(body.response_type).toBe("ephemeral");

    await flush();
    const rows = await allJournalRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("done");
    const sentPayload = JSON.parse(rows[0].payload);
    expect(sentPayload.text).toBe(text);
    expect(sentPayload.source).toBe("command");
    expect(calls.some((c) => c.url === env.GAS_URL)).toBe(true);
  });

  it.each(["unknown-arg", "refresh"])(
    "/kado %s: 未知の引数として使い方 ephemeral を返し journal には記録しない",
    async (text) => {
      const env = makeEnv(db);
      const { ctx, flush } = createTestCtx();
      const { fetchImpl, calls } = createFetchStub();
      const command = makeCommand({ text });

      const res = await handleSlashCommand({ env, ctx, command, fetchImpl });
      const body = (await res.json()) as any;
      expect(body.response_type).toBe("ephemeral");
      expect(body.text).toContain("使い方");

      await flush();
      expect(await allJournalRows()).toHaveLength(0);
      expect(calls).toHaveLength(0);
    },
  );

  it("GAS: ok:false,retryable:false → response_url へ失敗を POST する", async () => {
    const env = makeEnv(db);
    const { ctx, flush } = createTestCtx();
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "NOT_FOUND", retryable: false });
      }
      return undefined;
    });
    const command = makeCommand({ text: "status" });

    await handleSlashCommand({ env, ctx, command, fetchImpl });
    await flush();

    const rows = await allJournalRows();
    expect(rows[0].status).toBe("rejected");
    const notifyCall = calls.find((c) => c.url === command.response_url);
    expect(notifyCall).toBeDefined();
    expect((notifyCall?.body as any).text).toContain("NOT_FOUND");
  });
});
