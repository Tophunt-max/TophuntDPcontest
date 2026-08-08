---
inclusion: always
---

# TopHunt Blog — Complete Handbook

> Single source of truth for the TopHunt blog: architecture, data, endpoints, the
> Wayback archive importer, the admin panel, deployment, and step‑by‑step recipes.
> Point any AI assistant at this file to work on the blog safely.

---

## 1. What the blog is

The blog recovers the old **tophunt.in** WordPress posts (from the Internet
Archive / Wayback Machine) and serves them from the new stack:

- **Backend:** Cloudflare Worker `tophunt-api` (Hono + D1 + R2 + KV)
- **Database:** Cloudflare D1 (`tophunt-db`) — table `blog_posts`
- **Images:** Cloudflare R2 bucket `tophunt-media`, served through the Worker at `/media/*`
- **Admin UI:** Vite + React SPA (`apps/admin-panel`) → Cloudflare Pages `tophunt-admin-panel`
- **Reader UI:** Expo web/app (`apps/expo/app/blog`)
- **Importer:** Node script `scripts/archive-import/import.mjs`

**Live URLs**

| Thing | URL |
|---|---|
| Worker API | `https://tophunt-api.weadown-in.workers.dev` |
| Admin panel | `https://tophunt-admin-panel.pages.dev` (menu → CONTENT → Blog) |
| Public blog API | `https://tophunt-api.weadown-in.workers.dev/read/blog` |
| Media (images) | `https://tophunt-api.weadown-in.workers.dev/media/<key>` |

---

## 2. Architecture at a glance

```
Wayback Machine ──▶ importer (import.mjs, runs on a machine w/ Node)
                       │  parses ONE original post per URL
                       │  images ──▶ Worker /admin/media/fetch-to-r2 ──▶ R2
                       ▼
                 Worker /admin/blog/import  ──▶  D1 blog_posts (+ blog_import_log)
                       ▲                                     │
        admin panel (Firebase admin token)                  ▼
        reader app  ──▶  Worker /read/blog*  ◀── public, cached in KV
        images      ──▶  Worker /media/*     ◀── reads R2
```

Key point: the importer does the heavy Wayback crawling/parsing **off‑Worker**
(Node has no CPU/time limits). The Worker only stores parsed posts + serves them.

---

## 3. Data model

### `blog_posts` (D1)
| Column | Notes |
|---|---|
| `id` | primary key |
| `slug` | URL permalink (indexed, unique in practice) |
| `title` | required |
| `excerpt` | short summary for list cards |
| `content` | full HTML body |
| `cover_image_url` | featured image (R2 URL after import) |
| `category` | e.g. "Amazon Quiz", "Fashion" |
| `tags` | JSON array |
| `author` | default `TopHunt` |
| `status` | `published` \| `draft` |
| `meta_title`, `meta_description` | SEO — never empty (derived if needed) |
| `canonical_url`, `original_url` | original tophunt.in permalink (dedup key) |
| `content_hash` | sha256 of normalized text (dedup) |
| `source` | `admin` (hand‑written) \| `archive` (imported) |
| `view_count` | incremented on read |
| `published_at` | original publish date **or NULL** (never the Wayback capture date) |
| `created_at`, `updated_at` | epoch ms |

### `blog_import_log` (D1) — per‑URL importer state (resumable)
| Column | Notes |
|---|---|
| `url` | canonical original URL (unique) |
| `status` | `pending` \| `imported` \| `updated` \| `skipped` \| `duplicate` \| `failed` |
| `error` | reason when failed/skipped |
| `post_id` | linked blog post |
| `images_total`, `images_missing` | image recovery stats |
| `attempts` | retry counter |

Migrations: `apps/worker/migrations/0003_blog.sql`, `0004_blog_seo_import.sql`.

---

## 4. Worker endpoints

**Auth:** `/admin/*` accepts **either** a Firebase admin ID token (Bearer — used
by the admin panel) **or** the header `X-Admin-Secret: <ADMIN_PROXY_SECRET>`
(used by the importer script).

### Public (reader)
| Method | Path | Purpose |
|---|---|---|
| GET | `/read/blog?limit=&cursor=&category=&q=` | published posts (cursor pagination) |
| GET | `/read/blog/categories` | categories with counts |
| GET | `/read/blog/:slug` | single post (also accepts id); bumps view count |

### Admin (CRUD)
| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/blog?q=` | list all posts (any status) |
| GET | `/admin/blog/stats` | `{total, published, drafts, imported}` |
| GET | `/admin/blog/:id` | single post for edit |
| POST | `/admin/blog` | create post |
| PATCH | `/admin/blog/:id` | update post |
| DELETE | `/admin/blog/:id` | delete post |

### Admin (import pipeline)
| Method | Path | Purpose |
|---|---|---|
| POST | `/admin/blog/import` | bulk upsert `{posts:[...]}` (dedup by url + content hash) |
| POST | `/admin/media/fetch-to-r2` | `{url, folder}` → fetch image, store in R2, return public URL |
| GET/POST | `/admin/blog/import/progress` | live progress (stored in KV) |
| GET | `/admin/blog/import/done-urls` | URLs already handled (resume) |
| GET | `/admin/blog/import/log?status=&limit=` | import‑log rows |
| GET | `/admin/blog/import/summary` | counts by status + missing images |
| POST | `/admin/blog/import/retry-failed` | mark failed rows `pending` |
| POST | `/admin/blog/import/fail` | record a failed URL |

### Media
| Method | Path | Purpose |
|---|---|---|
| GET | `/media/*` | serve an R2 object (immutable, 1‑year cache) |

**Why `/media` instead of a custom domain:** the account has no
`tophuntdpcontest.com` zone, so R2 is served through the Worker.
`R2_PUBLIC_BASE_URL = https://tophunt-api.weadown-in.workers.dev/media`
(set in `apps/worker/wrangler.toml`). Image keys are content‑hash addressed
(`blog/imported/<sha256>.<ext>`), so they're safe to cache forever.

---

## 5. The importer — `scripts/archive-import/import.mjs`

### Guarantees
- Imports **only** from `tophunt.in` / `www.tophunt.in`.
- Strips all Wayback banners/toolbars/scripts **and** AddThis/share widgets; no
  `web.archive.org` URLs are ever stored (a final scrub pass unwraps them).
- Extracts **title, body, images, category, tags**, and the **original publish
  date** only when confident (else NULL).
- **Category** comes from JSON‑LD (`articleSection`, else the BreadcrumbList
  `Home > Category > Post` → second‑to‑last item). "Home" is ignored.
- **Richest‑snapshot selection:** for each URL it scores several captures
  (cover + date + category + content length), newest‑first with early exit, then
  migrates images only for the winner. (Older code took the oldest snapshot,
  which was often broken → empty content / no category.)
- Downloads original images to **R2** and rewrites `<img src>`; drops
  avatars/emoji/trackers.
- **SEO always present**; dedup by canonical URL then content hash.
- **Transactional, batched, resumable, retryable**; reports progress + summary.

### Environment
```bash
export WORKER_URL="https://tophunt-api.weadown-in.workers.dev"
export ADMIN_PROXY_SECRET="<the worker's admin secret>"   # see §8
# optional: export ARCHIVE_DOMAIN="tophunt.in"
```

### Flags
| Flag | Meaning |
|---|---|
| `--dry-run` | parse only; no uploads, no DB writes |
| `--urls-only` | print recoverable post URLs and exit |
| `--source=cdx` | (default) discover URLs by crawling the whole domain via CDX |
| `--source=done` | re‑import URLs already in the import log (avoids the flaky domain CDX) |
| `--since=<epochMs>` | with `--source=done`: skip URLs re‑imported at/after this time (resumable re‑import) |
| `--only=<substr>` | process only URLs containing this substring |
| `--retry-failed` | re‑process only URLs currently `failed` |
| `--fresh` | ignore resume state; process everything |
| `--limit=N` / `--offset=N` | window the URL set |
| `--concurrency=N` | parallel page fetches (default 3) |
| `--batch=N` | posts per DB import call (default 20) |
| `--delay=ms` | delay between fetches per worker (default 300) |
| `--out=file.json` | also write parsed posts to JSON |

### How URL/timestamp discovery works
- `--source=cdx`: paginated domain CDX crawl (`limit=1500` + `resumeKey`). Retries
  on 429/5xx. Gives every URL with all its timestamps in one pass — fast when
  archive.org is not throttling.
- `--source=done`: URL list comes from `/admin/blog/import/done-urls` (+ failed).
  Per‑URL timestamps come from the **Wayback availability API** (not the CDX
  search API, which gets rate‑limited after bulk use). This is the fast path used
  to re‑process existing posts.

---

## 6. Admin panel — Blog page

`apps/admin-panel/src/pages/Blog.tsx`

- **Stat cards:** Total / Published / Drafts / Imported.
- **Archive Import panel** (added for import visibility):
  - Chips: Imported / Updated / Duplicate / Skipped / Failed + Missing images.
  - Live progress bar when an import is running.
  - **View import log** → filter by Failed / Skipped / Imported / Updated /
    Duplicate / All → table of **URL + status + reason + time**. This is how you
    see *which posts imported and which didn't (and why)*.
- **Posts table:** cover, title, slug, category, status, views, date; edit / delete / new.

API client: `apps/admin-panel/src/lib/api.ts` (`api.blog*`, `api.blogImport*`).

---

## 7. Reader app

`apps/expo/app/blog/index.tsx` (list), `apps/expo/app/blog/[slug].tsx` (detail),
`apps/expo/src/components/blog/RenderHtml.tsx` (renders the HTML body),
`apps/expo/src/services/blog/blogService.ts` (fetch layer → `/read/blog*`).

---

## 8. Operations runbook

### Set / rotate the importer secret (needed to run imports)
The importer authenticates with `X-Admin-Secret`. Set a value you control:
```bash
cd apps/worker
printf '%s' "<your-strong-secret>" | npx wrangler secret put ADMIN_PROXY_SECRET
```
(The admin panel does **not** need this — it uses Firebase login.)

### Run a fresh import (discover everything via CDX)
```bash
cd scripts/archive-import && npm install
node import.mjs --dry-run --limit=10          # preview
node import.mjs --concurrency=5 --batch=25    # real, resumable
```

### Re‑import / improve existing posts (fast path, dodges CDX throttling)
```bash
SINCE=$(node -e "console.log(Date.now())")     # capture once; reuse for all chunks
node import.mjs --source=done --since=$SINCE --concurrency=8 --batch=25 --delay=50
# re-run the same command to resume; already-redone URLs are skipped
```

### Retry only failures
```bash
# in the admin panel: (or) POST /admin/blog/import/retry-failed
node import.mjs --retry-failed
```

### Inspect state
```bash
curl -H "X-Admin-Secret: $ADMIN_PROXY_SECRET" $WORKER_URL/admin/blog/stats
curl -H "X-Admin-Secret: $ADMIN_PROXY_SECRET" $WORKER_URL/admin/blog/import/summary
curl -H "X-Admin-Secret: $ADMIN_PROXY_SECRET" "$WORKER_URL/admin/blog/import/log?status=failed&limit=50"
```

---

## 9. Deployment

| Component | How it deploys |
|---|---|
| **Worker** (`apps/worker`) | `npx wrangler deploy` (from `apps/worker`). CI: `.github/workflows/worker-production.yml` on push to `main` touching `apps/worker/**`. **Note:** this CI job has been failing — deploy manually until it's fixed. |
| **Admin panel** (`apps/admin-panel`) | **No CI.** Build + deploy manually: `npm run build` then `npx wrangler pages deploy dist --project-name=tophunt-admin-panel --branch=main`. |
| **Reader app** (`apps/expo`) | `.github/workflows/web-production.yml` on push touching `apps/expo/**` → Cloudflare Pages `tophuntdpcontest`. |

Cloudflare bindings on the Worker: `DB` (D1 tophunt-db), `MEDIA` (R2 tophunt-media),
`CACHE_KV`, `OTP_KV`, Durable Objects, plus vars incl. `R2_PUBLIC_BASE_URL`.

---

## 10. Known limitations

- **Cover images ~low coverage:** many original images were **never archived** by
  Wayback (confirmed via the availability API). When an image isn't in the
  archive, the cover stays NULL — a data limitation, not a bug.
- **`failed` rows** (mostly `no content element`): the landed snapshot had no
  parseable article container. The richest‑snapshot re‑import recovers many of
  these; some captures are genuinely too thin.
- **Category values are inconsistent** in the source (e.g. `Amazon Quiz` vs
  `Amazon quiz` vs `amazon quiz answers`). Normalize if needed (see recipes).
- **archive.org rate‑limits** the CDX *search* API after bulk use (503/504). Page
  replay + the availability API keep working — hence `--source=done` uses them.

---

## 11. Current status (snapshot)

_Update this when you re‑run imports._

- Total posts: **~3,674** (all published)
- Imported: **3,473** · Updated: **198** · Duplicate: **7** · Failed: **717**
- Missing images: **~1,957**
- Category coverage: high on re‑imported posts (~96% in sample); the full
  richest‑snapshot re‑import was **started but paused** — resume with the
  `--source=done --since=…` command in §8 to bring the rest up.

---

## 12. Recipes — "tell the AI to…"

Use these as prompts; each maps to concrete, safe actions.

- **"Re‑import all posts with the improved parser."**
  → Run §8 "Re‑import existing posts" in ~28‑min chunks (resumable via `--since`).

- **"Fix one post from its archive URL."**
  → `node import.mjs --source=cdx --only="<slug-substring>" --fresh` **or** extract
  that snapshot and POST to `/admin/blog/import`.

- **"Show which posts failed and why."**
  → Admin panel → Blog → Archive Import → View log → Failed. Or
  `GET /admin/blog/import/log?status=failed`.

- **"Retry the failed ones."**
  → `POST /admin/blog/import/retry-failed` then `node import.mjs --retry-failed`.

- **"Normalize categories"** (e.g. merge `amazon quiz*` → `Amazon Quiz`).
  → A D1 `UPDATE blog_posts SET category=… WHERE lower(category) IN (…)`, run via
  `wrangler d1 execute tophunt-db --remote --command "…"`. Verify counts first.

- **"Add an auto‑deploy workflow for the admin panel."**
  → New `.github/workflows/admin-panel-production.yml`: build `apps/admin-panel`,
  deploy `dist` to Pages project `tophunt-admin-panel` (mirror `web-production.yml`).

- **"Hide/unpublish a post."**
  → `PATCH /admin/blog/:id { "status": "draft" }` (or delete via the panel).

---

## 13. Source map

| Area | Path |
|---|---|
| Worker blog + import routes | `apps/worker/src/routes/admin.ts` |
| Worker public blog routes | `apps/worker/src/routes/read.ts` |
| Worker media route + headers | `apps/worker/src/index.ts` (`/media/*`) |
| D1 schema | `apps/worker/src/db/schema.ts` (`blogPosts`, `blogImportLog`) |
| Migrations | `apps/worker/migrations/0003_blog.sql`, `0004_blog_seo_import.sql` |
| Importer | `scripts/archive-import/import.mjs` (+ `README.md`) |
| Admin Blog page | `apps/admin-panel/src/pages/Blog.tsx` |
| Admin API client | `apps/admin-panel/src/lib/api.ts` |
| Reader app | `apps/expo/app/blog/*`, `apps/expo/src/components/blog/RenderHtml.tsx`, `apps/expo/src/services/blog/blogService.ts` |
