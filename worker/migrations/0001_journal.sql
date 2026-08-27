CREATE TABLE journal (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL,             -- stamp | open_correction | correction_submit | command
  payload          TEXT NOT NULL,             -- GasRequest の JSON（送信するものと同一）
  status           TEXT NOT NULL CHECK (status IN ('pending','done','rejected')),
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  notified_at      INTEGER,                   -- N 回失敗メンションを送った時刻(ms)
  created_at       INTEGER NOT NULL,          -- ms
  updated_at       INTEGER NOT NULL,
  done_at          INTEGER
);
CREATE INDEX journal_status_created ON journal(status, created_at);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO settings(key, value) VALUES ('forwarding_enabled', '1');

CREATE TABLE nonces (nonce TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);
