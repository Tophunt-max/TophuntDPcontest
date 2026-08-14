# TopHunt Archive Importer (v2)

Recovers the original **tophunt.in** WordPress posts from the **Internet Archive
(Wayback Machine)** and loads them into the TopHunt blog
(Cloudflare Worker → **D1** + **R2**).

## What it guarantees

- Imports content **only** from `tophunt.in` / `www.tophunt.in`. Nothing else.
- Strips all Internet Archive banners, toolbars, timestamps, injected scripts
  and metadata. **No Wayback URLs are ever stored.**
- Extracts **title, body, images, category, tags**, and — only when it can be
  determined confidently — the **original publish date** (otherwise `NULL`;
  never the Wayback capture date).
- Downloads **original TopHunt images** and re-uploads them to **Cloudflare R2**,
  replacing content image URLs with the new R2 URLs and preserving image order.
  Avatars, emoji, trackers and archive-UI images are ignored.
- Unwraps internal links from Wayback and rewrites them to `tophunt.in`.
- **SEO is always present** (meta title + meta description, derived from content
  when the source lacks them).
- Skips **empty / broken / duplicate** pages (dedup by canonical URL **and**
  content hash).
- **Transactional** writes (`db.batch`), **batched**, **resumable** and
  **retryable**, with live progress + a final summary reported to the admin
  **Archive Import dashboard** (`/blog/import`).

## Prerequisites

1. Worker deployed with migrations `0003_blog.sql` **and** `0004_blog_seo_import.sql` applied.
2. `ADMIN_PROXY_SECRET` matching the Worker's secret.
3. R2 configured on the Worker (`MEDIA` binding + `R2_PUBLIC_BASE_URL`).

## Install

```bash
cd scripts/archive-import
npm install
```

## Preview (no writes, no uploads)

```bash
node import.mjs --urls-only            # list recoverable post URLs
node import.mjs --dry-run --limit=10   # parse a few and inspect the output
```

## Full import (resumable)

```bash
WORKER_URL=https://tophunt-api.<subdomain>.workers.dev \
ADMIN_PROXY_SECRET=<secret> \
node import.mjs --concurrency=3 --batch=20
```

Interrupted? Just run it again — completed URLs are skipped automatically
(resume). Watch live progress on the admin **Archive Import** page.

## Retry failed pages

Click **Retry Failed** on the dashboard (requeues failed URLs), then:

```bash
WORKER_URL=... ADMIN_PROXY_SECRET=... node import.mjs --retry-failed
```

## Flags

| Flag | Description |
|------|-------------|
| `--urls-only` | Print recoverable post URLs and exit. |
| `--dry-run` | Parse only; no image upload, no DB writes, no progress. |
| `--retry-failed` | Re-process only URLs currently marked "failed". |
| `--fresh` | Ignore resume state; process everything. |
| `--limit=N` / `--offset=N` | Window the set of posts (testing / manual resume). |
| `--concurrency=N` | Parallel page fetches (default 3). Keep modest for archive.org. |
| `--batch=N` | Posts per DB import call (default 20). |
| `--delay=ms` | Delay between page fetches per worker (default 300). |
| `--out=file.json` | Also write parsed posts to a JSON file. |

## Notes

- Snapshots are chosen **oldest-first**: the site was healthy for years, and
  only the recent outage produced broken 200 snapshots — the oldest good
  capture has the real content.
- Some very old / thin captures (image-attachment pages, etc.) can't be parsed;
  they're recorded as `failed`/`skipped` and are visible on the dashboard.
- Override the target domain with the `ARCHIVE_DOMAIN` env var if ever needed.
