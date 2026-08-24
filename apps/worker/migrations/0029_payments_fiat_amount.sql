-- Separate money from coins in the payments table.
--
-- `payments.amount` has always been populated with COINS (see lib/coinOrders.ts
-- and the manual-deposit approval), but /admin/revenue summed it and labelled the
-- result `totalRevenue`, alongside a 14-day "revenue" trend and a "top spenders"
-- ranking. Every rupee figure an admin looked at was actually a coin count.
--
-- The real fiat values did exist — `payment_orders.amount_paise` for Razorpay and
-- `deposits.pay_amount` for manual UPI — but nothing aggregated them anywhere.
--
-- `amount_paise` is integer paise (never a float) and is the only column revenue
-- reporting reads from now. `coins` keeps the coin count under an honest name.

ALTER TABLE payments ADD COLUMN amount_paise INTEGER;
ALTER TABLE payments ADD COLUMN coins REAL;
ALTER TABLE payments ADD COLUMN source TEXT;

-- Backfill: the coin count is what `amount` always held.
UPDATE payments SET coins = amount WHERE coins IS NULL;

-- Backfill the fiat side for Razorpay payments from the order that produced them.
UPDATE payments
   SET amount_paise = (
         SELECT po.amount_paise FROM payment_orders po WHERE po.payment_id = payments.id
       ),
       source = 'razorpay'
 WHERE amount_paise IS NULL
   AND EXISTS (SELECT 1 FROM payment_orders po WHERE po.payment_id = payments.id);

-- Backfill manual deposits: the payment row id is the deposit id, and pay_amount
-- is the rupee value the user actually transferred.
UPDATE payments
   SET amount_paise = (
         SELECT CAST(ROUND(d.pay_amount * 100) AS INTEGER) FROM deposits d WHERE d.id = payments.id
       ),
       source = 'manual_deposit'
 WHERE amount_paise IS NULL
   AND EXISTS (SELECT 1 FROM deposits d WHERE d.id = payments.id AND d.pay_amount > 0);

-- Revenue queries filter by status and bucket by day.
CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
