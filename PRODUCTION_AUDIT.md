# Production Readiness Audit — TophuntDPcontest

Audit date: 2026-08-16 · Scope: `apps/worker`, `apps/expo`, `apps/admin-panel`, repo/infra.

Every finding below was read in the source and verified. Line numbers refer to the
commit at the time of the audit (`b023109`).

**Verification baseline (what actually passes today):**

- `apps/worker`: `npm run typecheck` → clean; `npm test` → 19/19 pass (`test/money.test.ts`).
- `apps/expo`: has **no** `typecheck` script. `apps/admin-panel`: no `lint`, no tests.
- `.github/` does not exist — nothing is gated automatically.

---

## Severity summary

| # | Severity | Area | Finding |
|---|---|---|---|
| 1 | 🔴 Critical | Worker auth | Unauthenticated `createProfile` trusts `body.uid` → overwrite any user's profile |
| 2 | 🔴 Critical | Worker chat | 4 chat endpoints have no membership check → read/inject/delete any DM |
| 3 | 🔴 Critical | CORS | `allowMethods` omits PATCH/DELETE → withdrawal & deposit approval broken in prod |
| 4 | 🔴 Critical | Money | Withdrawal handler has no status CAS → double refund + reject→approve free payout |
| 5 | 🔴 Critical | Money | `claimAdReward` cap lives only in KV and fails open; ad itself is a fake timer |
| 6 | 🔴 Critical | Expo | Password-reset screen is a `setTimeout` fake **and** crashes on mount |
| 7 | 🔴 Critical | Contest | Every home-feed vote sends the literal string `'device_id'` |
| 8 | 🔴 Critical | Store | `app.json` ships "instagram-dp" name/scheme/bundle id + no iOS permission strings |
| 9 | 🔴 Critical | Store | No account-deletion flow anywhere |
| 10 | 🟠 High | Worker authz | `PATCH /admin/users/:id` missing `requireFullAdmin` → moderator can disable any admin |
| 11 | 🟠 High | Worker authz | 21 admin routes lack the full-admin guard |
| 12 | 🟠 High | Infra | Runtime D1 auto-migrator: no lock, no transaction, fails open |
| 13 | 🟠 High | Infra | No staging environment at all — one D1/KV/R2/Firebase project |
| 14 | 🟠 High | Infra | No CI/CD; docs reference a workflow file that doesn't exist |
| 15 | 🟠 High | Money | Refunds/chargebacks silently ignored; no reconciliation for paid-but-uncredited orders |
| 16 | 🟠 High | Money | Balance mutation and ledger row are not atomic in several paths |
| 17 | 🟠 High | Expo | Social login uses `signInWithPopup` — non-functional on iOS/Android |
| 18 | 🟠 High | Expo | No request timeout, no 401 handling in the API layer |
| 19 | 🟠 High | Observability | `console.log` is the entire backend telemetry; no alerting; `/health` is a stub |
| 20 | 🟠 High | Auth | Password-reset proof is keyed by phone number only |
| 21 | 🟡 Medium | — | See "Medium" section (rate limiter, money as floats, no DB constraints, pagination, …) |

---

## 🔴 Critical

### 1. Unauthenticated `createProfile` trusts a client-supplied `uid`

`apps/worker/src/routes/auth.ts` — the `/auth` sub-app is mounted with `optionalAuth`,
which silently swallows a missing or invalid token:

```ts
case "createProfile": {
  const profileUid = uid || body.uid;   // ← body.uid when there is no token
  if (!profileUid) throw httpsError("unauthenticated", ...);
  await createUserProfile(env, profileUid, body, reward.signupBonus || 0);
```

`createUserProfile` ends in an `onConflictDoUpdate` on `users.uid`, so it **overwrites**
`email`, `username`, `fullName`, `profileImageUrl` and `signupCompleted` on an existing row.

Victim uids are freely available from the *also* unauthenticated `getUserByIdentifier`
action in the same file, and from `/read/users/search`, `/read/comments` and
`/read/leaderboard`.

**Impact:** any anonymous caller can deface or hijack the D1 identity of any account
(including username squatting), and mint unlimited fake profiles — each of which also
writes a `signup_bonus` ledger row.

**Fix:** put the authenticated `/auth` actions behind `requireAuth`, delete the
`|| body.uid` fallback, and split insert vs update instead of a blanket upsert.

### 2. Chat endpoints have no membership check (4× IDOR)

The correct membership check already exists twice in the codebase — `/read/chats` uses
`json_each`, and the `/ws` upgrade handler verifies membership before accepting — but it
was omitted from all four of these:

| Endpoint | File | Problem |
|---|---|---|
| `GET /read/chats/:id/messages` | `apps/worker/src/routes/read.ts` | `requireAuth` present, but the caller's uid is **never used** — dumps 200 messages of any chat |
| `sendMessage` | `apps/worker/src/routes/api.ts` | Inserts into any `chatId`, updates `lastMessage`, and fans out over the realtime DO + push |
| `deleteChat` | `apps/worker/src/routes/api.ts` | `DELETE FROM messages WHERE chat_id=?` then `DELETE FROM chats` — no soft delete, no audit |
| `markChatRead` | `apps/worker/src/routes/api.ts` | Marks other people's messages read in any chat |

**Impact:** any logged-in user can read every private conversation on the platform,
inject push-notified messages into strangers' chats, and permanently wipe all messaging.

**Fix:** one shared `assertChatMember(env, chatId, uid)` helper called in all four places.

### 3. CORS blocks every PATCH and DELETE the admin panel makes

`apps/worker/src/index.ts:73`

```ts
allowMethods: ["GET", "POST", "OPTIONS"],
```

The panel is genuinely cross-origin in production — confirmed, not assumed:

- `apps/admin-panel/vite.config.ts:10,22` bakes an **absolute** `VITE_API_URL`
  (`https://tophunt-api.weadown-in.workers.dev`) into the bundle.
- The Vite `proxy` block only exists for the dev server.
- `apps/admin-panel/public/_redirects` is `/*  /index.html  200` — a plain SPA fallback,
  **no** `/admin/* → worker` proxy rule.
- Deploy target is a separate host: `wrangler pages deploy … --project-name tophunt-admin-panel`.

`Content-Type: application/json` makes every mutation a non-simple request, so the browser
always preflights, the preflight advertises only `GET, POST, OPTIONS`, and the request is
aborted before it leaves. **21 panel operations are affected**, including:

- `actionWithdrawal` → `PATCH /admin/withdrawals/:id`
- `actionDeposit` → `PATCH /admin/deposits/:id`
- `setUserBlocked`, `updateUserProfile`, `setPostHidden`, `updateContest`, `updateBlog`,
  `updateTicket`, `updateCoinPackage`
- all 12 deletes (`deleteUser`, `deletePost`, `deleteStory`, `deleteComment`,
  `deleteMessage`, `deleteContest`, `deleteBlog`, …)

**Impact:** approving or rejecting withdrawals and deposits — the money-critical admin
paths — cannot be performed from the panel at all. It works in dev only because the Vite
proxy makes it same-origin, so no test would catch it. The failure surfaces as an opaque
`toast.error`, so it looks like a flaky backend.

**Fix:** `allowMethods: ["GET","POST","PATCH","PUT","DELETE","OPTIONS"]`.

### 4. Withdrawal admin action has no status CAS and no state machine

`apps/worker/src/routes/admin.ts` (`adminRoute.patch("/withdrawals/:id")`) does a plain
`SELECT`, branches on the **stale** `w.status`, mutates the balance, and only then writes
the new status in a **separate unconditional** `UPDATE … WHERE id = ?`.

Two concrete defects:

1. **Double refund (race).** Two concurrent `action:"reject"` calls on a `reserved`
   pending row both read `status='pending'`, both pass the guard, both run the refund
   batch. The user receives `+2 × amount` for one escrowed deduction, with two
   `withdrawal_refund` ledger rows.
2. **Illegal transition = free money (no race needed).** `reject` a reserved request
   (coins refunded, status `rejected`), then call `approve` or `paid` on the same id. The
   `reserved` branch only moves coins for `reject`, so the row flips to `approved`/`paid`
   while the user still holds the refunded coins — and the payout is then executed
   off-platform. The legacy (`reserved = false`) branch has the mirror bug.

`GET /admin/finance-trends` sums rows with status `approved|paid`, so these transitions
also inflate reported payouts with no offsetting ledger.

**Fix:** a single claim statement —
`UPDATE withdrawals SET status=? … WHERE id=? AND status IN (<legal predecessors>)` —
check `meta.changes === 1`, and only then move coins (ideally in the same `db.batch`).
`reject → approve` must be rejected outright.

### 5. `claimAdReward`: KV-only cap that fails open, behind a fake ad

Server — `apps/worker/src/routes/api.ts` (`case "claimAdReward"`):

```ts
try { used = Number((await env.CACHE_KV.get(capKey)) || 0); }
catch { /* KV blip — treat as 0 (fail-open on the counter …) */ }
if (used >= DAILY_CAP) throw …
```

- KV has no CAS and is eventually consistent → N concurrent requests all read `used = 0`
  and all credit. The `get → compare → put` is read-then-write.
- The `catch` treats **any** KV error as `used = 0`, so a KV outage removes the daily cap
  entirely while the D1 credit still commits.
- There is no D1-side per-day claim record (contrast `daily_task_claims`, which correctly
  dedups on a `(uid, task_id, day)` primary key), so the cap is unauditable after a KV flush.
- The only other brake is `rateLimit(env, 'ad:'+uid, 20, 60)`, which is itself a fail-open
  KV counter (see #21).

Client — `apps/expo/app/wallet/index.tsx:158`: `simulateWatchAd` is a 5-second
`setInterval` countdown with **no ad SDK installed at all**, then calls
`walletService.claimAdReward()` which credits real, withdrawable Dpcoins. The service file
itself documents that SSV should gate this before production.

**Impact:** a scripted client mints coins that convert to real cash via `requestWithdrawal`.

**Fix:** move the cap into D1 in the same `db.batch` as the credit, and gate the credit
behind AdMob Server-Side Verification (or remove the feature until then).

### 6. Password-reset screen is a fake, and crashes on mount

`apps/expo/app/auth/forgot-password/new-password/index.tsx`

```ts
const onSubmit = async (data: NewPasswordFormData) => {
  setIsLoading(true);
  // Simulate API call
  setTimeout(() => { setIsLoading(false); setShowSuccessModal(true); }, 1500);
};
```

No network call at all — `data` is unused. The user sees a success modal and is routed to
`/auth/login`, where their **old** password still applies.

The same file also cannot render. Line 40 calls `useColorScheme()`; line 75 declares
`const useColorScheme = () => …` in the same scope and it is never imported — so the call
hits the temporal dead zone:
`ReferenceError: Cannot access 'useColorScheme' before initialization`.

The sibling screen `app/auth/forgot-password/reset/index.tsx` **does** correctly call
`callApi('updatePasswordWithPhone', …)`, so this file is a stale duplicate — but
expo-router still exposes `/auth/forgot-password/new-password` as a routable,
deep-linkable screen.

**Fix:** delete the directory (or wire it to the real API).

### 7. Every home-feed vote sends the literal string `'device_id'`

`apps/expo/src/components/home/PostCard.tsx:134`

```ts
await contestService.voteOnMatch(item.id, votedForUid, 'device_id');
```

`contestService.voteOnMatch` only falls back to the real `getDeviceId()` when the third
argument is falsy (`const did = deviceId || (await getDeviceId())`). `'device_id'` is
truthy, so the per-install UUID is bypassed on the **primary voting surface** and every
device on the platform reports the same id.

**Impact:** device-based duplicate-vote protection is either completely defeated or
inverted (only the first ever vote succeeds). Contest integrity is compromised — and this
is a paid-entry contest.

**Fix:** drop the third argument. (`src/lib/deviceId.ts` itself is a correct implementation.)

### 8. `app.json` still carries scaffolding identity, including a trademark

```json
"name": "instagram-dp",
"slug": "instagramdp-c67de8",
"scheme": "instagramdp",
"ios.bundleIdentifier": "com.bubun321uusorganization.instagramdpc67de8",
"android.package":      "com.bubun321uusorganization.instagramdpc67de8"
```

- "instagram" in the name, scheme and bundle id is Meta trademark infringement → rejection.
- Bundle id / package are **permanent** once published. This must be fixed before the
  first submission.
- The deep-link `scheme` is `instagramdp`, so every notification deep link and OAuth
  redirect URI is built on a name that cannot ship.

`infoPlist` contains only `ITSAppUsesNonExemptEncryption`, but the app actively requests:

| Permission | Requested at | Missing key |
|---|---|---|
| Location | `app/auth/signup/fill-profile/index.tsx` (`requestForegroundPermissionsAsync`) | `NSLocationWhenInUseUsageDescription` |
| Photo library | `fill-profile` (`launchImageLibraryAsync`) | `NSPhotoLibraryUsageDescription` |
| Camera / mic | story + video contest capture | `NSCameraUsageDescription`, `NSMicrophoneUsageDescription` |

`plugins` also omits `expo-image-picker`, `expo-location` and **`expo-notifications`** —
without the last one there is no APNs entitlement, so iOS push is silently dead. There is
no `android.permissions` block and no `googleServicesFile`.

**Impact:** on iOS the app hard-crashes the moment a permission with no usage string is
requested, and Apple auto-rejects binaries missing them.

### 9. No account-deletion flow

`grep -rn "deleteAccount|delete-account|deleteMyAccount"` across `apps/expo/app`,
`apps/expo/src` and `apps/worker/src` returns **zero** hits. `app/setting/index.tsx` has
no delete path.

**Impact:** guaranteed App Store rejection (Guideline 5.1.1(v), mandatory since June 2022)
and a Google Play data-deletion policy violation.

---

## 🟠 High

### 10 & 11. Admin authorization gaps

Good news first: **every** `/admin/*` route *is* behind the gate —
`adminRoute.use("*", …)` runs before all handlers, accepting either
`X-Admin-Secret === ADMIN_PROXY_SECRET` (→ `superadmin`) or a verified Firebase token
whose role resolves from a custom claim or the D1 `users.role` row. The second tier,
`requireFullAdmin(c)`, blocks moderators — but it is only called on 23 of the routes.

**#10 — `PATCH /admin/users/:id` is missing it.** The sibling
`DELETE /admin/users/:id` has the guard; the PATCH handler does not. It writes
`is_blocked`/`status` in D1 *and* calls `updateAuthUser(…, {disabled: true})`. So a
**moderator can disable the Firebase account of any user, including other admins and
superadmins** — full-platform lockout from the lowest-privileged role.

**#11 — 21 routes lack the guard.** Verified list (line numbers in
`apps/worker/src/routes/admin.ts`):

```
177  PATCH  /posts/:id                 190  PATCH  /stories/:id
244  DELETE /reports                   255  POST   /reports/:id/resolve
300  DELETE /support                   317  PATCH  /users/:id          ← #10
451  POST   /media/fetch-to-r2         493  POST   /blog/import
613  POST   /blog/import/progress      671  POST   /blog/import/retry
685  POST   /blog/import/discover      701  POST   /blog/import/finish
711  POST   /blog/import/fail          727  POST   /blog
763  PATCH  /blog/:id                  958  POST   /notifications/read
1011 POST   /notify                    1382 DELETE /comments/:id
1812 POST   /banned-words              1822 DELETE /banned-words/:word
1934 DELETE /messages/:id
```

`POST /notify` is the notable one — arbitrary push notification with attacker-chosen title
and body to any `userId`, i.e. a phishing vector at scale. Deleting reports and support
tickets destroys the abuse-evidence trail.

Related, same area:

- **Privilege escalation.** `POST /admin/set-role` (and `setAdminRole` in `api.ts`) gate
  only on "is an admin", so any `admin` can mint another `admin`. A `superadmin` tier
  exists in the model but **nothing is superadmin-only**. `setCustomClaims` *replaces*
  the whole claims map rather than merging it.
- **`isAdmin()` and `resolveAdminRole()` disagree.** `middleware/auth.ts` accepts only
  `role === "admin"` exactly, while the admin gate accepts `superadmin|admin|moderator`.
  So a `superadmin` passes every `/admin/*` route but is **denied** every `/api` admin
  action. Two divergent authorization predicates over one column.
- **`/api` admin actions bypass the audit trail.** `logAudit()` is only wired into
  `routes/admin.ts`. The equivalents in `routes/api.ts` — `setAdminRole`,
  `adminManageWallet`, `adminDeletePost`, `unblockUser`, `sendBroadcastNotification` —
  write no audit record, so an attacker with an admin token acts invisibly by using `/api`.
- **Shared secret is unattributable.** `logAudit` records `adminEmail: "server"` with
  `adminUid: null` for secret-authenticated calls, so money movements made with the secret
  are not traceable to a human. The secret has no IP allowlist, no rate limit, no expiry,
  and `scripts/archive-import/IMPORT_STATUS.md` documents that it "was given in chat" —
  treat it as compromised and rotate.

### 12. Runtime D1 auto-migrator has no lock and fails open

`apps/worker/src/db/autoMigrate.ts` + `src/index.ts` (global middleware on every request).

- **No distributed lock.** `let migrationPromise` is module-global = **per isolate**.
  Cloudflare runs isolates in every colo, so after a deploy that adds a migration, N
  isolates race `runMigrations` simultaneously. There is no `BEGIN IMMEDIATE` and no
  insert-first claim. The only thing that saves it is `isIgnorable()` swallowing
  `/duplicate column name|already exists/i` — i.e. correctness depends on every statement
  failing with one of exactly two error strings when re-run. `INSERT INTO settings …`,
  `UPDATE`, `ALTER TABLE … RENAME` and `DROP` are **not** covered and will double-apply
  or hard-fail. There are 11 migrations today.
- **No transaction.** Statements are split naively on `;` and run one at a time via
  `db.prepare(stmt).run()` — no `db.batch()`. If statement 5 of 9 throws, statements 1–4
  stay applied and the `INSERT INTO d1_migrations` is never reached. The DB is now neither
  the old nor the new schema, while `d1_migrations` claims the migration was never
  applied — so the next isolate replays it, steps 1–4 now throw "already exists" and get
  silently skipped, **masking the real failure forever**. There are no `down` migrations.
- **Failure is swallowed.** `index.ts` wraps `ensureMigrated` in `try/catch` and only
  `console.error`s ("continuing"). Traffic is then served against a broken schema,
  producing 500s that look like ordinary app bugs. `/health` still returns `{ok:true}`.
  And because the promise is reset on failure, a persistently-failing migration is retried
  on **every single request**.
- **Unsafe statement splitting.** `splitStatements` strips everything after the first `--`
  on each line and splits on every `;`, with no string-literal or `BEGIN…END` awareness.
  Any migration with `--` or `;` inside a quoted value, or a trigger body, is silently
  corrupted — so the runtime path and `wrangler d1 migrations apply` can behave
  differently on the same file.
- **Cold-start cost.** It sits in front of every route including `/media/*`, adding 2 D1
  round-trips to the first request in each new isolate, globally.

**Fix:** make `npm run migrate` the only migration path, gate it in CI before
`wrangler deploy`, and reduce the runtime migrator to a read-only drift check that alerts
when `d1_migrations` is behind `MIGRATIONS`.

### 13. No staging environment

- `apps/worker/wrangler.toml` has **zero `[env.*]` sections** — one `name`, one D1
  (`932ccd0f-…`), one R2 (`tophunt-media`), one pair of KV namespaces, one set of crons.
  `wrangler deploy` from any machine overwrites production. `npm run migrate` defaults to
  `--remote`.
- One Firebase project everywhere: `FIREBASE_PROJECT_ID = "tophuntdpcontest"` in
  `wrangler.toml` == `apps/admin-panel/.env.production`. Dev/test users, admin role grants
  and production users share one auth tenant.
- `apps/expo/eas.json` sets the **identical** `EXPO_PUBLIC_API_URL` for `preview` and
  `production`, and the `development` profile sets no `env` at all so it falls back to the
  hardcoded production URL in `src/services/api.ts`. **Internal test builds write to
  production D1 and R2** — a test withdrawal is a real payout request.
- `apps/admin-panel/vite.config.ts` hard-defaults to the production Worker when
  `VITE_API_URL` is unset, so a misconfigured build silently ships pointing at prod.

**Impact:** there is no safe place to test a migration, a payout, or a broadcast. Every
mistake is a production mistake — and #12's migration risks are exercised for the first
time in production, every time.

### 14. No CI/CD

`.github/` does not exist (verified). Yet `PRODUCTION_DOMAINS.md:77` tells you to edit
`.github/workflows/web-production.yml` line 44 — **the file it references is not in the
repo.** Deploys are manual `wrangler deploy` / `npm run deploy` from a laptop.

Per-app script coverage:

| app | typecheck | lint | test |
|---|---|---|---|
| `apps/worker` | ✅ (+ `pretypecheck` regen) | ❌ | ✅ 1 file, 19 tests |
| `apps/admin-panel` | ✅ | ❌ | ❌ none |
| `apps/expo` | ❌ **none** | ✅ `expo lint` | ✅ 5 files |
| root | ❌ | ⚠️ no-op `echo` that exits 0 | ❌ |

Nothing runs any of it automatically. A type error, a broken migration, or the #3 CORS
regression reaches production unchallenged.

### 15. Refunds/chargebacks ignored; no reconciliation

The Razorpay integration is otherwise **well built** — see "What's already correct" below.
The gaps are on the edges:

- `routes/webhook.ts` acts only on `payment.captured` and `order.paid`. Everything else —
  `payment.failed`, `refund.created`, `payment.refunded`, disputes — hits an unconditional
  `return c.json({ ok: true })`. There is **no debit path anywhere** for a reversed
  payment. Attack: buy coins → `requestWithdrawal` (paid out in cash) → raise a bank
  chargeback.
- `creditPaymentOrder`'s CAS is `ne(status, 'paid')`. If you later add a `refunded` status,
  the order becomes **re-creditable** — it must be `eq(status, 'created')`.
- `payment_orders.status` supports `created | paid | failed` but **nothing ever writes
  `failed`**, and there is no sweeper cron. If `RAZORPAY_WEBHOOK_SECRET` is unset the
  webhook returns 503; once Razorpay's retry window expires and if the client never
  returns (app killed), the money is captured at the gateway and the user is **never
  credited**, with no alert and no queue to drain.
- The legacy KV top-up fallback in `api.ts` is still live: `amount_mismatch` is not mapped
  as a hard error, so it falls through to a weaker path that credits from the 1-hour
  `rzp_order:*` KV blob and bypasses `payment_orders` entirely.
- `payments` has no `order_id` column, so gateway payments cannot be joined to
  `payment_orders` for reconciliation, and manual deposits inject synthetic `dep_${id}`
  rows into the same table.

### 16. Balance mutation and ledger row are not atomic

D1 has no interactive transactions, and the codebase's stated strategy — conditional
`UPDATE` + check `meta.changes`, grouped with `db.batch()` — is applied correctly in most
places. These are the exceptions:

- `joinMatch` (`api.ts`): fee deducted, slot claimed, then the `contest_entry_fee` ledger
  row inserted as a **separate** statement. Worse, the "someone else took the slot" refund
  writes **no ledger row at all** — a balance credit with zero audit trail.
- `claimDailyReward`: balance CAS and ledger insert are separate round trips.
- Withdrawal reject: refund commits, status write is separate — a crash in between leaves
  a refunded-but-still-`pending` row that #4 lets you refund again.
- Deposit approve: status flips to `approved` **first**, then the credit+ledger batch runs.
  A failure in the batch leaves an approved-but-uncredited deposit — and the "UTR already
  credited" guard then blocks any corrective re-approval.
- `cron.ts` tie refund: credits **both** participants with **no `coin_transactions` rows
  whatsoever**. This is the clearest reconciliation breaker — `SUM(coin_transactions)` vs
  `SUM(users.dpcoin)`, both computed on the admin finance page, can never balance again
  once a single match ties.

Also in this area:

- **`POST /admin/users/:id/wallet` logs the wrong amount.** Balance is updated with
  `MAX(dpcoin + delta, 0)` — clamped — but the ledger row records the **full requested
  `delta`**. Subtract 500 from a user holding 100 → balance 0, ledger −500. The equivalent
  in `api.ts` was already fixed to log the clamped value; the REST route was not. Two
  divergent implementations of "admin adjust wallet" is itself the defect.
- **`adminManageWallet` (`api.ts`) is a read-then-write absolute overwrite.** It `SELECT`s
  the balance, computes `newBal` in JS, and writes `dpcoin: newBal` with no guard. Every
  other write in the codebase is relative SQL. Any concurrent credit — a webhook top-up, a
  contest payout, a second admin — is silently erased.
- **Prize payouts are unbounded by the collected pot.** `rewardAmount = contest.rewardCoins`
  with no cap and no house/float account, so a mistyped `rewardCoins` mints unbacked coins
  that are withdrawable for cash.

### 17. Social login is web-only

`apps/expo/src/services/auth/socialAuth.ts` imports and calls `signInWithPopup` — a
web-only Firebase JS API. There is no browser `window.open` in React Native, so
Google/Facebook/Apple login throws `auth/operation-not-supported-in-this-environment` on
native. No `expo-auth-session`, `@react-native-google-signin`, or
`expo-apple-authentication` anywhere.

All three social buttons are broken on the shipping platforms. Note that offering any
third-party login makes **Apple Sign-In mandatory** (App Store 4.8).

### 18. Expo API layer: no timeout, no 401 handling

`apps/expo/src/services/api.ts`

- Both `readApi` and `callApi` use bare `fetch` with no `AbortController` /
  `AbortSignal.timeout`. On a captive-portal or half-open mobile connection the request
  hangs indefinitely — and every screen that sets `setLoading(true)` before the call
  (`wallet/withdraw`, `wallet/deposit`, `auth/login/password`) stays stuck forever with the
  submit button disabled.
- The token attach is wrapped in `try { … } catch { /* proceed without token */ }`, so if
  `getIdToken()` fails (revoked refresh token, disabled account) the request is sent
  **unauthenticated** and returns a generic "Request failed". There is no interceptor that
  reacts to a 401 by calling `getIdToken(true)` and retrying once, nor one that signs the
  user out on a revoked token. Users of a banned account get an app that looks logged in
  but fails every request silently. (Routine expiry *is* handled — the Firebase SDK
  refreshes inside `getIdToken()`.)
- `readApi` **throws** on non-2xx, which makes the "create a default profile" fallback in
  `src/hooks/useProfileData.ts` unreachable dead code. A user authenticated in Firebase
  but with no D1 row gets a permanently failing `['profile', uid]` query, so wallet
  balance and stats render as 0 forever instead of self-healing.

Related client-side gap: **no crash reporting is wired.** `src/lib/reportError.ts` only
`console.error`s. It is plumbed correctly into `QueryCache.onError`, `MutationCache.onError`
and the global `ErrorBoundary` — nothing leaves the device. Do this first, so everything
else in this document becomes observable.

### 19. Observability: `console.log` is the whole pipeline

What exists is better than typical: a per-request middleware emits one structured JSON
line with `{level, requestId, method, path, status, ms}`, sets a `crypto.randomUUID()`
request id plus `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`/`CORP`
headers, and `app.onError` returns the `requestId` to the client for correlation.

The gaps:

- `wrangler.toml` has **no `[observability]` block, no `tail_consumers`, no Logpush**. So
  retention is the live `wrangler tail` stream plus a short invocation-log window — after
  the fact you cannot answer "what 500'd last Tuesday". Error tracking exists on the
  mobile client but not in the backend.
- **No alerting on anything**: not the auto-migration failure, not the audit-write failure,
  not error-rate spikes, not D1 write failures, not cron failures. In particular
  `ctx.waitUntil(monthlyHallOfFame(env))` and `ctx.waitUntil(resolveContests(env))` have
  **no `.catch()`** — and contest resolution is the payout trigger, so a silent cron
  failure means users are not paid, with zero signal.
- **`/health` is a liveness stub** — `c.json({ ok: true, ts: Date.now() })`. It does not
  touch D1, KV, R2 or the DOs, and does not report migration state. Any uptime monitor
  pointed at it reports green through a total data-layer outage.
- **Analytics silently sample.** The dashboard's device-split and growth charts take
  `.limit(1000)` of `users` and compute from that subset, so the numbers become wrong once
  you exceed 1000 users.
- **Backups are documented, not configured.** `wrangler.toml` comments describe D1 Time
  Travel and recommend a weekly `d1 export` to R2 — the crons are contest resolution and
  hall-of-fame only, and no such script or workflow exists. Time Travel (a platform
  default, 30-day PITR) is the entire strategy. **R2 has no backup at all**: no
  versioning, no lifecycle rule, no replication — all user media is single-copy. The
  `VoteCounter` DO also holds un-flushed vote counts that nothing snapshots.

### 20. Password-reset proof is keyed by phone number only

`apps/worker/src/routes/auth.ts` — `verifyOtp` writes
`OTP_KV["pwverified:<phone>"] = "1"` with a 10-minute TTL, and
`updatePasswordWithPhone` accepts **any unauthenticated caller** who knows the phone
number while that flag exists. No nonce or reset token is returned to the client and
correlated back.

This is already a hardening pass over an earlier version (the code comments document the
previous, worse bug), and the OTP primitives themselves are good — `crypto.getRandomValues`,
constant-time compare, single-use burn, 5-attempt cap, 10-minute TTL, never echoed in a
response. Two residual gaps:

1. **Race within the window.** An attacker who knows the victim's phone (obtainable from
   the unauthenticated `getUserByIdentifier`) polls `updatePasswordWithPhone`. The moment
   the victim legitimately completes their own OTP, the attacker's next poll lands inside
   the 10-minute window and sets the victim's password.
2. **Zero rate limiting on `/auth`.** `grep rateLimit` returns no hits in the file. So:
   - **SMS toll fraud** — loop `sendOtpToPhone` with arbitrary international numbers for
     unbounded Twilio spend. (`sendPhoneOtp` also sends to `body.newPhone`
     **unnormalized and unvalidated**, unlike everywhere else.)
   - **The attempt counter resets.** Each `sendOtpToPhone` calls `setOtp(…, { otp })`,
     which overwrites the record **without `attempts`** — so the 5-attempt cap is
     per-issued-code, not per-phone. `for(;;){ resend; try 5 codes; }` gives unlimited
     guesses at a 10⁶ space. The counter is also a non-atomic read-modify-write on KV.
   - **Account enumeration** — `check` and `getUserByIdentifier` are both unauthenticated
     and unthrottled, and the latter returns `uid`, display name and avatar. This is the
     feeder for #1 and for both attacks above.

**Fix:** return an opaque single-use reset token from `verifyOtp` and require it in
`updatePasswordWithPhone`; rate-limit `/auth` per-phone, per-IP and per-action; keep the
attempt counter in a separate, longer-lived key.

Related: **phone numbers can be changed with no OTP and are not unique.** `COLUMN_KEYS`
in `updateProfile` includes `"phone"`, so a client can write `users.phone` directly,
bypassing the `sendPhoneOtp`/`verifyPhoneOtp` flow. The schema declares `phone: text()`
with only a non-unique index, and `updatePasswordWithPhone` resolves the target with
`.where(eq(users.phone, p)).get()` — an arbitrary row among duplicates. An attacker can
squat a number they don't control and permanently poison that number's reset path.

---

## 🟡 Medium

**Backend**

- **Rate limiter is fail-open, non-atomic, and barely deployed.** `lib/rateLimit.ts` is a
  KV fixed window doing `get → compare → put` with no CAS, swallowing all KV errors by
  design. A burst of N parallel requests all read the same `current` and all pass, so it is
  bypassed by firing in parallel instead of serially. It is the **sole** brake on
  `withdraw:` (5/hour), `deposit:` (5/hour) and `ad:` (20/min). Only 7 of ~60 mutating
  actions call it at all — unprotected: all of `/auth`, `/upload`, `createPost`,
  `createStory`, `addComment` (the *post* comment path; match comments *are* limited),
  `toggleFollow`, `startChat`, `sendMessage`, `startMatch`/`joinMatch`, `createReport`,
  `registerFcmToken`, `claimDailyTask`, and every `/read/*` endpoint. Move it to a Durable
  Object for atomicity.
- **All money is stored as SQLite `REAL` (floating point):** `users.dpcoin`,
  `coin_transactions.amount`, `payments.amount`, `withdrawals.amount`/`cash_amount`,
  `deposits.amount`, `coin_packages.*`. Only `amount_paise` is an INTEGER. Entry fees are
  halved in four places (`totalFee / 2`), so any odd fee yields `.5` balances and repeated
  add/subtract accumulates drift that makes exact ledger-vs-balance reconciliation
  impossible. Use integer coins and store cash as paise.
- **No database-level integrity constraints at all.** `dpcoin REAL DEFAULT 0` is
  **nullable**; there is no `CHECK (dpcoin >= 0)`, no `CHECK` on any status column
  (`withdrawals.status`, `deposits.status`, `payment_orders.status` are free text), no
  `UNIQUE` on `deposits.utr`, and no foreign keys to `users`. Non-negativity is purely the
  app's `WHERE dpcoin >= amt` guards. A `NULL` dpcoin would make `NULL + coins = NULL`,
  silently swallowing a paid top-up.
- **`deposits.utr` uniqueness is TOCTOU** — plain `SELECT` before `INSERT` at submit time
  and again at approve time. Two concurrent submissions with the same UTR both pass. The
  admin list even ships a "duplicateUtr" detector, which acknowledges that duplicates
  occur. Fix with `CREATE UNIQUE INDEX … ON deposits (lower(utr)) WHERE status <> 'rejected'`.
- **Webhook ignores currency, payment status and refund flags.** `creditPaymentOrder`
  compares only `capturedAmountPaise < order.amountPaise`; it never compares
  `payment.currency` against the `payment_orders.currency` column that exists for exactly
  this, never asserts `payment.status === 'captured'`, and never checks `amount_refunded`.
  A non-INR minor-unit amount numerically satisfies the paise check. The amount check is
  skipped entirely on the client-callback path.
- **`gamification.awardReward` is a loaded gun** — it increments `dpcoin` with **no ledger
  row** and no per-period guard. Currently dead code (imported, never called), but wiring
  `battle_vote` into `submitVote` would pay a coin per vote with no audit trail.
- **Upload: body fully buffered before the size check.** `const buf = await c.req.arrayBuffer()`
  then `if (buf.byteLength > MAX_BYTES)`. `Content-Length` is never inspected, so a 200 MB
  body OOMs the 128 MB isolate before the check fires. There is also no `rateLimit` in
  `upload.ts`, so one account can loop 80 MB uploads to inflate R2 costs.
- **`presignUpload` does not sanitize `folder`** (unlike `uploadToR2`, which strips
  `[^a-zA-Z0-9_-]`), and `getPresignedUrl` passes `body.folder` straight through. A client
  can inject arbitrary key prefixes, e.g. writing into the trusted `blog/imported`
  namespace. The random UUID filename caps this at namespace pollution rather than
  overwrite. Presigned PUTs are also valid for 3600 s — tighten to ~120 s.
- **`isPrivate` is never enforced on any read path** — `/read/users/:id`, `/posts`,
  `/followers`, `/following`, `/stories`, `/highlights` all use `optionalAuth` and never
  consult it. Private accounts are fully public via the API. Similarly
  `/read/users/:id/bookmarks` returns any user's bookmarks, and
  `/read/stories/:id/viewers` returns the viewer list with usernames for any story.
- **Wildcard CORS** (`ALLOWED_ORIGINS = "*"`). Not a classic CSRF escalation, since
  `origin: "*"` means Hono does not emit `Access-Control-Allow-Credentials` and the API is
  Bearer-authenticated with no cookies. But it removes a cheap defence-in-depth layer and
  lets any page enumerate the unauthenticated endpoints. Set it to the real origins.
- **Firebase ID token in the `/ws` query string** — lands in CF logs, proxy logs and
  browser history. Channel authz itself is correct. Use a short-lived single-use ticket.
- **`LIKE` patterns don't escape `%`/`_`** — parameterized, so not injection, but a search
  for `%` matches every user and forces a full scan.
- **Upstream Firebase error text is relayed verbatim** to clients (`WEAK_PASSWORD`,
  `INVALID_ID_TOKEN`, quota strings), giving an oracle for probing project state.
- **Token verification hardening:** no explicit `algorithms: ["RS256"]` allow-list (not
  exploitable today — `createLocalJWKSet` yields RSA keys so `alg: none`/`HS256` fail key
  matching), no `clockTolerance`, and no revocation/`disabled` check — so a user blocked
  via the admin panel keeps a valid token for up to an hour. JWKS is also never refetched
  on an unknown `kid`, so an early Google key rotation fails new tokens for the TTL.

**Admin panel**

- **Expired token force-logs-out with a wrong, alarming message.** `lib/http.ts` maps
  `permission-denied → 403`, and the admin gate throws `permission-denied` for *every*
  failure — missing token, **expired/malformed token**, and genuinely-not-an-admin. So the
  Worker **never returns 401 for `/admin/*`**, which makes the one-shot force-refresh retry
  in `lib/api.ts` (`if (res.status === 401)`) dead code, and `lib/auth.tsx` reacts to the
  403 by setting "This account does not have admin access." and calling `signOut`. A
  legitimate superadmin whose token expired is ejected and told they aren't an admin.
- **Wallet adjustment has no confirmation and no cap.** Every other destructive action
  uses `useConfirm` (60 call sites — genuinely good coverage), but the `WalletDialog`
  "Confirm" button fires `api.adjustWallet` immediately from a free-text
  `type="number"` input with only `disabled={!amount}` as a guard, and no reason field
  recorded in the audit log. A fat-fingered `100000` silently mints 100k coins.
- **Pagination exists on exactly one page.** `Users.tsx` does real offset/limit paging;
  everything else loads one server-capped page with no UI to reach page 2 — AuditLog,
  Comments, Withdrawals, Deposits, Transactions (hardcoded `limit: 300`), posts/stories
  (100), reports (100), support (100). The caps prevent an OOM, but the operational defect
  is **silent truncation**: at scale an admin cannot see or action withdrawals older than
  the newest few hundred rows, with no "showing N of M" indicator. `X-Next-Offset` is set
  by the Worker but **not in `exposeHeaders`**, so the panel couldn't read it anyway.
- **CSV export exports only the current page** (50 rows) with no warning.
- **`ErrorBoundary.tsx` exists but is never mounted** in `App.tsx`, so a render throw in
  any lazy page blanks the whole panel.
- **`isError` is dropped** on most pages, so a failed list renders the empty state — an
  admin cannot distinguish "no pending withdrawals" from "the API is down".
- **No role-aware routing.** `AdminUser` doesn't even carry `role`, so a moderator sees
  Withdrawals/Deposits/AppControl in the nav and the pages render, then every mutation
  fails with "requires full admin access".
- **Auth failure-opens** — on any non-403 error from the admin probe, `lib/auth.tsx` keeps
  the Firebase identity "so the UI renders", so a signed-in non-admin gets the full admin
  shell during a network hiccup. Cosmetic (the server enforces), but it discloses the
  entire admin feature map.
- **Logout doesn't clear the query cache** (`staleTime: 30_000`), so the previous admin's
  users/transactions/withdrawals are re-served to whoever logs in next in the same tab.
  There is also no idle or absolute session timeout on a panel that moves money.
- Good news: the panel **never** sends `X-Admin-Secret` from the browser — verified by
  grep across all of `src`. The only consumers are the Node CLI scripts. `.env.production`
  contains only the Firebase **web** config, which is a public identifier by design
  (confirm HTTP-referrer + API restrictions are set in GCP).

**Expo client**

- **No idempotency key on money mutations, and weak double-submit guards.**
  `handleClaimBonus` and `claimTask` have no in-flight guard (`claimedToday` isn't set
  until after the await), `simulateWatchAd` doesn't check `isWatchingAd` so repeated taps
  start N overlapping intervals, and `requestWithdrawal`/`requestDeposit` send no client
  token to dedupe on. `PostCard.handleVote` has no `isVoting` state.
  (`wallet/withdraw.tsx` and `wallet/deposit.tsx` **do** guard correctly — follow those.)
- **Timers not cleared → `setState` after unmount:** `PostCard`'s
  `setTimeout(() => setShowConfetti(false), 3000)` (FlatList recycles the row),
  `wallet/index.tsx`'s ad `interval` (navigating away mid-"ad" still fires `finishAd()`,
  crediting coins the user never sees), plus `notifications/index.tsx` and
  `messages/index.tsx`.
- **Reanimated callback can wedge double-tap-to-like.** `isHeartAnimating.current` is only
  reset when `finished === true`, so an interrupted animation (scroll, unmount, re-render)
  leaves it stuck `true` forever. `runOnJS(inlineArrow)()` inside a worklet callback is
  also the fragile form and can throw in release builds.
- **`live()` fires one interval per call.** WebSocket *connections* are correctly
  ref-counted per channel, but the 60s safety-net refetch is not — `PostCard` calls
  `live()` per card, so a 30-item feed means 30 intervals and 30 `/read/matches/:id`
  fetches per minute. `PostCard`'s effect also depends on the whole `user` object (never
  read inside), so every token refresh tears down and rebuilds every card's subscription.
- **`poll()` keeps rescheduling in the background.** It skips *fetching* while
  backgrounded but the `setTimeout` chain never stops, and there is no `AppState` listener
  to resume immediately on foreground — so a returning user waits up to `intervalMs`.
- **Errors swallowed into empty states**, masking outages as "no data": `useUserPosts` and
  `useUserBookmarks` return `[]` on error so `isError` is never true;
  `withdraw.tsx`'s `loadHistory` has `catch { /* ignore */ }`, so a user with pending
  payouts sees "No withdrawal requests yet".
- **Push notifications are quietly broken.** `registerForPushNotificationsAsync` is called
  fire-and-forget with **no `.catch()`** and `saveTokenToDatabase` has no try/catch → an
  unhandled rejection on every cold start where the Worker is unreachable, and the token is
  never registered with no retry. `vapidKey` falls back to the literal
  `"YOUR_VAPID_KEY_HERE"`. The handler still uses the deprecated
  `shouldShowAlert`/`shouldSetBadge` keys (SDK 52+ wants `shouldShowBanner`/`shouldShowList`),
  so foreground notifications won't display. And `firebase-messaging-sw.js` reads
  `payload.notification.title` unguarded, so any data-only payload throws in the SW.
- **Splash race: two competing navigation authorities.** `app/splash.tsx` registers its
  **own** `onAuthStateChanged` and calls `router.replace(…)`, while `app/_layout.tsx` runs
  a second guard off `useAuth()` that redirects `/home` whenever `segments[0] === 'splash'`.
  The splash listener awaits a `readApi` call, so `_layout` wins and pushes `/home` before
  the profile check resolves — a user with an incomplete profile lands on `/home` (which
  then renders against the failing profile query from #18). Splash's error path
  additionally does `router.replace('/home')` on **any** network failure. Consolidate to one
  guard.
- **Hardcoded client-side reward ladder** — `DAILY_REWARDS = [10,15,20,25,30,50,100]` is
  rendered *and* used to clamp `currentDay` before sending it to the server. If admin
  changes the ladder, the UI lies about what the user will earn.
- **Withdraw form validates against config that may not have loaded.** `useAppConfig()` is
  destructured without `loading`, so while config is in flight the form renders enabled
  with "Min 0 coins • Rate ₹1/coin" and a wrong cash preview. It also checks against a
  30s-stale cached balance, and after success only refetches the profile — nothing
  invalidates the wallet/transactions caches.
- **39 `console.log` calls left in shipping code**, none `__DEV__`-gated, including PII:
  `socialAuth` logs `user.email || user.uid`, `_layout.tsx` logs the full notification
  payload, `auth.ts` logs sign-out.
- **Unvalidated `as` casts on API responses** — `store.tsx` does
  `(await readApi('/read/coin-packages')) as CoinPackage[]`, so an error object makes
  `keyExtractor` throw. Zod is already a dependency; use it on the money endpoints.
- **Unbounded `ScrollView` + `.map()`** in `wallet/withdraw.tsx` (full server-length
  withdrawal history), `wallet/index.tsx`, `explore/index.tsx`.
  (`wallet/store.tsx` correctly uses `FlatList` — follow that.)
- **Location is requested silently on mount** in `fill-profile` (a `// SILENT LOCATION`
  effect with `catch (e) {}`), with no in-context justification before the OS prompt —
  an Apple rejection risk and a consent concern for storing precise coordinates at signup.
- **Notification deep links are unvalidated** — a server-supplied `data.url` goes straight
  into `router.push`. Whitelist the allowed prefixes.
- **`useAuth` has no error path** — `onAuthStateChanged` is called without the error
  callback, so an auth-init failure leaves `loading === true` forever and the whole app
  sits behind the `if (loading) return;` guards. It also calls `getAuth()` directly instead
  of importing the configured instance, which works only by import-order luck — a change
  would silently give an auth instance **without** AsyncStorage persistence, logging every
  user out on restart.
- **Version/runtime mismatch** — `app.json` pins `"version": "1.0.0"` while `eas.json` uses
  remote versioning with `autoIncrement`. `runtimeVersion.policy = "appVersion"` resolves
  against the local field, and `isUpdateRequired(config)` compares it to the admin's
  `minAppVersion` — so if `version` is never bumped, every OTA update shares one runtime
  version and the force-update gate can never trigger.

**Repo hygiene**

- **`functions.tar.gz` is committed: 18.7 MB at the repo root**, introduced in commit
  `d6c00bf` "All functions deployed". It is an archive of the **decommissioned** Firebase
  Functions backend that the Worker replaced, it is in git history permanently, and it is a
  potential secret-exposure vector — such bundles commonly contain `.env` or a
  service-account JSON, and the root `.gitignore` ignoring `functions/.env` suggests one
  existed. **Audit the contents for credentials, rotate anything found, then remove.**
- **Root `package.json` references a `functions/` directory that does not exist** — zero
  tracked files under `functions/` and no directory on disk. So `functions:serve`,
  `functions:build` and `functions:deploy` are guaranteed to fail, and the
  `firebase-tools ^13` devDependency exists solely for them.
- **Root `package.json` is a fake workspace root** — no `workspaces` field, so the app
  packages are unlinked and each has its own lockfile (5 total, with visible skew:
  `wrangler ^4.86.0` in the panel vs `^4.123.0` in the worker). Yet it declares a runtime
  dependency on `react-native-image-viewing` — a mobile UI library at the monorepo root.
  `lint` is a no-op `echo` that exits 0.
- **Root `tsconfig.json` is 3 lines and wrong for a monorepo** — `{"compilerOptions":{},"extends":"expo/tsconfig.base"}`,
  with no `include`/`exclude`, no `references`, no `strict`, extending an **Expo** base
  that is meaningless for the Worker and the Vite panel. It is not resolvable from
  `apps/worker`, which is why `wrangler.toml` had to add `tsconfig = "tsconfig.json"` to
  stop esbuild walking up. It still emits a warning on every worker test run:
  `Cannot find base config file "expo/tsconfig.base"`.
- **Root `README.md` is unmodified `create-expo-app` boilerplate**, starting with
  `> Edited for use in IDX on 07/09/12`. It documents neither the Worker, D1, the admin
  panel, nor how to deploy anything — and it actively suggests `npm run reset-project`,
  whose purpose is to **wipe the app directory**. Highest-value low-effort fix here.
- **IDX leftovers:** `.idx/dev.nix`'s `onCreate` hook runs
  `npm i react@latest react-dom@latest react-native@latest`, installing `@latest` over
  Expo's pinned versions — non-reproducible and directly at odds with `expo: ~54.0.28`.
- Stale files: `apps/expo/metro.config.js_backup`; `scripts/archive-import/` (a completed
  one-off that also references the superadmin secret in its `IMPORT_STATUS.md`);
  `apps/worker/scripts/migrate-firestore-to-d1.mjs` and `migrate-s3-to-r2.mjs` retained as
  live scripts that can still be pointed at production.
- `.env.example` says `tophuntdpcontest.appspot.com` while `.env.production` says
  `tophuntdpcontest.firebasestorage.app`, and the `firebase.ts` fallback hardcodes the
  **wrong** one. (`PRODUCTION_DOMAINS.md` already flags this.)

---

## What's already correct (don't re-fix)

Worth stating explicitly, because the money core is better built than the list above
suggests:

- **Razorpay signatures are correct.** Checkout: HMAC-SHA256 over `order_id|payment_id`
  with a constant-time compare, failing closed when the secret is missing. Webhook: the raw
  body is read **before** any parsing, HMAC'd with a separate `RAZORPAY_WEBHOOK_SECRET`,
  503 when unconfigured.
- **Pricing is server-authoritative.** Coins and price come from `coin_packages`; the
  client sends only a `packageId`. `amountPaise = Math.round(priceInr * 100)`.
- **Top-up double-credit is genuinely closed.** `UPDATE payment_orders SET status='paid'
  WHERE order_id=? AND status<>'paid'` + a `changes === 0` no-op, so webhook-vs-client
  cannot double-credit; `expectedFromUid` blocks cross-user theft; the `payments` PK insert
  blocks replay.
- **Entry-fee debits and withdrawal escrow are atomic** — single conditional
  `UPDATE … WHERE uid=? AND dpcoin >= amt` with a `changes` check. Balance cannot go
  negative on those paths.
- **`claimDailyReward`** uses a real CAS on `last_daily_claim`; **`claimDailyTask`** dedups
  on a `(uid, task_id, day)` primary key; **deposit approval** claims the pending row
  atomically; **match resolution and refunds** in `cron.ts` all claim the match status
  first.
- **No SQL injection.** `sql.raw` and interpolated `.prepare()` both return zero matches;
  every raw D1 query uses `.bind()`; drizzle `sql``` templates interpolate only column
  refs and JS numbers.
- **No live secrets committed.** Only placeholders, test fixtures, and the public Firebase
  **web** API key. `apps/worker/.gitignore` correctly excludes `.dev.vars`.
- **No mass-assignment.** `updateProfile`'s `COLUMN_KEYS` whitelist means `role`, `dpcoin`,
  `xp`, `verified` and `isBlocked` cannot be set by a client; unknown keys are diverted to
  an `extra` JSON blob that no authorization logic reads.
- **Ownership *is* enforced** on `deletePost`, `deleteStory` and `deleteComment`
  (`row.userId !== uid && !isAdmin`), and `/read/deposits|withdrawals|notifications|transactions`
  all filter by the token's uid. `submitVote` validates match status, expiry, self-vote and
  participant membership, and dedups inside the `VoteCounter` DO.
- **Identity comes from the token, not the body**, on every authenticated client mutation —
  `walletService.claimDailyBonus` even deliberately discards the uid it is passed.
- **The Expo client's money UX is right in principle:** no optimistic balance mutation
  anywhere; every money screen re-reads from the server.
- **React Query is configured thoughtfully** — `retry: 2` with capped exponential backoff,
  `mutations: { retry: 0 }` (correct for money), `onlineManager` wired to NetInfo and
  `focusManager` to `AppState`, centralized `QueryCache`/`MutationCache` error handling, a
  global `OfflineBanner`, and a full skeleton suite.
- **`realtime.ts` is a solid WebSocket layer** — per-channel ref-counted multiplexing,
  capped exponential-backoff reconnect, 25s heartbeat, token-gated connect, and correct
  teardown.
- **`deviceId.ts` is textbook** — persisted random UUID, non-hardware (store-compliant),
  graceful fallback. (It's just bypassed by #7.)
- **Maintenance and force-update screens exist and are gated** with `gestureEnabled: false`
  and correct priority ordering.
- Request logging with correlation ids and security headers; `logAudit` on the
  `/admin` surface; `X-Admin-Secret` never shipped to the browser.

---

## Suggested fix order

**Before any launch — data loss / theft / broken money:**

1. #1 `createProfile` client-uid — put authenticated `/auth` actions behind `requireAuth`.
2. #2 chat authorization — one `assertChatMember` helper, four call sites.
3. #3 CORS `allowMethods` — one line; withdrawal/deposit approval is broken right now.
4. #4 withdrawal status CAS + an explicit legal-transition table.
5. #5 move the ad-reward cap into D1; gate on AdMob SSV or remove the feature.
6. #7 delete the `'device_id'` literal.
7. #10/#11 add `requireFullAdmin` to `PATCH /admin/users/:id` and the other 20 routes;
   make `set-role` superadmin-only and merge claims instead of replacing them.
8. #20 bind the reset proof to a single-use token; rate-limit `/auth`.

**Before store submission:**

9. #8 rename app/slug/scheme/bundle id, add `infoPlist` usage strings and the missing
   plugins. Bundle ids are permanent — this must land before the first upload.
10. #9 account-deletion screen + Worker endpoint.
11. #6 delete the fake password-reset screen.
12. #17 replace `signInWithPopup` with `expo-auth-session` + `expo-apple-authentication`.

**Before real traffic:**

13. Crash reporting (3 lines per `reportError.ts`) — do this early so everything else is
    observable. Then #19: `[observability]`/Logpush, a real `/health`, `.catch()` on the
    cron `waitUntil`s, and alerting.
14. #12 move migrations to a CI step; reduce the runtime migrator to a drift check.
15. #14 add `.github/workflows` running typecheck + tests + migrations before deploy; add a
    `typecheck` script to `apps/expo`.
16. #13 create `[env.staging]` with its own D1/KV/R2, a separate Firebase project, and a
    distinct `EXPO_PUBLIC_API_URL` for the `preview` channel.
17. #15/#16 refund handling, a `payment_orders` reconciliation cron, fold every balance
    mutation and its ledger row into one `db.batch`, and unify the two admin-wallet
    implementations.
18. #18 `AbortSignal.timeout` + a 401 → force-refresh → retry-once → sign-out interceptor.
19. Integer money + `CHECK`/`UNIQUE` constraints in a new migration; move the rate limiter
    to a Durable Object; check `Content-Length` before buffering uploads.
20. Weekly `d1 export` to off-site storage and an R2 backup story; purge
    `functions.tar.gz` (audit for secrets first); rewrite the root `README.md`.
