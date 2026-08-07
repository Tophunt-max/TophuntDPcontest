# TopHunt Archive Importer

Recovers the old **tophunt.in** WordPress posts from the **Internet Archive
(Wayback Machine)** and loads them into the new TopHunt blog.

It scrapes the latest archived snapshot of every real post permalink, extracts
title / excerpt / cover image / date / category / body HTML, and bulk-upserts
them into D1 through the Worker endpoint `POST /admin/blog/import`
(protected by `X-Admin-Secret`). In-content and cover images keep their
permanent `web.archive.org` URLs (no re-upload needed).

## Prerequisites

- Node 18+ (uses global `fetch`).
- The Worker deployed, with the `0003_blog.sql` migration applied.
- The same `ADMIN_PROXY_SECRET` that the Worker has set.

## Install

```bash
cd scripts/archive-import
npm install
```

## 1. Preview the recoverable URLs (no writes)

```bash
node import.mjs --urls-only
```

## 2. Dry run — parse a few posts and inspect the output

```bash
node import.mjs --dry-run --limit=10
# or dump everything parsed to a file without importing:
node import.mjs --dry-run --out=posts.json
```

## 3. Real import

```bash
WORKER_URL=https://tophunt-api.<your-subdomain>.workers.dev \
ADMIN_PROXY_SECRET=<your-secret> \
node import.mjs --concurrency=4 --batch=25
```

Re-running is safe: posts are de-duplicated by their original URL, so an
interrupted run can simply be started again (optionally with `--offset=N`).

## Flags

| Flag | Description |
|------|-------------|
| `--urls-only` | Print the recoverable post URLs and exit. |
| `--dry-run` | Parse only; never writes to the DB. |
| `--limit=N` | Process only the first N posts. |
| `--offset=N` | Skip the first N posts (resume). |
| `--concurrency=N` | Parallel Wayback fetches (default 4). Keep it modest to avoid archive.org rate limits. |
| `--batch=N` | Posts per POST to the Worker (default 25). |
| `--delay=ms` | Delay between snapshot fetches per worker (default 300). |
| `--out=file.json` | Also write parsed posts to a JSON file. |

## Notes

- The importer targets `tophunt.in`. Override with `ARCHIVE_DOMAIN` env if needed.
- Some very old / thin snapshots may fail to parse (no content); those are
  reported at the end and skipped. Rerun with `--dry-run` to inspect them.
