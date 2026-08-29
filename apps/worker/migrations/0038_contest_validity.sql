-- Contest template validity window.
--
-- Until now a contest template had no lifetime of its own: the only lever was
-- `status`, which an admin had to flip by hand, so "this battle runs until
-- Sunday night" was not expressible and nothing in the app could count down to
-- anything. `vote_duration_days` / `auto_cancel_hours` are per-MATCH timers and
-- are unrelated — they govern a battle two users have already started.
--
-- Both columns are epoch milliseconds and NULLABLE, matching
-- contest_matches.expires_at. NULL means "unbounded": every pre-existing row
-- keeps behaving exactly as before (opens immediately, never expires), which is
-- also why D1's ADD COLUMN restriction on non-constant defaults costs us
-- nothing here.
--
-- Consumed by: apps/worker/src/routes/read.ts (GET /read/contests hides rows
-- outside the window, mapContest ships the absolute timestamps so the app's
-- countdown is immune to the 60s response cache) and apps/worker/src/cron.ts
-- (flips status to 'ended' once ends_at passes).
ALTER TABLE contests ADD COLUMN starts_at INTEGER;
ALTER TABLE contests ADD COLUMN ends_at INTEGER;

-- GET /read/contests filters on status plus the window on every cache miss.
CREATE INDEX IF NOT EXISTS idx_contests_status_window ON contests(status, starts_at, ends_at);
