-- User-level blocking and muting.
--
-- `users.is_blocked` already existed, but it is an ADMIN action against an
-- account: it disables the login entirely. That answers a different question
-- from "I do not want this person near me", and until now there was no answer
-- to that at all — someone being harassed could only file a report and wait for
-- a human. Both app stores require the self-serve version for an app carrying
-- user-generated content, so its absence was also a review risk.
--
-- Two tables rather than one with a `kind` column, because the two relations
-- have genuinely different semantics AND different query shapes:
--
--   user_blocks is MUTUAL and hard. Once A blocks B, neither sees the other
--   anywhere and every interaction write between them is refused. Enforcement
--   therefore has to answer "is there an edge in EITHER direction", which is why
--   there is an index on blocked_id in addition to the (blocker_id, blocked_id)
--   primary key — without it the reverse lookup scans the table on every read.
--
--   user_mutes is ONE-WAY and soft. The muter stops seeing the muted user's
--   content in their feed and stories; the muted user is never told, and can
--   still follow, message and interact normally. Only the muter's own reads
--   consult it, so the leading-column primary key is sufficient and no reverse
--   index is needed.
--
-- Blocking deliberately does NOT delete history. Existing votes, comments and
-- settled matches stay exactly as they are, because contest results and the
-- coin ledger reference them and a prize that was already paid cannot be
-- retracted because of a later falling-out. Only visibility and the ability to
-- interact from this point on change. The one exception is the follow edge,
-- which is removed in both directions by the block action itself — leaving it
-- in place would keep feeding the blocked user's content into the "Following"
-- tab and keep the blocker in the blocked user's follower list.
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id  TEXT NOT NULL,
  blocked_id  TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

-- Reverse direction: "who has blocked me". Required because blocks are mutual
-- and blocked_id is the TRAILING primary-key column (same reason
-- idx_profile_visits_visitor exists — see migration 0021).
CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);

CREATE TABLE IF NOT EXISTS user_mutes (
  muter_id    TEXT NOT NULL,
  muted_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (muter_id, muted_id)
);
