-- Full admin control: coin store, scheduled/segmented notifications,
-- auto-moderation word list, and user verification/feature flags.

-- Verified badge + featured-creator flags on users.
ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN featured INTEGER DEFAULT 0;

-- Coin top-up packages shown in the app store (admin-managed pricing).
CREATE TABLE IF NOT EXISTS coin_packages (
  id TEXT PRIMARY KEY,
  name TEXT,
  coins REAL NOT NULL DEFAULT 0,        -- base coins granted
  bonus_coins REAL NOT NULL DEFAULT 0,  -- extra promo coins
  price_inr REAL NOT NULL DEFAULT 0,    -- price in INR
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_coin_packages_active ON coin_packages (active, sort_order);

-- Scheduled / segmented broadcast notifications. A cron pass sends the ones
-- whose send_at has passed and marks them sent.
CREATE TABLE IF NOT EXISTS scheduled_notifications (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image TEXT,
  segment TEXT,                          -- JSON: { platform?, minLevel? }
  send_at INTEGER NOT NULL,              -- epoch ms; <= now means "send now"
  status TEXT NOT NULL DEFAULT 'pending',-- pending | sent | cancelled
  recipients INTEGER DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sched_notif_status ON scheduled_notifications (status, send_at);

-- Auto-moderation banned words (the app/worker can reject matching content).
CREATE TABLE IF NOT EXISTS banned_words (
  word TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
