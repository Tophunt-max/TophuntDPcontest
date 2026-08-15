-- Referral program + real daily tasks.

-- Referral: each user gets a code; referredBy records who invited them.
ALTER TABLE users ADD COLUMN referral_code TEXT;
ALTER TABLE users ADD COLUMN referred_by TEXT;
CREATE INDEX IF NOT EXISTS idx_users_referral_code ON users (referral_code);

-- Referral rewards ledger (admin visibility + dedup).
CREATE TABLE IF NOT EXISTS referrals (
  id TEXT PRIMARY KEY,
  referrer_uid TEXT NOT NULL,
  referred_uid TEXT NOT NULL UNIQUE,   -- a user can only be referred once
  bonus REAL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_uid);

-- Daily task claims — one row per (user, task, UTC-day).
CREATE TABLE IF NOT EXISTS daily_task_claims (
  uid TEXT NOT NULL,
  task_id TEXT NOT NULL,
  day INTEGER NOT NULL,                 -- days since epoch (UTC)
  reward REAL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, task_id, day)
);
