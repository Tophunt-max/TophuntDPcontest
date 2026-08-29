---
inclusion: manual
---

# Production domains — cutover runbook

The production hosts are:

| Role | Host |
|---|---|
| User web app (Expo web, apex) | `https://tophunt.in` |
| Admin panel | `https://admin.tophunt.in` |
| Backend API (Worker) | `https://api.tophunt.in` |
| Media / R2 public | `https://media.tophunt.in` |
| Email from | `no-reply@tophunt.in` |

There is no `app.tophunt.in`. The code side of the migration is done; what
remains is Cloudflare / Firebase / app-store configuration.

Invariants worth knowing before touching anything here:

- The Worker's `/media/*` route and `workers_dev = true` must stay. Note that
  adding `routes` makes wrangler stop publishing the workers.dev route unless
  `workers_dev` is set explicitly — that already caused one outage, blanking all
  media and cutting off every installed mobile build. Media urls
  are stored ABSOLUTE in D1, so pre-cutover rows and already-shipped mobile
  builds still point at the workers.dev host. `R2_LEGACY_BASE_URLS` is the
  matching half on the delete side.
- `MEDIA_TRANSFORMATIONS` is `"true"` and Transformations IS enabled on the
  `tophunt.in` zone. Never set it `"true"` on a zone where it is not enabled:
  `/cdn-cgi/image/...` errors instead of falling back, so the flag would break
  every thumbnail in the product. Verify with the `cf-resized` response header
  (`PRODUCTION_DOMAINS.md` §6), not by inspecting config. Rollback is `"false"`
  plus a deploy; no client release either way.
- Media urls are **canonicalised on the read path**, not just at write time —
  `lib/r2.ts#canonicalMediaUrl` maps any owned base (including legacy) onto
  `R2_PUBLIC_BASE_URL`. So a pre-cutover row is still CDN-served and optimised, and
  `scripts/media-domain-backfill.sql` is data hygiene rather than a prerequisite.
  Two prefixes are deliberately exempt — `contest-banners/images/` and
  `vs-cards/images/` — because they are deleted while still referenced and must
  keep a single cache identity (`PROXY_ONLY_PREFIXES` in `lib/media.ts`).
- Variant presets constrain width only and use `fit=scale-down`. Do not switch them
  to `cover`: without a height the only difference is that `cover` **upscales** a
  narrow source, which made the 1080 preset 67% larger on portrait DP entries.

Full runbook, including the media backfill and the cutover order:

#[[file:PRODUCTION_DOMAINS.md]]
