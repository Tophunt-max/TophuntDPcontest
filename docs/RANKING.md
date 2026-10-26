# Feed ranking, Explore and search

How battles are chosen and ordered for For You, Following, the Explore rails and
universal search. Code: `apps/worker/src/routes/read.ts` (`servePersonalizedFeed`,
`rankBaseScore`, `diversifyFeed`, `GET /read/matches`, `GET /read/search`),
`apps/worker/src/lib/feedWeights.ts` and `apps/worker/src/lib/feedDismissals.ts`.

## Eligibility (applied before ranking)

A battle may be **distributed** (ranked into a list) only when all of these hold:

| Rule | Where |
|---|---|
| Status matches the list (`active`, or `waiting_for_opponent` for "Open battles"). For You also pulls battles that finished in the last 24 h, so results stay visible. | SQL `WHERE` |
| Not held for moderation review (`moderation_hold_at IS NULL`, migration 0060). | SQL `WHERE` |
| Not invite-only (`COALESCE(is_private, 0) = 0`). | SQL `WHERE` (`publicMatch`) |
| Neither participant is pending deletion, deleted, or blocked by an admin. Same rule as the Stories bar. | `distributableMatches` / `filterDistributable` after the live user lookup |
| Signed-in viewer: neither participant is blocked (either direction) or muted by the viewer. | `excludeHiddenMatches(hiddenUidsFor(uid))` |
| Signed-in viewer, For You / Following only: the viewer has not said "Not interested" to this battle. | `loadFeedDismissals` |

A direct link (`/read/matches/:id`) still opens a battle that fails the
distribution rules; only the blocked-viewer rule applies there.

If the live user lookup fails, participants are kept (fail-open), so a D1 error
cannot empty the feed. Paging cursors for `hot`, `ending` and `recent` are
computed from the raw rows, so a dropped battle never shifts paging. A page can
therefore come back shorter than `limit`, or empty with a cursor.

Product decision, unchanged: battles by **private accounts** are distributed like
any other battle.

## For You and Following

Two stages.

1. **Candidate pool** (shared by every viewer, isolate memo for 45 s): the 150
   newest eligible battles of the requested status and type, plus up to 40 that
   finished in the last 24 h when `status=active`. Each gets a base score:

   ```
   engagement = totalVotes + likeCount + 2·commentCount + 3·shareCount + reactions
   velocity   = engagement / (hours since start + 2)          (completed: / (lifetime h + 2))
   freshness  = exp(-hours since start / 24)                  (completed: exp(-hours since end / 10))
   urgency    = 1 - hoursLeft/6 in the last 6 h of voting, else 0
   prize      = ln(1 + entryFee)

   base = freshness·w.freshness + ln(1 + velocity)·w.velocity + urgency·w.urgency + prize·w.prize
        + (completed ? freshness·w.result : 0)
        + (live and a participant is a new creator ? w.newCreator : 0)
   ```

   A **new creator** is an account created less than 30 days ago with fewer than
   50 followers. This is the cold-start / exploration signal: without it, a new
   account's first battles have no engagement and no followers, and sank below
   established creators.

2. **Per-viewer re-rank** (signed-in only; the id order is memoised for 60 s for
   stable paging):

   ```
   + w.follow          the viewer follows a participant
   + w.votedAffinity   the viewer voted for a participant before (last 500 votes)
   + w.visitAffinity   the viewer visited a participant's profile (last 500 visits)
   - w.notInterested   the viewer said "Not interested" to a battle by a participant (last 200)
   live battle:      - w.votedPenalty if already voted on it
                     - w.seenPenalty · min(times shown, w.seenCap) if shown but not voted
   finished battle:  + w.resultVotedBoost if the viewer voted on it
   ```

   Following keeps only battles with a followed participant.

Both stages end with `diversifyFeed` (window 2): a participant does not appear in
two neighbouring slots when another battle can take the slot. Guests get stage 1
plus diversity.

### Weights, bounds, version and rollback

Defaults and bounds are in `lib/feedWeights.ts`:

| Weight | Default | Range | Weight | Default | Range |
|---|---|---|---|---|---|
| freshness | 2.2 | 0–10 | votedPenalty | 1.5 | 0–10 |
| velocity | 1.6 | 0–10 | seenPenalty | 0.6 | 0–5 |
| urgency | 1.2 | 0–10 | seenCap | 5 | 0–20, whole |
| prize | 0.3 | 0–5 | result | 2.6 | 0–10 |
| follow | 3.0 | 0–10 | resultVotedBoost | 2.0 | 0–10 |
| votedAffinity | 1.5 | 0–10 | newCreator | 0.8 | 0–5 |
| visitAffinity | 1.0 | 0–10 | notInterested | 2.0 | 0–10 |

- **Override:** `appConfig.feedWeights` through `POST /admin/app-settings`. A
  partial object merges over the stored one; `null` restores the defaults.
- **Validation:** an unknown key or an out-of-range value is refused with a
  message naming it. Values are clamped again at read time, so a stored value can
  never invert a signal (a negative `votedPenalty` would promote battles the
  viewer already voted on).
- **Audit:** every change writes `settings.feedWeights.update` with before and
  after values to `admin_audit_log`.
- **Version:** every ranked response carries `X-Feed-Ranking:
  foryou-2.<hash of the effective weights>`. The version is part of the order-cache
  key, so a change applies on the next request. Bump `FEED_RANKING_ALGORITHM` when
  the scoring code changes.
- **Rollback:** save the previous weights (the audit row has them), or `null`.
  Other isolates pick up a change within 30 s (the weights memo).

There is no A/B split yet. The version header is the hook for one: an experiment
would choose weights per cohort and report the version with impressions. That
needs a cohort assignment and an impression log, which do not exist.

### "Not interested"

The ellipsis ("More options") on a Home card offers Not interested and Report.
Not interested calls the `setFeedDismissal` action (`{ matchId, dismissed }`,
explicit target state, rate limited 120/h). The server stores the viewer, the
battle and its two creators (`feed_dismissals`, migration 0065). The battle
leaves that viewer's For You and Following on the next request, including over a
cached order, and the creators are demoted by `w.notInterested`. Rows older than
90 days are pruned on the viewer's next dismissal and all rows are deleted with
the account. Explore lists and search are shared caches and do not apply it;
block or mute is the tool for "never show me this person". Not offered on your
own battles or to guests. The app has no undo screen yet; the action accepts
`dismissed: false`.

### Offline evaluation

Not built. The ranking functions are pure given rows, weights and the viewer's
signals, so a replay harness could score a recorded pool against two weight sets.
It needs logged impressions and outcomes (votes, likes, dwell), which are not
recorded today. The unit tests in `apps/worker/test/feedRanking.test.ts` pin the
behaviour of each control.

## Explore rails (`GET /read/matches`, not personalised)

| Rail | Rule |
|---|---|
| Trending (`sort=hot`) | Live battles by `totalVotes + likeCount + 2·commentCount + 3·shareCount`, newest first on ties. No time decay: a battle only stays live for its voting window. |
| Ending soon (`sort=ending`) | Live battles not yet expired, soonest deadline first. |
| Fresh (default) | Live battles, newest first, keyset cursor on `created_at`. |
| Open battles | `waiting_for_opponent`, newest first. |

Pages are cached per (status, type, sort, limit, page) for 30 s and shared across
viewers; the viewer's block/mute filter and vote state are applied after.

## Search (`GET /read/search`, `GET /read/users/search`)

- The term is trimmed, leading `@`s are dropped and it is lower-cased; `%` and
  `_` match literally. Fewer than 2 characters answers empty.
- People: completed sign-ups, not pending deletion or deleted, not blocked with
  the viewer. Admin-blocked accounts are still found (their profile stays
  visible by design; see Open below). Battles:
  open or live, public, not held, eligible as above. Contests: live. Blog:
  published.
- Rate limits: 300/min per IP for guests, 120/min per account for signed-in users.
- Client (`app/explore/search.tsx`): 300 ms debounce. A superseded request is
  aborted through react-query's signal. While a new term loads, the previous
  results are dimmed, and "nothing found" only shows for the current term.
  Recent searches stay on the device (10, clearable); `@name` and `name` are one
  entry.
- There is no case-insensitive index on usernames. The scans are bounded and
  not measured as slow; add one if measurements show otherwise.

## Recommended creators (`GET /read/users/suggested`)

Verified first, then by follower count. Excludes the viewer, people they follow,
users blocked or muted with the viewer, unfinished sign-ups, and pending-deletion
or deleted accounts.

## Open

- Admin-blocked accounts are still returned by people search and suggestions.
  Their battles are no longer distributed (above), but recommending the account
  itself is a product decision: `accountStatus.ts` deliberately keeps an
  admin-blocked profile visible.
