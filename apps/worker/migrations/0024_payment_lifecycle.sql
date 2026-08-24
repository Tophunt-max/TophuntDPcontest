-- Payment lifecycle: refunds, chargebacks and reconciliation.
--
-- Before this, `payment_orders` only understood "created" and "paid":
--
--  * A refund or chargeback left the coins credited and spendable — there was no
--    clawback path at all, and the webhook silently 200'd every event that was
--    not `payment.captured` / `order.paid`.
--  * Nothing ever swept orders that were paid at the gateway but never credited
--    (client closed the app AND the webhook was lost or misconfigured). The
--    money was taken and no job would ever find it.
--
-- The clawback columns record what was recovered and, importantly, what was NOT
-- (a user who already spent the coins), so a refund-and-keep abuser surfaces in
-- the admin panel instead of vanishing.

ALTER TABLE payment_orders ADD COLUMN refunded_at INTEGER;
ALTER TABLE payment_orders ADD COLUMN refunded_amount_paise INTEGER;
ALTER TABLE payment_orders ADD COLUMN clawed_back_coins REAL;
ALTER TABLE payment_orders ADD COLUMN clawback_shortfall REAL;
ALTER TABLE payment_orders ADD COLUMN reconcile_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE payment_orders ADD COLUMN reconciled_at INTEGER;

-- The reconciliation sweep reads `created` orders oldest-first; this index keeps
-- that a range scan rather than a table scan as the table grows.
CREATE INDEX IF NOT EXISTS idx_payment_orders_pending ON payment_orders(status, reconcile_attempts, created_at);

-- Look up an order by its Razorpay payment id — the refund/dispute webhook only
-- carries the payment id, not the order id.
CREATE INDEX IF NOT EXISTS idx_payment_orders_payment ON payment_orders(payment_id);
