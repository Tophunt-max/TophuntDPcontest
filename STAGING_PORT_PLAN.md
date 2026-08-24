# `staging` → `main` port plan

**Date:** 2026-08-24
**Status:** proposal — nothing ported yet

## Why this is a port and not a merge

`staging` branched at `65144b0` (2026-01-08) and has not seen `main` since. In
between, `main` migrated the entire backend off Firebase onto Cloudflare
(`7245cc2`, then `2f99565` "remove ALL remaining Firebase backend usage").

| | `main` | `staging` |
|---|---|---|
| Backend | `apps/worker` — Workers + D1 + R2 + KV + Durable Objects | `apps/functions` — Firebase Cloud Functions |
| Admin | `apps/admin-panel` — Vite + react-router | `apps/admin` — Next.js App Router |
| Firebase config | none | `firebase.json`, `firestore.rules`, `database.rules.json`, `firestore.indexes.json` |
| Chat backend | inside `apps/worker`, D1 `tophunt-db` | separate `apps/chat-worker`, D1 `bubun` |

`git merge origin/staging` would be **267 files, +20,280 / −11,937** and would:

- resurrect `apps/functions`, deleted on purpose in `2f99565`
- add a second admin app beside the current one
- restore the Firestore rules files
- **regress the messages screen** — `staging`'s `messages/index.tsx` is 178 lines,
  `main`'s is 633

So each feature is ported onto the current architecture instead.

## Ranked plan

Ordered by value-per-risk. Each row is one PR.

| # | Feature | Port | Effort | Risk |
|---|---|---|---|---|
| 1 | `WinnerResultSheet` | lift & shift | S | Low |
| 2 | Chat delivery receipts + unread + presence (server) | build on `main` | M | Low |
| 3 | Chat UI components | adapt | M | Medium |
| 4 | `video-feed` screen | lift & shift | S | Medium |
| 5 | `VotersSheet` | rewrite data layer | M | Medium |
| 6 | Voice/video calling | build on `main` | **L** | **High** |
| 7 | Admin monitoring + prizes pages | rewrite | L | Medium |
| 8 | Signup fixes | investigate first | S | Low |

### 1. `WinnerResultSheet` — 170 lines

Only dependencies are `expo-image`, `react-native-paper` `Portal`,
`react-native-reanimated`, `expo-linear-gradient` and `@/assets/svgs` — all
present in `main`. No backend coupling. `main` has no equivalent.

Straight copy plus a wiring point on the contest result screen.

### 2. Chat receipts, unread count and presence — server side

Do this **before** the chat UI, because the UI expects these fields.

`main`'s conversation list already renders `item.unreadCount` and
`otherUser.isOnline` (`app/messages/index.tsx:228,229`) but **the server never
sends either** — `/read/chats` (`read.ts:1222`) doesn't project them. The badge
and the green dot are dead pixels today. `/read/chats/:id/messages` likewise
drops `read`, so `received:` in the thread view is always false.

`staging`'s schema has what's missing:

```sql
type    TEXT NOT NULL,           -- text | image | voice_note | video_call | voice_call
status  TEXT DEFAULT 'sent',     -- sent | delivered | seen
delivered_at INTEGER,
seen_at      INTEGER
```

Work: one D1 migration adding `type`, `status`, `delivered_at`, `seen_at`,
`media_url`, `duration` to `messages`; extend `sendMessage` (which today hard
-rejects a missing `text`); project `unread_count` in `/read/chats`; add presence.

Presence needs a home — `RealtimeHub` uses the hibernation API, so a
connect/disconnect broadcast belongs in `webSocketClose` plus a KV or DO-storage
last-seen stamp.

### 3. Chat UI — 12 components, ~1,015 lines

| Component | Lines | | Component | Lines |
|---|---|---|---|---|
| `ChatInput` | 173 | | `MessagesHeader` | 58 |
| `MessageOptionsPopup` | 147 | | `RecentlyItem` | 38 |
| `ChatItem` | 93 | | `EmptyMessages` | 32 |
| `ChatOptionsPopup` | 96 | | `RecordingWaveform` | 46 |
| `ChatSearchBar` | 88 | | `AudioPlayer` | 81 |
| `MessageSkeleton` | 86 | | `SearchBar` | 66 |

Good news: `ChatInput` and `ChatItem` have **no backend imports** — they are
presentational. `main` currently inlines all bubble and toolbar styling inside
`app/messages/chat/[id].tsx` via `react-native-gifted-chat`, and
`src/components/messages/` holds only `MessageSkeleton`.

Two decisions to make:

- **Keep GiftedChat or drop it?** `staging`'s components are a bespoke chat UI.
  Running both is the worst outcome. Recommend dropping GiftedChat, since
  `staging`'s components support voice notes and images and GiftedChat is being
  fought with already (`renderInputToolbar` reaches into
  `(GiftedChat as any).InputToolbar` and wires a mic icon to `onSend`).
- **Where do adapters live?** `messageService.ts` is 16 lines with one function
  (`startChat`); every other chat call is inline in the screens. Fatten it into
  the real service layer for `sendMessage`, `markChatRead`, `deleteChat`,
  history and the `live()` subscriptions.

`AudioPlayer` + `RecordingWaveform` need voice notes, so they depend on item 2's
migration plus an R2 upload path and `expo-audio` (declared in `main`'s
`package.json` but imported nowhere).

⚠️ `staging` ships `assets/svgs/message/Back_Arrow.svg`. Drop it — `main` now has
one back arrow (`left_arrow.svg` via `ArrowIcon`/`BackButton`) and
`npm run check:icons` fails the build on a second one.

### 4. `video-feed` screen — 97 lines

Imports are all `main`-compatible (`safe-area-context`, `useThemeColor`,
`BottomNav`, `Colors`). Risk is the data source, which needs checking against
`main`'s current contest/video endpoints — `main` has since built the Bunny
Stream pipeline, so the video URLs will differ.

### 5. `VotersSheet` — 212 lines

The UI is fine but the data layer is **Firestore**:

```ts
import { firestore } from '@/src/services/firebase/initFirebase';
import { collection, query, where, getDocs, doc, getDoc } from 'firebase/firestore';
```

Needs a new worker read endpoint (votes joined to users, paginated) and a
rewrite of the fetch half. UI, animation and `getOptimizedMediaUrl` all carry
over.

### 6. Voice/video calling — ~719 lines, the risky one

`CallOverlay.native.tsx` (205) + `CallOverlay.web.tsx` (434) +
`callService.ts` (80). This is real WebRTC: `RTCPeerConnection`, ICE
candidates, `mediaDevices`, `RTCView`, mute, speaker, call timer.

`main` has **zero** calling code and none of the dependencies. Required:

| Need | Detail |
|---|---|
| Native deps | `react-native-webrtc@^124` + its Expo config plugin, `expo-av` |
| Build impact | **Expo Go stops working** — needs a dev client and an EAS rebuild |
| Signalling | `RealtimeHub.webSocketMessage` answers **only `"ping"`** today. Needs a client→server relay in the DO, or `POST /api {action:"callSignal"}` reusing `publish`/`publishMany` |
| Channel auth | extend `index.ts:224` for a `call:` channel kind |
| TURN/STUN | `callService.getIceServers()` needs a real credential source via `wrangler secret put`. STUN alone fails behind symmetric NAT |
| Assets | ringtone/dial tone are **hotlinked from mixkit.co and soundjay.com** — must be self-hosted before shipping |
| Call log | no `calls` table in D1 |

`staging`'s own signalling client (`realtimeService.ts`, 87 lines) should **not**
come across — see the rejected list below. Reuse `main`'s `subscribeChannel`
from `src/services/realtime.ts` and add the missing client→server publish path.

Hook point already exists: the dead `Ionicons name="call"` button in
`components/chat/ChatHeader.tsx:21`.

Recommend splitting: (6a) signalling transport + `calls` table, (6b) audio
calls, (6c) video calls. Do not attempt this as one PR.

### 7. Admin monitoring + prizes — 354 lines + `r2-upload.ts` (53)

`apps/admin/src/app/contests/monitoring/page.tsx` (167) and
`.../prizes/page.tsx` (187) are **Next.js App Router** pages. `main`'s
`admin-panel` is Vite + react-router, so routing, data fetching and layout all
need rewriting; only the table/form markup survives.

`r2-upload.ts` is probably already superseded — `main` has an R2 + Bunny Stream
pipeline (`MEDIA_MIGRATION_PLAN.md`). Check before porting.

### 8. Signup fixes — commit `a4544cf`

Touches 8 files, but 2 are `apps/functions/src/auth/authHandler.ts` and
`toggleFollow.ts` — dead in `main`. The remaining 6 are Expo-side
(`_layout.tsx`, `splash.tsx`, signup screens, `api.ts`).

`main` has since landed `fix/auth-hardening` (PR #15) and carries
`AUTH_PRODUCTION_CHECKLIST.md`, so these bugs are **probably already fixed
differently**. Verify the three symptoms reproduce on `main` before porting
anything; expect to drop this item.

## Do not port

### `apps/chat-worker` (168 lines) — rewrite the ideas, discard the code

The features are worth having. The implementation is not shippable:

| Problem | Detail |
|---|---|
| Committed secret | `const BRIDGE_KEY = "your-secure-shared-key"` |
| **No authentication** | `/chats?userId=X` trusts the query param — any caller reads any inbox |
| **No WebSocket auth** | `userId` comes from the query string with no Firebase token, so any client can join any room as anyone |
| Open CORS | `Access-Control-Allow-Origin: "*"` on every response |
| Fragile query | `participants LIKE '%uid%'` — substring match against JSON |
| Dead dependency | posts to `…cloudfunctions.net/sendChatNotificationBridge`, which lived in the deleted `apps/functions` |
| Wrong database | D1 `bubun` (`804e1640…`), not `main`'s `tophunt-db` (`932ccd0f…`) |
| No rate limiting | `main`'s `sendMessage` has `rateLimit(env, msg:<uid>, 60, 60)` |
| Block logic bug | `Object.values(blocked).some(v => v === true)` mutes **both** parties if **either** has blocked, and drops the message silently with no error to the sender |
| No hibernation | `ws.accept()` + an in-memory `sessions` Map — billed while idle and every session is lost when the DO is evicted. `main`'s `RealtimeHub` uses `state.acceptWebSocket` |

`main`'s worker already has auth on every route, rate limiting, per-channel
authorization, socket revocation on block, and hibernating WebSockets. Extend it
(item 2) rather than standing up a second, unauthenticated chat backend.

### `realtimeService.ts` (87 lines)

`main`'s `src/services/realtime.ts` (209 lines) is strictly better:

| | `staging` | `main` |
|---|---|---|
| Auth | `userId` query param, no token | Firebase ID token per connection |
| URL | hardcoded `wss://chat.tophunt.in` | derived from `API_BASE_URL` |
| Reconnect | fixed 3 s | exponential 2 s → 30 s capped |
| Channels | one at a time | ref-counted multiplexing |
| Heartbeat | none | 25 s ping/pong |
| Offline | none | `AppState`-gated safety poll |

Keep `main`'s and add the client→server publish path that calling needs.

### Everything else

`apps/functions`, `apps/admin`, `firebase.json`, `firestore.rules`,
`database.rules.json`, `firestore.indexes.json`, `apps/image-upload-worker`,
`apps/video-stream-worker` (superseded by R2 + Bunny), and `staging`'s
`messages/index.tsx` (178 lines vs `main`'s 633).

## Suggested sequence

1. **#1** — small, self-contained, proves the loop
2. **#8** — verify then most likely close as already-fixed
3. **#2** — unlocks #3 and fixes the dead `unreadCount` / `isOnline` UI on `main` today
4. **#3** — the visible chat upgrade
5. **#4**, **#5** — independent, can run in parallel
6. **#6a → 6b → 6c** — only once #2 and #3 are stable
7. **#7** — lowest value per unit of work

Keep `staging` alive until every item is either merged or explicitly dropped: it
is the only copy of this work.
