-- ===========================================================================
-- How much media is still on the OLD (Worker-proxied) base?
--
-- Read-only. Run this BEFORE and AFTER media-domain-backfill.sql:
--
--   cd apps/worker
--   npx wrangler d1 execute tophunt-db --remote --file=scripts/media-domain-report.sql
--
-- After a successful backfill every `remaining` value must be 0. A non-zero row
-- means that column still holds urls on the legacy host — which is not broken
-- (the Worker's /media/* route still serves them, and R2_LEGACY_BASE_URLS keeps
-- deletes correct) but those objects are still costing a Worker invocation per
-- request and can never be served as a resized Transformations variant.
--
-- Keep this in sync with media-domain-backfill.sql. If you add a column there,
-- add it here — an un-reported column is an un-noticed one.
-- ===========================================================================

SELECT 'users.profile_image_url' AS column_name, COUNT(*) AS remaining FROM users
  WHERE profile_image_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'contests.banner_url', COUNT(*) FROM contests
  WHERE banner_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'contest_matches.user_a', COUNT(*) FROM contest_matches
  WHERE user_a LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'contest_matches.user_b', COUNT(*) FROM contest_matches
  WHERE user_b LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'contest_matches.vs_image_url', COUNT(*) FROM contest_matches
  WHERE vs_image_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'posts.media_url', COUNT(*) FROM posts
  WHERE media_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'stories.media_url', COUNT(*) FROM stories
  WHERE media_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'stories.avatar_url', COUNT(*) FROM stories
  WHERE avatar_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'highlights.cover_image_url', COUNT(*) FROM highlights
  WHERE cover_image_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'notifications.image', COUNT(*) FROM notifications
  WHERE image LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'notifications.data', COUNT(*) FROM notifications
  WHERE data LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'blog_posts.cover_image_url', COUNT(*) FROM blog_posts
  WHERE cover_image_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'blog_posts.content', COUNT(*) FROM blog_posts
  WHERE content LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'deposits.screenshot_url', COUNT(*) FROM deposits
  WHERE screenshot_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'videos.thumbnail_url', COUNT(*) FROM videos
  WHERE thumbnail_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'videos.playback_url', COUNT(*) FROM videos
  WHERE playback_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'videos.mp4_url', COUNT(*) FROM videos
  WHERE mp4_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'videos.r2_source_url', COUNT(*) FROM videos
  WHERE r2_source_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'scheduled_notifications.image', COUNT(*) FROM scheduled_notifications
  WHERE image LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'broadcast_jobs.image', COUNT(*) FROM broadcast_jobs
  WHERE image LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'broadcast_jobs.data', COUNT(*) FROM broadcast_jobs
  WHERE data LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'chats.users_data', COUNT(*) FROM chats
  WHERE users_data LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'chats.last_message', COUNT(*) FROM chats
  WHERE last_message LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%'
UNION ALL SELECT 'settings.data', COUNT(*) FROM settings
  WHERE data LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';
