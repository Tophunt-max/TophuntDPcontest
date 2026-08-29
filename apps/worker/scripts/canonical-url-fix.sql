-- ===========================================================================
-- Repair blog canonical URLs that point at a path this app cannot serve.
--
--   https://tophunt.in/blog/blog/<slug>/   ->   https://tophunt.in/blog/<slug>/
--
-- ---------------------------------------------------------------------------
-- WHY THIS MATTERS MORE THAN IT LOOKS
-- ---------------------------------------------------------------------------
-- The archive importer built `canonical_url` by joining a `/blog/` prefix onto a
-- path that already contained one, so every imported post advertised
-- `/blog/blog/<slug>/`. That path has NO route. It only ever looked alive because
-- the SPA catch-all answers every path with 200 and the app shell, so opening it
-- renders `<title>TopHunt</title>` and nothing else.
--
-- A wrong canonical is worse than a missing one. It tells search engines "the real
-- version of this page is over there" — and over there is a page that renders no
-- content. That is an instruction to drop the URL that does work.
--
-- ---------------------------------------------------------------------------
-- WHY THE EDGE FIX IS NOT ENOUGH ON ITS OWN
-- ---------------------------------------------------------------------------
-- `apps/expo/public/_worker.js` (`canonicalForPost`) already collapses the
-- repeated prefix before emitting the tag, so pages served today are correct.
-- This script exists because that is a *presentation* fix over bad stored data:
--
--   * the admin blog editor shows the stored value, so anyone editing a post sees
--     and re-saves the broken URL;
--   * any future consumer of `canonical_url` — an export, a feed, a migration —
--     gets the broken value;
--   * and the SEO audit reads the rendered page, so the underlying defect is
--     invisible in the dashboard while the data stays wrong.
--
-- Fixing both means the data and the page finally agree.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------------
--   cd apps/worker
--
--   # 1. Count what is about to change (read-only).
--   npx wrangler d1 execute tophunt-db --remote --file=scripts/canonical-url-report.sql
--
--   # 2. Repair.
--   npx wrangler d1 execute tophunt-db --remote --file=scripts/canonical-url-fix.sql
--
--   # 3. Confirm doubled_blog_prefix is now 0.
--   npx wrangler d1 execute tophunt-db --remote --file=scripts/canonical-url-report.sql
--
-- Idempotent: each statement is guarded by a LIKE, so a second run touches no
-- rows. Safe to re-run after a partial failure. Rollback is D1 Time Travel
-- (`npx wrangler d1 time-travel restore tophunt-db --bookmark=<b>`), and nothing
-- user-visible depends on this either way — the edge Worker keeps emitting the
-- collapsed form regardless.
--
-- Not a migration in migrations/ for the same reason as the media backfill: those
-- auto-apply on deploy, and a data rewrite should be a deliberate, verified step.
--
-- ---------------------------------------------------------------------------
-- WHAT IS DELIBERATELY LEFT ALONE
-- ---------------------------------------------------------------------------
-- `original_url` is NOT touched. It is the original tophunt.in permalink and the
-- importer's dedup key (`blog_import_log.url` matches it) — rewriting it would
-- let an already-imported post be imported again as a duplicate.
--
-- Percent-encoded slugs (e.g. `...win-%E2%82%B920000`) are preserved: the
-- replacement only rewrites the prefix, never the slug, so an encoded URL stays
-- byte-identical after the `/blog/blog/` -> `/blog/` change.
-- ===========================================================================

-- Collapse a tripled prefix first, so the doubled pass below finishes the job in
-- one run. Ordering matters: doing the doubled pass first would turn
-- /blog/blog/blog/x into /blog/blog/x and leave it broken until a second run.
UPDATE blog_posts
   SET canonical_url = replace(canonical_url, '/blog/blog/blog/', '/blog/')
 WHERE canonical_url LIKE '%/blog/blog/blog/%';

UPDATE blog_posts
   SET canonical_url = replace(canonical_url, '/blog/blog/', '/blog/')
 WHERE canonical_url LIKE '%/blog/blog/%';
