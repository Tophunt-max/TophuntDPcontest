# Gamification: XP, levels, achievements, quests, cosmetics and seasons

This document covers the audit of the old XP code, the design that replaced it,
the policies, and how to roll it out and roll it back.

## 1. Audit of the code before this change

| Area | What existed | Status |
|---|---|---|
| Level formula | `calculateLevel` / `levelForXp` in `lib/gamification.ts`: step from L to L+1 costs `xpThreshold + (L−1)·xpIncrement` (defaults 500/500). Derived from `users.xp` on read. | Correct, kept as the only formula. It now has a max level. |
| XP writes | 7 inline `xp = xp + N` statements: vote +5 (VoteCounter DO), entry +10 (startMatch, joinMatch), entry rollback −10, win +100 / loss +20 (settlement), check-in +50 (hardcoded), Hall of Fame +500 (hardcoded), admin grant. | Inconsistent: no ledger, amounts hardcoded in five files, no daily caps. Only votes had dedupe. |
| `users.level` | Frozen at its seeded value. Still read by `equipBadge`, the admin leaderboard, the admin user view and the broadcast `minLevel` filter. | Bug: valid badges were refused and broadcasts targeted the wrong users. |
| Expo `ProfileHeader` | Its own copy of the formula with 500/500 hardcoded, and a "claim badge" modal at 99% progress. | Bug: disagreed with the server when the curve changed. The claim flow failed on the frozen level. |
| Badges | Server stores `string[]`, client typed `{name, icon, level}[]`. | Inconsistent. |
| `level_up` notification | Category mapped, never sent. | Missing. |
| Achievements, quests, seasons, cosmetics, XP history | None. | Missing. |
| Security | Clients could not send an XP amount anywhere. The admin grant did a bare `UPDATE` with no reason. | The admin path is now ledgered and needs a reason. |

## 2. Architecture

### One XP path: `lib/xpService.ts`

Every XP change is three statements that go into the caller's own D1 batch:

1. `INSERT OR IGNORE` into `user_xp_events`. The id is a deterministic
   idempotency key (`vote:<match>:<uid>`, `match_win:<match>`,
   `contest_entry:<match>:<uid>`, `daily_checkin:<uid>:<dayStart>`, …). The
   delta is computed in SQL: the rule amount, clamped by the rest of today's
   cap for that action and by `MAX_LIFETIME_XP` (2,000,000,000).
2. `UPDATE users.xp` by that delta, keyed to this attempt's nonce.
3. Upsert `user_xp_daily(uid, day, action)`. Caps and period leaderboards read this row.

The batch is one transaction, so XP is atomic with what earned it. Two
concurrent awards against one cap are exact, because D1 serialises them and
the second sees the first one's daily row. A reversal is a new `reversal` row
pointing at the original (`reverses` is unique). The original is never edited
or deleted.

`users.xp` stays the materialised total, so every existing read path works
unchanged. Migration 0070 writes one `opening_balance` event per user, so
`SUM(delta) = users.xp` holds from day one. `reconcileXp` checks this, and the
hourly cron raises a `ledger_mismatch` flag when it fails.

### Level engine: `lib/progression.ts`

`levelInfo(xp)` returns: level, max-level flag, current-level start, next-level
XP, XP inside the level, XP to the next level, progress (0..1, exactly 1 at
max), rank, next rank and next milestone. The Worker sends it on every profile,
and the app renders it without recomputing anything.

The max level defaults to 100 and is configurable. XP keeps accumulating past
it. Thresholds are validated so they increase monotonically and the max level
fits under the XP ceiling.

### Ranks

Ranks are assigned by **level**, not by XP band: Newcomer 1–5, Creator 6–15,
Challenger 16–30, Champion 31–50, Legend 51–100. The XP bands in the product
brief do not fit the existing formula (level 51 needs 637,500 XP at 500/500,
not 30,000). Keeping the formula meant nobody's level changed. An admin can
move the curve in Gamification → Rules if the bands should be tighter, and that
changes levels without changing anyone's XP.

### Progression sync: `lib/achievements.ts#syncProgression`

This step detects level-ups, evaluates achievements, grants milestone items and
creates milestone coin grants. It runs after the user's own actions, after
settlement, on every `getProgression`, and hourly for recent earners. Votes are
credited by the Durable Object, which does not sync.

- A level-up is detected with a compare-and-set on `users.level_seen`, so
  exactly one run announces it.
- The **first** sync of an account is silent. It records the current level and
  any achievements already met, with no XP, no coins and no notifications. So
  launching does not hand out retroactive XP or flood users with notifications.
- While the experience is off, every sync stays silent the same way.

## 3. XP rules and caps (defaults)

These are the amounts the app already paid before this change. Nobody's
earning rate changes except through the new daily caps.

| Action | XP | Daily cap | Notes |
|---|---:|---:|---|
| vote | 5 | 100 | Once per (match, voter). The DO still checks `vote_xp_awards`, so votes paid before the ledger are never paid again. |
| contest_entry | 10 | 60 | Granted with the entry fee. Reversed if the match ends **cancelled**. |
| match_win / match_loss | 100 / 20 | none | Once per settled match, inside the settlement batch. |
| daily_checkin | 50 | none | Once per reward day, gated on this request's check-in ledger row. |
| hall_of_fame | 500 | none | Once per (period, user). |
| daily_task | per task (`xp` field) | 100 | Daily quests. Gated on this request's task ledger row. Default `vote5` gives 15 XP. |
| quest | per quest | none | Weekly and monthly quests, once per period. |
| achievement | per achievement | none | Once per (achievement, tier). |
| like received | 0 | n/a | Deliberately no XP. |

The brief proposed different amounts (vote 2, check-in 5, win 40, entry 20).
To switch, change them in Gamification → Rules. Changes apply from then on;
historical XP is never recalculated. Profile completion (100) and first contest
(50) are one-time **achievements** in the default catalog.

### Lifecycle policies

- **Cancelled match** (no opponent, too few votes, same-device void, contest
  paused): the entry XP is reversed. A tie is "completed" and keeps its XP.
  Entries from before the ledger have no event, so nothing historical changes.
- **Refund of a paused contest's entry**: the entry XP is reversed in the same batch.
- **Disqualification or moderation**: staff reverse the specific events in
  Gamification → Users. Each reversal is a new event with a reason and an actor.
- **Admin corrections**: `POST /admin/gamification/users/:id/xp` takes a signed
  amount and a required reason. It never goes below zero, records before and
  after in the audit log, and can notify the user.
- History is never deleted. Account deletion keeps `user_xp_events`,
  `season_results` and `xp_flags`, keyed by the anonymised uid, and deletes
  achievements, inventory, quests, daily counters and unclaimed grants. The
  privacy policy says so.

### Anti-abuse

- Database-enforced idempotency keys, and caps computed inside the transaction.
- The server already rejected self-votes and duplicate votes per match, user
  and device. Joining from the creator's device is refused.
- `xp_flags` raises review flags for staff and never punishes anyone
  automatically: `velocity` when one action's events per day pass
  `velocityFlagEvents`, `same_device_match` for a voided same-device battle,
  and `ledger_mismatch`. A shared family phone looks like collusion, which is
  why a human decides.
- Rate limits cover every new action. Quest and reward claims fail closed.
- No endpoint accepts an XP amount, an unlock or an ownership claim from a client.

## 4. Data model (migration `0070_gamification.sql`, additive)

The migration adds:

- Tables: `user_xp_events`, `user_xp_daily`, `achievement_definitions`,
  `user_achievements`, `reward_catalog`, `user_inventory`, `reward_grants`,
  `quest_claims`, `seasons`, `season_results`, `xp_flags`.
- Columns on `users`: `level_seen`, `cosmetics`, plus the index `idx_users_xp`.
- Columns on `contests`: `min_level` and `max_level`.
- Seed rows: the default catalog and the default achievements.

## 5. Coin rewards

XP never converts into coins. A level milestone (`milestones[].coins`) or a
season band (`rewards[].coins`) can carry a fixed Diamond amount. It becomes a
`reward_grants` row. Claiming it:

- reserves from `progression.rewardBudgetId`, falling back to the free-rewards
  budget. The budget must be of kind `free_rewards`. Its total and per-user
  limit are enforced inside the transaction.
- writes the ledger row `reward_grant:<id>` of type `gamification_reward` and
  credits **Diamonds only** (`locked_coins`).
- leaves the grant `claimable` when no budget is configured or the budget has
  run out. XP, levels and cosmetics never depend on this.

Linking a budget, or changing milestone or season coin amounts, needs the
approval password.

## 6. Seasons and leaderboards

- Lifetime XP is `users.xp`. Week, month and season XP is the sum of
  `user_xp_daily` over the period's reward days. Admin adjustments are
  excluded, and reversals reduce the period that earned the XP.
- **Tie-breaks**: period XP (descending), then lifetime XP (descending), then
  account age (oldest first), then uid. A rank is a position in that order.
- Only publicly visible, onboarded accounts that are not blocked appear. Pages
  are cached for 60s at the edge, at most 500 deep. A viewer's block list is
  applied after the cache.
- **Season end** (hourly cron or admin "Finalize"):
  1. A compare-and-set moves the season to `finalizing`.
  2. A single `INSERT … SELECT ROW_NUMBER()` takes the ranking snapshot, and
     only if no results exist yet.
  3. Reward bands are stamped onto the results, items are granted, and claimable
     coin grants are created with deterministic ids.
  4. A compare-and-set moves the season to `finalized`, and rewarded users are
     notified once.

  Every step is idempotent. Lifetime XP is never touched.

## 7. API

`/api` actions, all for the caller's own data:

| Action | Purpose |
|---|---|
| `getProgression` | Level info, roadmap, recent XP and claimable rewards. Runs a sync first. |
| `getAchievements` | Achievement list with progress. |
| `getInventory` | Owned, locked and equipped cosmetics. |
| `equipCosmetic` | Equip or unequip one slot. |
| `pinAchievements` | Pin achievements to the profile. |
| `getQuests`, `claimQuest` | Weekly and monthly quests. |
| `getXpHistory` | XP events, cursor-paginated. |
| `claimRewardGrant` | Claim a milestone or season Diamond reward. |
| `getCreatorInsights` | The caller's contest stats. |
| `getXpRank` | The caller's rank for a period. |

Existing actions extended: `claimDailyReward` returns the real `xpEarned`, and
`claimDailyTask` returns `xpEarned`.

`/read` routes:

| Route | Purpose |
|---|---|
| `/gamification/catalog` | Public catalog, 300s cache. |
| `/leaderboard/xp?period=` | Public leaderboard pages. |
| `/leaderboard/xp/me` | The caller's own rank. |
| `/hall-of-fame` | Public Hall of Fame. |
| `/users/:id/achievements` | Someone's unlocked achievements, with the same block rules as the profile. |

Profiles now include `levelInfo` and the resolved `cosmetics`.

`/admin/gamification/*` covers config, achievements, catalog, seasons (with
finalize, cancel and results), user inspection and events, XP adjust, event
reverse, manual achievement grants, item revoke and restore, flags, analytics,
reconcile and grants. Writes need a full admin. Moderators can read config,
inspect users (without coin rewards) and review flags.

## 8. Rollout

1. **Staging**: deploy to the staging Worker (`wrangler deploy --env staging`).
   Migration 0070 applies automatically on the first request or cron run.
   Check:
   - `SELECT COUNT(*) FROM user_xp_events WHERE action='opening_balance'`
     equals the number of users with XP above zero;
   - `POST /admin/gamification/reconcile` reports no mismatches.
2. With the experience still **off** (the default), confirm on test accounts that:
   - check-in still gives 50 XP;
   - votes, entries and settlement still credit XP;
   - profiles show `levelInfo`;
   - the profile progress bar matches the server.
3. Add test uids to `betaUids` in Gamification → Rules. Exercise achievements,
   quests, a short season (finalize it), equipping, and a milestone with coins
   against a small `free_rewards` budget.
4. Production: deploy with the experience off. Watch the following for at least a day:
   - the `gamificationHourly` cron run in System Health (`mismatches` must stay 0);
   - XP issued per action in Gamification → Overview;
   - the error logs.
5. Turn on for beta uids, then set `enabled: true`.

Monitor `ledger_mismatch` and `velocity` flags, `cron_runs` for
`gamificationHourly`, reward grants by status, and budget spend.

## 9. Rollback

- **Disable the experience**: set `progression.enabled = false` and clear
  `betaUids`. Achievements, quests, seasons, level-up notifications and coin
  claims stop, and the app hides them. XP keeps being recorded and levels keep
  working. No data is lost.
- **Stop a single source**: set that rule's `enabled: false` (for example
  `vote`), or lower its cap.
- **Code rollback**: redeploy the previous Worker. The migration is additive,
  so old code ignores the new tables and columns.
  - Old code writes XP inline again, so `users.xp` grows without ledger rows.
    After re-deploying this version, the reconcile check flags those accounts.
  - Correct them with one admin adjustment each, or accept the drift for that
    window (one `opening_balance`-style backfill per affected user).
- Do **not** drop tables or delete events as a rollback.

## 10. Known limitations

- Vote XP is credited by the VoteCounter DO without a sync, so a level-up
  earned only by voting is announced on the next app read or by the hourly cron
  (at most 200 accounts per run).
- Photo, video, entry and battle counts for achievements and insights come from
  the entry-fee ledger ids (`contest_entry:<match>:<uid>`). Entries whose ledger
  rows predate that id format are not counted.
- Comeback missions and level-based matchmaking leagues are not implemented.
  Level-gated contests (`minLevel` / `maxLevel`) are, and are checked before
  any fee moves.
- The level-up celebration is per device (AsyncStorage). Server notifications
  are deduplicated per account.
- A shareable level-up card is not implemented.

## 11. Visual layer (apps/expo)

All XP, rank, achievement, cosmetic, reward and quest artwork is addressed by a
stable key in `apps/expo/src/lib/gamificationAssets.ts`. Each key resolves to
one of two things:

- a glyph from the existing Lucide icon shim (`src/lib/icons.tsx`), or
- a TopHunt-drawn SVG in `src/components/gamification/vectors.tsx`.

The SVG designs are:

- the XP spark;
- six rank emblem silhouettes;
- frame rings in six tiers, for circle and rounded-square avatars;
- the lock badge, trophy, gift and empty-inventory illustration.

They are vectors, not PNGs. They stay sharp at every density, have no
background, follow light and dark themes, and are editable as source.

The server sends only ids: rank id, achievement id, and catalog item id plus
`asset` (frames can carry `asset.key`, migration 0071). The manifest maps those
ids to keys. Unknown ids fall back to generic art.
`test/gamificationAssets.test.ts` checks four things:

- every key resolves to a mapped glyph or an implemented vector;
- every id the Worker seeds has art;
- the tier text contrast is readable;
- the animated components honour reduced motion.

The milestone roadmap's reward state (`rewardState`: none, pending, claimable,
claimed or ineligible) comes from the user's own `reward_grants`.

## 12. Animations (apps/expo)

Every animation is built on the app's existing `react-native-reanimated` 4
setup, with `expo-haptics` for feedback. No dependency was added. The battle
result screen's Lottie confetti loads a remote JSON file and fails offline, so
it is not used here; the sparkles are a local 8-particle Reanimated burst.

The rules live in `src/lib/xpAnimation.ts`, which is pure and covered by
`test/xpAnimation.test.ts`.

- **XP gain**: `useXpGainFeed` combined with `XpGainFloat`.
  - Gains are deduplicated by the server event id, stored per account on the
    device in a bounded set of 200. Bursts of more than 3 events merge into one
    "+N XP", and at most 3 items are queued.
  - The first snapshot on a device is silent.
  - The progress bar moves from the previous server snapshot to the new one
    (`barPlan`): within a level it slides; across levels it fills to 100% and
    then slides on, two steps even when several levels are crossed. A reversal
    or a remount jumps without animating.
- **Level-up**: `LevelUpCelebration` plays dim → badge spring → sparkles →
  old → new level → rank → unlocks → Continue, in about 1.9s.
  - Tap anywhere to skip. It auto-dismisses after 6s, and ends if the app is
    backgrounded or the screen loses focus.
  - It is deduplicated by `levelup:<uid>:<level>`, recorded before it is shown.
- **Achievements**: `AchievementUnlockToast` shows only unlocks the server
  returned (`newlyUnlocked`), one at a time, at most 3, deduplicated per device.
  Collections never animate all at once.
- **Rewards**: `RewardClaimReveal` shows success only with the `coins` the
  server returned. It has separate states for already claimed, unavailable
  (budget), expired, offline and failed, and offers retry where a retry can
  succeed. The client now carries the Worker's `error.reason` on `ApiCallError`.
- **Profile**: the level badge enters once per mount. Changing frames
  cross-fades inside a fixed-size box, so the layout does not move. Champion,
  Legendary and max-level frames carry a slow glint; it pauses when the screen
  is unfocused or the app is backgrounded.
- **Quests, streaks, leaderboard**:
  - A quest checkmark springs only when the server snapshot changes it to done.
  - Progress bars slide.
  - A banner marks 7, 30 and 100-day check-in streaks.
  - Small up/down markers show rank moves between two fetches of the same
    board. Jumps of more than 50 places are ignored.
- **Reduced motion** turns off every animation and particle. The
  announcements and the dismiss controls remain.
