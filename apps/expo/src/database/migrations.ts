import { schemaMigrations, addColumns, createTable } from '@nozbe/watermelondb/Schema/migrations';

/**
 * Schema migrations for the local database (stories cache + feed snapshot).
 *
 * These MUST stay in lockstep with `schema.ts`: the adapter migrates an existing
 * on-device database from its stored version up to the schema version, applying
 * each step. A column added to `schema.ts` without a matching `addColumns` step
 * here throws for every user who already has a cache, while the reverse leaves
 * the new column missing on upgraded devices. A failed migration is reported and
 * the database is reset once (`health.ts`), which is safe but empties the cache.
 * test/localDbSqlite.test.ts and test/localDbWeb.test.ts upgrade a database
 * from every earlier version on real SQLite and LokiJS; keep steps additive.
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
    {
      // v5 adds the Home feed snapshot table. A brand-new table, so existing
      // devices simply start with it empty: the first successful feed load fills
      // it, and until then Home behaves exactly as before (network first). Must
      // match the `feed_snapshots` declaration in schema.ts column-for-column —
      // test/storySchemaMigrations.test.ts enforces that.
      toVersion: 5,
      steps: [
        createTable({
          name: 'feed_snapshots',
          columns: [
            { name: 'owner', type: 'string', isIndexed: true },
            { name: 'tab', type: 'string' },
            { name: 'items', type: 'string' },
            { name: 'next_cursor', type: 'string', isOptional: true },
            { name: 'fetched_at', type: 'number' },
            { name: 'format', type: 'number' },
            { name: 'updated_at', type: 'number' },
          ],
        }),
      ],
    },
  ],
});
