-- Gamification: XP ledger, daily XP caps, achievements, cosmetics, quests,
-- seasons, claimable milestone rewards and abuse flags. All additive.
-- See apps/worker/GAMIFICATION.md for the design and rollout notes.
--
-- 1. user_xp_events: append-only XP ledger. `id` IS the idempotency key
--    (deterministic, e.g. vote:<matchId>:<uid>), so a retried award can never
--    be applied twice. `nonce` is the per-attempt token the same batch uses to
--    tell "my insert won" apart from "a previous attempt already wrote it".
--    `delta` is what actually moved users.xp (after caps and clamping),
--    `requested` what the rule asked for. A reversal is a NEW row whose
--    `reverses` points at the original, never an edit or a delete.
CREATE TABLE IF NOT EXISTS user_xp_events (
  id           TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  action       TEXT NOT NULL,
  delta        INTEGER NOT NULL CHECK (delta BETWEEN -2000000000 AND 2000000000),
  requested    INTEGER NOT NULL DEFAULT 0,
  day          INTEGER NOT NULL DEFAULT 0,
  source_type  TEXT,
  source_id    TEXT,
  rule_version INTEGER NOT NULL DEFAULT 1,
  reverses     TEXT,
  reason       TEXT,
  actor        TEXT,
  nonce        TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_events_uid_created ON user_xp_events (uid, created_at);
CREATE INDEX IF NOT EXISTS idx_xp_events_action_created ON user_xp_events (action, created_at);
CREATE INDEX IF NOT EXISTS idx_xp_events_created ON user_xp_events (created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_xp_events_reverses ON user_xp_events (reverses) WHERE reverses IS NOT NULL;

-- 2. user_xp_daily: per (user, reward day, action) XP and event counters. The
--    daily caps are enforced against this row INSIDE the awarding batch, and the
--    weekly / monthly / seasonal leaderboards sum it, so lifetime XP
--    (users.xp) and period XP are separate counters.
CREATE TABLE IF NOT EXISTS user_xp_daily (
  uid     TEXT NOT NULL,
  day     INTEGER NOT NULL,
  action  TEXT NOT NULL,
  xp      INTEGER NOT NULL DEFAULT 0,
  events  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (uid, day, action)
);
CREATE INDEX IF NOT EXISTS idx_xp_daily_day_uid ON user_xp_daily (day, uid);

-- 3. users: the level the user has been told about (NULL = never synced; the
--    first sync records the current level silently so launching this does not
--    send everyone a burst of level-up notifications), equipped cosmetics and
--    pinned achievements (JSON), and an index for the lifetime XP leaderboard.
ALTER TABLE users ADD COLUMN level_seen INTEGER;
ALTER TABLE users ADD COLUMN cosmetics TEXT;
CREATE INDEX IF NOT EXISTS idx_users_xp ON users (xp);

-- 4. Optional level-based tournament eligibility on a contest template.
--    NULL = no restriction (every existing contest).
ALTER TABLE contests ADD COLUMN min_level INTEGER;
ALTER TABLE contests ADD COLUMN max_level INTEGER;

-- 5. Achievement catalog. `metric` + `threshold` is the qualification rule,
--    evaluated only on the server (lib/achievements.ts).
CREATE TABLE IF NOT EXISTS achievement_definitions (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT 'trophy',
  category    TEXT NOT NULL DEFAULT 'general',
  rarity      TEXT NOT NULL DEFAULT 'common',
  metric      TEXT NOT NULL,
  threshold   INTEGER NOT NULL DEFAULT 1 CHECK (threshold >= 1),
  xp_reward   INTEGER NOT NULL DEFAULT 0 CHECK (xp_reward BETWEEN 0 AND 10000),
  item_id     TEXT,
  repeatable  INTEGER NOT NULL DEFAULT 0,
  max_tiers   INTEGER NOT NULL DEFAULT 1,
  active      INTEGER NOT NULL DEFAULT 1,
  hidden      INTEGER NOT NULL DEFAULT 0,
  starts_at   INTEGER,
  ends_at     INTEGER,
  sort        INTEGER NOT NULL DEFAULT 0,
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- tier = 1 for one-time achievements, 1..max_tiers for repeatable ones.
-- xp_awarded is 0 for achievements recorded by the silent first sync.
CREATE TABLE IF NOT EXISTS user_achievements (
  uid            TEXT NOT NULL,
  achievement_id TEXT NOT NULL,
  tier           INTEGER NOT NULL DEFAULT 1,
  unlocked_at    INTEGER NOT NULL,
  xp_awarded     INTEGER NOT NULL DEFAULT 0,
  event_id       TEXT,
  source         TEXT NOT NULL DEFAULT 'progress',
  PRIMARY KEY (uid, achievement_id, tier)
);
CREATE INDEX IF NOT EXISTS idx_user_achievements_def ON user_achievements (achievement_id, unlocked_at);
CREATE INDEX IF NOT EXISTS idx_user_achievements_uid ON user_achievements (uid, unlocked_at);

-- 6. Cosmetic catalog and inventory. Items are visual only.
--    type = frame | theme | title | accessory | sticker | effect | collectible | badge
CREATE TABLE IF NOT EXISTS reward_catalog (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  rarity      TEXT NOT NULL DEFAULT 'common',
  asset       TEXT NOT NULL DEFAULT '{}',
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_inventory (
  uid          TEXT NOT NULL,
  item_id      TEXT NOT NULL,
  source       TEXT NOT NULL,
  source_ref   TEXT,
  acquired_at  INTEGER NOT NULL,
  revoked_at   INTEGER,
  revoke_reason TEXT,
  PRIMARY KEY (uid, item_id)
);
CREATE INDEX IF NOT EXISTS idx_user_inventory_item ON user_inventory (item_id);

-- 7. Claimable coin rewards (level milestones, season results). Paid only
--    through the free-rewards budget + coin ledger, as Diamonds.
--    status = claimable | claimed | ineligible | expired
CREATE TABLE IF NOT EXISTS reward_grants (
  id           TEXT PRIMARY KEY,
  uid          TEXT NOT NULL,
  source_type  TEXT NOT NULL,
  source_id    TEXT NOT NULL,
  coins        INTEGER NOT NULL CHECK (coins >= 0),
  status       TEXT NOT NULL DEFAULT 'claimable',
  note         TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  claimed_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_reward_grants_uid ON reward_grants (uid, status);
CREATE INDEX IF NOT EXISTS idx_reward_grants_status ON reward_grants (status, created_at);

-- 8. Weekly / monthly quest claims. period_key = w<week> or m<YYYY-MM>.
CREATE TABLE IF NOT EXISTS quest_claims (
  uid        TEXT NOT NULL,
  quest_id   TEXT NOT NULL,
  period_key TEXT NOT NULL,
  xp         INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (uid, quest_id, period_key)
);

-- 9. Seasons. start_day / end_day are reward-day numbers (inclusive), fixed
--    when the season is saved. status = scheduled | active | finalizing | finalized | cancelled
CREATE TABLE IF NOT EXISTS seasons (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  starts_at      INTEGER NOT NULL,
  ends_at        INTEGER NOT NULL,
  start_day      INTEGER NOT NULL,
  end_day        INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'scheduled',
  top_n          INTEGER NOT NULL DEFAULT 100,
  rewards        TEXT NOT NULL DEFAULT '[]',
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_by     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  finalized_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_seasons_status ON seasons (status, end_day);

CREATE TABLE IF NOT EXISTS season_results (
  season_id   TEXT NOT NULL,
  uid         TEXT NOT NULL,
  rank        INTEGER NOT NULL,
  xp          INTEGER NOT NULL,
  rewards     TEXT NOT NULL DEFAULT '[]',
  reward_state TEXT NOT NULL DEFAULT 'pending',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (season_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_season_results_rank ON season_results (season_id, rank);

-- 10. Suspicious-activity flags for staff review. Never acted on automatically.
--     status = open | dismissed | actioned
CREATE TABLE IF NOT EXISTS xp_flags (
  id          TEXT PRIMARY KEY,
  uid         TEXT NOT NULL,
  kind        TEXT NOT NULL,
  detail      TEXT,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  INTEGER NOT NULL,
  reviewed_by TEXT,
  reviewed_at INTEGER,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_xp_flags_status ON xp_flags (status, created_at);
CREATE INDEX IF NOT EXISTS idx_xp_flags_uid ON xp_flags (uid, created_at);

-- 11. Opening balance: every account's XP from before this ledger existed, as
--     one event, so SUM(user_xp_events.delta) per user equals users.xp from day
--     one. Not added to user_xp_daily, so it never counts towards a weekly,
--     monthly or seasonal ranking.
INSERT OR IGNORE INTO user_xp_events (id, uid, action, delta, requested, day, rule_version, reason, created_at)
SELECT 'opening:' || uid, uid, 'opening_balance', MIN(xp, 2000000000), xp, 0, 0,
       'Lifetime XP earned before the XP ledger (migration 0070)',
       CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM users WHERE COALESCE(xp, 0) > 0;

-- 12. Default cosmetic catalog (editable in the admin panel).
INSERT OR IGNORE INTO reward_catalog (id, type, name, description, rarity, asset, sort, created_at, updated_at) VALUES
  ('frame_bronze', 'frame', 'Bronze Frame', 'Starter profile frame, unlocked at level 5.', 'common', '{"colors":["#CD7F32","#8C5A2B"],"animated":false}', 10, 0, 0),
  ('frame_silver', 'frame', 'Silver Frame', 'Unlocked at level 15.', 'uncommon', '{"colors":["#E3E6EA","#9AA3AD"],"animated":false}', 20, 0, 0),
  ('frame_gold_animated', 'frame', 'Golden Pulse Frame', 'Animated frame, unlocked at level 25.', 'rare', '{"colors":["#FFD54F","#FF8F00"],"animated":true}', 30, 0, 0),
  ('frame_diamond_animated', 'frame', 'Diamond Aura Frame', 'Rare animated frame, unlocked at level 90.', 'epic', '{"colors":["#80DEEA","#7C4DFF"],"animated":true}', 40, 0, 0),
  ('frame_legendary', 'frame', 'Legendary Frame', 'Unlocked at level 100.', 'legendary', '{"colors":["#FF5252","#FFD740","#7C4DFF"],"animated":true}', 50, 0, 0),
  ('theme_midnight', 'theme', 'Midnight Theme', 'Profile header theme, unlocked at level 15.', 'uncommon', '{"colors":["#1A237E","#4A148C"]}', 110, 0, 0),
  ('theme_royal', 'theme', 'Royal Theme', 'Premium-style profile theme, unlocked at level 60.', 'epic', '{"colors":["#4A148C","#FF6F00"]}', 120, 0, 0),
  ('title_creator', 'title', 'Creator', 'Title unlocked at level 10.', 'common', '{"text":"Creator"}', 210, 0, 0),
  ('title_champion', 'title', 'Champion', 'Title unlocked at level 50.', 'rare', '{"text":"Champion"}', 220, 0, 0),
  ('title_legend', 'title', 'Legend', 'Title unlocked at level 100.', 'legendary', '{"text":"Legend"}', 230, 0, 0),
  ('badge_rare_creator', 'badge', 'Rare Creator Badge', 'Unlocked at level 35.', 'rare', '{"icon":"star","color":"#FFB300"}', 310, 0, 0),
  ('collectible_season_star', 'collectible', 'Season Star', 'Seasonal collectible, unlocked at level 40.', 'rare', '{"icon":"sparkles","color":"#29B6F6"}', 410, 0, 0),
  ('collectible_elite_set', 'collectible', 'Elite Collection', 'Elite achievement set, unlocked at level 75.', 'epic', '{"icon":"diamond","color":"#AB47BC"}', 420, 0, 0),
  ('sticker_first_win', 'sticker', 'First Win Sticker', 'Awarded for your first finalized win.', 'common', '{"icon":"trophy","color":"#FFC107"}', 510, 0, 0),
  ('sticker_streak_30', 'sticker', '30-Day Streak Sticker', 'Awarded for a 30-day check-in streak.', 'rare', '{"icon":"flame","color":"#FF7043"}', 520, 0, 0),
  ('effect_legend_burst', 'effect', 'Legendary Burst', 'Level-up celebration effect, unlocked at level 100.', 'legendary', '{"colors":["#FFD740","#FF5252"]}', 610, 0, 0),
  ('collectible_season_top', 'collectible', 'Season Top Performer', 'Finished a season in the top ranks.', 'epic', '{"icon":"medal","color":"#FFD700"}', 430, 0, 0);

-- 13. Default achievements (editable in the admin panel). `profile_complete`
--     and `first_contest` are the one-time profile / first-entry milestones.
INSERT OR IGNORE INTO achievement_definitions (id, name, description, icon, category, rarity, metric, threshold, xp_reward, item_id, active, sort, created_at, updated_at) VALUES
  ('profile_complete', 'All Set', 'Add a profile photo, a name, a username and a bio.', 'person-circle', 'profile', 'common', 'profile_complete', 1, 100, NULL, 1, 10, 0, 0),
  ('first_contest', 'First Contest', 'Enter your first battle.', 'flag', 'contests', 'common', 'entries', 1, 50, NULL, 1, 20, 0, 0),
  ('first_vote', 'First Valid Vote', 'Vote in a battle.', 'checkmark-circle', 'community', 'common', 'votes', 1, 25, NULL, 1, 30, 0, 0),
  ('first_win', 'First Finalized Win', 'Win a battle.', 'trophy', 'contests', 'uncommon', 'wins', 1, 50, 'sticker_first_win', 1, 40, 0, 0),
  ('photo_creator', 'Photo Creator', 'Enter 5 photo battles.', 'image', 'creator', 'uncommon', 'photo_entries', 5, 50, NULL, 1, 50, 0, 0),
  ('video_creator', 'Video Creator', 'Enter 5 video battles.', 'videocam', 'creator', 'uncommon', 'video_entries', 5, 50, NULL, 1, 60, 0, 0),
  ('battles_10', '10 Valid Battles', 'Finish 10 battles that were not cancelled.', 'flash', 'contests', 'rare', 'completed_battles', 10, 75, NULL, 1, 70, 0, 0),
  ('votes_100', '100 Eligible Votes', 'Vote in 100 battles.', 'people', 'community', 'rare', 'votes', 100, 75, NULL, 1, 80, 0, 0),
  ('consistent_participant', 'Consistent Participant', 'Earn XP on 20 different days.', 'calendar', 'loyalty', 'rare', 'active_days', 20, 75, NULL, 1, 90, 0, 0),
  ('streak_7', '7-Day Streak', 'Check in 7 days in a row.', 'flame', 'loyalty', 'common', 'streak', 7, 25, NULL, 1, 100, 0, 0),
  ('streak_30', '30-Day Streak', 'Check in 30 days in a row.', 'flame', 'loyalty', 'rare', 'streak', 30, 100, 'sticker_streak_30', 1, 110, 0, 0),
  ('streak_100', '100-Day Streak', 'Check in 100 days in a row.', 'flame', 'loyalty', 'epic', 'streak', 100, 100, NULL, 1, 120, 0, 0),
  ('verified_champion', 'Verified Champion', 'Win 10 battles with a verified account.', 'shield-checkmark', 'contests', 'epic', 'verified_wins', 10, 100, NULL, 1, 130, 0, 0),
  ('season_top', 'Seasonal Top Performer', 'Finish a season in the rewarded top ranks.', 'medal', 'seasons', 'epic', 'season_top', 1, 100, 'collectible_season_top', 1, 140, 0, 0),
  ('community_contributor', 'Community Contributor', 'Recognised by the TopHunt team for helping the community.', 'heart', 'community', 'rare', 'manual', 1, 50, NULL, 0, 150, 0, 0);
