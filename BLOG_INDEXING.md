# Blog indexing — diagnosis and the steps code cannot do

Search Console, 28 Aug 2026: **92 indexed, 73 not indexed, 4,475 submitted.**

Nothing was broken in any way a browser could show you. Every post loaded, the
sitemap was valid XML with all 4,475 entries, and robots.txt allowed crawling. The
site was un-indexable because its pieces disagreed with each other.

## What was measured on production

| # | Finding | Evidence |
|---|---|---|
| 1 | The canonical tag never matched the URL in the sitemap | 40 URLs sampled, **0 matched**. 35 differed only by a trailing slash (`/sitemap.xml` said `/<slug>`, the page said `/<slug>/`); 5 named a different slug entirely. |
| 2 | Some canonicals pointed at pages that do not exist | `/tcl-is-a-global-top-____-tv-brand/` → `Not found`, `noindex`. De-duplicated `-2` slugs kept the original permalink. A canonical aimed at a noindex 404 removes the post rather than demoting it. |
| 3 | `/blog` contained no links to any article | `curl /blog \| grep -c '<a href>'` → **0**. The list is a React Native `FlatList`, so it renders `TouchableOpacity`. ~4,400 posts had zero internal links. |
| 4 | Article bodies linked to a live dead end | ~8 links per post to `/blog/blog/<slug>/`, which answered **200 with `noindex, nofollow`**. |
| 5 | Every dead URL answered 200 | `/wp-admin/`, `/wp-login.php`, `/xmlrpc.php`, `/feed`, `/?p=123`, `/wp-content/uploads/*.jpg`, `/sitemap_index.xml`, and every typo'd permalink. |
| 6 | The second submitted sitemap answered with HTML | Only `/sitemap.xml` exists; any other `*.xml` path returned the SPA shell with a 200, which Search Console reports as "Couldn't fetch". |

Reason 1 alone explains the headline number: for 4,466 posts, the URL submitted to
Google declared that the real page was somewhere else.

## What the code now does

- `canonicalForPost` always self-canonicalises to `https://tophunt.in/<slug>` and
  ignores the stored `canonical_url` (which stays as provenance and as the import
  dedup key). The canonical tag and the sitemap `<loc>` are now both derived from
  `post.slug`, so they cannot drift.
- One 301 collapses every historical shape onto that permalink: trailing slashes,
  `/blog/<slug>`, and the doubled `/blog/blog/<slug>/`. Combined into a single
  redirect rather than chained, because a hop is not free at this volume.
- New crawlable archive at `/blog/archive` and `/blog/archive/page/<n>` (plus
  `/blog/archive/category/<c>`), rendered as standalone HTML by the edge Worker —
  100 real `<a href>` per page, `rel=prev`/`rel=next`, and every page listed in
  `/sitemap.xml`. Every post now has an inbound link from an indexable page.
  These are NOT injected into the SPA shell: React mounts over the root element, so
  anything injected there is destroyed on hydration.
- Real statuses: 404 for an unresolved permalink and for unknown paths, 410 for the
  retired WordPress URL space, 404 for bogus `*.xml` and missing assets, **503 (not
  404) when the API is unreachable** — a 404 there would drop live articles from the
  index over a transient upstream failure.
- Imported in-body links are normalised at render time, and the importer now writes
  canonical on-site links for future imports.
- `seoAudit` gained the checks that would have caught all of this:
  `tech.canonical.sitemap_match`, `tech.permalink.one_url`, `tech.404.status`,
  `tech.legacy.gone`, `tech.sitemap.bogus_404`, `tech.archive.reachable`,
  `tech.archive.links`.

## Manual steps — these are not in code

1. **Remove the broken sitemap from Search Console.** Sitemaps → delete the entry
   showing "Couldn't fetch". Only `https://tophunt.in/sitemap.xml` exists.
2. **Check Cloudflare for the 403s.** "Blocked due to access forbidden (403)" is
   not reachable from this codebase — no blog or document path returns 403, and 7
   probed paths returned none. It is zone-level: Security → Events, filter by
   Googlebot. If Bot Fight Mode is on, turn it off, or add a WAF skip rule for
   verified bots. Bot Fight Mode blocking Googlebot is a known Cloudflare failure
   mode and it cannot be fixed from here.
3. **Re-submit `/sitemap.xml`** after deploy, then use "Validate fix" on the
   "Alternate page with proper canonical tag" and "Soft 404" reports. Validation is
   what makes Google re-process the affected URLs rather than waiting for its own
   schedule.
4. **Optionally run the link backfill.** Actions → "Blog internal link backfill" →
   `report` first, then `backfill` with `confirm=BACKFILL`. This is data hygiene:
   the edge Worker already normalises these links at render time and 301s the
   doubled path, so nothing breaks if it never runs. It removes a redirect hop on
   every internal link and makes what the app renders from the API match what the
   Worker serves.
5. **Note on the managed robots.txt.** Cloudflare prepends its own block, which
   disallows AI crawlers (`GPTBot`, `ClaudeBot`, `CCBot`, `Google-Extended`,
   `meta-externalagent`, …). Googlebot for Search is unaffected, so this is not part
   of the indexing problem — but `Google-Extended: Disallow` does opt the site out
   of AI Overviews and Gemini grounding. That is a product decision; if the
   intention is to be cited by answer engines, it is the wrong setting.

Expect movement in days, not hours: Google has to re-crawl ~4,400 URLs, and the
archive pages have to be crawled before the internal links they carry count for
anything.
