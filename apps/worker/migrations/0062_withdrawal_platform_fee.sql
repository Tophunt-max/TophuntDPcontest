-- Platform fee on withdrawals (lib/withdrawalFee.ts).
--
-- A withdrawal now records the whole money picture at request time, locked:
--   gross_amount  coins × payout rate (what the coins were worth)
--   fee_amount    platform fee deducted from the payout
--   cash_amount   NET — what is actually sent (unchanged meaning for every reader:
--                 the admin pays this, reports total it)
--   fee_detail    JSON of the fee rule used ({feePercent, feeFlat, feeMin, feeMax}),
--                 so a later settings change can be audited against old requests.
--
-- Additive and nullable. Existing rows carried no fee: gross = cash, fee = 0.
ALTER TABLE withdrawals ADD COLUMN gross_amount REAL;
ALTER TABLE withdrawals ADD COLUMN fee_amount REAL NOT NULL DEFAULT 0;
ALTER TABLE withdrawals ADD COLUMN fee_detail TEXT;
UPDATE withdrawals SET gross_amount = cash_amount WHERE gross_amount IS NULL;
