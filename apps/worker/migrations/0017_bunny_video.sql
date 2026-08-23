-- Bunny Stream video support (MEDIA_MIGRATION_PLAN.md Phase 2c).
--
-- DDL-only and idempotent by design: src/db/autoMigrate.ts has no distributed
-- lock (see AUDIT_2026-08-23.md #15), so isolates in different colos can run
-- this file concurrently. CREATE ... IF NOT EXISTS is naturally safe, and
-- ALTER TABLE ADD COLUMN is tolerated because isIgnorable() swallows
-- "duplicate column name". Do NOT add data statements here — run backfills as
-- explicit admin actions instead.
--
-- DESIGN NOTE — why a `videos` table rather than columns on contest_matches:
--
-- The plan proposed video_provider/bunny_video_id/... directly on
-- contest_matches, but that table holds TWO participants in the user_a / user_b
-- JSON snapshots, each with their own media. Single columns cannot represent two
-- videos. A separate table keyed by Bunny's own guid also turns the encoding
-- webhook into a primary-key update instead of a search across every table that
-- might own a video.
--
-- Linkage back to content is by URL: a Bunny video's playback URL is
-- https://{cdn-host}/{guid}/playlist.m3u8, so the guid is recoverable from the
-- existing media_url / userA.mediaUrl fields and no participant-JSON migration
-- is required.

CREATE TABLE IF NOT EXISTS videos (
  -- Bunny's video guid. Primary key so the webhook is a single-row update.
  id TEXT PRIMARY KEY,
  library_id TEXT,
  -- Uploader, for per-user quota and orphan cleanup.
  owner_uid TEXT NOT NULL,
  -- 'bunny' today; 'r2' rows are only written by the backfill for provenance.
  provider TEXT NOT NULL DEFAULT 'bunny',
  -- uploading | processing | ready | failed
  status TEXT NOT NULL DEFAULT 'uploading',
  -- What this video belongs to. Null until the story / contest entry that uses
  -- it is actually created, which is how orphaned uploads are identified.
  target_type TEXT,            -- 'story' | 'contest_entry'
  target_id TEXT,
  -- 'A' | 'B' for contest entries: a match holds two participant videos in its
  -- user_a / user_b JSON, so the id alone does not identify which one this is.
  target_side TEXT,
  thumbnail_url TEXT,
  duration_sec INTEGER,
  -- Populated on the 'ready' webhook so clients never build URLs themselves.
  playback_url TEXT,
  mp4_url TEXT,
  -- Set by the Phase 3 backfill: the original R2 object this was pulled from.
  -- Kept so the R2 original can be deleted later, after confirmed playback.
  r2_source_url TEXT,
  error_message TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Per-user listing (quota checks, orphan sweep).
CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos (owner_uid, created_at);
-- Find stuck/pending encodes without scanning the table.
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos (status);
-- Resolve "what videos does this story/entry use".
CREATE INDEX IF NOT EXISTS idx_videos_target ON videos (target_type, target_id);

-- Coarse migration markers. Provider is derivable from the URL host, but an
-- explicit column keeps the Phase 3 backfill query indexable and survives a
-- future CDN hostname change.
ALTER TABLE stories ADD COLUMN video_provider TEXT;
ALTER TABLE contest_matches ADD COLUMN video_provider TEXT;
