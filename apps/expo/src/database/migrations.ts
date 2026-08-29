import { schemaMigrations, addColumns } from '@nozbe/watermelondb/Schema/migrations';

/**
 * Schema migrations for the local stories cache.
 *
 * These MUST stay in lockstep with `schema.ts`: the adapter migrates an existing
 * on-device database from its stored version up to the schema version, applying
 * each step. A column added to `schema.ts` without a matching `addColumns` step
 * here throws for every user who already has a cache, while the reverse leaves
 * the new column missing on upgraded devices — either way the stories layer then
 * falls back to the network (see `adapter.ts` onSetUpError), which is safe but
 * defeats the cache.
 *
 * Note `Migration` is not an export of `@nozbe/watermelondb` — migrations must
 * be built through `schemaMigrations()`, which returns the validated shape the
 * adapter expects.
 */
export const migrations = schemaMigrations({
  migrations: [
    {
      // v2 adds the contest-story fields to the stories table. Existing cached
      // rows get NULLs, which is correct: a plain `user` story has no match, no
      // contest type and no title, and a battle story that predates this upgrade
      // is re-fetched from the network on the next feed load and re-saved WITH
      // these fields, at which point it renders as a proper VS frame.
      toVersion: 2,
      steps: [
        addColumns({
          table: 'stories',
          columns: [
            { name: 'match_id', type: 'string', isOptional: true, isIndexed: true },
            { name: 'type', type: 'string', isOptional: true },
            { name: 'contest_title', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      // v3 adds the soundtrack fields. Existing cached rows get NULLs, which
      // reads as "no music" — the same shape as a story published without a
      // track, so nothing renders wrongly in the meantime. Those rows are
      // re-fetched and re-saved WITH the music on the next forced feed refresh
      // (or when they expire after 24h), at which point the pill and audio
      // appear.
      toVersion: 3,
      steps: [
        addColumns({
          table: 'stories',
          columns: [
            { name: 'music_track_id', type: 'string', isOptional: true },
            { name: 'music_title', type: 'string', isOptional: true },
            { name: 'music_artist', type: 'string', isOptional: true },
            { name: 'music_artwork_url', type: 'string', isOptional: true },
            { name: 'music_preview_url', type: 'string', isOptional: true },
          ],
        }),
      ],
    },
    {
      // v4 adds the music start offset. Existing rows get NULL, which is exactly
      // right: a story cached before this upgrade plays from the beginning, which
      // is what it did when it was created.
      toVersion: 4,
      steps: [
        addColumns({
          table: 'stories',
          columns: [{ name: 'music_start_ms', type: 'number', isOptional: true }],
        }),
      ],
    },
  ],
});
