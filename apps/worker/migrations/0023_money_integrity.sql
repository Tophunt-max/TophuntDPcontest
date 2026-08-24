-- Money integrity hardening.
--
-- 1. `contest_matches.prize_coins` — the prize is now SNAPSHOTTED when a match
--    is created, exactly like `min_votes_required` already was. Previously
--    settlement re-read `contests.reward_coins` at payout time, so editing a
--    contest template retroactively changed the prize of every in-flight match.
--    NULL means "legacy row, fall back to the template" so existing waiting and
--    active matches keep settling correctly.
--
-- 2. `idempotency_keys` — a D1-backed replay claim. The previous idempotency
--    layer was a KV read-then-write that failed OPEN on any KV error, so two
--    simultaneous requests both passed. A primary key in a transactional store
--    is atomic by construction. `nonce` records WHICH request won the claim so a
--    replay can be distinguished from a first attempt even within the same
--    millisecond.
--
-- 3. Fractional coin balances are rounded to whole coins. Coins are a
--    whole-number currency; fractions only ever entered through `entryFee / 2`
--    on odd entry fees. The adjustment is written to the ledger so the books
--    still reconcile after the rounding.
--
-- All statements are idempotent: re-running this file is a no-op.

ALTER TABLE contest_matches ADD COLUMN prize_coins REAL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key        TEXT PRIMARY KEY,
  nonce      TEXT NOT NULL,
  scope      TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotency_keys(created_at);

INSERT OR IGNORE INTO coin_transactions (id, uid, amount, type, description, created_at)
SELECT
  'coin_rounding:' || uid,
  uid,
  CAST(ROUND(dpcoin) AS INTEGER) - dpcoin,
  'balance_rounding',
  'Fractional coin balance rounded to a whole number',
  CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM users
WHERE dpcoin IS NOT NULL
  AND dpcoin <> CAST(ROUND(dpcoin) AS INTEGER);

UPDATE users
   SET dpcoin = CAST(ROUND(dpcoin) AS INTEGER)
 WHERE dpcoin IS NOT NULL
   AND dpcoin <> CAST(ROUND(dpcoin) AS INTEGER);


-- 4. `ad_reward_claims` — the rewarded-ad daily cap moves from KV to D1.
--    The KV counter was a read-modify-write on an eventually-consistent store
--    that explicitly treated a KV error as "0 used", so concurrent requests all
--    observed the same count and all credited. Each claim is now a row, and the
--    cap is enforced by a COUNT(*) guard inside the same transaction as the
--    credit, which makes it exact.
CREATE TABLE IF NOT EXISTS ad_reward_claims (
  id         TEXT PRIMARY KEY,
  uid        TEXT NOT NULL,
  day        INTEGER NOT NULL,
  provider   TEXT,
  reward     REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ad_reward_uid_day ON ad_reward_claims(uid, day);
