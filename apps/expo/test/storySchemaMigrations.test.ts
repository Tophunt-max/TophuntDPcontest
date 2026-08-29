/**
 * The local schema and its migrations must move in lockstep.
 *
 * `migrations.ts` spells out the consequence: the adapter migrates an existing
 * on-device database from its stored version up to the schema version. A column
 * added to `schema.ts` with no matching `addColumns` step throws for every user
 * who already has a cache; a step with no column leaves it missing on upgraded
 * devices. Either way the stories layer falls back to the network — safe, but the
 * cache is dead and nothing says so.
 *
 * That coupling is invisible at the type level and only bites on upgrade, never on
 * a fresh install, so it survives local testing. This asserts it mechanically.
 */
import { describe, it, expect } from 'vitest';

import { schema } from '@/src/database/schema';
import { migrations } from '@/src/database/migrations';

/** Column names declared for a table in the current schema. */
function schemaColumns(table: string): string[] {
  const t = (schema.tables as any)[table];
  return Object.keys(t.columns);
}

/**
 * `schemaMigrations()` returns a validated object exposing `sortedMigrations` —
 * not the `migrations` array it was given. Reading the wrong key yields an empty
 * list, which would make every assertion below vacuously pass.
 */
function allMigrations(): any[] {
  const list = (migrations as any).sortedMigrations;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('could not read sortedMigrations — watermelondb internals changed');
  }
  return list;
}

/** Every column name any migration step adds to a table, across all versions. */
function migratedColumns(table: string): string[] {
  const names: string[] = [];
  for (const m of allMigrations()) {
    for (const step of m.steps ?? []) {
      if (step.type === 'add_columns' && step.table === table) {
        for (const col of step.columns ?? []) names.push(col.name);
      }
    }
  }
  return names;
}

describe('local cache schema ↔ migrations', () => {
  it('schema version matches the newest migration', () => {
    const versions = allMigrations().map((m: any) => m.toVersion);
    expect(Math.max(...versions)).toBe(schema.version);
  });

  it('has a migration step for every version from 2 up to the schema version', () => {
    // v1 is the baseline (no migration). Every version after it needs a step, or
    // a device sitting on an intermediate version cannot be upgraded.
    const versions: number[] = allMigrations().map((m: any) => m.toVersion);
    const expected = Array.from({ length: schema.version - 1 }, (_, i) => i + 2);
    expect([...versions].sort((a, b) => a - b)).toEqual(expected);
  });

  it('declares every migrated stories column in the schema', () => {
    // Catches the reverse mistake: a column added by a migration but never
    // declared, which exists on upgraded devices and is absent on fresh installs.
    const declared = schemaColumns('stories');
    for (const name of migratedColumns('stories')) {
      expect(declared, `migrated column "${name}" missing from schema`).toContain(name);
    }
  });

  it('carries the soundtrack columns in both schema and migrations', () => {
    // The music fields were the second set of columns to be dropped by the cache
    // (after the contest fields). Pin both halves so a future edit cannot add one
    // without the other.
    const music = [
      'music_track_id',
      'music_title',
      'music_artist',
      'music_artwork_url',
      'music_preview_url',
      // v4: which part of the track plays.
      'music_start_ms',
    ];
    const declared = schemaColumns('stories');
    const migrated = migratedColumns('stories');
    for (const name of music) {
      expect(declared, `${name} missing from schema.ts`).toContain(name);
      expect(migrated, `${name} missing from migrations.ts`).toContain(name);
    }
  });

  it('still carries the contest columns that broke battle stories', () => {
    const declared = schemaColumns('stories');
    const migrated = migratedColumns('stories');
    for (const name of ['match_id', 'type', 'contest_title']) {
      expect(declared).toContain(name);
      expect(migrated).toContain(name);
    }
  });
});
