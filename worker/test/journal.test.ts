/**
 * D1 受付ジャーナルのテスト（実装設計 §5, §4.2）。`createTestHarness` で実際に
 * D1 マイグレーションを適用し、`worker.getEnv()` で得た本物の D1 バインディングに対して
 * `src/journal.ts` の関数を直接呼び出す。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "wrangler";
import type { Env } from "../src/index";
import * as journal from "../src/journal";

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

describe("insertJournal", () => {
  it("新規 INSERT は inserted:true", async () => {
    const result = await journal.insertJournal(db, {
      id: "J1",
      idempotency_key: "U1:1.1:kado_start:1.123",
      kind: "stamp",
      payload: '{"kind":"stamp"}',
      now: 1000,
    });
    expect(result.inserted).toBe(true);
  });

  it("同一 idempotency_key の 2 回目は inserted:false（meta.changes===0）", async () => {
    const input = {
      id: "J1",
      idempotency_key: "U1:1.1:kado_start:1.123",
      kind: "stamp" as const,
      payload: '{"kind":"stamp"}',
      now: 1000,
    };
    const first = await journal.insertJournal(db, input);
    const second = await journal.insertJournal(db, { ...input, id: "J2" });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const row = await db.prepare("SELECT COUNT(*) AS c FROM journal").first<{ c: number }>();
    expect(row?.c).toBe(1); // 2 件目は本当に INSERT されていない
  });
});

describe("recordAttemptResult", () => {
  async function insertPending(id: string) {
    await journal.insertJournal(db, {
      id,
      idempotency_key: `key-${id}`,
      kind: "stamp",
      payload: "{}",
      now: 1000,
    });
  }

  it("done: status=done, done_at 設定, last_error=null", async () => {
    await insertPending("J1");
    await journal.recordAttemptResult(db, "J1", { status: "done" }, 2000);
    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.status).toBe("done");
    expect(row.attempts).toBe(1);
    expect(row.done_at).toBe(2000);
    expect(row.last_error).toBeNull();
    expect(row.updated_at).toBe(2000);
  });

  it("pending: attempts++, last_error 設定, done_at は null のまま", async () => {
    await insertPending("J1");
    await journal.recordAttemptResult(db, "J1", { status: "pending", error: "http_500" }, 2000);
    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("http_500");
    expect(row.done_at).toBeNull();
  });

  it("複数回の pending で attempts が積み上がる", async () => {
    await insertPending("J1");
    await journal.recordAttemptResult(db, "J1", { status: "pending", error: "e1" }, 2000);
    await journal.recordAttemptResult(db, "J1", { status: "pending", error: "e2" }, 3000);
    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.attempts).toBe(2);
    expect(row.last_error).toBe("e2");
  });

  it("rejected: status=rejected, last_error 設定", async () => {
    await insertPending("J1");
    await journal.recordAttemptResult(db, "J1", { status: "rejected", error: "SCHEMA_ERROR" }, 2000);
    const row = await db.prepare("SELECT * FROM journal WHERE id = ?").bind("J1").first<any>();
    expect(row.status).toBe("rejected");
    expect(row.last_error).toBe("SCHEMA_ERROR");
  });
});

describe("listPending", () => {
  it("created_at 昇順で返す", async () => {
    await journal.insertJournal(db, { id: "J3", idempotency_key: "k3", kind: "command", payload: "{}", now: 3000 });
    await journal.insertJournal(db, { id: "J1", idempotency_key: "k1", kind: "command", payload: "{}", now: 1000 });
    await journal.insertJournal(db, { id: "J2", idempotency_key: "k2", kind: "command", payload: "{}", now: 2000 });
    const rows = await journal.listPending(db);
    expect(rows.map((r) => r.id)).toEqual(["J1", "J2", "J3"]);
  });

  it("done/rejected は含まれない", async () => {
    await journal.insertJournal(db, { id: "J1", idempotency_key: "k1", kind: "command", payload: "{}", now: 1000 });
    await journal.insertJournal(db, { id: "J2", idempotency_key: "k2", kind: "command", payload: "{}", now: 2000 });
    await journal.recordAttemptResult(db, "J1", { status: "done" }, 1500);
    const rows = await journal.listPending(db);
    expect(rows.map((r) => r.id)).toEqual(["J2"]);
  });

  it("limit を超える分は返さない", async () => {
    for (let i = 0; i < 5; i++) {
      await journal.insertJournal(db, {
        id: `J${i}`,
        idempotency_key: `k${i}`,
        kind: "command",
        payload: "{}",
        now: 1000 + i,
      });
    }
    const rows = await journal.listPending(db, 3);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.id)).toEqual(["J0", "J1", "J2"]);
  });
});

describe("isForwardingEnabled", () => {
  it("既定は true（'1'）", async () => {
    expect(await journal.isForwardingEnabled(db)).toBe(true);
  });

  it("'0' に更新すると false", async () => {
    await db.exec("UPDATE settings SET value = '0' WHERE key = 'forwarding_enabled'");
    expect(await journal.isForwardingEnabled(db)).toBe(false);
  });
});

describe("deleteOldJournal", () => {
  it("30日超の done/rejected のみ削除し、pending は残す", async () => {
    const now = 100_000_000;
    await journal.insertJournal(db, { id: "OLD_DONE", idempotency_key: "a", kind: "command", payload: "{}", now });
    await journal.recordAttemptResult(db, "OLD_DONE", { status: "done" }, now); // updated_at=now(old)
    await journal.insertJournal(db, { id: "OLD_REJECTED", idempotency_key: "b", kind: "command", payload: "{}", now });
    await journal.recordAttemptResult(db, "OLD_REJECTED", { status: "rejected", error: "x" }, now);
    await journal.insertJournal(db, { id: "OLD_PENDING", idempotency_key: "c", kind: "command", payload: "{}", now });
    // NEW_DONE: 直近に done になったので消えない
    await journal.insertJournal(db, { id: "NEW_DONE", idempotency_key: "d", kind: "command", payload: "{}", now });

    const cutoff = now + 1; // OLD_* (updated_at===now) はカットオフ未満 → 削除対象
    await journal.recordAttemptResult(db, "NEW_DONE", { status: "done" }, cutoff + 1000); // 削除対象外

    const deleted = await journal.deleteOldJournal(db, cutoff);
    expect(deleted).toBe(2); // OLD_DONE, OLD_REJECTED

    const remainingIds = (await db.prepare("SELECT id FROM journal ORDER BY id").all<{ id: string }>()).results.map(
      (r) => r.id,
    );
    expect(remainingIds.sort()).toEqual(["NEW_DONE", "OLD_PENDING"]);
  });
});

describe("nonces", () => {
  it("isNonceSeen: 未記録は false、記録後は true", async () => {
    expect(await journal.isNonceSeen(db, "abc")).toBe(false);
    await journal.markNonceSeen(db, "abc", 1000);
    expect(await journal.isNonceSeen(db, "abc")).toBe(true);
  });

  it("markNonceSeen は同じ nonce を 2 回呼んでも例外にならない（ON CONFLICT DO NOTHING）", async () => {
    await journal.markNonceSeen(db, "abc", 1000);
    await expect(journal.markNonceSeen(db, "abc", 2000)).resolves.toBeUndefined();
  });

  it("deleteOldNonces: 10分（600000ms）超の nonce のみ削除する", async () => {
    await journal.markNonceSeen(db, "old", 1_000_000);
    await journal.markNonceSeen(db, "new", 1_700_000);
    const cutoff = 1_000_000 + 600_000; // ちょうど 10 分後
    const deleted = await journal.deleteOldNonces(db, cutoff);
    expect(deleted).toBe(1);
    expect(await journal.isNonceSeen(db, "old")).toBe(false);
    expect(await journal.isNonceSeen(db, "new")).toBe(true);
  });
});

describe("/internal/status 用の集計", () => {
  it("countPending / countRejectedSince / oldestPendingCreatedAt", async () => {
    await journal.insertJournal(db, { id: "P1", idempotency_key: "p1", kind: "command", payload: "{}", now: 1000 });
    await journal.insertJournal(db, { id: "P2", idempotency_key: "p2", kind: "command", payload: "{}", now: 2000 });
    await journal.insertJournal(db, { id: "R1", idempotency_key: "r1", kind: "command", payload: "{}", now: 3000 });
    await journal.recordAttemptResult(db, "R1", { status: "rejected", error: "x" }, 5000);

    expect(await journal.countPending(db)).toBe(2);
    expect(await journal.countRejectedSince(db, 4000)).toBe(1);
    expect(await journal.countRejectedSince(db, 6000)).toBe(0);
    expect(await journal.oldestPendingCreatedAt(db)).toBe(1000);
  });

  it("pending が無ければ oldestPendingCreatedAt は null", async () => {
    expect(await journal.oldestPendingCreatedAt(db)).toBeNull();
  });
});
