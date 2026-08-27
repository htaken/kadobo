/**
 * Cron（`scheduled`）のテスト（実装設計 §6.6）。
 * `runRetryCron` / `runCleanupCron` を実 D1 バインディングに対して直接呼び出す。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import { RETRY_NOTIFY_AT, RETRY_NOTIFY_EVERY } from "@kadobo/shared/protocol";
import type { Env } from "../src/index";
import { runCleanupCron, runRetryCron } from "../src/cron";
import * as journal from "../src/journal";
import { createFetchStub, jsonResponse, makeEnv } from "./support";

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

async function insertStampJournal(id: string, attempts: number, extra?: Record<string, unknown>) {
  const payload = JSON.stringify({
    kind: "stamp",
    idempotency_key: `key-${id}`,
    user_id: "U1",
    channel_id: "C1",
    message_ts: "1756260000.000100",
    action_id: "kado_start",
    occurred_at_ms: 1756260000123,
    received_at_ms: 1756260000500,
    source: "button",
    ...extra,
  });
  await journal.insertJournal(db, { id, idempotency_key: `key-${id}`, kind: "stamp", payload, now: 1000 });
  if (attempts > 0) {
    await db.prepare("UPDATE journal SET attempts = ? WHERE id = ?").bind(attempts, id).run();
  }
}

describe("runRetryCron", () => {
  it("forwarding_enabled='0' なら GAS へは送らずスキップする", async () => {
    await db.exec("UPDATE settings SET value = '0' WHERE key = 'forwarding_enabled'");
    await insertStampJournal("J1", 0);
    const env = makeEnv(db);
    const { fetchImpl, calls } = createFetchStub();

    await runRetryCron(env, { fetchImpl });

    expect(calls).toHaveLength(0);
    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
  });

  it("成功したら done になり、source は 'retry' で送信される", async () => {
    await insertStampJournal("J1", 3);
    const env = makeEnv(db);
    let capturedBody: any;
    const { fetchImpl } = createFetchStub((url, init) => {
      if (url === env.GAS_URL) {
        capturedBody = init?.body ? JSON.parse(JSON.parse(init.body as string).payload) : undefined;
        return jsonResponse({ ok: true, applied: true });
      }
      return undefined;
    });

    await runRetryCron(env, { fetchImpl });

    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(4);
    expect(capturedBody.source).toBe("retry");
  });

  it("失敗したら pending のまま attempts++、RETRY_NOTIFY_AT 未満ならメンションしない", async () => {
    await insertStampJournal("J1", RETRY_NOTIFY_AT - 2); // このリトライで attempts = RETRY_NOTIFY_AT - 1
    const env = makeEnv(db);
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "LOCK_TIMEOUT", retryable: true });
      }
      return undefined;
    });

    await runRetryCron(env, { fetchImpl });

    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(RETRY_NOTIFY_AT - 1);
    expect(row.notified_at).toBeNull();
    const mention = calls.find((c) => c.url.endsWith("/chat.postMessage") && (c.body as any).channel === "C1");
    expect(mention).toBeUndefined();
  });

  it("attempts が RETRY_NOTIFY_AT に達したらメンションし notified_at を記録する", async () => {
    await insertStampJournal("J1", RETRY_NOTIFY_AT - 1); // このリトライで attempts = RETRY_NOTIFY_AT
    const env = makeEnv(db);
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "LOCK_TIMEOUT", retryable: true });
      }
      return undefined;
    });

    await runRetryCron(env, { fetchImpl, now: () => 999_000 });

    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.attempts).toBe(RETRY_NOTIFY_AT);
    expect(row.notified_at).toBe(999_000);
    const mention = calls.find((c) => c.url.endsWith("/chat.postMessage") && (c.body as any).channel === "C1");
    expect(mention).toBeDefined();
    expect((mention?.body as any).text).toContain("<@U1>");
    expect((mention?.body as any).text).toContain("https://slack.com/archives/C1/p1756260000000100");
  });

  it(`RETRY_NOTIFY_AT + RETRY_NOTIFY_EVERY 回目でも再度メンションする`, async () => {
    await insertStampJournal("J1", RETRY_NOTIFY_AT + RETRY_NOTIFY_EVERY - 1);
    const env = makeEnv(db);
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "LOCK_TIMEOUT", retryable: true });
      }
      return undefined;
    });

    await runRetryCron(env, { fetchImpl });

    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.attempts).toBe(RETRY_NOTIFY_AT + RETRY_NOTIFY_EVERY);
    const mention = calls.find((c) => c.url.endsWith("/chat.postMessage") && (c.body as any).channel === "C1");
    expect(mention).toBeDefined();
  });

  it("command kind（message_ts 無し）はメッセージリンク無しでメンションする", async () => {
    const payload = JSON.stringify({
      kind: "command",
      idempotency_key: "key-CMD1",
      user_id: "U1",
      channel_id: "C1",
      text: "status",
      response_url: "https://hooks.slack.test/resp",
      received_at_ms: 1000,
      source: "command",
    });
    await journal.insertJournal(db, { id: "CMD1", idempotency_key: "key-CMD1", kind: "command", payload, now: 1000 });
    await db.prepare("UPDATE journal SET attempts = ? WHERE id = ?").bind(RETRY_NOTIFY_AT - 1, "CMD1").run();

    const env = makeEnv(db);
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "LOCK_TIMEOUT", retryable: true });
      }
      return undefined;
    });

    await runRetryCron(env, { fetchImpl });

    const mention = calls.find((c) => c.url.endsWith("/chat.postMessage") && (c.body as any).channel === "C1");
    expect(mention).toBeDefined();
    expect((mention?.body as any).text).not.toContain("slack.com/archives");
  });

  it("ok:false,retryable:false → rejected になり DM を送る（再送しない）", async () => {
    await insertStampJournal("J1", 2);
    const env = makeEnv(db);
    const { fetchImpl, calls } = createFetchStub((url) => {
      if (url === env.GAS_URL) {
        return jsonResponse({ ok: false, error: "SCHEMA_ERROR", retryable: false });
      }
      return undefined;
    });

    await runRetryCron(env, { fetchImpl });

    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.status).toBe("rejected");
    const dm = calls.find((c) => c.url.endsWith("/chat.postMessage") && (c.body as any).channel === "U1");
    expect(dm).toBeDefined();
  });

  it("pending を created_at 昇順・直列に処理する", async () => {
    await journal.insertJournal(db, {
      id: "J2",
      idempotency_key: "k2",
      kind: "command",
      payload: JSON.stringify({ kind: "command", idempotency_key: "k2", user_id: "U1", channel_id: "C1", text: "", response_url: "https://x", received_at_ms: 2000, source: "command" }),
      now: 2000,
    });
    await journal.insertJournal(db, {
      id: "J1",
      idempotency_key: "k1",
      kind: "command",
      payload: JSON.stringify({ kind: "command", idempotency_key: "k1", user_id: "U1", channel_id: "C1", text: "", response_url: "https://x", received_at_ms: 1000, source: "command" }),
      now: 1000,
    });

    const order: string[] = [];
    const env = makeEnv(db);
    const { fetchImpl } = createFetchStub((url, init) => {
      if (url === env.GAS_URL) {
        const inner = JSON.parse(JSON.parse(init?.body as string).payload);
        order.push(inner.idempotency_key);
        return jsonResponse({ ok: true, applied: true });
      }
      return undefined;
    });

    await runRetryCron(env, { fetchImpl });
    expect(order).toEqual(["k1", "k2"]); // created_at 昇順
  });
});

describe("runCleanupCron", () => {
  it("30日超の done/rejected を削除し、10分超の nonce を削除する", async () => {
    const now = 100_000_000;
    await journal.insertJournal(db, { id: "OLD", idempotency_key: "a", kind: "command", payload: "{}", now });
    await journal.recordAttemptResult(db, "OLD", { status: "done" }, now);
    await journal.markNonceSeen(db, "old-nonce", now);

    const laterNow = now + 31 * 24 * 3600 * 1000;
    await runCleanupCron(makeEnv(db), { now: () => laterNow });

    const row = await db.prepare("SELECT * FROM journal WHERE id = 'OLD'").first();
    expect(row).toBeNull();
    expect(await journal.isNonceSeen(db, "old-nonce")).toBe(false);
  });
});
