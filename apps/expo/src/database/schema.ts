import { appSchema, tableSchema } from '@nozbe/watermelondb';

/**
 * Local (offline) schema: the stories cache, its pending-action queue, and (v5)
 * the Home feed snapshot.
 *
 * Notes for anyone editing this file:
 *
 * - Do NOT declare an `id` column. WatermelonDB manages `id` itself on every
 *   table; adding it here and decorating it in a model shadows `Model#id` and
 *   breaks record identity.
 * - Every table declares `updated_at` because all three models expose a
 *   `@readonly @date('updated_at')` property. WatermelonDB touches that column
 *   automatically on write, so the column has to exist or the write fails.
 * - `created_at` / `expires_at` on `stories` hold the *server's* epoch-ms
 *   timestamps. Only `updated_at` is auto-managed by WatermelonDB, so these two
 *   are safe to own ourselves.
 */
export const schema = appSchema({
  version: 6,
  tables: [
    tableSchema({
      name: 'stories',
      columns: [
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'username', type: 'string' },
        { name: 'avatar_url', type: 'string' },
        { name: 'media_url', type: 'string' },
        { name: 'media_type', type: 'string' }, // 'image' | 'video'
        { name: 'created_at', type: 'number' }, // server timestamp, epoch ms
        { name: 'expires_at', type: 'number', isIndexed: true }, // epoch ms
        { name: 'seen', type: 'boolean' },
        { name: 'overlay_text', type: 'string', isOptional: true },
        { name: 'text_position', type: 'string', isOptional: true }, // JSON
        { name: 'mentions', type: 'string', isOptional: true }, // JSON
        // Contest-story fields (schema v2). Without these three, a battle story
        // read back from the cache lost what marks it as a battle: the viewer's
        // `isVsStory()` needs both `type` and `match_id`, so a cached story fell
        // through to the plain single-photo branch and showed only that user's
        // own entry instead of the merged head-to-head frame. All optional
        // because a normal `user` story carries none of them.
        { name: 'match_id', type: 'string', isOptional: true, isIndexed: true },
        { name: 'type', type: 'string', isOptional: true }, // StoryKind
        { name: 'contest_title', type: 'string', isOptional: true },
        // Soundtrack fields (schema v3). The same omission as the contest fields
        // above, one feature later: without these the cache read a story back
        // with no `music_preview_url`, and the viewer gates BOTH the audio player
        // and the music pill on that one value — so a story published with a
        // track played silently and showed no pill. The client only ever sends a
        // track id; title/artist/artwork/preview are resolved server-side, so the
        // cache is the only local copy and dropping it loses them outright.
        { name: 'music_track_id', type: 'string', isOptional: true },
        { name: 'music_title', type: 'string', isOptional: true },
        { name: 'music_artist', type: 'string', isOptional: true },
        { name: 'music_artwork_url', type: 'string', isOptional: true },
        { name: 'music_preview_url', type: 'string', isOptional: true },
        // Which part of the track plays (schema v4). Optional and a number, so an
        // absent value reads as null and means "from the beginning" — the same
        // thing it means in the column and on the wire.
        { name: 'music_start_ms', type: 'number', isOptional: true },
        { name: 'is_synced', type: 'boolean', isIndexed: true },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'user_stories',
      columns: [
        // Mirrors the record id, kept as a column so it stays queryable.
        { name: 'user_id', type: 'string', isIndexed: true },
        { name: 'username', type: 'string' },
        { name: 'avatar_url', type: 'string' },
        { name: 'has_unseen', type: 'boolean' },
        { name: 'last_fetched', type: 'number' },
        { name: 'stories', type: 'string' }, // JSON array of story ids
        { name: 'updated_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'pending_actions',
      columns: [
        { name: 'type', type: 'string', isIndexed: true }, // view | reaction | create | delete
        { name: 'story_id', type: 'string' },
        { name: 'user_id', type: 'string' },
        { name: 'data', type: 'string' }, // JSON payload
        { name: 'timestamp', type: 'number', isIndexed: true },
        { name: 'retries', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
    // Home feed first-page snapshot (schema v5) — see src/lib/feedSnapshot.ts.
    //
    // One row per (viewer, tab); the record id is `${owner}|${tab}`, so a refresh
    // is an idempotent upsert and the table holds at most two rows (rows owned by
    // any other viewer are deleted on every write and on account change). `items`
    // is a size-capped JSON array of match SUMMARIES — URLs only, never media bytes
    // or data: URIs; the bytes stay in expo-image / the video cache.
    tableSchema({
      name: 'feed_snapshots',
      columns: [
        { name: 'owner', type: 'string', isIndexed: true }, // `u:<uid>` | 'guest'
        { name: 'tab', type: 'string' }, // 'foryou' | 'following'
        { name: 'items', type: 'string' }, // JSON array (sanitised, capped)
        { name: 'next_cursor', type: 'string', isOptional: true },
        { name: 'fetched_at', type: 'number' }, // epoch ms of the network read
        { name: 'format', type: 'number' }, // snapshot payload format version
        { name: 'updated_at', type: 'number' },
      ],
    }),
    // Offline social outbox (schema v6) — see src/sync/outbox.ts and
    // docs/LOCAL_DATA.md. One row per (account, kind, target); only the
    // replay-safe kinds listed in outbox.ts are ever written.
    tableSchema({
      name: 'outbox_ops',
      columns: [
        { name: 'account', type: 'string', isIndexed: true }, // uid that made the change
        { name: 'kind', type: 'string' }, // 'match.like' | 'match.bookmark' | 'user.follow'
        { name: 'target', type: 'string' }, // match id or user id
        { name: 'op_key', type: 'string', isIndexed: true }, // `${account}|${kind}|${target}`
        { name: 'payload', type: 'string' }, // JSON target state
        { name: 'status', type: 'string' }, // 'pending' | 'failed'
        { name: 'attempts', type: 'number' },
        { name: 'revision', type: 'number' },
        { name: 'next_attempt_at', type: 'number', isIndexed: true },
        { name: 'last_error', type: 'string', isOptional: true },
        { name: 'created_at', type: 'number' },
        { name: 'updated_at', type: 'number' },
      ],
    }),
  ],
});
