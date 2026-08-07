-- Admin panel activity feed (was Firestore `admin_notifications`).
CREATE TABLE IF NOT EXISTS admin_notifications (
  id TEXT PRIMARY KEY,
  title TEXT,
  message TEXT,
  link TEXT,
  is_read INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_notif_created ON admin_notifications (created_at);
