-- Index the battle participants (stored inside the userA/userB JSON) so the
-- profile query `WHERE json_extract(user_a,'$.uid') = ? OR json_extract(user_b,
-- '$.uid') = ?` uses an index instead of a full table scan. The index
-- expression must match the query expression exactly for SQLite to use it.
CREATE INDEX IF NOT EXISTS idx_matches_user_a_uid
  ON contest_matches (json_extract(user_a, '$.uid'));

CREATE INDEX IF NOT EXISTS idx_matches_user_b_uid
  ON contest_matches (json_extract(user_b, '$.uid'));
