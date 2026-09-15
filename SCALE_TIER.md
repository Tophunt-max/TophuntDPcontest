# Scale tier — free now, paid later, **zero code change**

**Date:** 2026-09-15 · **Scope:** `apps/worker` · **Switch:** `SCALE_TIER` env var

This is the plan for running on the Cloudflare **free** tier today and moving to the
**Workers Paid** plan later, when traffic (≈1,500+ users) needs it — **without editing
code at the transition.** The move is one flag.

---

## TL;DR

| | Free tier (today) | Workers Paid (`SCALE_TIER="paid"`) |
|---|---|---|
| Hot reads (feed, contests, stories, suggestions, profiles, leaderboard) | Cache API + isolate memory, **0 KV writes** | same — no change needed |
| Per-request auth account-state read | direct D1 (1 row / authed request) | **served from KV**, D1 untouched on a hit |
| KV writes/day used by the above | ~0 (stays under the 1,000/day free cap) | auth-state cache only (affordable on paid) |
| What you change to switch | — | `SCALE_TIER = "paid"` + upgrade account |

**Default is `"free"`.** Anything other than the exact string `"paid"` (unset, empty,
a typo) resolves to free, so a mistake can never accidentally incur paid-only writes.

---

## Why the free tier is the hard part (and why it already works)

The Cloudflare free plan's scarcest quota is **KV writes: 1,000/day** for the whole
Worker — three orders of magnitude below its 100,000 KV reads/day. On top of that, D1
began **enforcing** its free daily limits on **1 Sep 2026** (5M rows read/day, 100K
rows written/day) — queries now *fail* past the cap instead of sliding through.

The app is already built around both facts:

- **Reads** are served from the **Cloudflare Cache API** (`lib/edgeCache.ts`) and
  **isolate memory** (`lib/memo.ts`), not KV — because an edge/memory tier saves KV
  *reads* but a KV cache still costs ~`86400/ttl` *writes* per hot key per day. The
  feed candidate pool, per-viewer feed order, `/stories/feed` and `/users/suggested`
  are all **edge-only** (`kv: null`), so they add **zero** KV writes.
- **Vote counting** and **rate limiting** live in Durable Objects, off D1's single
  writer and off KV entirely.
- Every cache read/write **fails open**: a blown quota degrades to a cache miss (recompute
  from D1), never a 500.

So on the free tier nothing is disabled — the app is simply *tuned* to stay inside the
quotas. On paid, that same code runs with far more headroom and needs no change.

---

## The one lever that is gated: the auth account-state cache

`D1_R2_LOAD_AUDIT.md` §1 identifies the **highest-COUNT** query in the system: the
account-state lookup (`status` / `isBlocked` / `tokensValidAfter`) that
`middleware/auth.ts` runs on **every** authenticated `/read/*` and `/api` request,
*before* any route cache. It is a cheap single-row read, but it is the most *frequent*
one, so it is what keeps signed-in traffic from ever reaching zero D1.

Caching it in KV removes that read from every authenticated request. The catch is pure
economics:

- **Free:** a per-user key at KV's 60s floor costs ~1,440 writes/day **per active
  user**. At ~1,500 users that's ~2.1M KV writes/day vs a **1,000/day** budget — it
  would exhaust the one quota everything else protects. **So it is OFF on free.**
- **Paid:** the Workers Paid plan raises the included KV write allowance to ~1M/day, so
  the same ~2.1M/day is a few cents of overage — and it buys back a D1 read on every
  authenticated request plus lower latency (a KV read beats a D1 query). **So it turns
  ON with the flag.**

### Correctness when it's ON

The cached row gates moderation (blocked/deleted) and session revocation, so a stale
copy must not outlive those facts. Two mechanisms bound it (`lib/scale.ts` documents both):

1. **Explicit, global invalidation.** Every writer of the cached columns drops the KV
   entry (`invalidateAuthState`), and a KV delete is visible in every colo:
   - `lib/sessionRevocation.ts` `setCutoff` — the choke point for **all** revocation
     (admin block, admin "log out everywhere", password/email/phone changes).
   - `routes/admin.ts` PATCH `/users/:id` — admin **block and unblock**.
   - `lib/accountDeletion.ts` — account **anonymisation** (blocked + deleted).
   - `routes/api.ts` `adminUnblockUser` — **reactivation**.
2. **TTL is only the fallback.** 60s (`= KV_MIN_TTL_SEC`) bounds how long any writer that
   *forgot* to invalidate could serve stale — the audit's "invalidation is the mechanism,
   TTL is the backstop" framing.

Blocking additionally closes live sockets and revokes the Firebase refresh token, so the
only residual is an already-minted ID token making REST calls for at most 60s in a colo a
delete hasn't reached yet — bounded, self-healing, and the trade the audit signed off on.

Proven now, not later: `test/scaleTier.test.ts` asserts free writes nothing, paid caches
after the first request, and block / unblock invalidate immediately (403 → 200).

---

## The "go paid" procedure (the whole thing)

1. Upgrade the Cloudflare account to the **Workers Paid** plan (dashboard, ~$5/mo).
2. Set the flag — **either**:
   - `SCALE_TIER = "paid"` in `apps/worker/wrangler.toml` `[vars]`, then `npm run deploy`; **or**
   - add `SCALE_TIER=paid` as a **dashboard environment variable** for an instant flip with no redeploy.
3. (Optional, recommended) turn on **D1 Insights** and set a **billing alert**, so the
   paid usage is visible.

That's it. No handler, query, migration, or mobile-app build changes.

To roll back: set `SCALE_TIER="free"` (or remove it). The auth-state cache stops being
written and read; invalidation calls become harmless no-ops.

---

## Headroom check at 1,500 users on paid

The Workers Paid plan includes **25 billion** D1 rows read/month (~833M/day) and **50
million** rows written/month, plus ~1M KV writes/day. Against that, 1,500 users — even
before the free-tier caching helps — are comfortably inside the included quotas, so the
transition is about **headroom and latency**, not about unblocking a hard wall.

---

## What is deliberately NOT tier-gated

Everything else already scales as-is, so it stays identical on both tiers to avoid
needless divergence:

- **Edge-only read caches** (`READ_CACHE_TTLS`) — already free *and* fast; global
  invalidation is handled by short TTLs + per-colo purge on write.
- **Notification safety-poll** (180s) — good for both tiers; the socket delivers
  instantly regardless.
- **Cron batch sizes**, **DO-backed vote/rate paths** — already within paid *and* free
  DO allowances.

If a future lever turns out to be "unaffordable on free, worth it on paid," add it to
`ScaleConfig` in `lib/scale.ts` the same way `cacheAuthState` was — one field, gated by
one flag, defaulted to the safe tier.
