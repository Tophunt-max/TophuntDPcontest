-- Partial index for the notification BADGE count.
--
-- DDL-only and idempotent (AUDIT_2026-08-23.md #15 — autoMigrate has no
-- distributed lock, so this file may run concurrently across colos).
--
-- Background: `read` was being used as if it meant `seen`. Opening the
-- notifications screen marked EVERY row read, including ones the user never
-- looked at, so `read` carried no real signal about what had been opened.
--
-- The two are now separated:
--   seen = the row was present when the user last opened the list  -> drives the
--          bell badge and the "new" row highlight
--   read = the user actually tapped through to the content
--
-- migration 0016 added idx_notif_unread as a partial index on `read = 0` to make
-- the badge COUNT an index-only scan. Now that the badge counts UNSEEN rows
-- instead, it needs the equivalent index on `seen = 0`, otherwise that
-- frequently-polled count degrades into a full scan of the user's history.
--
-- idx_notif_unread is deliberately KEPT: markAllNotificationsRead still filters
-- on read = 0.
CREATE INDEX IF NOT EXISTS idx_notif_unseen
  ON notifications (recipient_id)
  WHERE seen = 0;
