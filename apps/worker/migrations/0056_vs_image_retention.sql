-- Retention for the shared VS composite (contest_matches.vs_image_url).
--
-- Migration 0055 tied the composite's lifetime to the 24h VS Stories. But the
-- same image is the canonical SHARE asset for the battle — feed share sheet,
-- Story share, Save image and the /battle/<id> link preview — and a battle keeps
-- being shared for its whole voting window. Deleting the card at 24h made every
-- later share fall back to a link (or, in the link preview, to ONE participant's
-- photo).
--
-- vs_image_retain_until = end of voting + grace, extended whenever a share
-- resolves the image. The cleanup sweep deletes the object only once this has
-- passed AND no live Story references it. NULL (pre-0056 rows) falls back to the
-- previous story-expiry rule. No existing data is modified.
ALTER TABLE contest_matches ADD COLUMN vs_image_retain_until INTEGER;

CREATE INDEX IF NOT EXISTS idx_matches_vs_image_retain
  ON contest_matches(vs_image_retain_until)
  WHERE vs_image_url IS NOT NULL;
