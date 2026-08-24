-- Cron heartbeat.
--
-- `scheduled()` used to fire every job inside ctx.waitUntil and log nothing on
-- completion, so a cron that stopped firing was undetectable and a job that threw
-- only produced a console.error nobody was watching — while contest settlement,
-- refunds and payouts silently stopped happening.
--
-- One row per run gives a heartbeat, a duration metric (is the 10-minute job
-- about to overrun its window?) and a failure trail that both the deep health
-- check and the admin panel can read.
CREATE TABLE IF NOT EXISTS cron_runs (
  id          TEXT PRIMARY KEY,
  job         TEXT NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 1,
  duration_ms INTEGER,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);

-- "latest run for this job" is the only query shape.
CREATE INDEX IF NOT EXISTS idx_cron_runs_job_created ON cron_runs(job, created_at);
