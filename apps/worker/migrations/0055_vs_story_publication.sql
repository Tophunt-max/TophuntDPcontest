-- Server-owned VS Story publication for two-player battles.
--
-- A battle's competition lifecycle (`status`: waiting_for_opponent -> active ->
-- completed | ended | cancelled) gates voting, settlement and refunds, so story
-- publication cannot be folded into it: a match that is "publishing stories" is
-- still a match that must accept votes. Publication is therefore a SUB-state of
-- an `active` match, tracked in its own columns:
--
--   vs_story_status  NULL        not eligible (still waiting, or a match that
--                                predates this migration; historical matches are
--                                NEVER back-published)
--                    pending     both entries accepted; ready for composition
--                    processing  a worker holds the lease (vs_story_claim)
--                    published   composite stored AND both Story rows confirmed
--                    failed      permanent failure, or retries exhausted;
--                                repairable via the admin retry endpoint
--                    skipped     the match stopped being active (settled,
--                                cancelled, refunded) before publication
--
-- `pending` is written ONLY by the joinMatch claim UPDATE itself, in the same
-- D1 transaction that takes the joiner's entry fee, so nothing but a real,
-- paid, two-participant join can make a match eligible.
ALTER TABLE contest_matches ADD COLUMN vs_story_status TEXT;
ALTER TABLE contest_matches ADD COLUMN vs_story_attempts INTEGER NOT NULL DEFAULT 0;
-- Lease token + time. A crashed worker's lease expires and the cron reclaims it.
ALTER TABLE contest_matches ADD COLUMN vs_story_claim TEXT;
ALTER TABLE contest_matches ADD COLUMN vs_story_claimed_at INTEGER;
-- Earliest time the next attempt may run (exponential backoff).
ALTER TABLE contest_matches ADD COLUMN vs_story_next_at INTEGER;
ALTER TABLE contest_matches ADD COLUMN vs_story_error TEXT;
ALTER TABLE contest_matches ADD COLUMN vs_story_published_at INTEGER;
-- Generation metadata for the composite in vs_image_url (renderer, version,
-- dimensions, bytes, the shared story timestamp). JSON.
ALTER TABLE contest_matches ADD COLUMN vs_image_meta TEXT;

-- The reconciliation sweep reads only due, unfinished publications.
CREATE INDEX IF NOT EXISTS idx_matches_vs_story_due
  ON contest_matches(vs_story_status, vs_story_next_at)
  WHERE vs_story_status IN ('pending', 'processing');

-- At most one contest VS Story per (battle, owner). Story ids are also
-- deterministic, but this is the constraint that makes a duplicate impossible
-- regardless of how a row was written. Any pre-existing duplicate pair (none is
-- expected: the legacy writer ran once per join) is collapsed first so the index
-- can be created; these rows are 24h-ephemeral.
DELETE FROM stories
 WHERE type = 'contest_vs'
   AND match_id IS NOT NULL
   AND rowid NOT IN (
     SELECT MIN(rowid) FROM stories
      WHERE type = 'contest_vs' AND match_id IS NOT NULL
      GROUP BY match_id, user_id
   );
CREATE UNIQUE INDEX IF NOT EXISTS uniq_stories_contest_vs_owner
  ON stories(match_id, user_id)
  WHERE type = 'contest_vs';

-- Reference-aware cleanup of the shared composite looks stories up by match.
CREATE INDEX IF NOT EXISTS idx_stories_match ON stories(match_id) WHERE match_id IS NOT NULL;
