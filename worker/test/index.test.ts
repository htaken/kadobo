/**
 * Worker の `fetch()` ルーティング・署名検証・封筒検証の統合テスト（実装設計 §6.1, §3.4, §8 WP0/WP1 受入条件）。
 *
 * `createTestHarness` で実際に D1 マイグレーションを適用したうえで `server.fetch()` により
 * 本物の HTTP リクエストとして `index.ts` の `fetch()` を経由させる。
 *
 * 実ネットワークへアクセスしないことを保証するため、ここで真の HTTP 経由でテストするのは
 * 外部呼び出し（Slack API・GAS への `waitUntil` 内 fetch）が発生しない経路のみに限定する:
 *   - 署名検証の成否（失敗時は 401 になりハンドラへ到達しない）
 *   - `/kado` の不正引数（使い方 ephemeral をその場で返し、GAS へは転送しない）
 *   - `/internal/status`（D1 の読み取りのみで完結する）
 * 🔄 経費フェーズ §4.1 で `/keihi` は `views.open` を `waitUntil` 内で呼ぶようになったため、
 * この経路の対象からは外した（`fetchImpl` を注入できないこの真の HTTP 経路では実ネットワークに
 * 触れてしまうため）。`/keihi` の実際の振る舞い（モーダルの中身・失敗時の応答など）は
 * `expense.test.ts` で `fetchImpl` スタブを使って検証する。
 * block_actions・`/kado`（正常系）・view_submission 等、`waitUntil` 内で Slack API/GAS へ fetch
 * する経路は `handlers.test.ts` でハンドラ関数を直接呼び出し、`fetchImpl` スタブで検証する。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import type { Env } from "../src/index";
import { buildEnvelope } from "../src/gas";
import { hmacSha256Hex } from "../src/webcrypto";

const TEST_SECRETS = {
  SLACK_SIGNING_SECRET: "test-slack-signing-secret",
  SLACK_BOT_TOKEN: "xoxb-test-token",
  GAS_SHARED_SECRET: "test-gas-shared-secret",
  GAS_URL: "https://gas.example.test/exec",
};

const server = createTestHarness({
  workers: [{ configPath: "./wrangler.jsonc", secrets: TEST_SECRETS }],
});

async function signSlackBody(body: string, tsSec: number): Promise<{ ts: string; sig: string }> {
  const ts = String(tsSec);
  const hex = await hmacSha256Hex(TEST_SECRETS.SLACK_SIGNING_SECRET, `v0:${ts}:${body}`);
  return { ts, sig: `v0=${hex}` };
}

async function postSlack(path: string, body: string, tsSec: number, sigOverride?: string) {
  const { ts, sig } = await signSlackBody(body, tsSec);
  return server.fetch(`https://example.com${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Slack-Request-Timestamp": ts,
      "X-Slack-Signature": sigOverride ?? sig,
    },
    body,
  });
}

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

describe("ルーティング", () => {
  it("未知パスへの GET は404を返す", async () => {
    const res = await server.fetch("https://example.com/unknown-path");
    expect(res.status).toBe(404);
  });

  it("既知パスへの GET も404を返す（POST 以外は常に404）", async () => {
    const res = await server.fetch("https://example.com/slack/commands");
    expect(res.status).toBe(404);
  });

  it("D1マイグレーション適用後、settings.forwarding_enabled が '1' で読める", async () => {
    const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind("forwarding_enabled").first<{ value: string }>();
    expect(row?.value).toBe("1");
  });
});

describe("Slack 署名検証（真の HTTP 経由）", () => {
  // `/kado` の不正引数: normalizeKadoText が null を返し、その場で使い方 ephemeral を返して
  // 終了する（waitUntil なし・D1 なし・外部 fetch なし）。署名検証の通過確認に外部呼び出しを
  // 一切伴わない経路として選んでいる（ファイル冒頭コメントの不変条件を参照）。
  const body = new URLSearchParams({
    command: "/kado",
    text: "foo",
    user_id: "U1",
    channel_id: "C1",
    trigger_id: "T1",
    response_url: "https://hooks.slack.test/resp",
  }).toString();

  it("正しい署名・時刻窓内なら通り、/kado の不正引数は使い方 ephemeral を返す", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await postSlack("/slack/commands", body, nowSec);
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.response_type).toBe("ephemeral");
    expect(json.text).toContain("使い方");
  });

  it("不正な署名は401", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await postSlack("/slack/commands", body, nowSec, "v0=0000000000000000000000000000000000000000000000000000000000000000");
    expect(res.status).toBe(401);
  });

  it("±300秒を超えた古いタイムスタンプは401", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const staleTs = nowSec - 301;
    const res = await postSlack("/slack/commands", body, staleTs);
    expect(res.status).toBe(401);
  });

  it("bodyを署名後に改ざんすると401", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const { ts, sig } = await signSlackBody(body, nowSec);
    const res = await server.fetch("https://example.com/slack/commands", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Slack-Request-Timestamp": ts,
        "X-Slack-Signature": sig,
      },
      body: `${body}&tampered=1`,
    });
    expect(res.status).toBe(401);
  });
});

describe("POST /internal/status（実装設計 §3.4）", () => {
  it("正しい封筒なら 200 で pending/rejected_24h/oldest_pending_at_ms を返す", async () => {
    const envelope = await buildEnvelope(TEST_SECRETS.GAS_SHARED_SECRET, JSON.stringify({ kind: "status" }));
    const res = await server.fetch("https://example.com/internal/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json).toEqual({ ok: true, pending: 0, rejected_24h: 0, oldest_pending_at_ms: null });
  });

  it("署名が不正なら401", async () => {
    const envelope = await buildEnvelope(TEST_SECRETS.GAS_SHARED_SECRET, JSON.stringify({ kind: "status" }));
    envelope.sig = "0".repeat(64);
    const res = await server.fetch("https://example.com/internal/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(401);
  });

  it("±300秒を超えたtsは401", async () => {
    const envelope = await buildEnvelope(TEST_SECRETS.GAS_SHARED_SECRET, JSON.stringify({ kind: "status" }), {
      nowSec: () => Math.floor(Date.now() / 1000) - 301,
    });
    const res = await server.fetch("https://example.com/internal/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(res.status).toBe(401);
  });

  it("同じ nonce を再送すると2回目は401（nonce再利用拒否）", async () => {
    const envelope = await buildEnvelope(TEST_SECRETS.GAS_SHARED_SECRET, JSON.stringify({ kind: "status" }));
    const first = await server.fetch("https://example.com/internal/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(first.status).toBe(200);

    const second = await server.fetch("https://example.com/internal/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    expect(second.status).toBe(401);
  });

  it("pending/rejected の件数を正しく集計する", async () => {
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO journal (id, idempotency_key, kind, payload, status, attempts, created_at, updated_at, done_at)
         VALUES (?, ?, 'command', '{}', 'pending', 0, ?, ?, NULL)`,
      )
      .bind("P1", "p1", now - 1000, now - 1000)
      .run();
    await db
      .prepare(
        `INSERT INTO journal (id, idempotency_key, kind, payload, status, attempts, created_at, updated_at, done_at)
         VALUES (?, ?, 'command', '{}', 'rejected', 1, ?, ?, NULL)`,
      )
      .bind("R1", "r1", now - 2000, now)
      .run();

    const envelope = await buildEnvelope(TEST_SECRETS.GAS_SHARED_SECRET, JSON.stringify({ kind: "status" }));
    const res = await server.fetch("https://example.com/internal/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    const json = (await res.json()) as any;
    expect(json.ok).toBe(true);
    expect(json.pending).toBe(1);
    expect(json.rejected_24h).toBe(1);
    expect(json.oldest_pending_at_ms).toBe(now - 1000);
  });
});
