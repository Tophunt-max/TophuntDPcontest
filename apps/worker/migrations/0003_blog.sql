-- Blog feature: editorial posts + imported tophunt.in archive (Wayback) posts.
CREATE TABLE IF NOT EXISTS blog_posts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT,
  content TEXT,
  cover_image_url TEXT,
  category TEXT,
  tags TEXT DEFAULT '[]',
  author TEXT DEFAULT 'TopHunt',
  status TEXT DEFAULT 'published',
  source TEXT DEFAULT 'admin',
  original_url TEXT,
  view_count INTEGER DEFAULT 0,
  published_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Unique permalink; also the lookup key for /read/blog/:slug.
CREATE UNIQUE INDEX IF NOT EXISTS idx_blog_slug ON blog_posts (slug);
-- List query: published posts ordered by publish date.
CREATE INDEX IF NOT EXISTS idx_blog_status_published ON blog_posts (status, published_at);
CREATE INDEX IF NOT EXISTS idx_blog_category ON blog_posts (category);
-- Import dedup: skip posts already brought over from the archive.
CREATE INDEX IF NOT EXISTS idx_blog_original_url ON blog_posts (original_url);
