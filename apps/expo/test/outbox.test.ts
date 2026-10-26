/**
 * The offline social outbox (src/sync/outbox.ts) on REAL databases: native
 * SQLite and web LokiJS/IndexedDB. The network is a stub that records what
 * would have been sent.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ db: null as any }));

vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));
vi.mock('@/src/lib/reportError', () => ({ reportError: () => undefined }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
}));
vi.mock('@react-native-community/netinfo', () => ({ default: { fetch: async () => ({ isConnected: true }) } }));
vi.mock('@/src/services/firebase/initFirebase', () => ({ auth: { currentUser: null } }));
vi.mock('@/src/services/api', () => {
  class ApiCallError extends Error {
    code: string;
    status?: number;
    constructor(code: string, message: string, status?: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return { ApiCallError, callApi: vi.fn() };
});
vi.mock('@/src/database', () => ({
  get database() {
    return h.db;
  },
}));

import { installSqliteShim, makeDatabase, tempSqlitePath } from './helpers/localDb';
installSqliteShim();
const native = await import('@/src/database/adapter');
const web = await import('@/src/database/adapter.web');
const { ApiCallError } = await import('@/src/services/api');
const ob = await import('@/src/sync/outbox');

const netErr = () => new ApiCallError('functions/unavailable', "You're offline.");
const httpErr = (status: number) => new ApiCallError('functions/x', `HTTP ${status}`, status);

let n = 0;
const backends = {
  'native SQLite': () => makeDatabase(native.createAdapter({ dbName: tempSqlitePath(`ob${++n}`) })),
  'web LokiJS': () => makeDatabase(web.createAdapter({ dbName: `ob_web_${++n}` })),
};

for (const [label, make] of Object.entries(backends)) {
  describe(`outbox on ${label}`, () => {
    let uid: string | null;
    let clock: number;
    let online: boolean;
    let sent: Array<[string, string, any]>;
    let respond: (kind: string, target: string, payload: any) => Promise<unknown>;

    const rows = () => h.db.get('outbox_ops').query().fetch();

    beforeEach(async () => {
      h.db = make();
      uid = 'alice';
      clock = 1_000_000;
      online = true;
      sent = [];
      respond = async () => ({ success: true });
      ob.__setOutboxDepsForTests({
        now: () => clock,
        uid: () => uid,
        online: async () => online,
        random: () => 0.5,
        send: async (kind, target, payload) => {
          sent.push([kind, target, payload]);
          return respond(kind, target, payload);
        },
      });
      await ob.loadOutboxMirror();
    });

    it('stores an intent, survives a restart, and sends it once online', async () => {
      online = false;
      expect(await ob.enqueueOutbox('match.like', 'm1', { liked: true })).toBe(true);
      await ob.drainOutbox();
      expect(sent).toEqual([]);
      expect(ob.pendingIntent('match.like', 'm1')).toEqual({ liked: true });

      // Restart: a fresh mirror reads the stored row.
      ob.__setOutboxDepsForTests({ now: () => clock, uid: () => uid, online: async () => true, random: () => 0.5, send: async (k, t, p) => void sent.push([k, t, p]) });
      await ob.loadOutboxMirror();
      expect(ob.pendingIntent('match.like', 'm1')).toEqual({ liked: true });

      const res = await ob.drainOutbox();
      expect(res.sent).toBe(1);
      expect(sent).toEqual([['match.like', 'm1', { liked: true }]]);
      expect(await rows()).toHaveLength(0);
      expect(ob.pendingIntent('match.like', 'm1')).toBeUndefined();
    });

    it('like then unlike offline sends only the last intent', async () => {
      online = false;
      await ob.enqueueOutbox('match.like', 'm1', { liked: true });
      await ob.enqueueOutbox('match.like', 'm1', { liked: false });
      expect(await rows()).toHaveLength(1);
      online = true;
      await ob.drainOutbox();
      expect(sent).toEqual([['match.like', 'm1', { liked: false }]]);
    });

    it('an intent changed while its send is in flight is not lost', async () => {
      let release!: () => void;
      online = false;
      await ob.enqueueOutbox('match.like', 'm1', { liked: true });
      online = true;
      respond = () => new Promise<void>((r) => (release = r)).then(() => ({ success: true }));
      const draining = ob.drainOutbox();
      await new Promise((r) => setTimeout(r, 20)); // the send is now in flight
      respond = async () => ({ success: true });
      online = false; // the enqueue below must not start its own drain yet
      await ob.enqueueOutbox('match.like', 'm1', { liked: false });
      release();
      await draining;
      const left = await rows();
      expect(left).toHaveLength(1);
      expect(JSON.parse(left[0].payload)).toEqual({ liked: false });
      online = true;
      await ob.drainOutbox();
      expect(sent.map((s) => s[2])).toEqual([{ liked: true }, { liked: false }]);
      expect(await rows()).toHaveLength(0);
    });

    it('a network failure backs off with jitter and stops the drain', async () => {
      online = false;
      await ob.enqueueOutbox('match.like', 'm1', { liked: true });
      clock += 1; // oldest first; equal timestamps have no defined order
      await ob.enqueueOutbox('match.bookmark', 'm1', { bookmarked: true });
      online = true;
      respond = async () => {
        throw netErr();
      };
      const res = await ob.drainOutbox();
      expect(res.stoppedBecause).toBe('network');
      expect(sent).toHaveLength(1); // did not walk the whole queue into the same failure
      const [first] = (await rows()).filter((r: any) => r.kind === 'match.like');
      expect(first.attempts).toBe(1);
      expect(first.nextAttemptAt).toBe(clock + ob.backoffMs(1, () => 0.5));

      respond = async () => ({ success: true });
      sent.length = 0;
      await ob.drainOutbox(); // like is still backing off; bookmark goes
      expect(sent.map((s) => s[0])).toEqual(['match.bookmark']);
      clock += 60_000;
      await ob.drainOutbox();
      expect(sent.map((s) => s[0])).toEqual(['match.bookmark', 'match.like']);
    });

    it('a 4xx refusal is marked failed, not retried, and stops overriding the server', async () => {
      online = false;
      await ob.enqueueOutbox('user.follow', 'bob', { intent: 'follow' });
      online = true;
      respond = async () => {
        throw httpErr(403);
      };
      const res = await ob.drainOutbox();
      expect(res.failed).toBe(1);
      expect(ob.pendingIntent('user.follow', 'bob')).toBeUndefined();
      await ob.drainOutbox();
      expect(sent).toHaveLength(1);
      expect(await ob.outboxSummary()).toEqual({ pending: 0, failed: 1 });
    });

    it('429/5xx retry until MAX_ATTEMPTS, then the row is marked failed', async () => {
      online = false;
      await ob.enqueueOutbox('match.like', 'm1', { liked: true });
      online = true;
      respond = async () => {
        throw httpErr(503);
      };
      for (let i = 0; i < ob.MAX_ATTEMPTS + 2; i++) {
        await ob.drainOutbox();
        clock += 11 * 60_000;
      }
      expect(sent).toHaveLength(ob.MAX_ATTEMPTS);
      expect(await ob.outboxSummary()).toEqual({ pending: 0, failed: 1 });
    });

    it('a 409 idempotency duplicate counts as delivered', async () => {
      online = false;
      await ob.enqueueOutbox('match.like', 'm1', { liked: true });
      online = true;
      respond = async () => {
        throw httpErr(409);
      };
      expect((await ob.drainOutbox()).sent).toBe(1);
      expect(await rows()).toHaveLength(0);
    });

    it('a 401 keeps the row and stops until the session is fixed', async () => {
      online = false;
      await ob.enqueueOutbox('match.like', 'm1', { liked: true });
      online = true;
      respond = async () => {
        throw httpErr(401);
      };
      expect((await ob.drainOutbox()).stoppedBecause).toBe('auth');
      expect(await ob.outboxSummary()).toEqual({ pending: 1, failed: 0 });
    });

    it("only the signed-in account's rows are sent or shown", async () => {
      online = false;
      await ob.enqueueOutbox('match.like', 'm1', { liked: true });
      uid = 'bob';
      await ob.loadOutboxMirror();
      expect(ob.pendingIntent('match.like', 'm1')).toBeUndefined();
      online = true;
      await ob.drainOutbox();
      expect(sent).toEqual([]);
      uid = 'alice';
      await ob.loadOutboxMirror();
      await ob.drainOutbox();
      expect(sent).toEqual([['match.like', 'm1', { liked: true }]]);
    });

    it('refuses unknown kinds, bad payloads, guests, and a full queue', async () => {
      online = false;
      expect(await ob.enqueueOutbox('contest.vote' as any, 'm1', { side: 'a' } as any)).toBe(false);
      expect(await ob.enqueueOutbox('match.like', 'm1', { liked: 'yes' } as any)).toBe(false);
      expect(await ob.enqueueOutbox('user.follow', 'bob', { intent: 'toggle' } as any)).toBe(false);
      uid = null;
      expect(await ob.enqueueOutbox('match.like', 'm1', { liked: true })).toBe(false);
      uid = 'alice';
      expect(await rows()).toHaveLength(0);

      await h.db.write(async () => {
        const col = h.db.get('outbox_ops');
        const ops = [];
        for (let i = 0; i < ob.MAX_OPS_PER_ACCOUNT; i++) {
          ops.push(
            col.prepareCreate((r: any) => {
              Object.assign(r, { account: 'alice', kind: 'match.like', target: `x${i}`, opKey: `alice|match.like|x${i}`, payload: '{"liked":true}', status: 'pending', attempts: 0, revision: 1, nextAttemptAt: 0, createdAt: clock });
            }),
          );
        }
        await h.db.batch(...ops);
      });
      expect(await ob.enqueueOutbox('match.like', 'one-more', { liked: true })).toBe(false);
      // Changing an intent already queued still works at capacity.
      expect(await ob.enqueueOutbox('match.like', 'x1', { liked: false })).toBe(true);
    });

    it('drops intents older than 7 days instead of sending them', async () => {
      online = false;
      await ob.enqueueOutbox('match.like', 'm1', { liked: true });
      clock += ob.MAX_AGE_MS + 1;
      online = true;
      await ob.drainOutbox();
      expect(sent).toEqual([]);
      expect(await rows()).toHaveLength(0);
    });
  });
}
