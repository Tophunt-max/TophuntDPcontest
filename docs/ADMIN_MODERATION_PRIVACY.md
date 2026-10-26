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
  media, push tokens, "Not interested", **reports they filed and notifications naming
  them as actor** are removed. Votes, contest records, money ledger and referrals are
  kept (results and accounting).
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
| Feed impressions, Story completion, video buffering, search success, sync results, cache hit rate | **Not collected** |

There is no analytics consent toggle because nothing identifying is collected for
analytics. Adding impression or playback telemetry would need: an event schema
without user ids (or with a rotating pseudonymous id), a consent setting, a retention
limit, and a sink that does not spend the D1 or Durable Object write budgets
(Cloudflare Analytics Engine is the natural fit).

Feature flags (`appControl.features`) are global on/off switches; there is no
per-user rollout or experiment assignment.

## Open

- **Re-authentication for dangerous admin actions** (delete user, set role, wallet,
  payouts) is not required; any valid admin token up to an hour old works. Needs a
  re-auth step in the admin panel first.
- **WebSocket token in the URL**: `/ws?token=` puts the ID token in Workers Logs
  request URLs. Moving it to a header or a short-lived ticket is a client and server
  change.
- **Admin panel navigation** is not role-aware: moderators see pages that answer 403.
- **Support tickets** are readable by moderators; tickets can contain payment details.
  Decide whether support is a moderator duty.
- **Banned-word filter** is a simple word list and fails open.
- **Inline export fallback**: when email is unavailable the export is returned in the
  response to any valid session, without re-authentication.
- The CORS allow-list falls back to `*` when `ALLOWED_ORIGINS` is unset (logged);
  production and staging both set it, and staging includes localhost origins.
