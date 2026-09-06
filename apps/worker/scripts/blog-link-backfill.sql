-- Rewrite doubled /blog/blog/ links inside imported article bodies.
--
-- ## What is wrong
--
-- Imported articles link to each other, and an earlier import applied the /blog/
-- prefix twice, so bodies are full of https://tophunt.in/blog/blog/<slug>/.
-- Nothing serves that path. Measured on production, it answered **200 with
-- `noindex, nofollow`** — the SPA fallback returns index.html for any path, and the
-- edge Worker's fail-closed branch marks an unrecognised path noindex. So every
-- internal link Googlebot followed out of an article arrived at a page that both
-- existed and refused to be indexed: roughly eight such links per post across
-- ~4,400 posts. That is the largest single reason the catalogue has no usable
-- internal link graph, and it is a direct contributor to the "Excluded by
-- 'noindex' tag" and "Crawled - currently not indexed" buckets in Search Console.
--
-- ## Why this is a script and not a migration
--
-- Same reasoning as scripts/media-domain-backfill.sql, and it applies more
-- strongly here. Files in migrations/ are applied automatically on the first
-- request to a fresh isolate (src/db/autoMigrate.ts), so as a migration this would
-- fire the moment the code shipped — rewriting the `content` column of ~4,400 rows,
-- tens of megabytes of HTML, inside a live user request. If that exceeded a D1
-- query limit the migration would throw, and because `ensureMigrated` runs before
-- request handling, a failing migration takes the whole API down and retries on
-- every subsequent request. A deliberate, operator-gated run has none of that
-- coupling and can be rolled back with Time Travel.
--
-- ## Why nothing breaks if this never runs
--
-- The edge Worker (apps/expo/public/_worker.js#normalizeContentLinks) rewrites
-- these links at render time, and blogPermalinkRedirect 301s the doubled path onto
-- the root permalink. So crawlers and readers both reach the right page either way.
-- What this buys is the removal of a redirect hop on every internal link, and a
-- database whose contents match what is served — which matters because the app
-- fetches content straight from the API, not through the edge Worker, so a
-- rendered-page crawl of the SPA still sees whatever is stored here.
--
-- ## Matching
--
-- instr() rather than LIKE: the encoded form contains '%', which LIKE reads as a
-- wildcard. Only the unambiguous doubled prefix is rewritten. A single
-- /blog/<slug> link is deliberately left alone — the Worker 301s it, and a blind
-- REPLACE of that string would also rewrite links to the blog index itself.
--
-- The second REPLACE covers the percent-encoded copy of the same url that the
-- imported Facebook/Twitter/Pinterest share buttons embed in their query strings.
--
-- updated_at is bumped only on rows this actually changes. That is deliberate: it
-- is a real content change, so the sitemap's lastmod should invite a re-crawl —
-- but bumping every row to one timestamp would erase the freshness signal on posts
-- that were never touched.

UPDATE blog_posts
SET content = REPLACE(
      REPLACE(content, 'tophunt.in/blog/blog/', 'tophunt.in/'),
      'tophunt.in%2Fblog%2Fblog%2F', 'tophunt.in%2F'
    ),
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE content IS NOT NULL
  AND (
    instr(content, 'tophunt.in/blog/blog/') > 0
    OR instr(content, 'tophunt.in%2Fblog%2Fblog%2F') > 0
  );
