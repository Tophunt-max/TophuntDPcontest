-- Composite indexes to make the connections (followers/following) endpoints
-- paginate without a sort. The queries in routes/read.ts are:
--   followers → WHERE following_id = ? ORDER BY created_at DESC
--   following → WHERE follower_id  = ? ORDER BY created_at DESC
-- With these covering indexes SQLite can satisfy both the equality filter AND
-- the ORDER BY / keyset cursor (created_at < ?) straight from the index — no
-- temp B-tree sort, and only the requested page of rows is read.
--
-- Note: idx_follows_following (0000) already covers following_id alone, and the
-- PK (follower_id, following_id) covers follower_id alone, but neither includes
-- created_at, so an ORDER BY created_at still required a scan+sort before this.
CREATE INDEX IF NOT EXISTS idx_follows_following_created
  ON follows (following_id, created_at);

CREATE INDEX IF NOT EXISTS idx_follows_follower_created
  ON follows (follower_id, created_at);
