-- Scope admin notifications by the role that should see them.
--
-- The /admin gate admits moderators (content moderation only), and the admin
-- notification feed now carries financial events — payout requests, refund
-- clawbacks, chargebacks, cron failures. Those name users and amounts, so they
-- belong to full admins, while report/moderation alerts belong to everyone with
-- panel access.
--
-- Existing rows are backfilled from their link, which is a reliable signal: the
-- finance pages are the only ones the money alerts ever pointed at.
ALTER TABLE admin_notifications ADD COLUMN scope TEXT NOT NULL DEFAULT 'finance';

UPDATE admin_notifications
   SET scope = 'moderation'
 WHERE link LIKE '/reports%' OR link LIKE '/support%' OR link LIKE '/comments%';

CREATE INDEX IF NOT EXISTS idx_admin_notif_scope ON admin_notifications(scope, created_at);
