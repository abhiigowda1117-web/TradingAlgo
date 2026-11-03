-- AlgoTrade initial schema.
-- Phase 1 uses: users, sessions, system_logs.
-- Created now for Phase 2 (engine data sync): portfolios, positions, orders, trades, research_reports.
-- Money is NUMERIC (exact), times are TIMESTAMPTZ (UTC).

CREATE TABLE users (
  id             BIGSERIAL PRIMARY KEY,
  username       TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_.-]{3,32}$'),
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'owner' CHECK (role IN ('owner')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at  TIMESTAMPTZ
);

-- Only a SHA-256 of the session id is stored, so a database leak cannot be replayed as a login.
CREATE TABLE sessions (
  id_hash      TEXT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip           TEXT,
  user_agent   TEXT
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

CREATE TABLE portfolios (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  mode          TEXT NOT NULL DEFAULT 'paper' CHECK (mode IN ('paper')),
  initial_cash  NUMERIC(18, 2) NOT NULL CHECK (initial_cash > 0),
  cash          NUMERIC(18, 2) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE positions (
  id             BIGSERIAL PRIMARY KEY,
  portfolio_id   BIGINT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  symbol         TEXT NOT NULL,
  qty            INTEGER NOT NULL CHECK (qty >= 0),
  avg_price      NUMERIC(18, 4) NOT NULL,
  stop_price     NUMERIC(18, 4),
  protection     TEXT NOT NULL DEFAULT 'none' CHECK (protection IN ('confirmed', 'pending', 'none')),
  opened_at      TIMESTAMPTZ NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (portfolio_id, symbol)
);

CREATE TABLE orders (
  id               BIGSERIAL PRIMARY KEY,
  portfolio_id     BIGINT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  intent_id        TEXT NOT NULL UNIQUE,
  kind             TEXT NOT NULL CHECK (kind IN ('entry', 'exit', 'stop')),
  symbol           TEXT NOT NULL,
  side             TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type       TEXT NOT NULL CHECK (order_type IN ('MARKET', 'SL')),
  qty              INTEGER NOT NULL CHECK (qty > 0),
  trigger_price    NUMERIC(18, 4),
  status           TEXT NOT NULL,
  broker_order_id  TEXT,
  filled_qty       INTEGER NOT NULL DEFAULT 0,
  avg_fill_price   NUMERIC(18, 4),
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX orders_portfolio_idx ON orders (portfolio_id, created_at);

CREATE TABLE trades (
  id            BIGSERIAL PRIMARY KEY,
  portfolio_id  BIGINT NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  order_id      BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  symbol        TEXT NOT NULL,
  side          TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  qty           INTEGER NOT NULL CHECK (qty > 0),
  price         NUMERIC(18, 4),
  pnl           NUMERIC(18, 2),
  reason        TEXT,
  executed_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX trades_portfolio_idx ON trades (portfolio_id, executed_at);

CREATE TABLE research_reports (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL,
  generated_at  TIMESTAMPTZ NOT NULL,
  report        JSONB NOT NULL
);
CREATE INDEX research_reports_symbol_idx ON research_reports (symbol, generated_at);

CREATE TABLE system_logs (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  level     TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
  source    TEXT NOT NULL,
  message   TEXT NOT NULL,
  data      JSONB
);
CREATE INDEX system_logs_at_idx ON system_logs (at);
