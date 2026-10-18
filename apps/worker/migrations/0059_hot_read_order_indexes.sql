-- Index the ORDER BY of three hot/growing read paths, and the notifications
-- hard-retention prune. Every gap below was confirmed with EXPLAIN QUERY PLAN
-- against the fully-migrated schema (see test/queryPlans.test.ts, which pins the
-- resulting plans so a regression fails CI rather than a D1 bill).
--
-- 1. /read/matches?sort=recent (and every status page, e.g. the waiting list):
--      WHERE status = ? [AND type = ?] [AND created_at < ?] ORDER BY created_at DESC LIMIT n
--    Before: SEARCH USING idx_matches_status_expires (status=?) + USE TEMP B-TREE
--    FOR ORDER BY — i.e. every cache miss read and sorted EVERY match in that status
--    (completed grows forever) to return one page. With (status, created_at) it is
--    a bounded index range that stops after `limit` rows, and the keyset cursor
--    becomes a seek.
CREATE INDEX IF NOT EXISTS idx_matches_status_created ON contest_matches (status, created_at);

-- 2. /read/comments for battles and posts:
--      WHERE match_id = ? [keyset] ORDER BY created_at DESC, id DESC LIMIT n+1
--    Before: SEARCH USING idx_match_comments_match (match_id=?) + TEMP B-TREE, so a
--    popular battle's whole thread was read and sorted per uncached page (only page
--    one is edge-cached; "load older" always hits D1). blog_comments already has
--    (post_id, created_at) from 0034.
CREATE INDEX IF NOT EXISTS idx_match_comments_match_created ON match_comments (match_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_post_comments_post_created ON post_comments (post_id, created_at, id);

-- 3. pruneNotifications "hard" pass (lib/notify.ts), hourly:
--      SELECT id FROM notifications WHERE created_at < ? LIMIT 500
--    Before: SCAN notifications. The only created_at index is PARTIAL (read = 1,
--    migration 0022) and idx_notif_recipient leads with recipient_id, so whenever
--    fewer than 500 rows were past the 180-day ceiling — i.e. almost always — the
--    prune read the ENTIRE table, 24 times a day. That is the same failure mode as
--    the cron_runs prune fixed in 0048 (~57% of the daily rows_read cap from one
--    query), on a larger table. Cost: one extra index row written per notification
--    insert; created_at never changes, so read/seen updates do not touch it.
CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications (created_at);

-- Deliberately NOT dropped: idx_matches_status (status) is now a prefix of the new
-- composite and therefore redundant, but dropping it is a separate, reversible
-- decision to take after D1 Insights confirms the planner has moved over. Leaving
-- it costs one index write per match status change, which is negligible.
--
-- DDL-only and idempotent (autoMigrate has no distributed lock — IF NOT EXISTS is
-- safe to run concurrently across colos).
