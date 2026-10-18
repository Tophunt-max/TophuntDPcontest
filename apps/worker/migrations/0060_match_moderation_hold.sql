-- Community moderation hold for battles.
--
-- When enough DIFFERENT users report a battle (routes/api.ts createReport,
-- MATCH_REPORT_HOLD_THRESHOLD), it is stamped here and dropped from the shared
-- feeds (For You pool, recent/hot lists) until an admin reviews it in Reports:
-- "dismiss" clears the hold, "remove" cancels the battle as before.
--
-- Deliberately NOT a status change: `status` drives settlement and money, and a
-- held battle must still settle (or refund) exactly as it would have. The battle
-- page itself stays reachable by direct link.
--
-- Additive, nullable, no default rewrite: safe on a live table.
ALTER TABLE contest_matches ADD COLUMN moderation_hold_at INTEGER;

-- One report per reporter per target: repeated taps must not stack reports or
-- reach the hold threshold on their own. Existing duplicates are collapsed FIRST
-- (oldest kept), or the unique index would fail on a table that already has them
-- and block every later migration. NULL reporter/target rows are left alone; the
-- index treats NULLs as distinct anyway.
DELETE FROM reports
WHERE reporter_id IS NOT NULL AND target_id IS NOT NULL
  AND rowid NOT IN (
    SELECT MIN(rowid) FROM reports
    WHERE reporter_id IS NOT NULL AND target_id IS NOT NULL
    GROUP BY reporter_id, target_type, target_id
  );
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reports_reporter_target ON reports (reporter_id, target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_reports_target ON reports (target_type, target_id);
