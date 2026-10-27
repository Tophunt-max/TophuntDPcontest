-- Coin economy: promo budgets, locked (play-only) coins and a platform ledger.
-- All additive.
--
-- 1. users.locked_coins: the part of `dpcoin` that came from a platform-funded
--    promo (package bonus). It can be spent on contest entry fees (spent first)
--    but never withdrawn. Withdrawable = dpcoin - locked_coins.
--    Invariants: 0 <= locked_coins <= dpcoin and
--    locked_coins == SUM(coin_transactions.locked_delta) per user.
ALTER TABLE users ADD COLUMN locked_coins REAL NOT NULL DEFAULT 0;

-- 2. Every ledger row records how it moved the locked balance, and which promo
--    budget paid for it (if any).
ALTER TABLE coin_transactions ADD COLUMN locked_delta REAL NOT NULL DEFAULT 0;
ALTER TABLE coin_transactions ADD COLUMN budget_id TEXT;
CREATE INDEX IF NOT EXISTS idx_txn_type_created ON coin_transactions (type, created_at);
CREATE INDEX IF NOT EXISTS idx_txn_contest ON coin_transactions (contest_id);

-- 3. One budget per offer. kind = package_bonus (funds bonus coins on coin
--    packages), contest_prize (funds the part of a coin prize above the pot) or
--    product_prize (funds the coin cost of a physical prize above the pot).
--    status = active | paused | closed. per_user_limit = max coins one user can
--    receive from this budget (NULL = no limit).
CREATE TABLE IF NOT EXISTS promo_budgets (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  total_coins     REAL NOT NULL,
  spent_coins     REAL NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'active',
  starts_at       INTEGER,
  ends_at         INTEGER,
  per_user_limit  REAL,
  note            TEXT,
  created_by      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_budgets_kind ON promo_budgets (kind, status);

-- 4. Coins set aside from a budget for something not yet paid: a Razorpay order
--    (expires), a pending manual deposit, or a waiting/active match subsidy.
--    status = held | used | released. A held row with expires_at in the past no
--    longer counts against the budget.
CREATE TABLE IF NOT EXISTS promo_reservations (
  id          TEXT PRIMARY KEY,
  budget_id   TEXT NOT NULL,
  uid         TEXT,
  coins       REAL NOT NULL,
  status      TEXT NOT NULL DEFAULT 'held',
  ref_type    TEXT NOT NULL,
  ref_id      TEXT NOT NULL,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_res_budget ON promo_reservations (budget_id, status);
CREATE INDEX IF NOT EXISTS idx_promo_res_user ON promo_reservations (budget_id, uid, status);

-- 5. The platform's own side of every coin it creates or keeps. coins > 0 is
--    platform income (entry fees kept), coins < 0 is platform expense (promo
--    bonus, prize subsidy). kind = promo_bonus | prize_subsidy | product_prize |
--    product_prize_reversal | platform_fee | product_prize_fund.
CREATE TABLE IF NOT EXISTS platform_ledger (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  coins        REAL NOT NULL,
  budget_id    TEXT,
  contest_id   TEXT,
  match_id     TEXT,
  uid          TEXT,
  ref_id       TEXT,
  description  TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_ledger_kind ON platform_ledger (kind, created_at);
CREATE INDEX IF NOT EXISTS idx_platform_ledger_budget ON platform_ledger (budget_id);
CREATE INDEX IF NOT EXISTS idx_platform_ledger_contest ON platform_ledger (contest_id);

-- 6. Wiring: which budget funds a package bonus / a contest subsidy, and what a
--    match / order / deposit actually reserved.
ALTER TABLE coin_packages ADD COLUMN budget_id TEXT;
ALTER TABLE contests ADD COLUMN subsidy_budget_id TEXT;
ALTER TABLE contest_matches ADD COLUMN subsidy_coins REAL NOT NULL DEFAULT 0;
ALTER TABLE contest_matches ADD COLUMN subsidy_budget_id TEXT;
-- Admin-only coin cost of a product prize (never sent to the app), and the
-- snapshot of it on each match.
ALTER TABLE contests ADD COLUMN prize_cost_coins REAL NOT NULL DEFAULT 0;
ALTER TABLE contest_matches ADD COLUMN prize_cost_coins REAL NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN budget_id TEXT;
ALTER TABLE deposits ADD COLUMN budget_id TEXT;
