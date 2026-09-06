-- Physical product prizes, and the claim they have to be redeemed through.
--
-- Until now a contest could award exactly one thing: coins, via
-- `contests.reward_coins`. An admin who wanted to give away an earphone or a
-- phone had no way to express it.
--
-- WHY THIS IS NOT `reward_coins` WITH A LABEL BOLTED ON
--
-- `assertPrizeFundedByPot` (src/lib/money.ts) refuses any contest whose
-- reward_coins exceeds the pot the two players funded, because reward_coins is
-- credited straight to a wallet — unbounded, it is a coin printer. A phone has
-- no coin value, so routing it through reward_coins would mean either weakening
-- that guard (the one rule protecting the coin supply) or lying about the prize's
-- size. Product prizes therefore get their own columns and reward_coins stays 0,
-- which also keeps the pot rule true by construction: a product contest credits
-- nobody, so there is nothing to fund.
--
-- The entry fees a product contest collects are simply retained — that is how the
-- product is paid for — and because reward_coins is 0 the existing pot assertion
-- passes untouched.
--
-- WHY THE MATCH GETS ITS OWN COPY
--
-- `contest_matches.prize_coins` already exists for exactly this reason: "Immutable
-- prize snapshot captured at match creation. Settlement pays THIS, not the live
-- contest template, so editing a template can never change the prize of a match
-- that is already in flight." A product prize needs the same protection, or an
-- admin editing a template mid-battle would change what the winner is owed. NULL
-- in the snapshot means "legacy row, fall back to the template", matching how
-- prize_coins and min_votes_required already degrade.

ALTER TABLE contests ADD COLUMN prize_type TEXT DEFAULT 'coins';
ALTER TABLE contests ADD COLUMN prize_product_title TEXT;
ALTER TABLE contests ADD COLUMN prize_product_image_url TEXT;
ALTER TABLE contests ADD COLUMN prize_product_value REAL DEFAULT 0;
ALTER TABLE contests ADD COLUMN prize_product_description TEXT;

ALTER TABLE contest_matches ADD COLUMN prize_type TEXT;
ALTER TABLE contest_matches ADD COLUMN prize_product_title TEXT;
ALTER TABLE contest_matches ADD COLUMN prize_product_image_url TEXT;
ALTER TABLE contest_matches ADD COLUMN prize_product_value REAL;

-- One row per won product prize. Created by settlement, not by the winner: the
-- row IS the record that something is owed, so it has to exist whether or not the
-- winner ever opens the app again.
--
-- `id` is deterministic — `prize_claim:<match_id>` — so the INSERT OR IGNORE that
-- creates it inside settleWinner's atomic batch is exactly-once even if a
-- settlement statement were somehow replayed. The unique index on match_id is the
-- same guarantee stated a second way, at the level a human reading the schema can
-- see.
--
-- Delivery columns are all NULLABLE and stay NULL until the winner submits them.
-- That is the difference between `unclaimed` and `submitted`, and it is why the
-- address cannot be a required column: settlement has no address to write.
CREATE TABLE IF NOT EXISTS prize_claims (
  -- prize_claim:<match_id>
  id                TEXT PRIMARY KEY,
  match_id          TEXT NOT NULL,
  contest_id        TEXT,
  -- The winner. Not a foreign key, matching the rest of this schema, but every
  -- read path filters on it and the submit path requires it to equal the caller.
  uid               TEXT NOT NULL,
  -- unclaimed — won, no delivery details yet. The winner must act.
  -- submitted  — details supplied, waiting on an admin.
  -- approved   — admin accepted the address; being packed.
  -- shipped    — handed to a courier; courier/tracking_number are set.
  -- delivered  — terminal, successful.
  -- cancelled  — terminal, unsuccessful. admin_note says why.
  status            TEXT NOT NULL DEFAULT 'unclaimed',

  -- Product snapshot, copied from the match at settlement. Denormalised on
  -- purpose: this is a record of what was promised, and it must survive the
  -- contest template being edited or deleted years later.
  product_title     TEXT NOT NULL,
  product_image_url TEXT,
  product_value     REAL DEFAULT 0,

  -- Delivery details supplied by the winner. PII: purged by
  -- accountDeletion.phaseContent and included in accountExport.
  recipient_name    TEXT,
  phone             TEXT,
  address_line1     TEXT,
  address_line2     TEXT,
  landmark          TEXT,
  city              TEXT,
  state             TEXT,
  postal_code       TEXT,
  country           TEXT,
  notes             TEXT,

  -- Fulfilment, admin-only.
  courier           TEXT,
  tracking_number   TEXT,
  admin_note        TEXT,

  created_at        INTEGER NOT NULL,
  submitted_at      INTEGER,
  approved_at       INTEGER,
  shipped_at        INTEGER,
  delivered_at      INTEGER,
  cancelled_at      INTEGER,
  updated_at        INTEGER
);

-- A match can owe at most one prize. Belt and braces alongside the deterministic
-- primary key, and the thing that would catch a future code path that invented
-- its own id.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_prize_claims_match ON prize_claims(match_id);
-- "My prizes", and the unclaimed-reminder sweep.
CREATE INDEX IF NOT EXISTS idx_prize_claims_uid ON prize_claims(uid, status);
-- The admin queue, which is always "oldest of a given status first".
CREATE INDEX IF NOT EXISTS idx_prize_claims_status ON prize_claims(status, created_at);
