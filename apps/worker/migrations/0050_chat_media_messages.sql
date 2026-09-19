-- Image/media messages in DMs.
--
-- Message bodies live in the per-chat ChatArchive Durable Object (see
-- src/chatArchive.ts); that DO self-migrates its own SQLite table to add these
-- columns. This migration mirrors them onto the D1 `messages` table for two
-- reasons:
--
--   1. The DO SEEDS itself from these D1 rows on first touch, so a pre-media row
--      must be able to carry a `type`/`media_url` (they default to a text
--      message, which is what every existing row is).
--   2. `/read/chats/:id/messages` falls back to reading D1 directly if the DO
--      read fails, and that fallback must return media messages too.
--
-- `type` defaults to 'text' so every existing row backfills to a plain text
-- message in one statement. `media_url` is nullable (only image messages set it).
-- DDL-only and append-only: never edit this file once it has been applied.
ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN media_url TEXT;
