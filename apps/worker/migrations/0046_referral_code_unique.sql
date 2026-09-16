-- Referral codes must be unique, or a code collision mis-attributes the bonus.
--
-- ---------------------------------------------------------------------------
-- Why this migration exists
-- ---------------------------------------------------------------------------
-- `users.referral_code` was generated with Math.random() and stored with NO
-- unique constraint. A collision (however unlikely) meant the referrer lookup
-- `WHERE referral_code = ?` could resolve to the wrong account, paying the bonus
-- to someone who never invited anyone. Code generation is now collision-safe
-- (routes/api.ts#ensureReferralCode retries on the UNIQUE error), and this index
-- is what makes that retry meaningful.
--
-- SQLite treats NULLs as DISTINCT in a unique index, so the many users without a
-- code yet are unaffected — only real duplicate codes are forbidden.
--
-- The dedup UPDATE first clears any pre-existing duplicate (keeping the earliest
-- owner by rowid) so the index build cannot fail on historical collisions; a
-- cleared user simply gets a fresh unique code the next time they touch the
-- referral path. It is a no-op on a healthy table.

UPDATE users
   SET referral_code = NULL
 WHERE referral_code IS NOT NULL
   AND rowid NOT IN (
     SELECT MIN(rowid) FROM users WHERE referral_code IS NOT NULL GROUP BY referral_code
   );

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users (referral_code);
