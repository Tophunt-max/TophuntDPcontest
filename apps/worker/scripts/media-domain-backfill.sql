-- ===========================================================================
-- Move existing media urls from the Worker proxy onto the media domain.
--
--   https://tophunt-api.weadown-in.workers.dev/media/<key>  ->  https://media.tophunt.in/<key>
--
-- ---------------------------------------------------------------------------
-- WHY THIS IS A SCRIPT AND NOT A MIGRATION IN migrations/
-- ---------------------------------------------------------------------------
-- Files in migrations/ are applied AUTOMATICALLY by the Worker on the first
-- request of a fresh isolate (src/db/autoMigrate.ts). This rewrite is only
-- correct once `media.tophunt.in` actually resolves to the R2 bucket, and that
-- is a Cloudflare dashboard action no deploy can verify. As a migration it would
-- fire the instant the new code shipped and, if the custom domain were not ready,
-- would silently repoint EVERY image and video in the product at a dead host.
--
-- So it is deliberately a manual, operator-gated step. Run it when you have
-- checked the domain, not when you happen to deploy.
--
-- ---------------------------------------------------------------------------
-- HOW TO RUN
-- ---------------------------------------------------------------------------
--   cd apps/worker
--
--   # 0. The domain must already serve bytes. Use a key you know exists —
--   #    scripts/media-domain-report.sql tells you which tables have rows.
--   curl -I https://media.tophunt.in/<some-existing-key>      # expect 200
--
--   # 1. Count what is about to change (read-only).
--   npx wrangler d1 execute tophunt-db --remote --file=scripts/media-domain-report.sql
--
--   # 2. Rewrite.
--   npx wrangler d1 execute tophunt-db --remote --file=scripts/media-domain-backfill.sql
--
--   # 3. Confirm every count is now 0.
--   npx wrangler d1 execute tophunt-db --remote --file=scripts/media-domain-report.sql
--
-- Idempotent: every statement is guarded by a LIKE, so a second run touches no
-- rows. Safe to re-run after a partial failure.
--
-- Rollback: D1 Time Travel covers the last 30 days —
--   npx wrangler d1 time-travel info tophunt-db          (before running, note the bookmark)
--   npx wrangler d1 time-travel restore tophunt-db --bookmark=<bookmark>
-- Nothing user-visible breaks either way: `/media/*` keeps serving the old urls
-- and R2_LEGACY_BASE_URLS keeps deletes correct on both hosts.
--
-- ---------------------------------------------------------------------------
-- WHAT IS COVERED
-- ---------------------------------------------------------------------------
-- Plain url columns AND the JSON blobs, which is the half that is easy to miss
-- and holds the most traffic:
--   contest_matches.user_a / user_b  — the participant snapshots ARE the feed's
--                                      media; missing these leaves the busiest
--                                      images in the app on the Worker proxy
--   chats.users_data / last_message  — chat-list avatars
--   settings.data                    — paymentGateway.qrImageUrl, the UPI QR
--   notifications.data, broadcast_jobs.data
--   blog_posts.content               — imported posts embed R2 <img> urls in HTML
-- The urls are literal text inside those documents, so SQLite's replace() is
-- exactly the right tool and no JSON parsing is needed.
--
-- Do NOT rewrite blog_posts.canonical_url / original_url: those are the ORIGINAL
-- tophunt.in permalinks used for dedup and canonical tags, not media.
-- ===========================================================================

UPDATE users SET profile_image_url = replace(profile_image_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE profile_image_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE contests SET banner_url = replace(banner_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE banner_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE contest_matches SET user_a = replace(user_a, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE user_a LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE contest_matches SET user_b = replace(user_b, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE user_b LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE contest_matches SET vs_image_url = replace(vs_image_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE vs_image_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE posts SET media_url = replace(media_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE media_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE stories SET media_url = replace(media_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE media_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE stories SET avatar_url = replace(avatar_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE avatar_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE highlights SET cover_image_url = replace(cover_image_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE cover_image_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE notifications SET image = replace(image, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE image LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE notifications SET data = replace(data, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE data LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE blog_posts SET cover_image_url = replace(cover_image_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE cover_image_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE blog_posts SET content = replace(content, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE content LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE deposits SET screenshot_url = replace(screenshot_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE screenshot_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE videos SET thumbnail_url = replace(thumbnail_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE thumbnail_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE videos SET playback_url = replace(playback_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE playback_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE videos SET mp4_url = replace(mp4_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE mp4_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE videos SET r2_source_url = replace(r2_source_url, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE r2_source_url LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE scheduled_notifications SET image = replace(image, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE image LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE broadcast_jobs SET image = replace(image, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE image LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE broadcast_jobs SET data = replace(data, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE data LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE chats SET users_data = replace(users_data, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE users_data LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE chats SET last_message = replace(last_message, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE last_message LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';

UPDATE settings SET data = replace(data, 'https://tophunt-api.weadown-in.workers.dev/media/', 'https://media.tophunt.in/')
  WHERE data LIKE '%https://tophunt-api.weadown-in.workers.dev/media/%';
