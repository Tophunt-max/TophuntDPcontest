-- Read-only counts for the doubled-/blog/blog/ link problem in article bodies.
--
-- Run before and after scripts/blog-link-backfill.sql. Every count should be 0
-- afterwards. See .github/workflows/blog-canonical-backfill.yml.

SELECT 'posts with a doubled /blog/blog/ link' AS metric,
       COUNT(*) AS count
FROM blog_posts
WHERE content IS NOT NULL
  AND instr(content, 'tophunt.in/blog/blog/') > 0;

SELECT 'posts with a doubled link in an encoded share url' AS metric,
       COUNT(*) AS count
FROM blog_posts
WHERE content IS NOT NULL
  AND instr(content, 'tophunt.in%2Fblog%2Fblog%2F') > 0;

SELECT 'published posts (the sitemap total)' AS metric,
       COUNT(*) AS count
FROM blog_posts
WHERE status = 'published';
