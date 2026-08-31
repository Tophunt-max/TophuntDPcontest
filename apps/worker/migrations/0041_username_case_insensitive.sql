-- Case-insensitive username uniqueness, case-preserving display.
--
-- Usernames used to be forced to lowercase on every write, so the display was
-- always lowercase and the unique index (migration 0012) could stay a plain
-- binary-collation index. We now PRESERVE the case the user typed (so "Alice"
-- shows as "Alice"), which means "Alice" and "alice" must still be treated as
-- the SAME name for uniqueness — otherwise two accounts could differ only by
-- case. SQLite's default TEXT comparison is case-sensitive, so the unique index
-- is recreated with COLLATE NOCASE to enforce that at the database level.
--
-- Existing rows are all lowercase (every prior write lowercased them), so the
-- NOCASE index cannot collide with current data — this is safe to apply in
-- place. LIKE-based search is already case-insensitive in SQLite, so it is
-- unaffected; only equality/uniqueness needed the collation change.

DROP INDEX IF EXISTS idx_users_username;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username
  ON users (username COLLATE NOCASE)
  WHERE username IS NOT NULL;
