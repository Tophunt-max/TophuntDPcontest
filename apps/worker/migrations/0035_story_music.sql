-- Music attached to a story.
--
-- The editor already had a whole music picker — search field, result list,
-- draggable "now playing" sticker, play/pause — and none of it survived pressing
-- Next. `createStory` accepted mediaUrl, mediaType, overlayText, textPosition,
-- mentions and visibility, so the chosen track was dropped on the floor at the
-- last step. These columns are where it goes.
--
-- WHY THE FIELDS ARE DENORMALISED ONTO THE STORY rather than a `tracks` table
-- with a foreign key:
--
--   A story lives 24 hours and is then deleted by cron. A shared track table
--   would therefore need its own reference-counting or garbage collection to
--   avoid growing forever with rows nothing points at — real work, to normalise
--   four short strings that are never queried, aggregated or joined. They are
--   read only as part of the story that owns them.
--
-- WHY `music_preview_url` IS STORED even though it is someone else's CDN:
--
--   We do not host the audio. Playback needs a URL, and the alternative — asking
--   the provider to resolve the track id again at read time — would be one
--   outbound subrequest per story per viewer, on a screen that renders a whole
--   reel. The Worker's subrequest ceiling is 50; a reel of 20 stories would blow
--   through it. So the URL is resolved ONCE, when the story is created.
--
--   Every reader must treat a dead preview URL as "no music" and keep showing the
--   story. These links can rotate, and a story is not broken because its audio
--   is gone.
--
-- WHY THE CLIENT CANNOT SET THESE DIRECTLY:
--
--   `createStory` takes only `musicTrackId` and resolves the rest server-side.
--   Accepting a client-supplied URL here would mean any caller could have an
--   arbitrary URL embedded in every viewer's browser as a media load — a
--   ready-made way to log the IP and user-agent of everyone who watches a story,
--   from a domain the viewer trusts. Re-resolving costs one subrequest on a rate
--   -limited, once-per-story write path, and removes that class of abuse outright.
--
-- All nullable, and they stay nullable: music is optional, most stories will have
-- none, and the provider lookup is allowed to fail without failing the upload.
ALTER TABLE stories ADD COLUMN music_track_id TEXT;
ALTER TABLE stories ADD COLUMN music_title TEXT;
ALTER TABLE stories ADD COLUMN music_artist TEXT;
ALTER TABLE stories ADD COLUMN music_artwork_url TEXT;
ALTER TABLE stories ADD COLUMN music_preview_url TEXT;

-- No index. These columns are never a filter or a sort key — they are read only
-- via the story row that already came back from `idx_stories_created` /
-- `idx_stories_user`. An index here would be pure write cost on the story
-- creation path.
