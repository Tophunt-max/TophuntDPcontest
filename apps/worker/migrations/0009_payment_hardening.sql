-- Payment & payout hardening.
--
-- 1) payment_orders — a PERSISTENT record of every Razorpay order we create.
--    Previously the only trace of a pending order was a 1-hour CACHE_KV entry,
--    so if the client paid but never called back (app closed, network drop) the
--    coins were never credited and there was nothing to reconcile against. This
--    table lets both the client callback (/api topup) AND a server-to-server
--    webhook (/webhook/razorpay) credit the same order exactly once.
CREATE TABLE IF NOT EXISTS payment_orders (
  order_id     TEXT PRIMARY KEY,               -- Razorpay order id
  user_id      TEXT NOT NULL,
  package_id   TEXT,
  coins        REAL NOT NULL,                  -- server-authoritative coins to credit
  amount_paise INTEGER NOT NULL,               -- expected amount (paise), server-set
  currency     TEXT NOT NULL DEFAULT 'INR',
  status       TEXT NOT NULL DEFAULT 'created', -- created | paid | failed
  payment_id   TEXT,                           -- razorpay payment id once captured
  source       TEXT,                           -- callback | webhook (who credited it)
  credited_at  INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders (user_id);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders (status, created_at);

-- 2) withdrawals.reserved — coins are now escrowed (deducted from the balance)
--    at REQUEST time instead of at admin-approval time, which removes the race
--    where a user could spend coins after requesting a payout. This flag marks
--    rows created under the new model so the admin action code never
--    double-deducts legacy (pre-migration) pending rows.
ALTER TABLE withdrawals ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0;
