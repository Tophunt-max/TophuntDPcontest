-- "Not interested" on a For You card (negative feedback).
--
-- One row per (viewer, battle). The dismissed battle is removed from that
-- viewer's For You and Following feeds, and other battles featuring the same
-- creators are demoted by the `notInterested` ranking weight
-- (lib/feedWeights.ts). The creators are captured at dismissal time so the
-- demotion does not need a join back to contest_matches on the feed path.
--
-- Only the viewer's own feed reads this, so the (viewer_uid, match_id) primary
-- key covers the idempotent insert/delete, and the (viewer_uid, created_at)
-- index serves the "most recent N" load the feed does on every request.
-- Retention: rows older than 90 days are pruned for the viewer on each new
-- dismissal, and all of a viewer's rows go with account deletion.
CREATE TABLE IF NOT EXISTS feed_dismissals (
  viewer_uid  TEXT NOT NULL,
  match_id    TEXT NOT NULL,
  creator_a   TEXT,
  creator_b   TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (viewer_uid, match_id)
);

CREATE INDEX IF NOT EXISTS idx_feed_dismissals_viewer_created
  ON feed_dismissals (viewer_uid, created_at);
