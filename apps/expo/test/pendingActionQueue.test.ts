/**
 * The offline Story action queue is bounded, de-duplicated and replay-safe.
 *
 * Only idempotent actions (view, reaction — both upserts on (story, viewer)
 * server-side) may be queued; repeated failures of the same action must not add
 * rows; and the queue has a hard ceiling with oldest-first eviction.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  let seq = 0;
  const rows: any[] = [];
  const makeRow = () => {
    const row: any = { id: `p${++seq}` };
    row.prepareDestroyPermanently = () => ({ op: 'destroy', row });
    row.prepareUpdate = (fn: (r: any) => void) => ({ op: 'update', row, fn });
    row.destroyPermanently = async () => {
      rows.splice(rows.indexOf(row), 1);
    };
    return row;
  };
  const matches = (row: any, conds: any[]) =>
    conds.every((c) => (c.kind === 'where' ? row[c.field] === c.value : true));
  const fieldOf: Record<string, string> = { type: 'type', story_id: 'storyId', user_id: 'userId', timestamp: 'timestamp' };
  const collection = {
    query: (...conds: any[]) => ({
      fetch: async () => {
        const out = rows.filter((r) => matches(r, conds));
        if (conds.some((c) => c.kind === 'sort')) out.sort((a, b) => a.timestamp - b.timestamp);
        return out;
      },
    }),
    prepareCreate: (fn: (r: any) => void) => ({ op: 'create', fn }),
    find: async (id: string) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error('not found');
      return r;
    },
  };
  const Q = {
    where: (field: string, value: any) => ({ kind: 'where', field: fieldOf[field] ?? field, value }),
    sortBy: (field: string) => ({ kind: 'sort', field }),
    asc: 'asc',
  };
  const database = {
    write: async (fn: () => Promise<void>) => fn(),
    get: () => collection,
    batch: async (...ops: any[]) => {
      for (const o of ops) {
        if (o.op === 'destroy') rows.splice(rows.indexOf(o.row), 1);
        if (o.op === 'update') o.fn(o.row);
        if (o.op === 'create') {
          const r = makeRow();
          o.fn(r);
          rows.push(r);
        }
      }
    },
  };
  return { rows, database, Q, reset: () => { rows.length = 0; seq = 0; } };
});

vi.mock('@/src/database', () => ({ database: h.database, StoryModel: class {}, UserStoryModel: class {}, PendingActionModel: class {} }));
vi.mock('@/src/services/firebase/initFirebase', () => ({ auth: { currentUser: null } }));
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: false }) } }));
vi.mock('@nozbe/watermelondb', () => ({ Q: h.Q, Model: class {} }));

import { queuePendingAction, removePendingAction, MAX_PENDING_ACTIONS } from '@/src/services/stories/offlineStoryService';

beforeEach(() => h.reset());

describe('pending story action queue', () => {
  it('queues a failed view once, however many times it fails', async () => {
    for (let i = 0; i < 5; i++) {
      await queuePendingAction({ type: 'view', storyId: 's1', userId: 'alice', data: { storyId: 's1' } });
    }
    expect(h.rows).toHaveLength(1);
  });

  it('keeps only the latest reaction per story (the server upserts it anyway)', async () => {
    await queuePendingAction({ type: 'reaction', storyId: 's1', userId: 'alice', data: { emoji: '🔥' } });
    await queuePendingAction({ type: 'reaction', storyId: 's1', userId: 'alice', data: { emoji: '❤️' } });
    expect(h.rows).toHaveLength(1);
    expect(JSON.parse(h.rows[0].data).emoji).toBe('❤️');
    expect(h.rows[0].retries).toBe(0);
  });

  it('scopes de-duplication by account', async () => {
    await queuePendingAction({ type: 'view', storyId: 's1', userId: 'alice', data: {} });
    await queuePendingAction({ type: 'view', storyId: 's1', userId: 'bob', data: {} });
    expect(h.rows.map((r) => r.userId).sort()).toEqual(['alice', 'bob']);
  });

  it('refuses action types that are not safe to replay', async () => {
    await queuePendingAction({ type: 'create', storyId: 's1', userId: 'alice', data: {} });
    await queuePendingAction({ type: 'delete', storyId: 's1', userId: 'alice', data: {} });
    expect(h.rows).toHaveLength(0);
  });

  it('a reaction rewritten during its replay survives the replay’s cleanup', async () => {
    const spy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    await queuePendingAction({ type: 'reaction', storyId: 's1', userId: 'alice', data: { emoji: '🔥' } });
    const row = h.rows[0];
    const replayed = row.timestamp; // sync reads the row and starts replaying 🔥
    spy.mockReturnValue(2000);
    await queuePendingAction({ type: 'reaction', storyId: 's1', userId: 'alice', data: { emoji: '❤️' } });
    spy.mockRestore();
    await removePendingAction(row.id, replayed); // sync's cleanup after the 🔥 replay
    expect(h.rows).toHaveLength(1);
    expect(JSON.parse(h.rows[0].data).emoji).toBe('❤️');
    // An untouched row is removed normally.
    await removePendingAction(row.id, h.rows[0].timestamp);
    expect(h.rows).toHaveLength(0);
  });

  it('never grows past its ceiling, evicting the oldest first', async () => {
    let t = 1_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => ++t);
    try {
      for (let i = 0; i < MAX_PENDING_ACTIONS + 5; i++) {
        await queuePendingAction({ type: 'view', storyId: `s${i}`, userId: 'alice', data: {} });
      }
    } finally {
      spy.mockRestore();
    }
    expect(h.rows).toHaveLength(MAX_PENDING_ACTIONS);
    const ids = h.rows.map((r) => r.storyId);
    expect(ids).not.toContain('s0');
    expect(ids).toContain(`s${MAX_PENDING_ACTIONS + 4}`);
  });
});
