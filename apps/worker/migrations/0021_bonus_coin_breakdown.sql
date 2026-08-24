-- Record how much of a top-up was bonus.
--
-- DDL-only and idempotent (AUDIT_2026-08-23.md #15 — autoMigrate has no
-- distributed lock, so this file may run concurrently across colos).
-- ALTER TABLE ADD COLUMN is tolerated because isIgnorable() swallows
-- "duplicate column name".
--
-- Bonus coins were already being credited: both createOrder and requestDeposit
-- resolve a package to coins + bonus_coins and store the TOTAL, which is what
-- gets added to users.dpcoin. But only the total was kept, so:
--
--   * the wallet ledger read "Purchased 15 Dpcoins" with no hint that 5 of them
--     were a bonus, leaving the user no way to confirm the offer was applied
--   * there was no way to report on how many bonus coins had been given away
--
-- These columns keep the breakdown alongside the total. `coins` / `amount` stay
-- the authoritative credit figure — the bonus is already inside them, so nothing
-- reads these to decide what to credit. NULL/0 on rows created before this.
ALTER TABLE payment_orders ADD COLUMN bonus_coins REAL DEFAULT 0;
ALTER TABLE deposits ADD COLUMN bonus_coins REAL DEFAULT 0;
