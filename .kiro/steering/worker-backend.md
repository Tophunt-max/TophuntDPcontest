---
inclusion: manual
---

# TopHunt Worker (backend) — reference

Cloudflare Worker `tophunt-api` that replaced the Firebase Cloud Functions
backend: Hono + D1 + R2 + KV + Durable Objects; Firebase is used for Auth only.
Covers one-time setup, auto D1 migrations, data migration, and the port status
of every endpoint/phase.

Full document:

#[[file:apps/worker/README.md]]
