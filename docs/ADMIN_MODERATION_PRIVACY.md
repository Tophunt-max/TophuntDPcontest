# Admin roles, moderation, privacy and analytics

Current rules after Phase H. Code: `apps/worker/src/routes/admin.ts` (the `/admin`
gate and routes), `apps/worker/src/routes/api.ts` (`createReport`),
`apps/worker/src/lib/accountDeletion.ts`, `accountExport.ts`, `observability.ts`.

## Admin access

- **Credentials.** A Firebase ID token whose role (custom claim, else
  `users.role`) is `superadmin`, `admin` or `moderator`, checked with the same
  session revocation and blocked-account checks as the app; or the server-to-server
  `X-Admin-Secret` (constant-time compare, not sendable from a browser because CORS
  does not allow the header). Script actions are audited as `server`.
- **Full admin** (`requireFullAdmin`) = superadmin or admin. Everything that moves
  money, changes roles or settings, reads PII, sends broadcasts, purges data or
  runs ops is full-admin only.
- **Moderators** can: read the report queue, dismiss reports, remove reported
  posts, stories and comments, delete posts/stories/comments, manage banned words,
  read and answer support tickets, edit blog posts, and see dashboard counts.
  They cannot: remove a live battle (refunds stakes; their removal holds it
  instead), run the blog importer, see voter device ids or IPs, see revenue, or
  reach any money, role, settings or data-deletion route.
- **Roles.** `set-role` accepts only `admin`, `moderator` or `user`; nobody can
  grant superadmin through the API, change their own role, or touch a superadmin
  unless they are one. Demotion ends the target's sessions. Every change is audited.
- **Audit log** (`admin_audit_log`): every mutating admin route writes a row with
  the admin and before/after where it matters. Phase H added rows for reward
  settings, error-log wipes, scheduled-notification cancels, fetch-to-R2 and blog
  imports. The log is full-admin readable and has no delete route.

## Reports and moderation

- **Filing** (`createReport`): type is one of `match` (aliases `contestMatch`,
  `contestMatches`), `comment`, `user`, `post`, `story`. The target must exist and
  must not be the reporter's own (participants cannot report their own battle).
  One report per reporter per target; 20 per hour per account.
- **Auto-hold**: a battle is hidden from shared feeds after reports from 3
  different accounts that are older than 24 hours, **verified (email or phone)**
  and in good standing, excluding participants. It still settles normally and stays
  reachable by link. Dismissing every open report releases it.
- **Remove** (`POST /admin/reports/:id/resolve {action:"remove"}`):
  - comment: deleted from whichever table holds it (battle, post or blog
    comments), counter and live count updated, its likes removed, thread cache
    purged;
  - post: deleted with its comments and likes, media deleted (owner-checked);
  - story: deleted, personal media deleted (contest media is shared and kept);
  - battle: a live one is cancelled with a full refund (full admins); a settled one
    is marked cancelled and its VS stories torn down;
  - user: refused; block the account from Users instead.

  Every open report on the same target is then closed, and the owner gets a
  "Content removed" notification that names the appeal route (Settings › Report a Problem).
- **Dismiss** keeps the row as `dismissed` so a re-report is a duplicate.

## Privacy

- **Account deletion** (after the grace period): profile anonymised; content,
  likes, bookmarks, follows, requests, blocks, mutes, visits, shares, chat messages,
  media, push tokens, "Not interested" and **notifications naming them as actor** are
  removed. Votes, contest records, money ledger, referrals and reports they filed are
  kept (results, accounting and moderation evidence).
- **Data export** (3 per day, emailed to the address on file): profile (no push
  tokens), content, comments, likes, bookmarks, connections and requests, wallet and
  ledger, payments, deposits, withdrawals, referrals, support tickets, votes, battle
  entries, prize claims, messages sent, notifications, and now **blocks, mutes,
  reports filed, Story views, profile visits, shares, comment likes and "Not
  interested"**.
- **Links from content** (announcements, blog HTML) open in the app only when they
  are `http(s)://` or `mailto:` (`src/lib/safeLink.ts`). The server also validates
  announcement and Explore banner links.
- **Crash reports** (Sentry, when a DSN is set): the app sends the error, a short
  stack, platform and version; context keeps only short primitive values under keys
  that do not name a user, contact detail, token or payment field.

## Analytics

| Signal | Status |
|---|---|
| Onboarding funnel | Collected: `/telemetry/onboarding`, counts per day/event/slide/platform, no identifiers, 512-byte body cap, 120/hour per IP |
| Server errors | `error_logs` (14 days) and Sentry; 5xx only |
| Client errors | Sentry over fetch, scrubbed context, no native crash capture |
| Request log | Cloudflare Workers Logs: method, path, status, duration, edge-cache outcome |
| Admin dashboards | `/admin/overview`, `/admin/analytics` (counts; revenue for full admins only) |
| Usage counters | Workers Analytics Engine (`tophunt_events`), anonymous, see below |

### Usage counters

`apps/worker/src/lib/usageEvents.ts` (server), `apps/expo/src/lib/usageStats.ts` and
`src/services/usageStats.ts` (app).

| Event | Dimensions | Where counted |
|---|---|---|
| `feed_impression` | `home` | Home feed: each battle the first time it is 50% visible on that screen |
| `story` | `complete`, `skip`, `close` | Story viewer: timer finished, tap right, close button or swipe down |
| `video` | `first_frame` (with ms), `stall`, `error` | Story viewer video status |
| `search` | `results`, `empty` | Explore search, once per settled query (no query text) |
| `sync` | `sent`, `retry`, `failed` | Offline outbox drain totals |
| `upload` | `ok` (with ms), `failed`, `cancelled` | R2 and video (Qencode pipeline) transfers |

- **No identifiers.** A batch has the platform (`ios`/`android`/`web`/`other`), the
  app version (`1.2.3` shape, else `unknown`) and the counters. No uid, device id,
  IP, content id or text. The Worker drops any event or dimension outside the list.
- **Batched.** The app adds counts in memory and sends one request when it goes to
  the background, or 5 minutes after the first count. The Worker writes one data
  point per (event, dimension): at most 15 per request.
- **Off switch.** Settings › Privacy › "Share anonymous usage statistics", stored
  on the device, offered signed in or out. Off clears the buffer and stops counting.
- **Bounds.** `POST /telemetry/events`: 4 KB body, 50 events, count ≤ 1000, duration
  ≤ 10 min per occurrence; per-IP `USAGE_LIMITER` 30/min (Workers Rate Limiting,
  not a Durable Object). Over the limit or without the binding: 204, nothing written.
- **Retention.** Analytics Engine keeps data for 3 months.
- **Reading.** `GET /admin/usage-events?days=1..90` (full admins), shown on the
  Analytics page. It uses the Analytics Engine SQL API with the existing
  `CF_ANALYTICS_TOKEN` (needs Account Analytics: Read) and is memoised 5 minutes
  per isolate. Without the token the page says "Not configured".
- **Free plan budget.** 100,000 data points written and 10,000 read queries a day.
  Every batch is also one Worker request (100,000 a day on Free). At one batch
  per session, 10,000 sessions a day would use about 10% of the request budget.
- **Privacy policy** (`apps/worker/src/content/legal.ts`) names these counts and
  the switch; `LEGAL_LAST_UPDATED` is 26 October 2026.

Not counted: cache hit rate, feed card video start (the feed player has no status
listener), explore list impressions.

### Feature rollout

`appControl.featureRollout{feature: 0-100}` (absent = 100). The bucket is FNV-1a of
`feature:uid` mod 100, so an account stays in as the percentage grows. Guests are in
only at 100. The server gate (`appControlGate`) refuses the feature's actions for
accounts outside the rollout; the app (`src/lib/rollout.ts`) computes the same
bucket (pinned by tests on both sides). Set per feature on the App Control page.

## Admin sessions

- **Recent sign-in for dangerous actions.** Deleting or blocking a user, ending their
  sessions, wallet adjustments, `set-role`, withdrawal and deposit decisions,
  deletion purge, broadcast, app settings, rewards, coin packages and integrations
  need a sign-in within 15 minutes (`auth_time`, which token refresh does not move).
  Otherwise the Worker answers 412 `reauth_required`; the panel asks for the password
  (`reauthenticateWithCredential`) and retries once. Reads are not gated. The
  `X-Admin-Secret` server-to-server path is exempt. Moderators get the route's 403.
- **Role-aware panel.** `/admin/overview` returns `viewerRole`; moderators see only
  Dashboard, Analytics, Users, Matches, Posts, Stories, Comments, Blog, Reports,
  Support and Moderation.
- **Support tickets for moderators.** Subject, message and reply are returned with
  emails/UPI ids, IFSC codes and digit runs of 10+ masked (`lib/redact.ts`). Full
  admins see the original.

## Realtime sockets

The app asks `/api` (`createWsTicket`, Authorization header) for a 120-second HMAC
ticket naming the uid and sign-in time, and opens `/ws?ticket=`. The ID token no
longer appears in request URLs (Workers Logs). Key: `WS_TICKET_SECRET`, else derived
from `ADMIN_PROXY_SECRET` with a domain prefix. `?token=` still works for older
builds; the app falls back to it when no ticket is issued.

## Other decisions

- **Inline data export** (no email on file, too large to attach, or the send failed)
  needs a recent sign-in or a passed OTP challenge. The app shows the same
  re-verify step as account deletion and retries.
- **Word filter** also checks a folded reading: accents removed, common look-alikes
  (`5c4m` → `scam`) and letters separated by dots or spaces joined. Still a word
  list, still fails open when the list cannot be read.
- **Reports filed by a deleted account are kept** (moderation evidence, like votes).

## Open

- The CORS allow-list falls back to `*` when `ALLOWED_ORIGINS` is unset (logged);
  production and staging both set it, and staging includes localhost origins.
- Deploy notes: `WS_TICKET_SECRET` is optional (`wrangler secret put`). The
  `tophunt_events` dataset is created on first write. Staging has no
  `CF_ACCOUNT_ID` var, so its usage page reads "Not configured".
