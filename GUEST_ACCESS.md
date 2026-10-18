# Guest access policy

Guests can open the app and browse public content. They are asked to sign in only when they open a personal screen or tap an action that needs an account.

- **Client route policy:** `apps/expo/src/lib/routeAccess.ts` (one table, exact segment matching, unlisted routes are private).
- **Action prompts:** `apps/expo/src/hooks/useAuthGate.ts`.
- **Story audience rule:** `apps/worker/src/lib/storyAudience.ts`.
- **Private accounts and follow requests:** `apps/worker/src/lib/privateAccount.ts`, `apps/worker/src/lib/followRequests.ts` (migration 0057).
- **What actually protects private data:** server-side checks. Every private endpoint enforces auth itself. The client policy is UX only.

## Audit: what blocked guests, and what changed

| Surface | Before | Now | Change (file) |
|---|---|---|---|
| Cold start (`splash.tsx`) | Returning guest → `/auth/login`; first launch → onboarding → login | New guest → 3-slide TopHunt intro once (Skip / Get started → `/home`, or Log in) → later launches straight to `/home`. Signed-in users never see the intro | `app/splash.tsx`, `app/onboarding/index.tsx`, `src/lib/onboarding.ts` |
| Root guard (`_layout.tsx`) | Every route except blog/legal/`[slug]` → login; signed-in users bounced off **all** `auth/*`, including profile setup and action links | Policy table: guests browse public routes; private → login with a sanitized `redirect`; just signed out → `/home`; signed in on login → leave it; `auth/action` and post-signup steps are never bounced | `app/_layout.tsx`, `src/lib/routeAccess.ts` |
| `/@handle`, `/profile?userId=` | Guest → login | Public profile, field allow-list enforced by the Worker. Bare `/profile` (own profile) → login | `src/screens/ProfileScreen.tsx` |
| `GET /read/stories/feed` | `requireAuth`, **and returned followers-only Stories to every signed-in user** | `optionalAuth` + the audience rule | `routes/read.ts`, `lib/storyAudience.ts` |
| `GET /read/users/:id/stories`, `/highlights/:id/stories`, `/users/:id/highlights` | `optionalAuth`, no audience check (the shelf exposed cover media) | Audience rule applied; covers replaced or hidden | `routes/read.ts` |
| Battle share image | `/api` action (401 for guests) | `GET /read/matches/:id/share-image` (`optionalAuth`; block check for signed-in viewers) | `routes/read.ts`, `contestService.ts` |
| Stories bar | Disabled for guests | Enabled; per-viewer query key; waits for auth to resolve | `StoriesBar.tsx` |
| Story viewer | Feed list only (guest got `[]`) → `router.back()` | Loads a shared link's user directly; shows an "isn't available" state instead of going back | `app/story/view/[userId].tsx` |
| Inbox tab | Pointed at `/inbox`, which doesn't exist | `/messages` (requires an account) | `BottomNav.tsx` |
| Follow a private account | Followed instantly, so "private" protected nothing | Pending request; owner confirms or deletes | `routes/api.ts`, `lib/followRequests.ts` |
| Private profile (guest / non-follower) | Battles grid, Wins, posts, followers/following and `following[]` all visible | "This account is private" lock; those reads answer empty | `routes/read.ts`, `ProfileScreen.tsx` |
| Header (guest) | Notification and inbox icons that only prompted | "Log in" button | `Header.tsx` |
| Bottom of every screen with the nav (guest) | Nothing | Log in / Sign up strip | `GuestBanner.tsx` via `BottomNav.tsx` |
| Home feed (guest) | Endless | Dismissible "See more on TopHunt" sheet every 12 battles seen | `home.tsx`, `lib/guestWall.ts` |
| `/battle/:id` | VS image + a button to Home | Full battle (`PostCard`): votes, countdown, likes, comments, save, share | `app/battle/[id].tsx` |
| `/@handle` SEO | `noindex` for everyone | Public account `index, follow`; private account `noindex` with a "private" description | `public/_worker.js` |
| Guest read volume | Only search and share-image limited | 1000/min per IP per colo on every other guest read | `guestReadLimit` (`middleware/auth.ts`) |

## Guest-readable

| Screens | Worker reads (all `optionalAuth`, bounded) |
|---|---|
| Home, Explore, leaderboard, contest listings (photo/video), battle `/battle/:id`, profiles (`/@handle`, `?userId=`), followers/following lists, wins, Story viewer and highlight reels, blog, legal, onboarding | `/read/matches` (≤100), `/read/matches/:id`, `/read/matches/:id/share-image` (600/h per IP; re-renders 20/h per battle), `/read/contests`, `/read/leaderboard`, `/read/users/:id`, `/read/users/by-username/:u`, `/read/users/:id/{matches,posts,followers,following,stories,highlights}`, `/read/highlights/:id/stories`, `/read/stories/feed`, `/read/comments` (≤100), `/read/users/search` (300/min per IP for guests), `/read/users/suggested`, `/read/blog*`, `/read/legal`, `/read/app-config` |

Private accounts: guests see the profile header only (name, avatar, bio, counters). The battles grid, Wins, posts, highlights and followers/following lists answer empty with `locked: true` on the profile. Battles themselves stay public in the feed and at `/battle/:id`, because they have a second player and public voting.

Guests see public Stories of public accounts only. Followers-only Stories and Stories from private accounts are shown only to followers and the owner. Deleted, pending-deletion and banned accounts are hidden from everyone.

## Account required

- **Screens:** messages, notifications, wallet (store, deposit, withdraw), settings, profile management and verification, own profile, Story create, contest setup/joined, prizes.
- **Reads:** chats/messages, notifications, transactions, deposits/withdrawals, `me/*`, bookmarks, blocked list, announcements, prizes, music, Story viewer lists.
- **Every `/api` mutation:** `requireApiAuth`. This covers like, comment, vote, follow, bookmark, story view/react/reply, create, upload, start/join contest, payments, withdrawals, referral, profile edits and account deletion. Existing verification and admin checks are unchanged.

When a guest taps a protected action, they get a prompt that names it ("Sign in to vote in battles…") and returns them to the same screen after sign-in. The action is **not** replayed automatically.

## Private accounts

The rule is in `lib/privateAccount.ts`. Only an **approved** follow (a `follows` row) unlocks content. A pending request lives in `follow_requests` and is never read as a follow.

- **Follow a private account** → request + a `follow_request` notification. A second tap ("Requested") withdraws it. The notification is capped at 3 per pair per hour, so request/cancel cannot spam pushes.
- **Owner** → Notifications → "Follow requests" (`/notifications/requests`) → Confirm or Delete (`respondFollowRequest`).
  - Confirm makes them a follower, bumps both counters once (gated, double-tap safe) and sends `follow_accept`.
  - Delete is silent.
- **Remove follower** (own followers list) takes access back without blocking. No notification.
- **Going public** approves every pending request. **Going private** keeps existing followers.
- **Unfollowing a private account** asks for confirmation, because getting back in needs a new request.
- **Explicit intent:** clients send `toggleFollow` with `intent: follow | unfollow | cancel`, so a list that can't see a pending request never withdraws it by accident. Without `intent`, the old toggle behaviour applies.
- **Race with going public:** the request insert only happens if the account is still private (checked in the same statement). Otherwise it becomes a direct follow.
- **Account deletion and privacy:**
  - Requesting deletion forces the account private. Cancelling now restores the value saved at request time (`deletion_requests.was_private`, migration 0057).
  - Requests made before 0057 have no saved value, so those accounts stay private on cancel.
  - Accounts that had *already* cancelled a deletion before this change are still private. Whether to reset them is a product decision. Find them with `SELECT uid FROM deletion_requests WHERE status = 'cancelled'`.
- **Block** deletes requests both ways. **Account deletion** deletes requests both ways plus the requester's "wants to follow you" rows. The data export includes sent and received requests.
- **Not changed (intentional):** battles of private accounts stay in the public feed and at `/battle/:id`.
- **Caching:**
  - The public profile cache entry is still shared. The lock and the emptied `following[]` are applied after the cache.
  - Private-account answers are `private, no-store` for signed-in viewers and send `Vary: Authorization`.
  - The Follow button state comes from `GET /read/users/:id/relationship`, so the profile itself stays one shared entry.

## Rate limits for guests

- **`GUEST_READ_LIMITER` binding** (wrangler `[[ratelimits]]`): 1000 requests/min per IP per colo on every `optionalAuth` read except search and share-image, which keep their own limits.
  - Applied after `optionalAuth`, so a bogus token still counts as a guest.
  - No Durable Object request per check. Fails open if the binding is missing.
  - The binding's namespace ids (7301 prod, 7302 staging) must be unique in the Cloudflare account.
- **Recommended edge backstop (dashboard, not in code):** a WAF rate-limiting rule.
  - Match: `starts_with(http.request.uri.path, "/read/users/")` and no `Authorization` header.
  - Limit: about 1500 per minute per IP, action Managed Challenge.

## Caches and sessions

- **Story feed edge cache:** the shared base holds rows plus owner facts, and contains nothing viewer-specific. The follow check and block/mute filtering run after the cache.
  - Guest answers: `public, max-age=30` with `Vary: Authorization`. Signed-in answers: `private, no-store`.
  - The base is purged when an account changes its privacy or is banned. The purge is per colo; other colos catch up within the 60s TTL.
- **Account change (sign-in, sign-out, switch):** React Query is cleared (existing behaviour). The on-device Story content cache is wiped. Queued Story actions are kept because they are tied to their owner's uid.
- **Device Story cache, guests:** never read or written.
- **Device Story cache, signed in:** network first. Each fetch replaces the cache; the cache is the offline fallback only.
- **Revoked token on a public read:** treated as a guest (`optionalAuth`). On a private read it gets a 401 and the existing sign-out flow runs.
- **Realtime:** guests open no sockets, because `/ws` requires a token.

## Staging QA checklist

1. Fresh install / private window → the intro shows once (Skip works). The next launch opens straight on Home, with no login. Sign in on a fresh install → no intro, now or after signing out. A shared `/battle/<id>` link opens the battle directly, without the intro.
2. As a guest, scroll the feed and open a battle, a profile (`/@handle`), Explore, the leaderboard and a contest listing.
3. As a guest, tap like / vote / comment / follow / bookmark / Story reply → each shows a "Sign in to …" prompt. Choose "Sign in", finish, and confirm you land back on the same screen with the action **not** performed.
4. As a guest, open `/wallet`, `/messages`, `/setting` and `/notifications` directly → login with `?redirect=`. After signing in you land on that screen.
5. Open shared links signed out, cold, and in the browser: `/battle/<id>`, `/@handle`, `/story/view/<uid>`. A deleted or expired one shows "isn't available".
6. Story audience: post a followers-only Story as A. Check it is hidden from guests and from non-follower B, and visible to follower C. Make A private and check A's public Stories disappear for guests.
7. Sign out from Settings → Home (guest), with no login loop. Sign up a new phone account → profile setup is not skipped.
8. Password-reset and email-verification links still open `/auth/action`.
9. As a guest, share a battle → the VS image attaches.
10. Private account A, user B:
    - B taps Follow → "Requested". A's grid, Wins, followers and following show the lock.
    - A gets a "Follow request" notification and confirms it under Follow requests → B's profile view of A unlocks.
    - Repeat with Delete → B is back to "Follow".
    - A switches to public with a request pending → it is approved.
11. As a guest:
    - Home shows "Log in" in the header and the Log in / Sign up strip.
    - After about 12 battles the "See more" sheet appears. "Not now" closes it.
12. Open `/battle/<id>` signed out → full card. Vote, like and comment each ask to sign in and come back.
13. View source of `/@public_user` → `index, follow`. `/@private_user` → `noindex` with "This account is private".
