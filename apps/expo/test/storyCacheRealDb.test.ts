/**
 * offlineStoryService against REAL databases (native SQLite and web LokiJS),
 * not a hand-written mock. The mock-based tests check call shapes; these check
 * what actually lands on disk:
 *  - replacing the cache is one transaction (no partial cache after a crash),
 *  - repeated ids from the server cannot fail the transaction on SQLite,
 *  - the owner rule holds against stored rows,
 *  - the pending-action queue dedupes and stays bounded.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  db: null as any,
  kv: new Map<string, string>(),
  currentUser: null as null | { uid: string },
}));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/src/lib/reportError', () => ({ reportError: () => undefined }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => h.kv.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.kv.set(k, v),
    removeItem: async (k: string) => void h.kv.delete(k),
  },
}));
vi.mock('@/src/services/firebase/initFirebase', () => ({
  auth: {
    get currentUser() {
      return h.currentUser;
    },
  },
}));
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: false }) } }));
// syncPendingActions replays through storyService; `seen` decides each outcome.
const replay = vi.hoisted(() => ({ seen: async (_id: string) => undefined as unknown, calls: [] as string[] }));
vi.mock('@/src/services/stories/storyService', () => ({
  markStoryAsSeen: async (id: string) => {
    replay.calls.push(id);
    return replay.seen(id);
  },
  reactToStory: async () => undefined,
}));
vi.mock('@/src/database', async () => {
  const models = await import('./helpers/localDb');
  return {
    get database() {
      return h.db;
    },
    StoryModel: models.modelClasses[0],
    UserStoryModel: models.modelClasses[1],
    PendingActionModel: models.modelClasses[2],
    FeedSnapshotModel: models.modelClasses[3],
  };
});

import { installSqliteShim, makeDatabase, tempSqlitePath } from './helpers/localDb';
installSqliteShim();
const native = await import('@/src/database/adapter');
const web = await import('@/src/database/adapter.web');
const svc = await import('@/src/services/stories/offlineStoryService');

const day = 86_400_000;
const story = (id: string, userId: string, extra: any = {}) => ({
  id,
  userId,
  username: userId,
  avatarUrl: null,
  mediaUrl: `https://media.tophunt.in/${id}.jpg`,
  mediaType: 'image',
  createdAt: Date.now(),
  expiresAt: Date.now() + day,
  seen: false,
  ...extra,
});
const group = (userId: string, ids: string[]) => ({
  userId,
  username: userId,
  avatarUrl: null,
  hasUnseen: true,
  stories: ids.map((id) => story(id, userId)),
});

let n = 0;
const backends = {
  'native SQLite': () => makeDatabase(native.createAdapter({ dbName: tempSqlitePath(`svc${++n}`) })),
  'web LokiJS': () => makeDatabase(web.createAdapter({ dbName: `svc_web_${++n}` })),
};

for (const [label, make] of Object.entries(backends)) {
  describe(`Story cache on ${label}`, () => {
    beforeEach(async () => {
      h.kv.clear();
      h.db = make();
      h.currentUser = { uid: 'alice' };
    });

    it('replace stores exactly the server answer, readable by its owner only', async () => {
      await svc.replaceUserStoriesLocally([group('bob', ['b1', 'b2']), group('carol', ['c1'])], 'alice');
      const mine = await svc.getUserStoriesLocally();
      expect(mine.map((g) => [g.userId, g.stories.map((s) => s.id)]).sort()).toEqual([
        ['bob', ['b1', 'b2']],
        ['carol', ['c1']],
      ]);

      // A second answer REPLACES the first: carol's story is gone.
      await svc.replaceUserStoriesLocally([group('bob', ['b2'])], 'alice');
      const after = await svc.getUserStoriesLocally();
      expect(after.map((g) => [g.userId, g.stories.map((s) => s.id)])).toEqual([['bob', ['b2']]]);
      expect(await h.db.get('stories').query().fetchCount()).toBe(1);

      h.currentUser = { uid: 'mallory' };
      expect(await svc.getUserStoriesLocally()).toEqual([]);
    });

    it('repeated ids in one answer do not fail the transaction', async () => {
      await svc.replaceUserStoriesLocally(
        [group('bob', ['b1', 'b1']), group('bob', ['b9']), group('dave', ['b1', 'd1'])],
        'alice',
      );
      expect(await h.db.get('user_stories').query().fetchCount()).toBe(2);
      expect((await h.db.get('stories').query().fetch()).map((r: any) => r.id).sort()).toEqual(['b1', 'd1']);
    });

    it('replace is all-or-nothing: a failing write keeps the previous cache intact', async () => {
      await svc.replaceUserStoriesLocally([group('bob', ['b1'])], 'alice');
      const realBatch = h.db.batch.bind(h.db);
      h.db.batch = async () => {
        throw new Error('disk full');
      };
      await svc.replaceUserStoriesLocally([group('carol', ['c1'])], 'alice');
      h.db.batch = realBatch;
      const ids = (await h.db.get('stories').query().fetch()).map((r: any) => r.id);
      expect(ids).toEqual(['b1']);
    });

    it('the pending queue keeps one row per (type, story, user) and is capped', async () => {
      for (let i = 0; i < 3; i++) await svc.queuePendingAction({ type: 'view', storyId: 's1', userId: 'alice', data: {} });
      expect(await h.db.get('pending_actions').query().fetchCount()).toBe(1);

      for (let i = 0; i < svc.MAX_PENDING_ACTIONS + 5; i++) {
        await svc.queuePendingAction({ type: 'view', storyId: `x${i}`, userId: 'alice', data: {} });
      }
      expect(await h.db.get('pending_actions').query().fetchCount()).toBe(svc.MAX_PENDING_ACTIONS);
    });

    it('replay: delivered rows go, refused rows go, a network failure stops without spending attempts', async () => {
      const apiErr = (status?: number) => Object.assign(new Error(`HTTP ${status}`), { code: 'functions/x', status });
      for (const s of ['ok', 'gone', 'net1', 'net2']) {
        await svc.queuePendingAction({ type: 'view', storyId: s, userId: 'alice', data: {} });
        await new Promise((r) => setTimeout(r, 2)); // distinct timestamps: replay is oldest first
      }
      replay.calls.length = 0;
      replay.seen = async (id) => {
        if (id === 'gone') throw apiErr(404); // Story deleted: permanent
        if (id.startsWith('net')) throw apiErr(undefined); // offline again
        return undefined;
      };
      await svc.syncPendingActions();
      expect(replay.calls).toEqual(['ok', 'gone', 'net1']); // stopped at the first network failure
      const left: any[] = await h.db.get('pending_actions').query().fetch();
      expect(left.map((r) => [r.storyId, r.retries]).sort()).toEqual([
        ['net1', 0],
        ['net2', 0],
      ]);
    });

    it('replay: 5xx counts an attempt and the row is dropped after the limit', async () => {
      await svc.queuePendingAction({ type: 'view', storyId: 's5', userId: 'alice', data: {} });
      replay.seen = async () => {
        throw Object.assign(new Error('HTTP 503'), { code: 'functions/unavailable', status: 503 });
      };
      for (let i = 0; i < 4; i++) await svc.syncPendingActions();
      expect(((await h.db.get('pending_actions').query().fetch()) as any[])[0].retries).toBe(4);
      await svc.syncPendingActions();
      expect(await h.db.get('pending_actions').query().fetchCount()).toBe(0);
    });

    it('refuses to queue anything but replay-safe Story actions', async () => {
      await svc.queuePendingAction({ type: 'create' as any, storyId: 's1', userId: 'alice', data: {} });
      await svc.queuePendingAction({ type: 'delete' as any, storyId: 's1', userId: 'alice', data: {} });
      expect(await h.db.get('pending_actions').query().fetchCount()).toBe(0);
    });
  });
}
