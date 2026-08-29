-- Reader comments on blog articles.
--
-- WHY A SEPARATE TABLE instead of reusing `post_comments`:
--
--   `post_comments.post_id` refers to `posts` — the in-app social feed. Three
--   things are wired to that meaning and all three would break if blog comments
--   were stored there under a blog post's id:
--
--     * `posts.comment_count` is denormalised and bumped on every insert/delete
--       in routes/api.ts. A blog comment has no `posts` row to bump, so the
--       UPDATE would silently match zero rows — and the reverse (a blog id that
--       happened to collide with a post id) would corrupt a real counter.
--     * deleting a social post deletes its comments by `post_id`. Sharing the
--       column would make that cascade reach across content types.
--     * admin moderation lists "recent post comments" by joining that table.
--       Blog comments would appear as app-feed comments with an unresolvable
--       post id.
--
--   The two also differ in *audience*: `posts` comments are between people who
--   follow each other inside the app, while these are public UGC on pages that
--   search engines index. Keeping them apart is what lets the read path treat
--   them differently (see below) without weakening the social path.
--
-- WHY THERE IS NO `blog_posts.comment_count`:
--
--   Nothing renders a comment count in a list of articles — the blog index shows
--   title/excerpt/cover — so a denormalised counter would exist only to be kept
--   in sync, and drift is exactly what a counter nobody reads accumulates. The
--   article page needs the number for its "Comments (N)" heading and gets it
--   from a COUNT on the cached first page of the thread. One COUNT per cache
--   miss, on an indexed column, is cheaper than a column that has to be correct
--   after every insert, delete, admin removal and account deletion.
--
-- WHY FLAT (no `parent_id`):
--
--   `post_comments` carries `parent_id` for replies. A blog thread is a comment
--   section, not a conversation graph: threading needs collapse/expand affordances
--   and a reply-notification path, and the notification path does not exist here
--   because `blog_posts.author` is free text ("TopHunt"), not a uid — there is
--   nobody to notify. Adding the column "for later" would mean the read path has
--   to decide what to do with orphaned children today.
--
-- `like_count` IS here and shares the existing `comment_likes` table, which is
-- keyed by comment id alone and already spans `post_comments` and
-- `match_comments`. Ids come from newId()/clientId, so the space is shared
-- safely — the same assumption the two existing tables already rely on.
CREATE TABLE IF NOT EXISTS blog_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT,
  like_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- Serves the only two access patterns: the keyset page
-- (WHERE post_id = ? ORDER BY created_at DESC) and the COUNT for the heading.
-- Composite rather than post_id alone so neither has to sort or scan the thread.
CREATE INDEX IF NOT EXISTS idx_blog_comments_post ON blog_comments (post_id, created_at);

-- Account deletion removes a departing user's comments by user_id
-- (lib/accountDeletion.ts). Without this index that is a full table scan inside
-- a batch that already holds a lot of work.
CREATE INDEX IF NOT EXISTS idx_blog_comments_user ON blog_comments (user_id);
