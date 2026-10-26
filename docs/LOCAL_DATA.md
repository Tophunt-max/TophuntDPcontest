# On-device data: what is stored, where, and who owns it

This document covers the Expo app (`apps/expo`) on Android, iOS and web. For
server and CDN caching see [`CACHE_POLICY.md`](../CACHE_POLICY.md).

## 1. Source of truth

| Data | Authoritative copy | What the device may hold |
|---|---|---|
| Coin balance, ledger, payments, withdrawals | Server (D1) | Nothing durable. React Query holds the last response in memory only. |
| Votes, contest entry, eligibility, results | Server | Nothing durable. These actions are never queued offline. |
| Permissions, roles, block/mute, privacy | Server | Nothing durable. A block or mute clears the Home snapshot. |
| Stories bar (other people's Stories) | Server | The last server answer for the signed-in account (`stories`, `user_stories`). |
| Home feed first page | Server | One snapshot per (account, tab): at most 16 items, 200 KB, served only if under 12 h old (`feed_snapshots`). |
| Story views and reactions made offline | Server, once replayed | A queue of at most 200 rows, dropped after 7 days (`pending_actions`). |
| Likes, bookmarks, follows made offline | Server, once sent | The user's target state per (account, kind, target): at most 300 rows per account, dropped after 7 days or 8 failed sends (`outbox_ops`). |
| Media bytes | R2 / CDN | expo-image cache (no app-set size limit) and expo-video cache (256 MB, native only). |
| Session | Firebase Auth | Firebase's own persistence: AsyncStorage on native, IndexedDB on web. |

The local database holds caches and one replay-safe queue. It is never the only
copy of anything the server needs, so wiping it is always safe. The automatic
recovery in §5 depends on that, so keep it true. Never add a table holding data
that exists nowhere else without changing the recovery policy first.

## 2. Storage layers

| Layer | Native | Web | Used for |
|---|---|---|---|
| WatermelonDB `tophunt_stories` | SQLite (`@nozbe/watermelondb/adapters/sqlite`) | LokiJS in memory, saved to IndexedDB | The tables in §3 |
| AsyncStorage | App sandbox files | `localStorage` | Small flags and preferences (§4) |
| React Query | Memory only (no persister) | Memory only | Request state. Cleared when the uid changes. |
| expo-image / expo-video | Disk caches | Browser HTTP cache | Media bytes |

Screens never import the database. Only `src/services/stories/offlineStoryService.ts`,
`src/lib/feedSnapshot.ts` and the launch housekeeping in `app/_layout.tsx` use
it. Metro picks the adapter per platform: `src/database/adapter.ts` on native,
`adapter.web.ts` on web, and the same for `flush.ts` and `flush.web.ts`.

## 3. Tables (schema v6)

| Table | Rows | Bound | Scope |
|---|---|---|---|
| `stories`, `user_stories` | The last Stories-bar answer | Replaced in one transaction on every successful fetch. Expired rows are deleted 5 s after launch. | One account. The owner uid is in AsyncStorage `tophunt.storyCache.owner`. Reads return nothing for any other account, a guest, or a missing marker. |
| `feed_snapshots` | Home first page | 2 rows (one per tab). Other owners' rows are deleted on every write. | Row id `u:<uid>\|tab` or `guest\|tab`. |
| `pending_actions` | Offline Story `view` / `reaction` | 200 rows, oldest evicted first, dropped after 7 days, given up after 5 failed replays. A 4xx refusal drops the row at once; a network failure stops the replay without spending attempts. | Each row carries its `user_id`, and only that account replays it. Kept across sign-out on purpose. |
| `outbox_ops` (v6) | Offline like / bookmark / follow, as an explicit target state | 300 rows per account; one row per (account, kind, target), newest intent wins; 7 days; 8 sends with backoff, then `failed` | `account` column. Only that account sends or sees it. Kept across sign-out on purpose. |

**Never queued offline:** votes, coin spends, payments, contest entry, withdrawals, comments. The outbox accepts only the kinds listed in `src/sync/outbox.ts#HANDLERS`, and each sends a target state the server applies idempotently (`apps/worker/test/socialReplay.test.ts`).

**Never stored locally:** passwords, OTPs, ID or refresh tokens (other than
Firebase's own persistence), payment details, coin balances, chat messages,
notifications, `data:` URIs or media bytes.

### Changing the schema

1. Bump `version` in `src/database/schema.ts`.
2. Add a matching step in `src/database/migrations.ts`. Steps must be additive
   (`addColumns`, `createTable`). `test/helpers/localDb.ts#schemaAtVersion`
   rebuilds every old version by undoing those steps, and it throws on anything
   else.
3. Run `npm test`. `test/localDbSqlite.test.ts` and `test/localDbWeb.test.ts`
   build a database at every earlier version, then open it with the current app
   on real SQLite and real LokiJS/IndexedDB. `test/storySchemaMigrations.test.ts`
   checks that schema and migrations agree.

## 4. AsyncStorage keys

Account data, cleared or scoped on sign-out:

- `tophunt.cachedIdentity.<uid>`: name and avatar for cold-start UI. Removed on sign-out.
- `tophunt.storyCache.owner`: owner marker for the Story tables. Removed with them.
- `tophunt.explore.recentSearches`: cleared on sign-out.
- `signup-draft`: an unfinished email signup (no password; that stays in memory). Removed on completion or "Cancel signup", and discarded after 48 h. It is kept across app restarts on purpose so signup can resume.
- `remembered_email`: the "remember me" email. Kept by design.

Device data, not tied to an account: `tophunt.deviceId`, `tophunt.themePreference`,
`push::deviceToken`, `hasSeenOnboarding`, `app-config:last:v1`, `auth:methods:v1`,
`auth:lastMethod:v1`, `appControl:updateSnooze:v1`, `tophunt.announcementSnoozes`,
`tophunt.dismissedAnnouncementBanner`, `tophunt.pendingReferralCode`,
`tophunt:auth:pendingRedirect`, the tus upload resume URLs, and
`tophunt.localDb.lastResetAt` (§5).

## 5. Failure handling

| Failure | What happens | Where |
|---|---|---|
| Setup fails (corrupt file, failed migration, IndexedDB refused) | Recorded in `getDatabaseHealth()`, reported through `reportError` (`area: local-db`), then one `unsafeResetDatabase()` is attempted. Callers already catch, so the app falls back to the network meanwhile. | `src/database/health.ts` |
| Reset crash loop | A stamp `{at, done:false}` is written before the reset and set to `done:true` after it. The native JSI reset `abort()`s on a partial failure, so a stamp still at `done:false` means the last reset killed the app. It is then never retried on that install. Otherwise at most one reset per 24 h. | same |
| Database from a newer app version (rollback) | Both adapters rebuild it empty. | tested |
| Web: no IndexedDB | Loki runs in memory. The app works, and nothing survives a reload. | tested |
| Web: quota exceeded | Recorded and reported. Loki keeps working in memory. | `adapter.web.ts` |
| Web: IndexedDB deleted underneath the app | Recorded and reported. Reads keep the in-memory copy, and later saves are lost until reload. | tested |
| Web: two tabs | IndexedDB is last-writer-wins. Recorded as `overwritten-by-other-tab`. Acceptable for caches. | `adapter.web.ts` |
| Web: tab closed right after a write | Loki autosaves every 500 ms. The app also saves when the page is hidden (`visibilitychange`, `pagehide`) and after sign-out. A write followed by an immediate hard kill can still be lost. | `flush.web.ts`, tested |
| Account switch while a fetch is in flight | A generation counter drops the stale write, and the owner marker stops stale reads. | `offlineStoryService.ts` |

## 6. Platform status (2026-10-26)

| Item | Status | Evidence |
|---|---|---|
| Native module linked (iOS and Android) | **Verified.** `@nozbe/watermelondb` and `@nozbe/simdjson` are autolinked. | `expo-modules-autolinking react-native-config` for both platforms, and `expo prebuild` plus `pod install` resolution, which got as far as the step that needs `xcodebuild` |
| iOS JSI | Requested (`jsi: true`). Under the New Architecture the install goes through `RCTBridgeProxy.runtime`. **Not run on a device.** If JSI is unavailable, WatermelonDB falls back to the async bridge on its own. | `WMDatabaseBridge.m#initializeJSI` |
| Android JSI | **Not linked.** Autolinking only includes `native/android`; the JSI build lives in `native/android-jsi` and needs a config plugin. The app uses the asynchronous bridge (`jsi: false` on Android), which is what it already did, behind a warning. | `react-native.config.js` in the package |
| iOS pod install with simdjson | **Not verified.** WatermelonDB's docs ask for `pod 'simdjson', modular_headers: true`. The generated Podfile has no such line, and the check stops before CocoaPods analyses modules because Linux has no `xcodebuild`. | needs an EAS or macOS build |
| JS bundles | Android, iOS and web all bundle. The native bundles contain the SQLite bridge and no LokiJS adapter options. | `expo export -p android -p ios`, `npm run build` |
| Migrations v1 to v5 on real SQLite and LokiJS/IndexedDB | **Verified** by tests. | `test/localDbSqlite.test.ts`, `test/localDbWeb.test.ts` |

## 7. Open items

- Run a native EAS build (Android and iOS) and a launch on a device. Confirm a
  Story is cached, then shown offline after a restart. This needs EAS
  credentials.
- Decide whether to link Android JSI (an Expo config plugin for
  `native/android-jsi`). Only worth doing if profiling shows the bridge is a
  bottleneck. The current data set is a few hundred rows.
- Firebase stores its refresh token in AsyncStorage on native, which is not
  encrypted on Android. Moving it to the Keychain/Keystore needs a custom
  Firebase persistence backed by `expo-secure-store`.
