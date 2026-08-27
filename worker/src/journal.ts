/**
 * D1 受付ジャーナル（実装設計 §5, §4.2）。
 *
 * 冪等 INSERT・status 遷移・pending 取得・30 日削除・nonce 記録/重複判定/10 分削除を提供する。
 * 時刻はすべて ms（`Date.now()`）。呼び出し側から `now` を渡すことでテスト時刻を固定できる。
 */

export type JournalStatus = "pending" | "done" | "rejected";

export interface JournalRow {
  id: string;
  idempotency_key: string;
  kind: string;
  payload: string;
  status: JournalStatus;
  attempts: number;
  last_error: string | null;
  notified_at: number | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
}

/** GAS 転送 1 回の試行結果（実装設計 §3.3 のマッピングを D1 更新の形に正規化したもの）。 */
export type AttemptOutcome =
  | { status: "done" }
  | { status: "pending"; error: string }
  | { status: "rejected"; error: string };

export interface InsertJournalInput {
  id: string;
  idempotency_key: string;
  kind: "stamp" | "open_correction" | "correction_submit" | "command";
  /** GasRequest の JSON 文字列（送信するものと同一。実装設計 §5）。 */
  payload: string;
  now: number;
}

/**
 * `INSERT ... ON CONFLICT(idempotency_key) DO NOTHING`。
 * `meta.changes === 0` なら重複（既存の行がある）。
 */
export async function insertJournal(
  db: D1Database,
  input: InsertJournalInput,
): Promise<{ inserted: boolean }> {
  const result = await db
    .prepare(
      `INSERT INTO journal (id, idempotency_key, kind, payload, status, attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(idempotency_key) DO NOTHING`,
    )
    .bind(input.id, input.idempotency_key, input.kind, input.payload, input.now, input.now)
    .run();
  return { inserted: result.meta.changes > 0 };
}

/**
 * GAS 転送 1 回の試行結果を反映する。`attempts` を必ず 1 増やし、
 * `status='done'` のときのみ `done_at` を設定し `last_error` を消す。
 */
export async function recordAttemptResult(
  db: D1Database,
  id: string,
  outcome: AttemptOutcome,
  nowMs: number,
): Promise<void> {
  const doneAt = outcome.status === "done" ? nowMs : null;
  const lastError = outcome.status === "done" ? null : outcome.error;
  await db
    .prepare(
      `UPDATE journal SET status = ?, attempts = attempts + 1, last_error = ?, done_at = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(outcome.status, lastError, doneAt, nowMs, id)
    .run();
}

/** `status='pending'` を `created_at` 昇順に最大 `limit` 件取得する（既定 50、実装設計 §6.6）。 */
export async function listPending(db: D1Database, limit = 50): Promise<JournalRow[]> {
  const result = await db
    .prepare(`SELECT * FROM journal WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`)
    .bind(limit)
    .all<JournalRow>();
  return result.results;
}

/** `settings.forwarding_enabled` を読む（行が無い場合は安全側に倒して `false`）。実装設計 §5。 */
export async function isForwardingEnabled(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE key = 'forwarding_enabled'`)
    .first<{ value: string }>();
  return row?.value === "1";
}

/** `status IN ('done','rejected') AND updated_at < beforeMs` を削除する（実装設計 §5）。削除件数を返す。 */
export async function deleteOldJournal(db: D1Database, beforeMs: number): Promise<number> {
  const result = await db
    .prepare(`DELETE FROM journal WHERE status IN ('done', 'rejected') AND updated_at < ?`)
    .bind(beforeMs)
    .run();
  return result.meta.changes;
}

/** `notified_at` を更新する（Cron の N 回失敗メンション時、実装設計 §6.6）。 */
export async function updateNotifiedAt(db: D1Database, id: string, nowMs: number): Promise<void> {
  await db
    .prepare(`UPDATE journal SET notified_at = ?, updated_at = ? WHERE id = ?`)
    .bind(nowMs, nowMs, id)
    .run();
}

/** `status='pending'` の件数（`/internal/status`、実装設計 §3.4）。 */
export async function countPending(db: D1Database): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM journal WHERE status = 'pending'`)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** `status='rejected' AND updated_at >= sinceMs` の件数（`/internal/status`、実装設計 §3.4）。 */
export async function countRejectedSince(db: D1Database, sinceMs: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS c FROM journal WHERE status = 'rejected' AND updated_at >= ?`)
    .bind(sinceMs)
    .first<{ c: number }>();
  return row?.c ?? 0;
}

/** `status='pending'` の中で最も古い `created_at`（無ければ `null`）。`/internal/status`。 */
export async function oldestPendingCreatedAt(db: D1Database): Promise<number | null> {
  const row = await db
    .prepare(`SELECT MIN(created_at) AS m FROM journal WHERE status = 'pending'`)
    .first<{ m: number | null }>();
  return row?.m ?? null;
}

// --- nonces（Worker 側の封筒 nonce 管理。GAS→Worker `/internal/status` 用。実装設計 §3.1, §5） ---

/** `nonce` が既知（=再利用）かどうか。 */
export async function isNonceSeen(db: D1Database, nonce: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS x FROM nonces WHERE nonce = ?`).bind(nonce).first();
  return row !== null;
}

/** `nonce` を記録する（署名検証に成功した要求のみ消費すること。実装設計 §3.1）。 */
export async function markNonceSeen(db: D1Database, nonce: string, nowMs: number): Promise<void> {
  await db
    .prepare(`INSERT INTO nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING`)
    .bind(nonce, nowMs)
    .run();
}

/** `seen_at < beforeMs` の nonce を削除する（10 分 TTL、実装設計 §5）。削除件数を返す。 */
export async function deleteOldNonces(db: D1Database, beforeMs: number): Promise<number> {
  const result = await db.prepare(`DELETE FROM nonces WHERE seen_at < ?`).bind(beforeMs).run();
  return result.meta.changes;
}
