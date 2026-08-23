-- Production-grade notification system.
--
-- DDL-only and idempotent by design: src/db/autoMigrate.ts has no distributed
-- lock (AUDIT_2026-08-23.md #15), so isolates in different colos can run this
-- file concurrently. CREATE ... IF NOT EXISTS is naturally safe, and
-- ALTER TABLE ADD COLUMN is tolerated because isIgnorable() swallows
-- "duplicate column name". No data statements here.

-- ---------------------------------------------------------------------------
-- 1. Per-user notification preferences.
--
-- Stored as JSON on `users` rather than in its own table on purpose:
-- createNotification() already SELECTs users.fcm_tokens for every notification,
-- so reading prefs from the same row costs ZERO extra queries on the hot path.
--
-- Shape (all keys optional; absent means "enabled"):
--   {
--     "social":   true,          -- likes, comments, follows, reactions
--     "contest":  true,          -- contest lifecycle, votes, results
--     "wallet":   true,          -- deposits, withdrawals, purchases, rewards
--     "admin":    true,          -- broadcasts and announcements
--     "push":     true,          -- master switch for OS push (in-app rows still written)
--     "quietStart": 22,          -- local hour 0-23, inclusive
--     "quietEnd":   7,           -- local hour 0-23, exclusive
--     "utcOffsetMinutes": 330    -- e.g. 330 for IST; used to resolve local hour
--   }
--
-- Broadcast segmentation can filter on this with
--   json_extract(users.notification_prefs, '$.admin') IS NOT 0
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN notification_prefs TEXT;

-- ---------------------------------------------------------------------------
-- 2. Collapsing / actor grouping on notifications.
--
-- Instagram-style "Asha and 5 others liked your photo" instead of one row and
-- one push per like.
--
-- IMPORTANT ordering note: on collapse we bump `created_at` to the latest
-- activity time. That is deliberate — the list is ordered by created_at and
-- paginated with a created_at cursor, so bumping it makes a re-activated
-- notification rise to the top without needing a new index, a new sort column,
-- or a client change. Treat `created_at` as "last activity" for collapsible
-- types. `updated_at` is kept purely for audit/debugging.
-- ---------------------------------------------------------------------------

-- Most recent actor (for the avatar and the leading name).
ALTER TABLE notifications ADD COLUMN actor_id TEXT;
-- Up to a few recent actors for display: [{ uid, username, avatarUrl }, ...].
ALTER TABLE notifications ADD COLUMN actors TEXT;
-- Total distinct actors folded into this row. 1 for non-collapsible types.
ALTER TABLE notifications ADD COLUMN actor_count INTEGER DEFAULT 1;
-- Grouping handle, normally "{type}:{targetId}". Also the idempotency handle:
-- a retried event resolves to the same key and is absorbed instead of
-- duplicated. NULL for types that must never collapse (wallet, admin, ...).
ALTER TABLE notifications ADD COLUMN collapse_key TEXT;
-- Row modification time (audit only — ordering uses created_at, see above).
ALTER TABLE notifications ADD COLUMN updated_at INTEGER;
-- "Delivered to the list" vs "opened". `read` already exists and means opened;
-- this lets the bell badge clear on view without marking items read.
ALTER TABLE notifications ADD COLUMN seen INTEGER DEFAULT 0;

-- Drives the collapse lookup:
--   SELECT ... WHERE recipient_id = ? AND collapse_key = ? AND created_at > ?
CREATE INDEX IF NOT EXISTS idx_notif_collapse
  ON notifications (recipient_id, collapse_key);

-- ---------------------------------------------------------------------------
-- 3. Resumable broadcast fan-out jobs.
--
-- sendBroadcastToAllUsers() used to load every uid into memory and then perform
-- an insert + a WebSocket publish + an FCM call per user inside a single
-- request. That cannot survive a real user table within a Worker's CPU/time
-- limits.
--
-- Instead a job row is created and drained by the existing cron, a page at a
-- time, using KEYSET pagination on users.uid (the primary key) — so it is
-- resumable, needs no OFFSET scan, and never holds more than one page in memory.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS broadcast_jobs (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  image TEXT,
  -- Notification type written for each recipient (usually 'admin').
  type TEXT NOT NULL DEFAULT 'admin',
  data TEXT,                                  -- JSON passed through to the row
  segment TEXT,                               -- JSON { platform?, minLevel? }
  -- pending | running | done | cancelled | failed
  status TEXT NOT NULL DEFAULT 'pending',
  -- Keyset cursor: the last users.uid processed. NULL = not started.
  cursor TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  error_message TEXT
);

-- Lets the cron find the next job to drain without scanning.
CREATE INDEX IF NOT EXISTS idx_broadcast_jobs_status
  ON broadcast_jobs (status, created_at);
