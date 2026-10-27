-- Qencode replaces Bunny Stream as the video provider (MEDIA_ARCHITECTURE.md).
--
-- DDL-only and idempotent, same rules as 0017: autoMigrate has no distributed
-- lock, so ADD COLUMN must be safe to race (isIgnorable() swallows "duplicate
-- column name"). No data statements.
--
-- The `videos` table keeps its shape and lifecycle (uploading -> processing ->
-- ready | failed). Two columns are new because Qencode works differently from
-- Bunny:
--
--  * job_id     Qencode's task_token. Bunny's guid was both our row id and the
--               provider's handle; with Qencode the row id is OUR uuid (it names
--               the R2 output folder `videos/<id>/`) and the job is a separate
--               handle used to poll /v1/status.
--  * source_key The R2 key of the raw upload (`video-src/<random>.<ext>`) that
--               Qencode pulls from. Deleted once the encode is ready or failed;
--               a row with a source_key and no job_id is an encode that still
--               has to be started (the reconcile cron retries it).

ALTER TABLE videos ADD COLUMN job_id TEXT;
ALTER TABLE videos ADD COLUMN source_key TEXT;
