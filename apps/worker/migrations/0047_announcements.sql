-- In-app announcement popups.
--
-- Distinct from the appConfig.announcement BANNER (one global message, session
-- dismiss) and from `notifications` (an append-only per-user history). A popup
-- is STATEFUL: it is "active" for a targeted audience, a user dismisses it, and
-- it re-appears once a per-announcement snooze window lapses. That needs its own
-- tables.
--
-- DDL-only and idempotent by design (src/db/autoMigrate.ts has no distributed
-- lock — isolates in different colos may run this concurrently): every statement
-- is CREATE ... IF NOT EXISTS, and isIgnorable() swallows "already exists".

-- ---------------------------------------------------------------------------
-- 1. The announcement itself (authored in the admin panel).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  -- Optional call-to-action opened when the popup is tapped.
  link TEXT,
  -- Optional hero image URL shown above the text.
  image TEXT,
  -- Master on/off. An inactive announcement is never served, regardless of window.
  is_active INTEGER NOT NULL DEFAULT 1,
  -- 'all'  -> every user; 'users' -> only uids in announcement_targets.
  target_type TEXT NOT NULL DEFAULT 'all',
  -- Hours the popup stays hidden after a user closes it, after which it
  -- re-appears. Admin-settable per announcement; defaults to 24h.
  snooze_hours INTEGER NOT NULL DEFAULT 24,
  -- Higher shows first when several are active for one user.
  priority INTEGER NOT NULL DEFAULT 0,
  -- Optional schedule window (epoch ms). NULL = unbounded on that side.
  start_at INTEGER,
  end_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Serves the "active announcements, best first" scan the user endpoint runs.
CREATE INDEX IF NOT EXISTS idx_announcements_active
  ON announcements (is_active, priority, created_at);

-- ---------------------------------------------------------------------------
-- 2. Explicit per-user targeting (only used when target_type = 'users').
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcement_targets (
  announcement_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  PRIMARY KEY (announcement_id, uid)
);

-- Reverse lookup: "which targeted announcements name THIS user".
CREATE INDEX IF NOT EXISTS idx_announcement_targets_uid
  ON announcement_targets (uid);

-- ---------------------------------------------------------------------------
-- 3. Per-user dismissal / snooze state — the heart of the 24h behaviour.
--
-- One row per (announcement, user). `snoozed_until` is when the popup becomes
-- eligible again; the user endpoint shows an announcement only when it has no
-- dismissal row OR now() >= snoozed_until. Kept server-side (not just in the
-- client) so the snooze is consistent across a user's devices and reinstalls.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS announcement_dismissals (
  announcement_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  snoozed_until INTEGER NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (announcement_id, uid)
);
