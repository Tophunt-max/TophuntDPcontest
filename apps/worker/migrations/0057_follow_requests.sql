-- Follow requests for private accounts.
--
-- Until now `users.is_private` only gated Stories: `toggleFollow` inserted the
-- follow edge straight away, so anyone could follow a private account and then
-- see everything. A follow of a private account is now a PENDING request that
-- the owner confirms or deletes. Only a confirmed request becomes a `follows`
-- row, so every existing reader of `follows` (feed, Stories audience, counters,
-- connections) stays correct without knowing requests exist.
--
-- A separate table rather than a status column on `follows`: a status column
-- would make every one of those readers responsible for filtering pending rows,
-- and one forgotten filter is a privacy leak.
--
-- No existing data is modified. Existing follows of private accounts stay.
CREATE TABLE IF NOT EXISTS follow_requests (
  requester_id TEXT NOT NULL,
  target_id    TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (requester_id, target_id)
);

-- The owner's "Follow requests" list: newest first, keyset-paginated.
CREATE INDEX IF NOT EXISTS idx_follow_requests_target_created
  ON follow_requests(target_id, created_at);

-- Requesting account deletion forces `is_private` on so the account drops out of
-- view at once. Cancelling never put it back, because the old value was not
-- kept. That was harmless while "private" only hid Stories; with the lock above
-- it would leave every reactivated account with a locked profile and
-- request-only follows nobody chose. The value at request time is now kept and
-- restored on cancel. NULL (requests made before this migration) keeps the old
-- behaviour: the account stays private and the owner can switch it off.
ALTER TABLE deletion_requests ADD COLUMN was_private INTEGER;
