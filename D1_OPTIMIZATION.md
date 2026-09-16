# D1 optimization — design for now (free) → scale (paid)

**Scope:** `apps/worker` (D1 access, cron, caching). **Goal:** stay comfortably
inside the Cloudflare **free** D1 limits today, and scale to the **Workers Paid**
plan for more users with **no code rewrite** — one env flag.

This is the standing design. It complements two existing docs:
`D1_R2_LOAD_AUDIT.md` (the original code-reasoned audit) and `SCALE_TIER.md`
(the free↔paid switch). Everything here was re-grounded against **real
production numbers** from `wrangler d1 insights tophunt-db`.

---

## 1. The limits we design against

| Metric | Free/day | Paid (Workers Paid) |
|---|---|---|
| **D1 rows read** | 5,000,000 | 25 billion/month (~833M/day) |
| **D1 rows written** | 100,000 | 50 million/month |
| **KV writes** | 1,000 | ~1,000,000/day |

D1 began **enforcing** the free daily caps on **1 Sep 2026** (queries now *fail*
past the cap). So the free tier is a hard wall, not a soft bill — the whole
design is about never touching it.

The scarcest quotas, in order, are: **KV writes (1k/day)** → **D1 rows written
(100k/day)** → **D1 rows read (5M/day)**. Every choice below is driven by that
ordering.

---

## 2. Measured baseline (before this work)

`wrangler d1 insights tophunt-db --sort-by reads` — top consumers over 1 day,
combined ≈ **3.66M rows_read/day (~73% of the 5M cap)**:

| rows_read/day | query | cause |
|---:|---|---|
| **2,873,202** | `DELETE FROM cron_runs WHERE created_at < ?` | full scan — no `created_at` index |
| ~681,000 | blog_posts: category GROUP BY, `count(*)`, sitemap, archive | ~4.5k published rows per cache miss |
| 47,380 | `SELECT name FROM d1_migrations` | once per isolate cold start |
| 459 | per-request auth read | tiny — traffic is currently low |

**rows_written** was ~5k/day (well under 100k) and **not a concern**. The single
recurring write is one `cron_runs` heartbeat per job run (~3.5k/day).

Key insight: at today's traffic the cost is **not** per-user request volume
(feed/auth are negligible) — it is **a handful of unindexed/uncached background
and aggregate queries**. Those are what this design fixes, plus the levers that
matter once per-user volume grows.

---

## 3. The optimization types (the playbook)

Each type below lists: the rule, what is DONE, and what is STAGED (with the
scale threshold that should trigger it).

### Type 1 — Indexing: turn scans into seeks *(highest leverage)*
**Rule:** any `WHERE col = ?`, `col < ?`, or `ORDER BY col` on a table that
grows needs an index whose LEADING column matches. A composite led by the wrong
column does not count.

- **DONE.** The DB is broadly well-indexed (`0022_hot_path_indexes`,
  `0045_chat_members`, status indexes on matches/deposits/withdrawals). The one
  gap — `cron_runs(created_at)` — is fixed in **`0048`** (was 57% of all
  rows_read). Verified live: plan is now `SEARCH … USING INDEX`.
- **Ongoing rule:** every new `NNNN_*.sql` that adds a queried column adds its
  index in the same migration. Never merge a hot `WHERE`/`ORDER BY` without one.

### Type 2 — Caching: collapse repeat identical reads to ~0 D1
**Rule (free-tier critical):** cache on the **Cloudflare Cache API** (per-colo,
edge) or **isolate memory** (`lib/memo.ts`) — **never** a per-hot-key KV write,
which would burn the 1k/day KV-write budget. Cache misses must **fail open**
(recompute from D1), never 500.

- **DONE:** feed candidate pool + per-viewer order (edge/memo), `/read/app-config`,
  `/read/users/suggested`, `/read/stories/feed`, all blog read endpoints.
- **DONE here:** blog TTLs lengthened (categories 5m→30m, sitemap 15m→6h,
  archive 15m→30m — editorial content, invalidated in the acting colo on write);
  admin `/blog/stats` and `/overview` memoised 60s/30s in isolate memory (they
  ran a dozen `COUNT(*)`s on every dashboard poll).
- **Already optimal:** `integration_secrets` decrypt is isolate-cached 30s
  (`resolveSecret`), never KV (plaintext must not touch shared storage).
- **Rule:** never cache an **authorization** decision in memory (block/deletion/
  session, OTP, rate-limit, payment intent) — those need globally-visible
  invalidation and live in KV/D1/Durable Objects. See `lib/memo.ts` header.

### Type 3 — Counters instead of `COUNT(*)` *(the scaling lever)*
**Rule:** `COUNT(*)`/`SUM()` over a growing table reads every matching row,
even with an index. Fine at thousands; expensive at millions.

- **DONE (interim):** the dashboard aggregates (`/overview`, `/blog/stats`) are
  cached (Type 2), so they cost their full scan at most once per TTL.
- **STAGED — trigger: `users`/`payments`/`contest_matches` > ~1M rows.** Replace
  the live counts with **maintained counters**: a small `stats(key, value)`
  table (or a Durable Object) incremented/decremented on the write paths that
  change them, read as a single-row lookup. Introduce behind the same
  fail-open pattern (missing counter → fall back to a live `COUNT(*)`), so it can
  ship incrementally, table by table. Do NOT do this before the threshold — a
  counter maintained across every insert/delete/rollback is real complexity and
  risk (must match settlement/refund paths exactly), and caching already covers
  the small-table case.

### Type 4 — Frequency: don't run work more often than needed
**Rule:** background/aggregate work should run at the slowest cadence its
freshness allows.

- **DONE here (cron redesign, see §4):** retention sweeps moved off the 10-min
  operational tick onto their own **hourly** trigger (144→24 runs/day).
- **DONE:** the client is WebSocket-push driven with slow safety-net polls
  (notifications 180s; feed cards 180s); admin dashboard aggregates now cached so
  its 20s poll no longer hits D1 each time.
- **STAGED — trigger: many admins polling.** If the dashboard poll ever dominates,
  raise its client `refetchInterval` 20s→60s (the server cache already absorbs it).

### Type 5 — Per-request auth read: the free↔paid switch
**Rule:** every authenticated request reads one `users` row (block/deletion/
session) *before* any route cache. At scale this becomes the highest-**count**
query in the system (today it is only ~459/day — traffic is low).

- **BUILT-IN, STAGED — trigger: ~1,000+ active users, on Workers Paid.** Set
  `SCALE_TIER = "paid"` (env var, no code change). The read is then served from a
  short-TTL `CACHE_KV` entry, invalidated on block/revocation, so D1 is untouched
  on a hit. On free it stays a direct D1 read *by design* — caching it in KV would
  cost ~1.4k KV writes/day **per user**, blowing the 1k/day KV budget. See
  `SCALE_TIER.md` and `lib/scale.ts`.

### Type 6 — Narrow reads: select columns, not `*` *(polish)*
`SELECT *` on wide tables (blog list pulling full article bodies, users pulling
`fcm_tokens`) wastes I/O/CPU even when rows_read count is unchanged. Convert to
explicit column lists opportunistically (`D1_R2_LOAD_AUDIT.md §8`). Low priority.

### Type 7 — Keyset pagination over `OFFSET`
Deep `OFFSET` scans the skipped rows. Hot lists already use keyset cursors;
`/blog/archive` uses page-number `OFFSET` deliberately (crawlable URLs) and is
bounded (~4.5k rows) — fine until the archive is much larger.

### Type 8 — Retention / growth control *(hygiene that keeps Types 1–3 cheap)*
Every high-churn table must have a bounded retention sweep, and the sweep’s
predicate must be indexed (Type 1): `cron_runs` (30d, now indexed),
`notifications`, `error_logs`, `idempotency_keys`, `admin_notifications`. Smaller
tables ⇒ cheaper scans/counts everywhere else.

---

## 4. Cron design

**Principle:** separate **time-critical** work (money, settlement, deletion SLAs)
from **housekeeping** (retention), and give each the cadence it needs.

| Cron | Cadence | Work |
|---|---|---|
| `*/10 * * * *` | every 10 min | resolveContests, expireContests, reconcilePayments, reconcileVideos, purgeScheduledDeletions |
| `0 * * * *` | **hourly (new)** | pruneErrorLogs, pruneNotifications, pruneOpsTables (retention) |
| `0 */6 * * *` | every 6 h | SEO audit (own subrequest budget) |
| `0 0 1 * *` | monthly | monthlyHallOfFame |

- Retention was previously bundled into the 10-min tick (144×/day). It is not
  time-critical, so it now runs hourly (24×/day). Combined with the
  `cron_runs`/`error_logs`/`notifications` indexes, each retention run is a cheap
  index range, not a scan.
- Cloudflare fires each matching cron as its **own** `scheduled` event
  (`event.cron` is the exact pattern), so the `*/10` and `0 * * * *` events at the
  top of the hour do not collide — they run as two separate, single-purpose ticks.

**STAGED cron scaling (trigger: many matches resolving per tick / large broadcasts)** —
from `D1_R2_LOAD_AUDIT.md §6`, not needed at today’s volume:
- Batch the per-match notification inserts in `resolveMatch` (one `db.batch()` per
  page instead of 2 `createNotification()` calls per match).
- Drop the `unreadCount()` `COUNT` from the notification insert path.
- Add a keyset cursor to the waiting-match drain so a no-op page isn’t re-scanned.

---

## 5. Free-now → paid-later: what changes (and what doesn’t)

**Nothing structural changes.** The transition is one env var:

1. Upgrade the Cloudflare account to **Workers Paid** (~$5/mo).
2. Set `SCALE_TIER = "paid"` (wrangler `[vars]` + deploy, or a dashboard env var
   for an instant flip).

On paid, the auth-state read (Type 5) starts serving from KV; everything else —
edge/memo caches, DO-backed vote/rate paths, cron cadence — runs **identically**,
just with far more headroom. Rollback is `SCALE_TIER="free"`. See `SCALE_TIER.md`.

**Scale checklist (do these in order as you grow):**
1. *Now:* Types 1, 2, 4, 8 — **done** in this work.
2. *At ~1,000+ users:* flip `SCALE_TIER="paid"` (Type 5).
3. *At ~1M rows in a hot table:* introduce maintained counters (Type 3).
4. *At high match/broadcast volume:* batch cron notification writes (§4 staged).

---

## 6. Expected effect of the work landed now

| | Before | After |
|---|---|---|
| D1 rows_read/day | ~3.66M (~73%) | **~250–300k (~5–6%)** |
| Largest single query | cron_runs prune 2.87M | eliminated (indexed) |
| Blog read misses | every 5–15 min/colo | every 30 min–6 h/colo |
| Dashboard aggregate D1 | every ~20s poll | ≤ once / 30–60s / isolate |
| Retention cron runs | 144×/day | 24×/day |
| rows_written/day | ~5k | ~5k (unchanged, far under cap) |

---

## 7. Operational guardrails

- **Turn on D1 Insights + a billing/usage alert** in the Cloudflare dashboard so
  regressions surface as a graph, not an outage. Re-run
  `wrangler d1 insights tophunt-db --sort-by reads` after any schema/query change
  and confirm nothing new tops the list.
- **Every cache fails open** — a blown quota degrades to a recompute, never a 500.
- **Every new hot query ships with its index** (Type 1) and, if it repeats,
  a cache (Type 2). Treat a full-table `SCAN` in `EXPLAIN QUERY PLAN` on a growing
  table as a bug.
