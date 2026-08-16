-- Voting integrity, immutable match policy, and exactly-once settlements.
ALTER TABLE contest_matches ADD COLUMN min_votes_required INTEGER;
ALTER TABLE contest_matches ADD COLUMN settlement_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_matches_settlement_id
  ON contest_matches (settlement_id)
  WHERE settlement_id IS NOT NULL;

-- Snapshot the current template policy for legacy matches where possible.
-- If a template has been deleted the value intentionally remains NULL, and the
-- resolver fails closed rather than silently treating the threshold as zero.
UPDATE contest_matches
SET min_votes_required = (
  SELECT min_votes FROM contests WHERE contests.id = contest_matches.contest_id
)
WHERE min_votes_required IS NULL
  AND contest_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM contests WHERE contests.id = contest_matches.contest_id);

-- Historical imports may contain duplicate audit rows. Keep the earliest vote
-- per voter and retain only the earliest non-empty device fingerprint before
-- adding database-level uniqueness constraints.
DELETE FROM votes
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM votes
  GROUP BY match_id, voter_uid
);

UPDATE votes
SET device_id = NULL
WHERE device_id IS NOT NULL
  AND device_id <> ''
  AND rowid NOT IN (
    SELECT MIN(rowid)
    FROM votes
    WHERE device_id IS NOT NULL AND device_id <> ''
    GROUP BY match_id, device_id
  );

-- Reconcile denormalized D1 tallies with the cleaned audit rows. Actor-local
-- tallies are independently rebuilt by VoteCounter's schema-version repair.
UPDATE contest_matches
SET user_a = CASE
      WHEN user_a IS NULL THEN NULL
      ELSE json_set(
        user_a,
        '$.votes',
        (SELECT COUNT(*) FROM votes
          WHERE votes.match_id = contest_matches.id
            AND votes.voted_for_uid = json_extract(contest_matches.user_a, '$.uid'))
      )
    END,
    user_b = CASE
      WHEN user_b IS NULL THEN NULL
      ELSE json_set(
        user_b,
        '$.votes',
        (SELECT COUNT(*) FROM votes
          WHERE votes.match_id = contest_matches.id
            AND votes.voted_for_uid = json_extract(contest_matches.user_b, '$.uid'))
      )
    END,
    total_votes = (SELECT COUNT(*) FROM votes WHERE votes.match_id = contest_matches.id);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_votes_match_voter
  ON votes (match_id, voter_uid);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_votes_match_device
  ON votes (match_id, device_id)
  WHERE device_id IS NOT NULL AND device_id <> '';

-- Durable Object retries consult this D1 ledger before incrementing XP. The
-- ledger and increment are committed in the same D1 batch, making vote XP
-- exactly once even if the actor restarts after D1 commits but before it marks
-- its local row as acknowledged.
CREATE TABLE IF NOT EXISTS vote_xp_awards (
  match_id TEXT NOT NULL,
  voter_uid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (match_id, voter_uid)
);
CREATE INDEX IF NOT EXISTS idx_vote_xp_awards_voter
  ON vote_xp_awards (voter_uid, created_at);
