/**
 * The native (iOS/Android) database, end to end on a real SQLite engine.
 *
 * test/storySchemaMigrations.test.ts checks that schema.ts and migrations.ts
 * AGREE. This checks that they WORK: the production adapter factory
 * (src/database/adapter.ts) generates the CREATE TABLE / ALTER TABLE / INSERT
 * SQL it sends to native SQLite, and that SQL runs here on node:sqlite through
 * WatermelonDB's own Node driver. Each "restart" is a new adapter on the same
 * database file.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
const reported: any[] = [];
vi.mock('@/src/lib/reportError', () => ({ reportError: (e: unknown, extra?: unknown) => void reported.push([e, extra]) }));
const kv = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => kv.get(k) ?? null,
    setItem: async (k: string, v: string) => void kv.set(k, v),
    removeItem: async (k: string) => void kv.delete(k),
  },
}));

import { installSqliteShim, makeDatabase, migrationsUpTo, schemaAtVersion, tempSqlitePath } from './helpers/localDb';
import { schema } from '@/src/database/schema';
import { schemaMigrations } from '@nozbe/watermelondb/Schema/migrations';

installSqliteShim();
const { createAdapter } = await import('@/src/database/adapter');
const health = await import('@/src/database/health');

/** Open `file` as the current app, or as the app version that shipped schema `version`. */
function open(file: string, opts: { version?: number } = {}) {
  if (!opts.version) return makeDatabase(createAdapter({ dbName: file }));
  return makeDatabase(
    createAdapter({ dbName: file, schema: schemaAtVersion(opts.version), migrations: migrationsUpTo(opts.version) }),
  );
}

const sqliteVersion = (file: string): number => {
  const d = new DatabaseSync(file);
  try {
    return Number((d.prepare('PRAGMA user_version').get() as any).user_version);
  } finally {
    d.close();
  }
};

async function seedV1Story(db: any) {
  await db.write(async () => {
    await db.get('stories').create((r: any) => {
      r._raw.id = 'story-1';
      r.userId = 'alice';
      r.username = 'alice';
      r.avatarUrl = '';
      r.mediaUrl = 'https://media.tophunt.in/s1.jpg';
      r.mediaType = 'image';
      r.createdAt = 1;
      r.expiresAt = Date.now() + 86_400_000;
      r.seen = false;
      r.isSynced = true;
    });
  });
}

beforeAll(() => health.__resetDatabaseHealthForTests());

describe('native SQLite database', () => {
  it('a fresh install creates every table at the current schema version', async () => {
    const file = tempSqlitePath('fresh');
    const db = open(file);
    for (const t of Object.keys(schema.tables)) {
      expect(await db.get(t).query().fetchCount()).toBe(0);
    }
    expect(sqliteVersion(file)).toBe(schema.version);
  });

  for (let from = 1; from < schema.version; from++) {
    it(`upgrades a v${from} database to v${schema.version} and keeps its rows`, async () => {
      const file = tempSqlitePath(`from-v${from}`);
      const old = open(file, { version: from });
      await seedV1Story(old);
      expect(sqliteVersion(file)).toBe(from);

      const db = open(file); // the new app version starts
      const story: any = await db.get('stories').find('story-1');
      expect(story.mediaUrl).toBe('https://media.tophunt.in/s1.jpg');
      // Columns added after v1 exist and read as empty, not as a crash.
      expect(story.matchId ?? null).toBeNull();
      expect(story.musicStartMs ?? null).toBeNull();
      // The v5 table exists and accepts writes.
      await db.write(async () => {
        await db.get('feed_snapshots').create((r: any) => {
          r._raw.id = 'u:alice|foryou';
          r.owner = 'u:alice';
          r.tab = 'foryou';
          r.items = '[]';
          r.nextCursor = null;
          r.fetchedAt = 1;
          r.format = 1;
        });
      });
      expect(await db.get('feed_snapshots').query().fetchCount()).toBe(1);
      expect(sqliteVersion(file)).toBe(schema.version);
    });
  }

  it('writes survive a restart (the pending-action queue is durable)', async () => {
    const file = tempSqlitePath('durable');
    const db = open(file);
    await db.write(async () => {
      await db.get('pending_actions').create((r: any) => {
        r.type = 'view';
        r.storyId = 's1';
        r.userId = 'alice';
        r.data = '{}';
        r.timestamp = 123;
        r.retries = 0;
      });
    });
    const again = open(file);
    const rows: any[] = await again.get('pending_actions').query().fetch();
    expect(rows.map((r) => [r.type, r.storyId, r.userId])).toEqual([['view', 's1', 'alice']]);
  });

  it('a failed batch rolls back as a whole', async () => {
    const file = tempSqlitePath('atomic');
    const db = open(file);
    await seedV1Story(db);
    const col = db.get('stories');
    await expect(
      db.write(async () => {
        await db.batch(
          col.prepareCreate((r: any) => {
            r._raw.id = 'story-2';
            r.userId = 'bob';
          }),
          // Same primary key as an existing row: SQLite rejects the INSERT.
          col.prepareCreate((r: any) => {
            r._raw.id = 'story-1';
            r.userId = 'bob';
          }),
        );
      }),
    ).rejects.toThrow();
    const ids = (await open(file).get('stories').query().fetch()).map((r) => r.id);
    expect(ids).toEqual(['story-1']);
  });

  /**
   * A file that is not SQLite. This driver behaves like the Android bridge: the
   * failed initialize leaves no connection, so an in-session reset cannot run.
   * What must hold: the failure is recorded and reported (it used to be a
   * console.error only), no unhandled rejection escapes, reads degrade to
   * empty instead of crashing, and the attempt is stamped as finished so the
   * next launch knows it did not crash.
   */
  it('a corrupt database file is reported, degrades reads, and stamps a finished reset attempt', async () => {
    const file = tempSqlitePath('corrupt');
    fs.writeFileSync(file, Buffer.from('this is not a sqlite database file '.repeat(200)));
    health.__resetDatabaseHealthForTests();
    kv.clear();
    reported.length = 0;

    const db = open(file);
    await new Promise((r) => setTimeout(r, 0));

    expect(health.getDatabaseHealth().issues).toContain('setup-failed');
    expect(reported.some(([, extra]) => extra?.phase === 'setup')).toBe(true);
    await expect(db.get('stories').query().fetch()).rejects.toThrow();

    const outcome = await health.recoverFromSetUpError(db, 1_000);
    expect(outcome).toBe('failed');
    expect(health.getDatabaseHealth().status).toBe('degraded');
    expect(JSON.parse(kv.get(health.LAST_RESET_KEY)!)).toEqual({ at: 1_000, done: true });
  });

  it('the reset clears a working database and leaves it usable', async () => {
    const file = tempSqlitePath('reset');
    health.__resetDatabaseHealthForTests();
    kv.clear();
    const db = open(file);
    await seedV1Story(db);

    expect(await health.recoverFromSetUpError(db, 5_000)).toBe('reset');
    expect(health.getDatabaseHealth().status).toBe('recovered');
    expect(await db.get('stories').query().fetchCount()).toBe(0);
    await seedV1Story(db);
    expect(await open(file).get('stories').query().fetchCount()).toBe(1);
  });

  it('a database left by a NEWER app version (downgrade) is rebuilt, not a crash', async () => {
    const file = tempSqlitePath('downgrade');
    const newer = makeDatabase(
      createAdapter({
        dbName: file,
        schema: { ...schema, version: schema.version + 1 } as any,
        migrations: schemaMigrations({
          migrations: [
            ...((migrationsUpTo(schema.version) as any).sortedMigrations as any[]),
            { toVersion: schema.version + 1, steps: [] },
          ],
        }),
      }),
    );
    await seedV1Story(newer);
    expect(sqliteVersion(file)).toBe(schema.version + 1);

    const db = open(file);
    expect(await db.get('stories').query().fetchCount()).toBe(0); // rebuilt empty
    expect(sqliteVersion(file)).toBe(schema.version);
  });
});
