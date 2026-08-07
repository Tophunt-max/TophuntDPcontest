-- Blog: SEO fields + content-hash dedup + resumable import log.

-- SEO + provenance columns on blog_posts.
ALTER TABLE blog_posts ADD COLUMN meta_title TEXT;
ALTER TABLE blog_posts ADD COLUMN meta_description TEXT;
ALTER TABLE blog_posts ADD COLUMN canonical_url TEXT;
ALTER TABLE blog_posts ADD COLUMN content_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_blog_content_hash ON blog_posts (content_hash);

-- Per-URL import state so the importer can resume, retry and be logged.
CREATE TABLE IF NOT EXISTS blog_import_log (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  post_id TEXT,
  images_total INTEGER DEFAULT 0,
  images_missing INTEGER DEFAULT 0,
  attempts INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_import_url ON blog_import_log (url);
CREATE INDEX IF NOT EXISTS idx_blog_import_status ON blog_import_log (status);
