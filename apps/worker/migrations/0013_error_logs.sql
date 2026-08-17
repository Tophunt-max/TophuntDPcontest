-- Server error trail surfaced in the admin panel (see src/lib/observability.ts).
-- Written from app.onError; pruned by retention in the cron.
CREATE TABLE IF NOT EXISTS error_logs (
  id          TEXT PRIMARY KEY,
  level       TEXT NOT NULL DEFAULT 'error',
  message     TEXT NOT NULL,
  stack       TEXT,
  request_id  TEXT,
  path        TEXT,
  method      TEXT,
  status      INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_error_logs_created ON error_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_error_logs_level ON error_logs (level);
