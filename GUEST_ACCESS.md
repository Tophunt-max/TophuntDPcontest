# Guest access policy

Guests can open the app and browse public content. They are asked to sign in only when they open a personal screen or tap an action that needs an account.

- **Client route policy:** `apps/expo/src/lib/routeAccess.ts` (one table, exact segment matching, unlisted routes are private).
- **Action prompts:** `apps/expo/src/hooks/useAuthGate.ts`.
- **Story audience rule:** `apps/worker/src/lib/storyAudience.ts`.
- **What actually protects private data:** server-side checks. Every private endpoint enforces auth itself. The client policy is UX only.

## Audit: what blocked guests, and what changed

| Surface | Before | Now | Change (file) |
|---|---|---|---|
| Cold start (`splash.tsx`) | Returning guest → `/auth/login`; first launch → onboarding → login | Guest → `/home` | `app/splash.tsx`, `app/onboarding/index.tsx` |
| Root guard (`_layout.tsx`) | Every route except blog/legal/`[slug]` → login; signed-in users bounced off **all** `auth/*`, including profile setup and action links | Policy table: guests browse public routes; private → login with a sanitized `redirect`; just signed out → `/home`; signed in on login → leave it; `auth/action` and post-signup steps are never bounced | `app/_layout.tsx`, `src/lib/routeAccess.ts` |
| `/@handle`, `/profile?userId=` | Guest → login | Public profile, field allow-list enforced by the Worker. Bare `/profile` (own profile) → login | `src/screens/ProfileScreen.tsx` |
| `GET /read/stories/feed` | `requireAuth`, **and returned followers-only Stories to every signed-in user** | `optionalAuth` + the audience rule | `routes/read.ts`, `lib/storyAudience.ts` |
| `GET /read/users/:id/stories`, `/highlights/:id/stories`, `/users/:id/highlights` | `optionalAuth`, no audience check (the shelf exposed cover media) | Audience rule applied; covers replaced or hidden | `routes/read.ts` |
| Battle share image | `/api` action (401 for guests) | `GET /read/matches/:id/share-image` (`optionalAuth`; block check for signed-in viewers) | `routes/read.ts`, `contestService.ts` |
| Stories bar | Disabled for guests | Enabled; per-viewer query key; waits for auth to resolve | `StoriesBar.tsx` |
| Story viewer | Feed list only (guest got `[]`) → `router.back()` | Loads a shared link's user directly; shows an "isn't available" state instead of going back | `app/story/view/[userId].tsx` |
| Inbox tab | Pointed at `/inbox`, which doesn't exist | `/messages` (requires an account) | `BottomNav.tsx` |

## Guest-readable

| Screens | Worker reads (all `optionalAuth`, bounded) |
|---|---|
| Home, Explore, leaderboard, contest listings (photo/video), battle `/battle/:id`, profiles (`/@handle`, `?userId=`), followers/following lists, wins, Story viewer and highlight reels, blog, legal, onboarding | `/read/matches` (≤100), `/read/matches/:id`, `/read/matches/:id/share-image` (600/h per IP; re-renders 20/h per battle), `/read/contests`, `/read/leaderboard`, `/read/users/:id`, `/read/users/by-username/:u`, `/read/users/:id/{matches,posts,followers,following,stories,highlights}`, `/read/highlights/:id/stories`, `/read/stories/feed`, `/read/comments` (≤100), `/read/users/search` (300/min per IP for guests), `/read/users/suggested`, `/read/blog*`, `/read/legal`, `/read/app-config` |

Guests see public Stories of public accounts only. Followers-only Stories and Stories from private accounts are shown only to followers and the owner. Deleted, pending-deletion and banned accounts are hidden from everyone.

## Account required

- **Screens:** messages, notifications, wallet (store, deposit, withdraw), settings, profile management and verification, own profile, Story create, contest setup/joined, prizes.
- **Reads:** chats/messages, notifications, transactions, deposits/withdrawals, `me/*`, bookmarks, blocked list, announcements, prizes, music, Story viewer lists.
- **Every `/api` mutation:** `requireApiAuth`. This covers like, comment, vote, follow, bookmark, story view/react/reply, create, upload, start/join contest, payments, withdrawals, referral, profile edits and account deletion. Existing verification and admin checks are unchanged.

When a guest taps a protected action, they get a prompt that names it ("Sign in to vote in battles…") and returns them to the same screen after sign-in. The action is **not** replayed automatically.

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

1. Fresh install / private window → app opens on Home; no login.
2. As a guest, scroll the feed and open a battle, a profile (`/@handle`), Explore, the leaderboard and a contest listing.
3. As a guest, tap like / vote / comment / follow / bookmark / Story reply → each shows a "Sign in to …" prompt. Choose "Sign in", finish, and confirm you land back on the same screen with the action **not** performed.
4. As a guest, open `/wallet`, `/messages`, `/setting` and `/notifications` directly → login with `?redirect=`. After signing in you land on that screen.
5. Open shared links signed out, cold, and in the browser: `/battle/<id>`, `/@handle`, `/story/view/<uid>`. A deleted or expired one shows "isn't available".
6. Story audience: post a followers-only Story as A. Check it is hidden from guests and from non-follower B, and visible to follower C. Make A private and check A's public Stories disappear for guests.
7. Sign out from Settings → Home (guest), with no login loop. Sign up a new phone account → profile setup is not skipped.
8. Password-reset and email-verification links still open `/auth/action`.
9. As a guest, share a battle → the VS image attaches.
