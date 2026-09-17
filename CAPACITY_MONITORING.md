# Capacity monitoring & alerting runbook

**Goal:** never be surprised by a Cloudflare quota. Get warned at **70%**, act at
**90%**, so a cap is a planned upgrade — not an outage.

Pairs with `D1_OPTIMIZATION.md` (the optimizations) and `SCALE_TIER.md` (the
free→paid switch). Two layers of monitoring:

1. **Cloudflare native usage alerts** — the source of truth, e-mails you. *(Part 1)*
2. **`npm run capacity`** — a one-command diagnostic: which query / which table is
   driving usage, and how close each is to a wall. *(Part 2)*

---

## The caps we watch (free tier, per day)

| Resource | Free/day | Binds first? | Lever when it fills (`D1_OPTIMIZATION.md`) |
|---|---|---|---|
| **KV writes** | **1,000** | ⚠️ **YES — first wall** (~100–150 daily-active users) | `SCALE_TIER="paid"`; raise feed-seen flush interval |
| D1 rows written | 100,000 | ~2–3k DAU | batch cron notif writes; per-user notification DO |
| D1 rows read | 5,000,000 | ~2.5–3.3k DAU | indexes (done), caching (done), counters |
| D1 storage | 5 GB | far off (~53 MB now) | retention (Type 8) |

The scarcest quota is **KV writes**, so it is the one that decides when to go
paid. On the Workers **Paid** plan these limits jump 166×–1000×, and the ceiling
becomes D1 single-writer throughput, not the quotas.

---

## Part 1 — Cloudflare native alerts (set up ONCE, in the dashboard)

This is the real alerting. Do it once; it e-mails you automatically.

1. Cloudflare dashboard → **Manage Account → Notifications → Add**.
2. Add these (product = **Workers** / **D1** where offered):
   - **Workers KV — daily writes** → alert at **700/day** (70% of 1,000). *This is
     the most important one.*
   - **D1 — rows read** → alert at **3,500,000/day** (70%).
   - **D1 — rows written** → alert at **70,000/day** (70%).
   - **Billing / usage** (if on Paid) → a spend alert so overage is visible.
3. Delivery = the ops e-mail (the same inbox the D1 limit warning arrived on).

> If a specific metric isn’t offered as a native alert in your plan, rely on the
> weekly `npm run capacity` check (Part 2) for that one.

Optional, for **in-app** alerts (no dashboard needed): a daily cron can query the
Cloudflare **GraphQL Analytics API** for D1 usage and raise the existing ops
alert (`alertOnce` → admin-panel notification) at 70/90%. It needs a read-only
`CF_ANALYTICS_TOKEN` + account id as Worker secrets. Deferred on purpose — the
native alert above already covers it with zero code and zero token to manage.

---

## Part 2 — `npm run capacity` (run weekly, and after any query/schema change)

```bash
cd apps/worker && npm run capacity
```

Prints, with a 🟢/🟠/🔴 %-used bar for each:
- **rows_read / rows_written** vs the daily caps (sum of the top queries over the
  last day — a close lower bound; Cloudflare’s alert is the billing truth).
- **TOP rows_read queries** — so a regression names the exact query.
- **Growth tables** vs their soft thresholds (the point to pull a staged lever).
- **DB storage** vs 5 GB.

What healthy looks like today: rows_read comfortably under 10% *(the number is
briefly higher right after a fix, while the 1-day window still contains
pre-fix runs — it settles within 24h)*, writes tiny, every table 🟢.

**Also run, ad hoc, the raw insight** (what tops the read list):
```bash
npx wrangler d1 insights tophunt-db --sort-by reads --limit 10 --json
```
Treat any **new** query at the top, or a full-table `SCAN` in
`EXPLAIN QUERY PLAN` on a growing table, as a bug (add its index — Type 1).

---

## Part 3 — Threshold → action playbook

When an alert or `npm run capacity` crosses a line, act by resource:

| Signal at 70% | Do this |
|---|---|
| **KV writes** (or ~1,500 users) | Upgrade to Workers Paid + set `SCALE_TIER="paid"` (one env var). If still tight: raise the feed-seen flush interval 5→15 min, or move it to a Durable Object. |
| **D1 rows read** | Run `npm run capacity`; find the top query. Add its missing index, or lengthen/добавить a cache for it. If a `COUNT(*)` on a >1M-row table dominates → maintained counters (Type 3). |
| **D1 rows written** | Almost always cron notification fan-out or a hot write loop → batch inserts; move per-user notifications to a Durable Object (the Cassandra-style fan-out). |
| **A growth table 🟠** | Pull that table’s staged lever: `votes`/`matches` → counters; `notifications` → per-user DO; `cron_runs` → shorten retention. |
| **Storage** | Tighten retention windows (Type 8). |

---

## Part 4 — Growth checkpoints (do these IN ORDER as you scale)

1. **Now** — indexes, caching, retention cadence: **done** (`D1_OPTIMIZATION.md`).
2. **~1,000–1,500 users / KV-writes alert fires** → `SCALE_TIER="paid"`.
3. **A hot table > ~1M rows** → maintained counters instead of `COUNT(*)`.
4. **High social/broadcast volume** → notification fan-out to a per-user Durable
   Object; batch cron notification writes.
5. **Read-heavy at large scale** → D1 read replicas (Sessions API).

Each step is a small, isolated change — never a rewrite. The architecture
(D1 relational core + Durable Objects for high-write + edge/memo caches) is
already shaped for all five.
