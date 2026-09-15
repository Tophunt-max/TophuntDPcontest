-- chat_members: an indexed membership edge, replacing the correlated
-- EXISTS(json_each(chats.users)) that scanned the whole `chats` table.
--
-- D1_R2_LOAD_AUDIT.md §4 named the un-LIMITed /read/chats scan the single worst
-- query in the codebase. `chats.users` is a JSON array, so membership could only
-- be tested by expanding it with json_each inside a correlated subquery — which no
-- index can serve, so every chat-list open, every "chat between these two users"
-- check, and every logout-all/deletion sweep read the entire table.
--
-- Membership here is IMMUTABLE: a chat is created with exactly two participants and
-- never gains or loses one (no group chats, no add/remove). That is what makes this
-- table cheap to keep correct — it is written once at chat creation and deleted with
-- the chat, and nothing else ever touches it.
--
-- DDL is idempotent (IF NOT EXISTS) and the backfill is INSERT OR IGNORE, so this
-- file is safe under autoMigrate's lock-free, possibly-concurrent apply across colos
-- (AUDIT_2026-08-23.md #15) and safe to re-run after a partial failure.

CREATE TABLE IF NOT EXISTS chat_members (
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  -- (user_id, chat_id): the leading column serves the hot path — "every chat this
  -- user is in" — as an index seek instead of a table scan.
  PRIMARY KEY (user_id, chat_id)
);

-- Reverse lookup: "every member of this chat", used when a chat is deleted. Without
-- it, DELETE ... WHERE chat_id = ? would scan the table the composite PK orders by
-- user_id.
CREATE INDEX IF NOT EXISTS idx_chat_members_chat ON chat_members (chat_id);

-- Backfill from the JSON arrays already stored on every existing chat. json_each is
-- used ONCE here, offline, to retire it from the hot paths — the opposite of the
-- per-request scans this migration removes. INSERT OR IGNORE keeps it idempotent.
INSERT OR IGNORE INTO chat_members (user_id, chat_id)
  SELECT je.value, c.id
    FROM chats c, json_each(c.users) je
   WHERE je.value IS NOT NULL;
