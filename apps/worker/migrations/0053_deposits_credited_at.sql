-- When a manual deposit's coins actually landed.
--
-- `PATCH /admin/deposits/:id` used to claim the pending row in one statement and
-- credit the wallet in a SEPARATE batch whose balance update carried no gate at
-- all. If the isolate died, or D1 rejected the batch, after the claim committed,
-- the deposit read `approved` with no coins, no `payments` row and no ledger row —
-- and the handler's own "already processed" guard then made a retry impossible.
-- The user had transferred real INR (a verified UTR) and the loss was both
-- invisible and unrecoverable without hand-written SQL.
--
-- The handler now writes the credit, the `payments` row, the ledger row AND this
-- column in ONE batch, every statement gated on the same `status = 'pending'`
-- snapshot, so they can only all apply or all no-op. This column is what makes
-- that invariant OBSERVABLE rather than merely intended: `computeMoneyHealth`
-- reports any `approved` deposit with `credited_at IS NULL`, which after this
-- change is structurally impossible and therefore a real alarm if it ever fires.
--
-- The backfill below declares every ALREADY-approved deposit as credited, dated
-- from the row's own `updated_at` (the moment it was processed). That is the
-- correct direction: those deposits were approved by the old code path, which
-- credited them in all but the rare interrupted case, and treating an unknown
-- historical row as "needs crediting" would invite a double credit. It runs once,
-- recorded by filename in `d1_migrations`, so it cannot re-apply to rows approved
-- later.

ALTER TABLE deposits ADD COLUMN credited_at INTEGER;

-- One-time backfill: everything approved before this migration is settled.
UPDATE deposits SET credited_at = updated_at WHERE status = 'approved' AND credited_at IS NULL;

-- Serves the money-health probe for the invariant above ("approved but never
-- credited"), which would otherwise scan the whole table.
CREATE INDEX IF NOT EXISTS idx_deposits_credited
  ON deposits (status, credited_at);
