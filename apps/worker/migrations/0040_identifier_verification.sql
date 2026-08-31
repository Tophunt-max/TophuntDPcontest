-- Whether an email address / phone number has actually been PROVEN to belong to
-- the account holder.
--
-- Until now nothing recorded this anywhere in D1. Verification state existed only
-- inside Firebase Auth, only for email, and only ever read client-side — where
-- login deliberately does not block on it (a hard block would lock out the whole
-- existing user base, see apps/expo/app/auth/login/password/index.tsx). The
-- consequences of having no server-side flag:
--
--   1. The Worker could not gate anything on it. "Require a verified email before
--      a payout / before an identifier change" was not expressible, because the
--      backend genuinely did not know.
--   2. A typo at signup was indistinguishable from a proven address, and that
--      same unverified address is what Firebase password reset targets. An
--      address nobody ever confirmed could therefore be used to take the account
--      over.
--   3. Our own OTP flow proved ownership and then threw the proof away. Worse,
--      Identity Toolkit's `accounts:update` RESETS emailVerified to false when the
--      email changes, so a user who had just completed our OTP ended up flagged
--      less verified than before they started.
--
-- Defaults are deliberately 0/false rather than backfilled to true: an existing
-- row's identifier has NOT been proven by us, and recording an optimistic
-- "verified" would make the column a lie on the very first day. Users become
-- verified as they pass through the OTP flow.
--
-- These are recorded but NOT yet enforced anywhere. Turning them into a gate is a
-- product decision with a migration path (existing users need a prompt before
-- anything starts refusing them), and doing it in the same change that introduces
-- the column would lock people out.
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0;
-- When ownership was proven, for support ("since when has this been their email?")
-- and so a future re-verification policy has something to measure against.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
ALTER TABLE users ADD COLUMN phone_verified_at INTEGER;
