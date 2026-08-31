-- Account deletion, second pass: a lifecycle instead of a single irreversible call.
--
-- The first implementation (migration 0030) did the whole thing inside one
-- request: check eligibility, anonymise, delete content, delete the Firebase
-- login. That had three problems serious enough to need a schema change.
--
-- 1. IT REFUSED. A pending payout or a live contest made the request fail with
--    `failed-precondition`, and the client hid its own delete button in
--    response. So the one path both app stores require could be unavailable for
--    days, with nothing the user could do but come back later and guess. A
--    deletion request must always be ACCEPTED; what varies is when it runs.
--
-- 2. IT WAS UNRECOVERABLE. Anonymisation was immediate, so a mistap, a stolen
--    phone, or a moment of frustration destroyed the account with no way back.
--
-- 3. IT WAS NOT RESUMABLE. The work spanned two `db.batch()` calls plus R2,
--    Bunny, KV and Firebase. A failure between them left an account half
--    deleted, and nothing recorded how far it had got, so nothing could finish
--    the job or even report that it had stalled.
--
-- `deletion_requests` is the state machine that fixes all three. One row per
-- account, created the moment the user asks. `scheduled_for` is when the purge
-- becomes due (the grace period, during which signing in cancels it). `phase`
-- records how far the purge has progressed so cron can resume mid-way instead
-- of restarting work that already committed.
--
-- `account_deletions` (0030) is unchanged in meaning: it stays the terminal
-- compliance record, written only once the purge actually completes.
CREATE TABLE IF NOT EXISTS deletion_requests (
  uid              TEXT PRIMARY KEY,
  -- pending    — inside the grace period, or waiting on a deferral below
  -- processing  — a purge is mid-flight; `phase` says where it got to
  -- completed  — purged; account_deletions holds the compliance record
  -- cancelled  — the user came back and kept the account
  status           TEXT NOT NULL DEFAULT 'pending',
  reason           TEXT,
  requested_at     INTEGER NOT NULL,
  -- When the purge becomes due. Pushed out (never pulled in) while something is
  -- genuinely in flight, so a live contest delays erasure rather than blocking
  -- the request.
  scheduled_for    INTEGER NOT NULL,
  -- Why the purge has not run yet, for the "your account is scheduled for
  -- deletion" screen. Machine-readable code, message is built client-side.
  deferred_reason  TEXT,
  deferred_until   INTEGER,
  -- Resumable purge progress. NULL until the purge starts, then advances:
  -- snapshots -> media -> content -> social -> auth -> done.
  phase            TEXT,
  -- Every storage object to remove, captured in the FIRST phase while the rows
  -- that reference them still exist. Without this the media phase could not be
  -- retried: the `posts` / `stories` rows holding the URLs are deleted two
  -- phases later, so a crash in between would orphan the objects forever —
  -- which is a privacy failure, not just a storage bill.
  media_urls       TEXT,
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  -- Coins at request time, so the user is told the same number the purge will
  -- forfeit, and an admin can see what a cancellation gave back.
  balance_at_request REAL NOT NULL DEFAULT 0,
  -- Whether the request came from the app, the web deletion page, or an admin.
  source           TEXT NOT NULL DEFAULT 'app',
  cancelled_at     INTEGER,
  completed_at     INTEGER,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- The cron sweep's only query: due, not yet finished. Ordered so the oldest
-- request is always purged first.
CREATE INDEX IF NOT EXISTS idx_deletion_requests_due
  ON deletion_requests(status, scheduled_for);

-- Public read paths must exclude accounts that are pending deletion or already
-- anonymised. Without this index that filter turns every user listing into a
-- scan; `status` was previously never queried, so no index existed.
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- The purge's own lookup for a user's Bunny videos is already covered by
-- idx_videos_owner (owner_uid, created_at) from the media migration.
