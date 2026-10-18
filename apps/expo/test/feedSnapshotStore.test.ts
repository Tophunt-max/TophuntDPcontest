/**
 * The WatermelonDB-backed feed snapshot store: idempotent upsert by stable id, one
 * owner's rows only, and no duplicate rows across refreshes.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const rows = new Map<string, any>();
  const makeRecord = (id: string) => {
    const rec: any = { id, _raw: { id } };
    rec.prepareDestroyPermanently = () => ({ op: 'destroy', id: rec.id });
    rec.prepareUpdate = (fn: (r: any) => void) => ({ op: 'update', rec, fn });
    return rec;
  };
  const collection = {
    query: () => ({ fetch: async () => [...rows.values()] }),
    find: async (id: string) => {
      const r = rows.get(id);
      if (!r) throw new Error('not found');
      return r;
    },
    prepareCreate: (fn: (r: any) => void) => ({ op: 'create', fn }),
  };
  const database = {
    write: async (fn: () => Promise<void>) => fn(),
    get: () => collection,
    batch: async (...ops: any[]) => {
      for (const o of ops) {
        if (o.op === 'destroy') rows.delete(o.id);
        if (o.op === 'update') o.fn(o.rec);
        if (o.op === 'create') {
          const rec = makeRecord('');
          o.fn(rec);
          rec.id = rec._raw.id;
          rows.set(rec.id, rec);
        }
      }
    },
  };
  return { rows, database };
});

vi.mock('@/src/database', () => ({ database: h.database }));

import { __setSnapshotStoreForTests, clearFeedSnapshots, loadFeedSnapshot, saveFeedSnapshot } from '@/src/lib/feedSnapshot';

beforeEach(() => {
  h.rows.clear();
  __setSnapshotStoreForTests(null); // the real (WatermelonDB) store, over the fake database
});

const page = (ids: string[]) => ids.map((id) => ({ id, status: 'active', userA: { uid: 'a' }, userB: { uid: 'b' } }));

describe('WatermelonDB feed snapshot store', () => {
  it('upserts by `${owner}|${tab}` — repeated refreshes never add rows', async () => {
    for (let i = 0; i < 5; i++) await saveFeedSnapshot('u:alice', 'foryou', page([`m${i}`]), i);
    expect([...h.rows.keys()]).toEqual(['u:alice|foryou']);
    expect(JSON.parse(h.rows.get('u:alice|foryou').items)[0].id).toBe('m4');
    expect(h.rows.get('u:alice|foryou').nextCursor).toBe('4');
  });

  it('reads back through a restart (fresh session memory)', async () => {
    await saveFeedSnapshot('u:alice', 'following', page(['m1', 'm2']), null, Date.now() - 60_000);
    __setSnapshotStoreForTests(null);
    const snap = await loadFeedSnapshot('u:alice', 'following');
    expect(snap?.items.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(snap?.nextCursor).toBeNull();
  });

  it('holds at most one owner: a different viewer’s write removes the others', async () => {
    await saveFeedSnapshot('u:alice', 'foryou', page(['m1']), null);
    await saveFeedSnapshot('u:alice', 'following', page(['m2']), null);
    await saveFeedSnapshot('guest', 'foryou', page(['m3']), null);
    expect([...h.rows.keys()]).toEqual(['guest|foryou']);
  });

  it('clear removes every row', async () => {
    await saveFeedSnapshot('u:alice', 'foryou', page(['m1']), null);
    await clearFeedSnapshots();
    expect(h.rows.size).toBe(0);
  });
});
