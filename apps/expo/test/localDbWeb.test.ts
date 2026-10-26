/**
 * The web database, end to end: the production LokiJS adapter
 * (src/database/adapter.web.ts) persisting to IndexedDB (fake-indexeddb, which
 * keeps data across adapter instances in this process). A "reload" is a new
 * adapter on the same database name.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const reported: any[] = [];
vi.mock('@/src/lib/reportError', () => ({ reportError: (e: unknown, extra?: unknown) => void reported.push([e, extra]) }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));

import { makeDatabase, migrationsUpTo, schemaAtVersion } from './helpers/localDb';
import { schema } from '@/src/database/schema';
import { createAdapter, flushLokiAdapter } from '@/src/database/adapter.web';
import * as health from '@/src/database/health';

let n = 0;
const freshName = (label: string) => `tophunt_test_${label}_${++n}`;

function open(name: string, opts: { version?: number } = {}) {
  const adapter = opts.version
    ? createAdapter({ dbName: name, schema: schemaAtVersion(opts.version), migrations: migrationsUpTo(opts.version) })
    : createAdapter({ dbName: name });
  return { db: makeDatabase(adapter), adapter };
}

/** Wait until the adapter finished loading from IndexedDB. */
async function ready(db: any) {
  await db.get('pending_actions').query().fetchCount();
}

async function queueView(db: any, storyId: string) {
  await db.write(async () => {
    await db.get('pending_actions').create((r: any) => {
      r.type = 'view';
      r.storyId = storyId;
      r.userId = 'alice';
      r.data = '{}';
      r.timestamp = 1;
      r.retries = 0;
    });
  });
}

beforeEach(() => {
  health.__resetDatabaseHealthForTests();
  reported.length = 0;
});

describe('web database (LokiJS + IndexedDB)', () => {
  it('flushLokiAdapter reaches the real Loki instance (pins the internal path it uses)', async () => {
    const { db, adapter } = open(freshName('pin'));
    await ready(db);
    // If a WatermelonDB upgrade moves the Loki instance, this turns false and
    // the flush-on-hide in production silently becomes a no-op. Fail here.
    expect(await flushLokiAdapter(adapter)).toBe(true);
  });

  it('a flushed write survives a reload', async () => {
    const name = freshName('reload');
    const first = open(name);
    await queueView(first.db, 's1');
    expect(await flushLokiAdapter(first.adapter)).toBe(true);

    const again = open(name);
    const rows: any[] = await again.db.get('pending_actions').query().fetch();
    expect(rows.map((r) => [r.type, r.storyId])).toEqual([['view', 's1']]);
  });

  for (let from = 1; from < schema.version; from++) {
    it(`upgrades a v${from} IndexedDB database to v${schema.version} and keeps its rows`, async () => {
      const name = freshName(`v${from}`);
      const old = open(name, { version: from });
      await queueView(old.db, `s-from-${from}`);
      await flushLokiAdapter(old.adapter);

      const cur = open(name);
      const rows: any[] = await cur.db.get('pending_actions').query().fetch();
      expect(rows.map((r) => r.storyId)).toEqual([`s-from-${from}`]);
      await cur.db.write(async () => {
        await cur.db.get('feed_snapshots').create((r: any) => {
          r._raw.id = 'u:alice|foryou';
          r.owner = 'u:alice';
          r.tab = 'foryou';
          r.items = '[]';
          r.fetchedAt = 1;
          r.format = 1;
        });
      });
      expect(await cur.db.get('feed_snapshots').query().fetchCount()).toBe(1);
      expect(health.getDatabaseHealth().issues).toEqual([]);
    });
  }

  it('without IndexedDB (blocked storage, some private modes) the app still works, in memory', async () => {
    const saved = (globalThis as any).indexedDB;
    (globalThis as any).indexedDB = undefined;
    try {
      const name = freshName('noidb');
      const { db, adapter } = open(name);
      await queueView(db, 's1');
      expect(await db.get('pending_actions').query().fetchCount()).toBe(1);
      await flushLokiAdapter(adapter); // must not throw
      expect(await open(name).db.get('pending_actions').query().fetchCount()).toBe(0);
    } finally {
      (globalThis as any).indexedDB = saved;
    }
  });

  it('IndexedDB deleted underneath the app (site data cleared) is recorded, reads keep working', async () => {
    const name = freshName('cleared');
    const { db } = open(name);
    await queueView(db, 's1');
    await new Promise<void>((resolve) => {
      const req = indexedDB.deleteDatabase(name);
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve();
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(health.getDatabaseHealth().issues).toContain('storage-closed');
    expect(reported.some(([, extra]) => extra?.phase === 'versionchange')).toBe(true);
    expect(await db.get('pending_actions').query().fetchCount()).toBe(1); // in-memory copy
  });

  it('a database from a NEWER app version (rolled-back deploy) is rebuilt empty, not a crash', async () => {
    const name = freshName('downgrade');
    const newer = createAdapter({
      dbName: name,
      schema: { ...schema, version: schema.version + 1 } as any,
      migrations: { ...(migrationsUpTo(schema.version) as any), maxVersion: schema.version + 1 } as any,
    });
    const ndb = makeDatabase(newer);
    await queueView(ndb, 's1');
    await flushLokiAdapter(newer);

    const { db } = open(name);
    expect(await db.get('pending_actions').query().fetchCount()).toBe(0);
  });
});
