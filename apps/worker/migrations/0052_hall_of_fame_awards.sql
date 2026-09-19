-- The settled Hall of Fame winner set, per month.
--
-- Why a table is needed rather than deriving the winners each run
-- ---------------------------------------------------------------------------
-- `monthlyHallOfFame` picked its top 3 live, with
--
--     SELECT ... FROM users ORDER BY monthly_wins DESC LIMIT 3
--
-- and then reset `monthly_wins` to 0 for everyone. The winner set was therefore
-- only ever knowable WHILE the month's counters were still standing, and the run
-- destroyed the very data it derived from.
--
-- `POST /admin/ops/hall-of-fame` accepts an explicit `period`, so an admin can
-- re-run a month that settled long ago. When they did, the query no longer
-- returned that month's winners — it returned whoever happened to be leading the
-- CURRENT month. Those users have no ledger row for the old period, so they were
-- paid for a month they did not win, and the reset then wiped the in-progress
-- leaderboard the payout had just been derived from.
--
-- Recording the settled set makes the operation genuinely idempotent: a re-run
-- replays these exact rows instead of re-deriving, so it can only ever complete a
-- partial payout, never invent a new one. It is also the audit trail for "who won
-- which month", which the ledger only carried implicitly in a row id.
--
-- Backward compatibility: periods settled BEFORE this table existed have no rows
-- here. `monthlyHallOfFame` therefore also treats the presence of
-- `hall_of_fame:<period>:` ledger ids as proof a period is already settled, so an
-- old period cannot be re-derived either.
--
-- DDL-only and idempotent by design (src/db/autoMigrate.ts has no distributed
-- lock — isolates in different colos may run this concurrently): every statement
-- is CREATE ... IF NOT EXISTS, and isIgnorable() swallows "already exists".

CREATE TABLE IF NOT EXISTS hall_of_fame_awards (
  -- 'YYYY-MM' of the settled month.
  period TEXT NOT NULL,
  uid TEXT NOT NULL,
  -- 1 | 2 | 3. Part of the payload, not the key: a user can hold only ONE rank in
  -- a given month, and (period, uid) being the key is what makes a replay exact.
  rank INTEGER NOT NULL,
  -- Coins promised for that rank, frozen here so a later change to the reward
  -- table cannot alter what an unpaid winner is still owed.
  reward REAL NOT NULL DEFAULT 0,
  -- `monthly_wins` the rank was awarded for. Audit only — the counter itself is
  -- reset by the run, so this is the only surviving record of the margin.
  wins REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (period, uid)
);

-- Serves the "winners of this period, best rank first" read that both the payout
-- replay and any admin history view need.
CREATE INDEX IF NOT EXISTS idx_hof_awards_period
  ON hall_of_fame_awards (period, rank);
