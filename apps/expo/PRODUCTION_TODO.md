# Production Readiness — Remaining Work

This document tracks what still needs to be done to take the Tophunt user app
to production. The **first section is already implemented** in code and only
needs configuration/credentials to go live. The later sections are separate
initiatives that need your accounts, product decisions, or larger engineering
effort.

---

## ✅ Implemented in code — needs config/credentials to activate

### 1. Coin purchases (Razorpay)
The full purchase flow is wired end-to-end:
- **Server (`apps/worker`)**
  - `createOrder` action — prices the order **server-side** from the
    `coin_packages` table (client can't dictate price/coins), creates a Razorpay
    order, and stashes the intent in `CACHE_KV` (`rzp_order:<id>`, 1h TTL).
  - `topup` action — verifies the Razorpay signature, then credits the coin
    amount **from the stored order record** (not from the client). Idempotent
    via the `payments` table; fails closed if the gateway isn't configured.
  - `GET /read/coin-packages` — public catalog of active packages.
- **Client (`apps/expo`)**
  - `walletService.createOrder()` / `walletService.confirmTopup()`
  - `src/services/wallet/razorpayCheckout.ts` → `purchasePackage()`
  - `app/wallet/store.tsx` — fetches real packages and runs the checkout.

**To activate:**
1. `cd apps/expo && npm install` (adds `react-native-razorpay`).
2. Set worker secrets: `wrangler secret put RAZORPAY_KEY_ID` and
   `RAZORPAY_KEY_SECRET`.
3. Seed at least one row in `coin_packages` (via the admin panel).
4. **Build a custom dev client or EAS/production build.** Razorpay is a native
   module and does **not** work in Expo Go.
5. Verify a full sandbox payment end-to-end before going live.

> ⚠️ App-store policy: selling in-app "coins" (digital goods) may require
> Apple/Google's own IAP instead of Razorpay. Confirm store policy before
> submission — this can force an alternate IAP integration on iOS/Android.

### 2. Crash reporting (Sentry)
- A central reporter exists at `src/lib/reportError.ts` and is already called by
  the global `ErrorBoundary` (`src/components/ErrorBoundary.tsx`).

**To activate:**
1. `npm i @sentry/react-native`
2. `Sentry.init({ dsn: process.env.EXPO_PUBLIC_SENTRY_DSN })` in `app/_layout.tsx`.
3. In `reportError.ts`, swap the console call for `Sentry.captureException`.
4. Set `EXPO_PUBLIC_SENTRY_DSN` per environment.

### 3. Environment configuration
- `src/services/api.ts` now warns (in dev) when `EXPO_PUBLIC_API_URL` is unset.
- Set `EXPO_PUBLIC_API_URL` (and any other `EXPO_PUBLIC_*`) per environment in
  `.env` / `eas.json`. Keep staging and production separate so dev builds never
  hit prod by accident.

---

## 🔴 Still needed before launch

### 4. Ad-reward crediting — PARTIALLY DONE
The "Watch Ad" flow now actually credits coins via the `claimAdReward` worker
action (fixed reward, per-UTC-day cap + rate limit, ledger entry). Remaining
hardening before real money value:
- ⚠️ It currently trusts the client that an ad was watched. Gate it behind the
  ad network's **Server-Side Verification** (AdMob SSV) callback so only a
  verified impression credits coins.
- Integrate the actual rewarded-ads SDK (e.g. `react-native-google-mobile-ads`)
  in place of the simulated timer.

### 5. Automated tests — STARTED
Done:
- **Worker** money-path suite (Vitest + a node:sqlite-backed D1 shim, since
  workerd can't run in all CI): `createOrder`/`topup`, `claimDailyReward`,
  `claimAdReward`, entry-fee deduction, `submitVote` validation. `npm test` in
  `apps/worker`.
- **Client** logic suite (Vitest, native modules mocked): `walletService`,
  `razorpayCheckout`, `getDeviceId`, `contestService.voteOnMatch`. `npm test`
  in `apps/expo`.

Still to add:
- Component/screen tests (jest-expo + React Native Testing Library) for auth,
  join-battle, and wallet screens.
- Full `submitVote` tally/dedup test (needs the VoteCounter Durable Object → run
  under `@cloudflare/vitest-pool-workers` in a workerd-capable CI).
- E2E smoke tests (Maestro/Detox) for the critical happy paths.

### 6. Daily-tasks progress (partially mock)
The wallet's "Daily Tasks" progress values are still hardcoded. Wire them to
real per-user progress (votes cast today, profile shared, etc.) or hide the
ones that aren't tracked yet.

---

## 🟠 Stability & scale

### 7. Realtime (infrastructure already exists — migrate the client)
The worker already has Durable Objects (`REALTIME`, `VOTE_COUNTER`) and a
`publish`/`voteCounter` layer, but the **client still polls every 5s**
(`poll()` in `src/services/api.ts`). Migrate hot paths (live voting, chat,
waiting-match) to a WebSocket/SSE connection backed by the existing DO, keeping
polling as a fallback. This cuts latency and request volume at scale.

### 8. Offline & error UX — DONE (baseline)
- React Query retries + refetches on reconnect, and `onlineManager` is now wired
  to NetInfo so queries pause offline and resume automatically.
- A global `OfflineBanner` overlays every screen when connectivity drops.
- Mutation errors surface a toast globally (via `QueryClient` `MutationCache`
  + the toast bridge); query errors are reported to the central reporter.
- Reusable `ErrorState` / `EmptyState` components exist
  (`src/components/ui/StateViews.tsx`).
- Remaining: adopt `ErrorState`/`EmptyState` on the rest of the screens as they
  are touched.

### 9. Auth hardening
- Token refresh + expired-session handling, force-logout, and a race-free
  profile bootstrap (`useProfileData` auto-creates a profile — verify no double
  creation under concurrent calls).

---

## 🟡 Polish, compliance & store

### 10. Performance
- Replace `ScrollView + .map()` lists with `FlatList`/`FlashList` where lists
  can grow (some explore/home sections). Tune image sizes/thumbnails via
  `expo-image` `cachePolicy`.

### 11. Content moderation & safety (UGC app)
- Photos/videos + comments need moderation: report/block flows, a review queue,
  and automated image scanning. The worker already has a `banned_words` table
  and `reports` table — wire them into the client and an admin review flow.

### 12. Accessibility & i18n
- Add `accessibilityLabel`s, dynamic font scaling, and sufficient contrast.
- The UI mixes Hindi/English — adopt a real i18n framework (i18next) instead of
  hardcoded strings.

### 13. App Store / Play Store readiness
- `app.json`: final bundle IDs, version/build numbers, permission usage strings
  (camera, photos, **location** — `expo-location` is used), icons, splash,
  deep-link scheme.
- Link the existing legal pages (`app/legal/*`) in the store listing.
- Account-deletion / data-export flow (GDPR + store requirement).

### 14. Data & DR
- Automate a weekly `wrangler d1 export` to off-site storage (R2) in addition to
  D1 Time Travel.

---

## Note on CI/CD
Intentionally excluded from this pass per request. When ready, add GitHub
Actions to run `tsc --noEmit` + `eslint` on PRs and `wrangler deploy` +
EAS build on merges to `main`.
