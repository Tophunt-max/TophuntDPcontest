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

Two invariants worth knowing before touching anything here:

- The Worker's `/media/*` route and `workers_dev = true` must stay. Note that
  adding `routes` makes wrangler stop publishing the workers.dev route unless
  `workers_dev` is set explicitly — that already caused one outage, blanking all
  media and cutting off every installed mobile build. Media urls
  are stored ABSOLUTE in D1, so pre-cutover rows and already-shipped mobile
  builds still point at the workers.dev host. `R2_LEGACY_BASE_URLS` is the
  matching half on the delete side.
- `MEDIA_TRANSFORMATIONS` stays `"false"` until Transformations is enabled on the
  `tophunt.in` zone in the dashboard. Flipping it first breaks every thumbnail.

Full runbook, including the media backfill and the cutover order:

#[[file:PRODUCTION_DOMAINS.md]]
