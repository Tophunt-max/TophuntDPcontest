-- Partial index for the unread-notification counter (routes/read.ts
-- GET /notifications/unread-count), which is polled by every signed-in client:
--   SELECT count(*) FROM notifications WHERE recipient_id = ? AND read = 0
--
-- The existing idx_notif_recipient (recipient_id, created_at) covers the list
-- query but NOT this filter, so the count previously scanned all of a user's
-- rows and filtered read=0 in memory. This partial index contains ONLY unread
-- rows, so the count is an index-only scan whose size is the (usually tiny)
-- unread set — it doesn't grow with a user's total notification history.
CREATE INDEX IF NOT EXISTS idx_notif_unread
  ON notifications (recipient_id)
  WHERE read = 0;
