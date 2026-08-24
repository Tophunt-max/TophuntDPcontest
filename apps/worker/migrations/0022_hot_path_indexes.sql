-- Indexes for query shapes that were doing full table scans.
--
-- DDL-only and idempotent (AUDIT_2026-08-23.md #15 — autoMigrate has no
-- distributed lock, so this file may run concurrently across colos).
-- CREATE INDEX IF NOT EXISTS is naturally safe.
--
-- Sourced from D1_R2_LOAD_AUDIT.md sections 2, 3, 4 and 7. Every index below
-- matches a query that exists today; none are speculative.

-- ---------------------------------------------------------------------------
-- 1. votes (voter_uid, created_at)
--
-- The only vote indexes were (match_id), (match_id, voter_uid) and
-- (match_id, device_id) — voter_uid was never a LEADING column, so any
-- "what did this user do" query scanned the whole table. votes grows faster
-- than anything else in the app, and three hot queries need exactly this:
--
--   read.ts:390  For You affinity   WHERE voter_uid = ? LIMIT 500
--   api.ts:753   getDailyTasks      COUNT(*) WHERE voter_uid = ? AND created_at >= ?
--   api.ts:787   claimDailyTask     same
--
-- vote_xp_awards already had idx_vote_xp_awards_voter with this exact shape;
-- votes was simply missed.
CREATE INDEX IF NOT EXISTS idx_votes_voter_created ON votes (voter_uid, created_at);

-- ---------------------------------------------------------------------------
-- 2. profile_visits (visitor_id)
--
-- The table's only index is PRIMARY KEY (user_id, visitor_id). read.ts:396
-- filters on visitor_id, the TRAILING column, which a composite index cannot
-- serve — so the second half of the For You affinity step was also a full scan.
CREATE INDEX IF NOT EXISTS idx_profile_visits_visitor ON profile_visits (visitor_id, created_at);

-- ---------------------------------------------------------------------------
-- 3. shares (user_id, created_at)
--
-- shares had NO indexes at all beyond its id primary key, while api.ts:757 and
-- :791 run COUNT(*) WHERE user_id = ? AND created_at >= ? every time the
-- rewards/daily-tasks screen loads.
CREATE INDEX IF NOT EXISTS idx_shares_user_created ON shares (user_id, created_at);

-- ---------------------------------------------------------------------------
-- 4. notifications (created_at) WHERE read = 1
--
-- pruneNotifications (notify.ts:151-177) runs two passes of
--   DELETE ... WHERE id IN (SELECT id FROM notifications
--                            WHERE read = 1 AND created_at < ? LIMIT 500)
-- every 10 minutes — 144 times a day, forever, whether or not anything is
-- prunable. No existing index leads with `read = 1` or a bare created_at:
-- idx_notif_recipient is (recipient_id, created_at), and idx_notif_unread /
-- idx_notif_unseen are partial on read = 0 / seen = 0. So both passes were full
-- table scans. A partial index matching the predicate exactly stays small,
-- because it only covers rows already marked read.
CREATE INDEX IF NOT EXISTS idx_notifications_read_created
  ON notifications (created_at)
  WHERE read = 1;

-- ---------------------------------------------------------------------------
-- 5. stories (created_at)
--
-- read.ts:1388 is WHERE expires_at > ? ORDER BY created_at DESC LIMIT 100.
-- idx_stories_expires serves the filter but not the sort, so every live story
-- was read and sorted just to return 100.
--
-- Deliberately indexing created_at rather than a composite: stories expire a
-- fixed window after creation, so created_at DESC order is very nearly
-- expires_at DESC order. SQLite can walk this index backwards and stop once it
-- has 100 unexpired rows. A composite (expires_at, created_at) would NOT help —
-- a range predicate on the leading column leaves the output unordered by
-- created_at, so the sort would remain.
CREATE INDEX IF NOT EXISTS idx_stories_created ON stories (created_at);

-- ---------------------------------------------------------------------------
-- 6. chats (updated_at)
--
-- chats had no indexes at all, so /read/chats (read.ts:1222) paid a filesort on
-- ORDER BY updated_at DESC on top of its scan.
--
-- This is a partial mitigation, NOT the fix. That query's real problem is the
-- correlated EXISTS over json_each(chats.users), which no index can serve, plus
-- the missing LIMIT. The proper fix is a chat_members(user_id, chat_id) join
-- table — see D1_R2_LOAD_AUDIT.md section 4.
CREATE INDEX IF NOT EXISTS idx_chats_updated ON chats (updated_at);
