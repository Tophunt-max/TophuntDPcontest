-- Phase 4: match engagement, bookmarks, highlights, reactions, profile fields.

-- users: extra profile fields
ALTER TABLE users ADD COLUMN bio TEXT;
ALTER TABLE users ADD COLUMN is_private INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN auth_provider TEXT;
ALTER TABLE users ADD COLUMN extra TEXT;

-- contest_matches: quick-reaction counters
ALTER TABLE contest_matches ADD COLUMN reactions TEXT;

-- story_views: emoji reaction
ALTER TABLE story_views ADD COLUMN reaction TEXT;

CREATE TABLE IF NOT EXISTS match_likes (
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id)
);

CREATE TABLE IF NOT EXISTS match_comments (
  id TEXT PRIMARY KEY,
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  text TEXT,
  parent_id TEXT,
  like_count INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_match_comments_match ON match_comments (match_id);

CREATE TABLE IF NOT EXISTS match_reactions (
  match_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, user_id, type)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL,
  match_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, match_id)
);

CREATE TABLE IF NOT EXISTS highlights (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT,
  cover_image_url TEXT,
  story_ids TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_highlights_user ON highlights (user_id);
