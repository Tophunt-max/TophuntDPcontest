-- ---------------------------------------------------------------------------
-- Demo seed: exactly 2 fake users + 2 contests, plus a full live battle
-- between the two users (entries + entry-fee ledger) so the whole contest flow
-- is populated. Everything below is scoped to just these two demo users.
--
-- Usage (run from apps/worker):
--   Local DB:   npx wrangler d1 execute tophunt-db --local  --file=scripts/seed-demo.sql
--   Remote DB:  npx wrangler d1 execute tophunt-db --remote --file=scripts/seed-demo.sql
--
-- Idempotent: re-running deletes the previous demo rows first, so it never
-- creates duplicates. All demo ids are prefixed with "demo-".
-- ---------------------------------------------------------------------------

-- Clean up any previous run (demo data only) ---------------------------------
DELETE FROM coin_transactions WHERE uid IN ('demo-user-1', 'demo-user-2');
DELETE FROM contest_matches   WHERE id IN ('demo-match-1');
DELETE FROM contests          WHERE id IN ('demo-contest-1', 'demo-contest-2');
DELETE FROM users             WHERE uid IN ('demo-user-1', 'demo-user-2');

-- 2 fake users ---------------------------------------------------------------
INSERT INTO users (
  uid, email, username, full_name, profile_image_url, role, status, is_blocked,
  dpcoin, xp, level, signup_completed, verified, contests_joined, created_at, updated_at
) VALUES
  ('demo-user-1', 'aarav.demo@example.com', 'aarav_demo', 'Aarav Demo',
   'https://i.pravatar.cc/300?img=12', 'user', 'active', 0,
   950, 120, 2, 1, 1, 1, unixepoch() * 1000, unixepoch() * 1000),
  ('demo-user-2', 'diya.demo@example.com', 'diya_demo', 'Diya Demo',
   'https://i.pravatar.cc/300?img=45', 'user', 'active', 0,
   950, 90, 2, 1, 0, 1, unixepoch() * 1000, unixepoch() * 1000);

-- 2 contests -----------------------------------------------------------------
INSERT INTO contests (
  id, title, type, status, total_entry_fee, reward_coins, vote_duration_days,
  auto_cancel_hours, min_votes, banner_url, extra, created_by, created_at
) VALUES
  ('demo-contest-1', 'Demo Photo Face-Off', 'photo', 'live',
   100, 500, 3, 24, 5,
   'https://picsum.photos/seed/demo-contest-1/1200/675',
   '{"description":"A friendly demo photo battle between two seeded users.","rules":"Original photos only. Demo data for testing."}',
   'seed', unixepoch() * 1000),
  ('demo-contest-2', 'Demo Reel Showdown', 'video', 'upcoming',
   200, 1000, 5, 48, 10,
   'https://picsum.photos/seed/demo-contest-2/1200/675',
   '{"description":"An upcoming demo reel contest.","rules":"Short vertical videos. Demo data for testing."}',
   'seed', unixepoch() * 1000);

-- Full live battle between the 2 users on contest 1 --------------------------
INSERT INTO contest_matches (
  id, contest_id, status, type, title, entry_fee, is_private,
  join_id_a, join_id_b, user_a, user_b, total_votes, min_votes_required,
  created_at, activated_at, expires_at
) VALUES (
  'demo-match-1', 'demo-contest-1', 'active', 'photo', 'Demo Photo Face-Off', 100, 0,
  'DEMOA1', 'DEMOB2',
  '{"uid":"demo-user-1","joinId":"DEMOA1","username":"aarav_demo","profilePic":"https://i.pravatar.cc/300?img=12","mediaUrl":"https://picsum.photos/seed/demo-entry-a/800/800","mediaType":"photo","caption":"My best shot!","votes":3,"deviceId":"demo-device-a"}',
  '{"uid":"demo-user-2","joinId":"DEMOB2","username":"diya_demo","profilePic":"https://i.pravatar.cc/300?img=45","mediaUrl":"https://picsum.photos/seed/demo-entry-b/800/800","mediaType":"photo","caption":"Let''s go!","votes":2,"deviceId":"demo-device-b"}',
  5, 5,
  unixepoch() * 1000, unixepoch() * 1000, (unixepoch() + 3 * 86400) * 1000
);

-- Entry-fee ledger for both users (50% split each side of a 100-coin fee) -----
INSERT INTO coin_transactions (id, uid, amount, type, contest_id, match_id, description, created_at) VALUES
  ('demo-txn-1', 'demo-user-1', -50, 'contest_entry_fee', 'demo-contest-1', 'demo-match-1', 'Entry fee (50% split) for Demo Photo Face-Off', unixepoch() * 1000),
  ('demo-txn-2', 'demo-user-2', -50, 'contest_entry_fee', 'demo-contest-1', 'demo-match-1', 'Entry fee (50% split) for Demo Photo Face-Off', unixepoch() * 1000);

-- Verify ---------------------------------------------------------------------
SELECT 'users'    AS entity, COUNT(*) AS n FROM users            WHERE uid IN ('demo-user-1', 'demo-user-2')
UNION ALL
SELECT 'contests' AS entity, COUNT(*) AS n FROM contests         WHERE id  IN ('demo-contest-1', 'demo-contest-2')
UNION ALL
SELECT 'matches'  AS entity, COUNT(*) AS n FROM contest_matches  WHERE id  IN ('demo-match-1')
UNION ALL
SELECT 'txns'     AS entity, COUNT(*) AS n FROM coin_transactions WHERE uid IN ('demo-user-1', 'demo-user-2');
