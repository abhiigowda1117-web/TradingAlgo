-- AlgoTrade initial schema for the built-in SQLite database (data/algotrade.db).
-- Same tables and columns as db/migrations (PostgreSQL). Times are ISO-8601 UTC text, JSON is text.

CREATE TABLE users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  username       TEXT NOT NULL UNIQUE CHECK (length(username) BETWEEN 3 AND 32 AND username NOT GLOB '*[^a-z0-9_.-]*'),
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at     TEXT NOT NULL DEFAULT now(),
  updated_at     TEXT NOT NULL DEFAULT now(),
  last_login_at  TEXT
);

-- Only a SHA-256 of the session id is stored, so a database leak cannot be replayed as a login.
CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT now(),
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE research_reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  generated_at  TEXT NOT NULL,
  report        TEXT NOT NULL
);
CREATE INDEX research_reports_symbol_idx ON research_reports (symbol, generated_at);

CREATE TABLE system_logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  at        TEXT NOT NULL DEFAULT now(),
  level     TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  source    TEXT NOT NULL,
  message   TEXT NOT NULL,
  data      TEXT
);
CREATE INDEX system_logs_at_idx ON system_logs (at);
