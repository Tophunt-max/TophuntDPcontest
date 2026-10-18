-- Onboarding (first-launch intro) funnel, aggregated per day.
--
-- One counter row per (day, event, slide, platform). The app sends an event
-- when a new guest's intro is shown, reaches each slide, is skipped, is
-- completed, or taps "Log in". There is no user id, device id or IP here: only
-- counts, which is all the admin panel's funnel needs.
--
-- About 4 events x 6 slides x 3 platforms rows per day at most, so the table
-- stays small without a pruning job. No existing data is modified.
CREATE TABLE IF NOT EXISTS onboarding_daily (
  day      TEXT    NOT NULL, -- UTC 'YYYY-MM-DD'
  event    TEXT    NOT NULL, -- shown | reached | skipped | completed | login
  slide    INTEGER NOT NULL, -- 0-based slide index; -1 when not slide-specific
  platform TEXT    NOT NULL, -- ios | android | web | other
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, event, slide, platform)
);
