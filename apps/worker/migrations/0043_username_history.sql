-- Released usernames, so a handle can never silently change owner.
--
-- ---------------------------------------------------------------------------
-- Why this table exists
-- ---------------------------------------------------------------------------
-- The public profile url is becoming `/@username` (it was `/profile?userId=<uid>`,
-- which put the internal Firebase uid into every shared link). A username is
-- MUTABLE — `updateProfile` lets anyone change theirs — so a readable handle in a
-- url creates two problems that an opaque uid did not have:
--
--   1. LINK ROT. Every link, @-mention and QR code pointing at the old handle
--      breaks the moment it changes.
--
--   2. SILENT OWNER CHANGE, which is the serious one. `users.username` has a
--      unique index and nothing else, so releasing a handle makes it claimable
--      IMMEDIATELY. Rename `alice` -> `alice2`, and anyone can take `alice` in the
--      next second; from then on every previously-shared `/@alice` link resolves to
--      a DIFFERENT PERSON. That is impersonation handed out for free, and it is
--      worse than a 404 because the link keeps working and looks right.
--
-- Instagram — whose url scheme this follows — has exactly this gap: changing a
-- username 404s the old url, Instagram does not redirect, and after a hold period
-- the handle can be claimed by someone else. That is a tolerable trade for a photo
-- app. It is not tolerable here: this product moves wallets, contest entry fees and
-- prize payouts, so "the profile this shared link opens is the person you think it
-- is" is a security property, not a nicety.
--
-- ---------------------------------------------------------------------------
-- What the table gives us
-- ---------------------------------------------------------------------------
-- Recording who released a handle, and when, buys both fixes at once:
--
--   * NO ROT — a released handle with no new owner redirects to whatever that uid's
--     current handle is, so old links keep working. Strictly better than Instagram.
--   * NO SILENT TAKEOVER — `released_at` lets the claim path refuse a DIFFERENT uid
--     for a hold window (see USERNAME_HOLD_MS in lib/userIdentifiers.ts), so a
--     handle cannot be sniped the instant it is freed.
--
-- Resolution order is always CURRENT OWNER FIRST: if someone legitimately holds the
-- handle now, they are who `/@handle` shows. History only answers when nobody does.
-- So a row here is a fallback, never an override — which is what keeps this table
-- from becoming a way to hijack a name that has since been re-registered.
--
-- ---------------------------------------------------------------------------
-- Shape notes
-- ---------------------------------------------------------------------------
-- `username_lower` is the PRIMARY KEY, so there is one row per handle and a later
-- release overwrites an earlier one (`ON CONFLICT DO UPDATE`). That is deliberate:
-- the MOST RECENT owner is the one an unclaimed handle should lead to. Keeping full
-- history would let an ancient owner win over a recent one, which is the opposite of
-- what a reader expects.
--
-- COLLATE NOCASE for the same reason migration 0041 gave `users.username` that
-- collation: the code always writes lowercase, but a caller that forgets would
-- otherwise create a second row for the same name, and the guard would then miss.
-- Enforcing it in the database means the invariant does not depend on caller
-- discipline.

CREATE TABLE IF NOT EXISTS username_history (
  -- The released handle, lowercased. One row per handle.
  username_lower TEXT PRIMARY KEY COLLATE NOCASE,
  -- The account that released it. Not a foreign key: `users` rows survive account
  -- deletion in anonymised form, and the purge below removes these rows explicitly.
  uid            TEXT NOT NULL,
  -- Epoch ms. Drives the hold window, so it must be a real timestamp and not a flag.
  released_at    INTEGER NOT NULL
);

-- Read by `purgeUsernameHistory` on account deletion: a deleted account's old
-- handles must stop redirecting to it, otherwise `/@oldhandle` leads to an
-- anonymised profile. Added WITH its reader rather than speculatively — an index
-- nobody queries is a cost with no benefit.
CREATE INDEX IF NOT EXISTS idx_username_history_uid
  ON username_history (uid);
