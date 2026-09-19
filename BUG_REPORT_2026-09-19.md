# Bug Report — 2026-09-19

Review of `apps/worker` (money, auth, validation) and `apps/expo` (client).

**Baseline:** `npm run typecheck` passes clean and all **1040 tests in 50 files pass**.
Every defect below is a *logic* bug that the existing suite does not cover — none of
them show up as a red build.

Severity: **P0** = real money can be created/destroyed, or private data leaks.
**P1** = user-visible breakage or money misstatement. **P2** = hardening / latent.

---

## P0 — Money can move without a ledger row

### 1. The hourly idempotency purge destroys the only replay guard on the Hall-of-Fame payout
`apps/worker/src/lib/ops.ts:166-170` — the DELETE is **scope-blind**:

```ts
const keyCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
const keys = await env.DB.prepare("DELETE FROM idempotency_keys WHERE created_at < ?")
  .bind(keyCutoff).run();
```

`idempotency_keys` has a `scope` column (`db/schema.ts:1338-1349`) holding
`wallet`, `clawback`, `hall_of_fame`, `alert`… — the DELETE ignores it and wipes them
all. `pruneAlertClaims` (`lib/ops.ts:217-224`) is a second copy of the same
scope-blind delete despite its name. Runs hourly from `index.ts:524`.

Now the HoF payout, `cron.ts:587-619`. The claim key is per-rank, the ledger id is **not**:

```ts
const claimKey = `hall_of_fame:${period}:${i + 1}:${u.uid}`;   // :587
// ledger id:
`hall_of_fame:${period}:${u.uid}`                              // :607  (no rank)
// balance update, gated ONLY on the claim nonce:
`UPDATE users SET dpcoin = dpcoin + ?, xp = xp + 500, badges = ?, monthly_wins = 0 ...
   WHERE uid = ? AND EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ? AND nonce = ?)`
```

`POST /admin/ops/hall-of-fame` accepts an **explicit period** (`routes/admin.ts:4234`,
`/^\d{4}-\d{2}$/`). Re-run it for a period older than 7 days:

1. Claim row was pruned → `INSERT OR IGNORE` succeeds with a **new** nonce.
2. `claimGate` passes.
3. Ledger `INSERT OR IGNORE` is **ignored** — that id already exists.
4. `dpcoin + 1000` **applies a second time.**

1000 coins minted with no ledger row — exactly the `ledgerDrift` condition
`lib/moneyHealth.ts:44` alarms on. One admin click.

Second variant: the top-3 set is re-selected live by `monthly_wins DESC`, which run #1
reset to 0 — so a re-run picks *different* users whose ledger ids don't exist yet, and
mints 1750 coins funded by no pot and no payment.

The comment at `admin.ts:4230-4232` ("a second click pays nobody twice") is only true
inside the 7-day window.

Same purge breaks `adjustUserWallet`: its `claimKey` is the only guard because
`ledgerId` defaults to `crypto.randomUUID()` (`lib/money.ts:159`), so after a purge the
same `Idempotency-Key` replays as a full second adjustment.

> **Fix:** never prune `scope IN ('wallet','clawback','hall_of_fame')`; additionally gate
> the HoF balance update on `NOT EXISTS (SELECT 1 FROM coin_transactions WHERE id = …)`.

### 2. Manual deposit approval: status CAS outside the crediting batch, credit gated on nothing, no recovery sweep
`apps/worker/src/routes/admin.ts:3477-3509`. Status is claimed in its own statement:

```ts
const claim = await db.update(schema.deposits).set({ status, ... })
  .where(and(eq(schema.deposits.id, id), eq(schema.deposits.status, "pending"))).run();
if (claim.meta.changes === 0) throw httpsError("failed-precondition", "…already processed.");
```

…then a **separate** batch whose balance update carries **no gate at all**:

```ts
db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${d.amount}` })  // :3493
```

If the isolate dies or D1 rejects the batch after the CAS commits, the deposit reads
`approved` with **no coins, no `payments` row, no ledger row** — and `admin.ts:3459`
makes a retry impossible. There is no recovery sweep: `recoverStrandedPaidOrders`
(`lib/coinOrders.ts:463-550`) and `moneyHealth`'s `strandedPaidOrders` both only scan
`payment_orders`. Real INR was transferred (a UTR was verified) and the loss is
invisible and unrecoverable without hand-written SQL.

Secondary: ledger id is `newId()` (`:3507`), not `manual_deposit:${id}`, so any manual
re-run writes a second ledger row — the opposite of what the Razorpay recovery path
does deliberately (`coinOrders.ts:517` uses `purchase:${paymentId}` "so a repeated
recovery cannot write a second row").

### 3. `claimDailyTask` commits its claim outside the crediting batch → reward silently destroyed
`apps/worker/src/routes/api.ts:1529-1541`. Claim is statement A, money is transaction B,
and B's `UPDATE users` is gated on **nothing**:

```ts
const ins = await db.insert(schema.dailyTaskClaims).values({...}).onConflictDoNothing().run();
if (ins.meta.changes === 0) throw httpsError("already-exists", "Task already claimed today.");

await db.batch([
  db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${task.reward}` }) // ungated
    .where(eq(schema.users.uid, uid)),
  db.insert(schema.coinTransactions).values({ id: newId(), ... }),
]);
```

A crash between the two leaves the claim present and the reward gone forever
(`already-exists` on every retry, no sweeper). This is the odd one out — `claimAdReward`
**directly above it** (`api.ts:1450-1467`) does it correctly, with the claim INSERT as
statement #1 *inside* the batch and both money statements gated on
`EXISTS (SELECT 1 FROM ad_reward_claims WHERE id = ?)`.

### 4. `adjustUserWallet` burns the claim on a *failed* adjustment, then reports the retry as "already applied"
`apps/worker/src/lib/money.ts:174-186` writes the claim unconditionally as statement #1;
the money statements are gated on `dpcoin + delta >= 0`. On an over-subtract they no-op
and the function throws (`:238-242`) — **but the batch committed, so the claim row
survives**. Nothing releases it; there is no `revert` path (contrast
`releaseIdempotency`, `lib/idempotency.ts:71-88`, which this path doesn't use).

Admin subtracts 500 from a 300 balance with `Idempotency-Key: k` → error. User tops up.
Admin retries with the same `k` (the whole point of the header) → fresh nonce loses to
the stale row → `changes === 0` → `WalletReplay` → `routes/admin.ts:1008-1021` returns
**"Wallet already updated for this request (no change applied)."** The adjustment is now
permanently impossible with that key and the admin is told it already happened.

> **Fix:** delete the claim row before throwing the insufficient-balance error.

---

## P0 — Private data leak

### 5. Story IDOR via highlights — `storyIds` ownership is never checked
Write side, `apps/worker/src/routes/api.ts:2873-2887`: `createHighlight` validates
**nothing**, and `addStoryToHighlight` checks the *highlight* belongs to the caller but
never the *story*:

```ts
case "createHighlight": {
  const { name, coverImageUrl, storyIds } = body;
  await db.insert(schema.highlights).values({ id, userId: uid, ..., storyIds: storyIds || [] });
```

Read side, `apps/worker/src/routes/read.ts:3316-3331`: the only visibility test is on the
**highlight owner** — i.e. the attacker — and `profileHiddenFrom` returns `false` when
viewer === target (`read.ts:2391-2399`). Story rows are then returned whole (`...s`) with
no per-story `userId` / `visibility` / block filter:

```ts
if (await profileHiddenFrom(c, h.userId)) return c.json(null);   // attacker's own id
const rows = await db.select().from(schema.stories).where(inArray(schema.stories.id, storyIds)).all();
stories: rows.map((s) => ({ ...s, seen: true })).sort(...)
```

**Exploit:** harvest victim story ids from `GET /read/users/:id/stories` (`optionalAuth`,
returns ids) → `POST {"action":"createHighlight","storyIds":["<victim story id>"]}` →
`GET /read/highlights/:id/stories` serves the victim's full story rows, including stories
past the 24h window and non-public `visibility`, **attributed to the attacker's profile**
(`userId: h.userId`, victim's username replaced) and readable by **anyone,
unauthenticated**. `stories` has `userId` and `visibility` (`db/schema.ts:511-525`), so the
check is expressible and simply absent.

### 6. `videoStatus` has no ownership filter
`apps/worker/src/routes/api.ts:415-431` selects `playbackUrl`, `mp4Url`, `thumbnailUrl`
for up to 50 caller-supplied guids. `videos.ownerUid` exists (`db/schema.ts:1427`, plus an
index at `:1451`) and is **never in the predicate**:

```ts
let rows = await db.select(columns).from(schema.videos).where(inArray(schema.videos.id, ids)).all();
```

Any authenticated user gets playback/MP4 URLs for anyone's videos — including uploads not
yet attached to any public object (`targetType`/`targetId` still null) and videos on
stories they're blocked from. Also drives up to 3 outbound Bunny calls per request with no
rate limit.

---

## P1 — Money misstated / lost through refunds

### 7. Partial Razorpay refunds claw back only once
`lib/coinOrders.ts:199-201` short-circuits on the order's terminal status and `:239` keys
the claim on the **payment**, not the refund (`clawback:${paymentId}`). The proportional
math is right (`Math.ceil`, so rounding never favours the refunder) but the state machine
is wrong for multiple refunds of one payment, which Razorpay supports:

- ₹100 → 100 coins. Refund #1 ₹50 → claws 50, status `refunded`.
- Refund #2 ₹50 → `order.status === "refunded"` → returns `already`.
- **User keeps 50 coins for a fully refunded payment.**

`refunded_amount_paise` is overwritten not accumulated, so nothing records the second
refund; `payments.status` was already flipped, so revenue reporting under-states the loss
too. Needs `clawback:${paymentId}:${refundId}`, cumulative paise, and a
`partially_refunded` state.

### 8. Clawback debits coins that were never credited, and removes the order from the recovery sweep
`lib/coinOrders.ts:203-208` treats `status === 'paid'` as proof the coins landed — but the
same file says otherwise at `:451-462`: the claim commits *before* the credit batch, which
is exactly why `recoverStrandedPaidOrders` exists.

Stranded order (paid, credit batch lost) + refund webhook →
`UPDATE users SET dpcoin = dpcoin - ?` (`:285-287`) debits coins the user never received,
records a `clawback_shortfall` and raises an admin alert *accusing them of refund farming*
(`webhook.ts:53-75`) — then flips status to `refunded`, which **removes the row from
`recoverStrandedPaidOrders`' `status = 'paid'` filter** (`:487`). The lost credit can never
be recovered.

> **Fix:** one predicate the code already trusts at `:495`/`:515` —
> only debit `WHERE EXISTS (SELECT 1 FROM payments WHERE id = ?)`.

Same function, two smaller defects: `balanceBefore` is read **outside** the batch
(`:229-236`) so the persisted shortfall and the alert are numerically wrong under
concurrency; and the success probe `results[3]` (`:294`) is the `UPDATE users`, which
yields 0 changes for a deleted account — so it returns `already` even though the status
flip and the ledger row *did* apply, skipping the notification and the shortfall alert.

### 9. Feed prize badge shows a wrong, fractional coin amount
`apps/expo/src/components/home/PostCard.tsx:548`:

```tsx
<Text style={styles.prizeText}>{item.entryFee * 1.8}</Text>
```

Three bugs in one line:

1. **Wrong base.** On a match object `entryFee` is the pot for **both** players —
   documented at `src/lib/contestPricing.ts:24-29`. ×1.8 advertises 180% of the money
   that exists, against a server payout hard-capped at the pot.
2. **Bypasses the single source of truth.** `src/lib/contestPrize.ts` exists for exactly
   this ("Every surface that shows a prize has to go through here instead") and handles
   product prizes — so a **product-prize battle still renders a coin figure**.
3. **Fractional coins.** No rounding: `entryFee: 7` renders **`12.6`**. Coins are a
   whole-number currency (`contestPricing.ts:53-56`).

Explore shows a *different* number for the same battle — `app/explore/index.tsx:402`
uses `item.entryFee` raw ("Win 7" vs the feed's "12.6").

### 10. Notifications screen can hang on the skeleton forever
`apps/expo/app/notifications/index.tsx` — `setLoading(false)` appears on **exactly one
path**, inside the realtime success callback (`:154`). Three ways it never fires:

- `live()` swallows fetch errors — `src/services/realtime.ts:241-244` `catch { /* transient */ }`.
- `live()` returns early when `AppState.currentState !== 'active'` (`realtime.ts:238`),
  including on the initial `void refresh()` — common on an iOS cold start from a push tap,
  which is how users reach this screen.
- `if (!user?.uid) return;` (`:151`) exits before any `setLoading(false)`.

**Kicker:** the render gate at `:258` hides the `FlatList` — and therefore the
`RefreshControl` — while loading, so pull-to-refresh is unreachable. No error text, no
retry. This is the same bug class `app/messages/chat/[id].tsx:54-60` documents having
fixed; this screen never got the treatment (and `home.tsx:196-208` has a proper Retry).

### 11. Failed chat send is swallowed; the bubble looks delivered
`apps/expo/app/messages/chat/[id].tsx:178-190` appends the optimistic bubble, then
`catch (error) { console.error(...) }` — no rollback, no failed state, no retry. The
bubble later vanishes silently when the realtime callback replaces `messages` wholesale.
Silent data loss with a UI that signals success. (Sibling paths do it right:
`onPickImage` alerts on failure.)

### 12. Pagination clamp is one-sided — negative → unlimited, non-numeric → NaN into SQL
Eight handlers clamp only the upper bound:

```
read.ts:1224  /read/matches (optionalAuth → public)   :1381 /read/leaderboard
read.ts:1672  /read/notifications                     :1823 /read/transactions
read.ts:1926  /read/users/suggested                   :2407 /read/users/:id/posts
read.ts:2429  /read/users/:id/matches                 :3342 /read/blog
```

`const limit = Math.min(parseInt(c.req.query("limit") || "30", 10), 100);`

The same file has the correct pattern at `:2874`, `:2990`, `:3437`
(`Math.min(Math.max(parseInt(...) || 50, 1), 100)`), which makes these oversights.

- `?limit=-1` → SQLite treats a negative LIMIT as **no limit** → one unauthenticated
  `GET /read/matches?limit=-1` dumps the whole `contest_matches` table, runs
  `enrichParticipants` per row, and caches the result under the attacker-chosen key
  `cache:matches:…:${limit}:${cursor}` (`:1244`).
- `?limit=abc` → `Math.min(NaN, 100)` is NaN → bound as the LIMIT parameter (500, or
  coerced to NULL = unlimited).
- Cursors are unvalidated too: `lt(schema.notifications.createdAt, Number(cursor))`
  (`:1676`) and `:1827` put NaN straight into the predicate.

### 13. Explore people-search: out-of-order results, stuck spinner, setState after unmount
`apps/expo/app/explore/index.tsx:154-165` — the cleanup clears only the **timer**; once it
fires, `searchUsers(query)` is unguarded (no `cancelled` flag, no request id, no
`AbortController`). Slow request A for `al` landing after B for `alice` shows results for
the wrong query; a stale `setSearching(false)` hides the spinner while the newer request
runs; leaving the screen mid-search sets state on an unmounted component; and the
`activeTab` early-return at `:155` leaves `searching === true` forever on a tab switch.
`app/home.tsx:52,58` already has the `reqIdRef` pattern this needs. `fetchExploreData`
(`:167-186`) has the same shape and three concurrent callers.

---

## P2 — Hardening / latent

### 14. `startMatch` rollback deletes ledger history
`apps/worker/src/routes/api.ts:625-650` — the pause-race rollback **deletes** the
`contest_entry_fee` row instead of appending a compensating refund row (the only refund
path in the worker that rewrites history; compare `lib/payouts.ts:186-200`), and the
re-credit is gated on `stillWaiting` (the *match*) rather than on the ledger row it
compensates for. `xp - 10` can also drive XP negative.

### 15. `/webhook/bunny` is unauthenticated when no secret is set, and accepts the secret in the query string
`routes/webhook.ts:239-251` — the check is wrapped in `if (configuredSecret)`, and the
secret is read from `?secret=` among other places (query strings survive in proxy/CDN
logs). Blast radius is limited because `applyBunnyEncodeResult` re-fetches truth from
Bunny, so it's forced-refresh amplification rather than state forgery. Neither webhook has
a replay window/timestamp — replay is contained by order idempotency instead.

### 16. Four unguarded `item.userB.` dereferences in PostCard
`apps/expo/src/components/home/PostCard.tsx:567, 695, 701, 703` — while the same file
treats `userB` as nullable everywhere else (`item.userB?.votes`, and the header wraps the
second avatar in `{item.userB && …}`). Currently non-firing **only** because the Worker
filters one-sided matches out of every list feeding this component — `read.ts:2446` says
so out loud: *"waiting_for_opponent (no userB -> would crash the card)"*. The client has
zero defense of its own; a one-line server change red-screens the home feed.

### 17. CORS headers are lost on thrown errors
`index.ts:111-137` mounts `hono/cors` as normal middleware, but `app.onError`
(`:437-476`) builds a fresh response after the chain has unwound by exception. Hono's
`cors` sets ACAO *after* `await next()`, so every 401/403/429 reaches the browser with no
ACAO header — the admin panel shows `TypeError: Failed to fetch` instead of the real
status. Note `index.ts:118` also defaults to `"*"` when `ALLOWED_ORIGINS` is unset
(production sets it correctly at `wrangler.toml:533`).

---

## Verified correct — don't re-audit

- **Prize ≤ pot holds end-to-end**: `assertPrizeFundedByPot` on create/patch, snapshot
  clamp at creation and activation, re-clamped in both resolvers, plus a defensive
  `rewardAmount = product ? 0 : …` in `lib/contestSettlement.ts:170`.
- **No float money**: `assertCoinAmount` rejects non-integers; fiat is integer paise.
  The `amount_paise` vs `coins` split is written and read consistently by all three
  writers — that confusion is genuinely fixed.
- **Withdrawals**: `requestWithdrawal` is a correct single-transaction escrow;
  reject-refund puts the UPDATE first gated on the refund row's absence; `paid` writes a
  deterministic zero-sum pair; `paid`/`rejected` are terminal with the CAS before all
  accounting.
- **`joinMatch`, `settleWinner`, `settleRefund`** — token-gated single batches with
  deterministic ledger ids.
- **Token verification** (`lib/firebaseAuth.ts`): no bypass, no alg confusion, no JWKS
  cache poisoning (constant KV key, TTL from the endpoint's own `max-age`). Gaps are
  defense-in-depth only: `algorithms: ["RS256"]` not pinned, no `clockTolerance`.
- **Admin gating**: `adminRoute.use("*")` is registered before every route;
  `requireFullAdmin` **throws**, so the ~65 call sites without `return` are correct; the
  shared-secret path is constant-time and correctly conditioned on a non-empty secret.
- **Chat authz**: `assertChatMember` on every chat read/write and on the `/ws` channel.
- **No string-concatenated SQL** anywhere in `routes/` or `lib/` — all parameterised.
- **Client**: home feed pagination (`reqIdRef`, id dedupe, cursor reset), vote/like/
  purchase/upload double-submit guards, and the `realtime.ts` WebSocket lifecycle
  (ref-counted channels, heartbeat cleanup, jittered backoff, guarded `JSON.parse`).

---

## Suggested order

1. Scope the idempotency purge (#1) — one-line `WHERE scope NOT IN (…)`, stops coins
   being minted.
2. Story IDOR (#5) — validate `storyIds` ownership on write, filter by story owner on read.
3. Move the deposit credit into one gated batch (#2) and add a stranded-deposit sweep.
4. `claimDailyTask` (#3) → copy the `claimAdReward` pattern beside it.
5. Release the claim on failed `adjustUserWallet` (#4).
6. `videoStatus` ownership filter (#6) — add `eq(videos.ownerUid, uid)`.
7. Clawback: `EXISTS payments` predicate + per-refund claim key (#7, #8).
8. Client: prize badge via `contestPrize()` (#9), notifications error state (#10),
   chat send failure (#11), `Math.max(…, 1)` on the eight limits (#12).
