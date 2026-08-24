-- Payout reconciliation.
--
-- Payouts are executed by hand in a banking app, so "an admin marked this paid"
-- and "the bank actually sent the money" were two unrelated facts with nothing
-- linking them: `withdrawals` had no reference column and no paid timestamp, so
-- no outgoing rupee could ever be matched against a bank statement.
--
-- `payout_ref` is now required to mark a payout paid and must be unique, which
-- also stops the same bank reference being recorded against two payouts.
ALTER TABLE withdrawals ADD COLUMN payout_ref TEXT;
ALTER TABLE withdrawals ADD COLUMN paid_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_withdrawals_payout_ref
  ON withdrawals(payout_ref) WHERE payout_ref IS NOT NULL;
