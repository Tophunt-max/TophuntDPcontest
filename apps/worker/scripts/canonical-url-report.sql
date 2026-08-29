-- ===========================================================================
-- How many posts advertise a canonical URL that this app cannot serve?
--
-- Read-only. Run before and after canonical-url-fix.sql:
--
--   cd apps/worker
--   npx wrangler d1 execute tophunt-db --remote --file=scripts/canonical-url-report.sql
--
-- After the fix, `doubled_blog_prefix` must be 0. The other rows are context: a
-- canonical on a foreign host or a shape this app has no route for is equally
-- wrong, and worth knowing about before assuming this one pattern is the whole
-- problem.
--
-- Keep in sync with canonical-url-fix.sql.
-- ===========================================================================

SELECT 'published posts'            AS metric, COUNT(*) AS n FROM blog_posts WHERE status = 'published'
UNION ALL
SELECT 'canonical_url set',              COUNT(*) FROM blog_posts
  WHERE status = 'published' AND canonical_url IS NOT NULL AND trim(canonical_url) <> ''
UNION ALL
-- The defect: the importer joined a /blog/ prefix onto a path that already had
-- one, so the canonical points at /blog/blog/<slug>/ — a path with no route.
SELECT 'doubled_blog_prefix  <-- the bug', COUNT(*) FROM blog_posts
  WHERE canonical_url LIKE '%/blog/blog/%'
UNION ALL
SELECT 'triple or more /blog/',           COUNT(*) FROM blog_posts
  WHERE canonical_url LIKE '%/blog/blog/blog/%'
UNION ALL
-- Anything not on tophunt.in is a canonical handing ranking to another site.
SELECT 'off-site canonical',              COUNT(*) FROM blog_posts
  WHERE canonical_url IS NOT NULL
    AND trim(canonical_url) <> ''
    AND canonical_url NOT LIKE 'https://tophunt.in/%'
    AND canonical_url NOT LIKE 'https://www.tophunt.in/%'
UNION ALL
SELECT 'http:// (not https)',             COUNT(*) FROM blog_posts
  WHERE canonical_url LIKE 'http://%'
UNION ALL
-- After the fix every canonical should be https://tophunt.in/blog/<slug>/ —
-- which is what the edge Worker emits, so data and page agree.
SELECT 'already correct shape',           COUNT(*) FROM blog_posts
  WHERE canonical_url LIKE 'https://tophunt.in/blog/%'
    AND canonical_url NOT LIKE '%/blog/blog/%';
