-- Gamification visual layer: stable asset keys on the default cosmetics, and
-- the Champion frame granted with the level-50 milestone (lib/progression.ts).
-- Additive. The app maps `asset.key` to its vector artwork
-- (apps/expo/src/lib/gamificationAssets.ts); items without one fall back by id
-- and rarity, so nothing here is required for older rows.
UPDATE reward_catalog SET asset = json_set(asset, '$.key', 'frame.bronze') WHERE id = 'frame_bronze' AND json_extract(asset, '$.key') IS NULL;
UPDATE reward_catalog SET asset = json_set(asset, '$.key', 'frame.silver') WHERE id = 'frame_silver' AND json_extract(asset, '$.key') IS NULL;
UPDATE reward_catalog SET asset = json_set(asset, '$.key', 'frame.gold') WHERE id = 'frame_gold_animated' AND json_extract(asset, '$.key') IS NULL;
UPDATE reward_catalog SET asset = json_set(asset, '$.key', 'frame.champion') WHERE id = 'frame_diamond_animated' AND json_extract(asset, '$.key') IS NULL;
UPDATE reward_catalog SET asset = json_set(asset, '$.key', 'frame.legendary') WHERE id = 'frame_legendary' AND json_extract(asset, '$.key') IS NULL;
INSERT OR IGNORE INTO reward_catalog (id, type, name, description, rarity, asset, sort, created_at, updated_at) VALUES
  ('frame_champion', 'frame', 'Champion Frame', 'Unlocked at level 50 with the Champion title.', 'epic', '{"key":"frame.champion","colors":["#B39DFF","#5B21B6"],"animated":false}', 35, 0, 0);
