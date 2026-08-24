-- Self-service account deletion (an app-store requirement that had no code path).
--
-- The account row itself is anonymised rather than deleted: the financial ledger,
-- contest history and vote records reference the uid, and those must be retained
-- for accounting and for the integrity of contests other people entered. Deleting
-- the row would orphan all of it.
--
-- This table is the compliance record of the deletion: when it happened, why (if
-- the user said), and how many coins were forfeited. It is deliberately the ONLY
-- new place the uid appears after deletion, and it holds no personal data.
CREATE TABLE IF NOT EXISTS account_deletions (
  uid              TEXT PRIMARY KEY,
  reason           TEXT,
  forfeited_coins  REAL NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_account_deletions_created ON account_deletions(created_at);
