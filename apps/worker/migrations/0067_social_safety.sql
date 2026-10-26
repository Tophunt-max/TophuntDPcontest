-- Social safety features (all additive).
--
-- 1. Restrict (Instagram-style). The owner restricts an account; that account's
--    NEW and existing comments on the owner's battles and posts are visible only
--    to the commenter themselves (and to the owner), and nothing they do sends
--    the owner a notification. Softer than a block: no follow teardown, and the
--    restricted person is not told.
CREATE TABLE IF NOT EXISTS user_restricts (
  restricter_id  TEXT NOT NULL,
  restricted_id  TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (restricter_id, restricted_id)
);
-- Notification suppression and comment filtering look up "who restricted this
-- commenter" by the restricted side.
CREATE INDEX IF NOT EXISTS idx_user_restricts_restricted ON user_restricts (restricted_id);

-- 2. Hide my story from a specific account. The owner keeps posting stories as
--    normal; the hidden account simply never sees them (feed ring, profile ring,
--    highlights) and cannot view/react/reply.
CREATE TABLE IF NOT EXISTS user_story_hides (
  owner_id    TEXT NOT NULL,
  hidden_uid  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_id, hidden_uid)
);
-- Story reads ask "which owners hide from ME", i.e. by the hidden side.
CREATE INDEX IF NOT EXISTS idx_user_story_hides_hidden ON user_story_hides (hidden_uid);

-- 3. Report status for the reporter ("My reports"). An admin "remove" now marks
--    the reports 'actioned' (with resolved_at) instead of deleting them, and a
--    dismiss stamps resolved_at too, so the reporter can see the outcome.
ALTER TABLE reports ADD COLUMN resolved_at INTEGER;
CREATE INDEX IF NOT EXISTS idx_reports_reporter_created ON reports (reporter_id, created_at);

-- 4. Battle ending reminder for people who SAVED the battle. bookmarks is keyed
--    (user_id, match_id); the reminder needs "who saved this battle".
CREATE INDEX IF NOT EXISTS idx_bookmarks_match ON bookmarks (match_id);
