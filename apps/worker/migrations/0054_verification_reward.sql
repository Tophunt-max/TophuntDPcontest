-- Registration verification reward: a small welcome grant at signup, plus a
-- completion bonus once BOTH the email address and the mobile number have been
-- proven (users.email_verified / users.phone_verified, migration 0040).
--
-- ENROLMENT IS EXPLICIT. A user is only ever eligible for the completion bonus if
-- they have a row here, and rows are written ONLY by the signup path from this
-- release onward. No existing account is enrolled by this migration:
--   * Until now signup credited the whole `rewardSettings.signupBonus` (default
--     100) up front, with no verification requirement. Those users already had
--     their welcome reward; enrolling them would pay a second one.
--   * Historical grants cannot be reconstructed reliably (the bonus amount was
--     admin-configurable over time), so guessing a per-user entitlement would be
--     wrong for someone either way. Balances and ledger history are untouched.
--
-- `completion_reward` is a SNAPSHOT of the amount promised at signup, so changing
-- the admin setting later never re-prices a promise already shown to a user.
CREATE TABLE IF NOT EXISTS verification_rewards (
  uid TEXT PRIMARY KEY NOT NULL,
  registration_reward INTEGER NOT NULL DEFAULT 0,
  registration_ledger_id TEXT,
  completion_reward INTEGER NOT NULL DEFAULT 0,
  completion_ledger_id TEXT,
  completed_at INTEGER,
  -- Server-side reminder state, so reminders survive reinstalls and are shared
  -- across devices: how many times the prompt was shown, and when last.
  prompt_count INTEGER NOT NULL DEFAULT 0,
  last_prompt_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_rewards_completed ON verification_rewards(completed_at);

-- One completion bonus per real-world identifier, forever.
--
-- users.phone / users.email are unique only among CURRENT values. Without this,
-- one phone number could be verified on account A (bonus), changed away, then
-- verified on account B (bonus again), farming the withdrawable bonus across
-- sybil accounts. Keyed by a SHA-256 of the canonicalised identifier, so the
-- table holds no raw contact data, and kept when an account is deleted so a
-- delete-and-re-register cycle cannot claim twice either.
CREATE TABLE IF NOT EXISTS verification_reward_claims (
  identifier_hash TEXT PRIMARY KEY NOT NULL,
  kind TEXT NOT NULL,
  uid TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_verification_reward_claims_uid ON verification_reward_claims(uid);
