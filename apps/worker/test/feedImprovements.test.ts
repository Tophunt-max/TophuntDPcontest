/**
 * Feed follow-ups: the paging cursor (no repeats or skips when the order is
 * recomputed), the "Not interested" list + undo, the admin feed-weights read,
 * and the offline evaluation harness.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/publish', async (orig) => ({
  ...(await orig<any>()),
  publish: async () => {},
  publishMany: async () => {},
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { memoReset } from '../src/lib/memo';
import { decodeFeedCursor, feedPage, idFingerprint } from '../src/lib/feedCursor';
import { compareWeights, rankSnapshot, scoreOrder, type EvalDataset, type EvalSnapshot } from '../src/lib/feedEval';
import { FEED_DEFAULT_WEIGHTS, sanitizeFeedWeights } from '../src/lib/feedWeights';

const app = makeApp();
const DAY = 86_400_000;
beforeEach(() => memoReset());

async function get(env: TestEnv, path: string, uid?: string) {
  const res = await app.request(`/read${path}`, { headers: uid ? { Authorization: `Bearer ${uid}` } : {} }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}
async function api(env: TestEnv, uid: string, action: string, data: Record<string, unknown> = {}) {
  const res = await app.request(
    '/api',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` }, body: JSON.stringify({ action, ...data }) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function user(env: TestEnv, uid: string) {
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: 1, updatedAt: 1, followersCount: 500 } as any);
}
async function match(env: TestEnv, id: string, a: string, b: string, createdAt: number, extra: Record<string, any> = {}) {
  await drizzleOf(env)
    .insert(schema.contestMatches)
    .values({
      id,
      status: 'active',
      type: 'photo',
      title: id,
      userA: { uid: a, username: a, mediaUrl: 'https://media.example.com/a.jpg' },
      userB: { uid: b, username: b, mediaUrl: 'https://media.example.com/b.jpg' },
      entryFee: 0,
      createdAt,
      activatedAt: createdAt,
      expiresAt: createdAt + 3 * DAY,
      ...extra,
    } as any);
}
/** 12 battles between 12 distinct creator pairs, newest first by id number. */
async function seedFeed(env: TestEnv) {
  await user(env, 'viewer');
  const now = Date.now();
  for (let i = 0; i < 12; i++) {
    await user(env, `a${i}`);
    await user(env, `b${i}`);
    await match(env, `m${String(i).padStart(2, '0')}`, `a${i}`, `b${i}`, now - (i + 1) * 3_600_000);
  }
}
const page = (env: TestEnv, cursor?: string | null, uid = 'viewer') =>
  get(env, `/matches?status=active&sort=foryou&limit=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, uid);

describe('feed cursor (pure)', () => {
  it('round-trips the served set and still accepts the old numeric offset', () => {
    const p = feedPage(['a', 'b', 'c'], null, 2, 1234);
    expect(p.ids).toEqual(['a', 'b']);
    const c = decodeFeedCursor(p.next);
    expect(c).toMatchObject({ kind: 'served', t: 1234 });
    expect([...(c as any).served].sort()).toEqual([idFingerprint('a'), idFingerprint('b')].sort());
    expect(decodeFeedCursor('16')).toEqual({ kind: 'offset', o: 16 });
    for (const bad of ['garbage', 'f2.!!.AAAA', 'f2.abc.AAA', 'f1.xyz']) expect(decodeFeedCursor(bad), bad).toBeNull();
    expect(decodeFeedCursor(null)).toBeNull();
    expect(idFingerprint('m01')).toMatch(/^[A-Za-z0-9_-]{4}$/);
  });
  it('serves what was not served yet, wherever it now ranks', () => {
    const first = feedPage(['a', 'b', 'c', 'd', 'e'], null, 2, 9);
    // Recomputed: the two just shown sank (impression fatigue), a new one is in.
    const second = feedPage(['c', 'x', 'd', 'e', 'a', 'b'], decodeFeedCursor(first.next), 2, 9);
    expect(second.ids).toEqual(['c', 'x']);
    const third = feedPage(['d', 'e', 'a', 'b', 'c', 'x'], decodeFeedCursor(second.next), 5, 9);
    expect(third).toEqual({ ids: ['d', 'e'], next: null });
  });
  it('turns an old offset into a fingerprinted session', () => {
    const p = feedPage(['a', 'b', 'c', 'd'], { kind: 'offset', o: 2 }, 1, 5);
    expect(p.ids).toEqual(['c']);
    const next = feedPage(['d', 'a', 'b', 'c'], decodeFeedCursor(p.next), 4, 5);
    expect(next.ids).toEqual(['d']);
  });
});

describe('ranked feed paging', () => {
  it('pages through every battle exactly once', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const r = await page(env, cursor);
      seen.push(...r.body.items.map((m: any) => m.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(12);
    expect(new Set(seen).size).toBe(12);
  });

  it('a recomputed order (another server, or the cache gone) neither repeats nor skips', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    const p1 = await page(env);
    const first = p1.body.items.map((m: any) => m.id);
    // The viewer votes on a later battle, which re-ranks it, and every
    // in-memory order is lost, as on a different isolate.
    memoReset();
    const p2 = await page(env, p1.body.nextCursor);
    const second = p2.body.items.map((m: any) => m.id);
    expect(second.filter((id: string) => first.includes(id))).toEqual([]);
    expect(second).toHaveLength(4);
  });

  it('a battle created after the first page waits for the next refresh', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    const p1 = await page(env);
    await user(env, 'na');
    await user(env, 'nb');
    // Brand new and very fresh: it would rank first.
    await match(env, 'fresh', 'na', 'nb', Date.now());
    memoReset();
    const rest: string[] = [];
    let cursor = p1.body.nextCursor;
    while (cursor) {
      const r = await page(env, cursor);
      rest.push(...r.body.items.map((m: any) => m.id));
      cursor = r.body.nextCursor;
    }
    expect(rest).not.toContain('fresh');
    expect(new Set([...p1.body.items.map((m: any) => m.id), ...rest]).size).toBe(12);
    const refreshed = await page(env);
    expect(refreshed.body.items[0].id).toBe('fresh');
  });

  it('an old numeric cursor still works as an offset', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    const r = await page(env, '4');
    expect(r.body.items).toHaveLength(4);
    expect(typeof r.body.nextCursor).toBe('string');
  });
});

describe('"Not interested" list and undo', () => {
  it('lists dismissals newest first with a preview, and Show again brings the battle back', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    expect((await api(env, 'viewer', 'setFeedDismissal', { matchId: 'm00', dismissed: true })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 5));
    expect((await api(env, 'viewer', 'setFeedDismissal', { matchId: 'm01', dismissed: true })).status).toBe(200);
    const list = await get(env, '/me/feed-dismissals', 'viewer');
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('private, no-store');
    expect(list.body.items.map((i: any) => i.matchId)).toEqual(['m01', 'm00']);
    expect(list.body.items[0].match).toMatchObject({ id: 'm01', userA: { username: 'a1' } });

    const all = async () => {
      memoReset();
      const r = await get(env, '/matches?status=active&sort=foryou&limit=20', 'viewer');
      return r.body.items.map((m: any) => m.id);
    };
    expect(await all()).not.toContain('m01');
    expect((await api(env, 'viewer', 'setFeedDismissal', { matchId: 'm01', dismissed: false })).status).toBe(200);
    expect(await all()).toContain('m01');
    expect((await get(env, '/me/feed-dismissals', 'viewer')).body.items.map((i: any) => i.matchId)).toEqual(['m00']);
  });

  it('is private to the viewer and needs sign-in', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    await user(env, 'other');
    await api(env, 'viewer', 'setFeedDismissal', { matchId: 'm00', dismissed: true });
    expect((await get(env, '/me/feed-dismissals')).status).toBe(401);
    expect((await get(env, '/me/feed-dismissals', 'other')).body.items).toEqual([]);
  });

  it('pages with a cursor', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    for (const id of ['m00', 'm01', 'm02']) {
      await api(env, 'viewer', 'setFeedDismissal', { matchId: id, dismissed: true });
      await new Promise((r) => setTimeout(r, 3));
    }
    const p1 = await get(env, '/me/feed-dismissals?limit=2', 'viewer');
    expect(p1.body.items).toHaveLength(2);
    const p2 = await get(env, `/me/feed-dismissals?limit=2&cursor=${p1.body.nextCursor}`, 'viewer');
    expect(p2.body.items.map((i: any) => i.matchId)).toEqual(['m00']);
    expect(p2.body.nextCursor).toBeNull();
  });
});

describe('admin feed weights', () => {
  it('returns defaults, ranges and the effective weights for full admins only', async () => {
    const { env } = makeEnv();
    await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid: 'mod', username: 'mod', fullName: 'mod', role: 'moderator', createdAt: 1, updatedAt: 1 } as any);
    const call = (headers: Record<string, string>) => app.request('/admin/feed-weights', { headers }, env, fakeCtx());
    expect((await call({ Authorization: 'Bearer mod:moderator' })).status).toBe(403);
    const r: any = await (await call({ 'X-Admin-Secret': 'test-admin-secret' })).json();
    expect(r.defaults).toEqual(FEED_DEFAULT_WEIGHTS);
    expect(r.effective).toEqual(FEED_DEFAULT_WEIGHTS);
    expect(r.stored).toBeNull();
    expect(r.bounds.follow).toEqual([0, 10]);
    expect(r.integerKeys).toEqual(['seenCap']);
    expect(r.version).toBe(r.defaultVersion);

    await app.request(
      '/admin/app-settings',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' }, body: JSON.stringify({ feedWeights: { follow: 4 } }) },
      env,
      fakeCtx(),
    );
    const after: any = await (await call({ 'X-Admin-Secret': 'test-admin-secret' })).json();
    expect(after.effective.follow).toBe(4);
    expect(after.version).not.toBe(after.defaultVersion);
  });
});

describe('offline evaluation harness', () => {
  const at = 1_800_000_000_000;
  const m = (id: string, a: string, b: string, hAgo: number, votes = 0) => ({
    id,
    status: 'active' as const,
    createdAt: at - hAgo * 3_600_000,
    activatedAt: at - hAgo * 3_600_000,
    expiresAt: at + DAY,
    totalVotes: votes,
    likeCount: 0,
    commentCount: 0,
    userA: { uid: a },
    userB: { uid: b },
  });
  const snap: EvalSnapshot = {
    viewer: 'v',
    at,
    // The viewer follows "fav", whose battle is the oldest and quietest.
    pool: [m('new1', 'x1', 'y1', 1, 5), m('new2', 'x2', 'y2', 2, 5), m('fav', 'fav', 'z', 20, 0)],
    creators: {},
    signals: { follows: ['fav'], votedFor: [], votedMatches: [], visited: [], dismissedCreators: [], dismissedMatches: [] },
    outcomes: { fav: 1 },
  };

  it('ranks with the live feed code: the follow signal decides', () => {
    expect(rankSnapshot(snap, sanitizeFeedWeights({}))[0]).toBe('fav');
    expect(rankSnapshot(snap, sanitizeFeedWeights({ follow: 0 }))[0]).not.toBe('fav');
  });

  it('scores NDCG, recall and MRR', () => {
    const top = scoreOrder(['fav', 'new1', 'new2'], snap);
    expect(top).toMatchObject({ ndcg8: 1, recall8: 1, mrr: 1 });
    const third = scoreOrder(['new1', 'new2', 'fav'], snap);
    expect(third.mrr).toBeCloseTo(1 / 3);
    expect(third.ndcg8).toBeCloseTo(1 / Math.log2(4));
  });

  it('compares two weight sets per snapshot and skips snapshots with no outcome in the pool', () => {
    const data: EvalDataset = {
      version: 1,
      builtAt: at,
      source: 'test',
      horizonHours: 24,
      snapshots: [snap, { ...snap, outcomes: { gone: 1 } }],
    };
    const r = compareWeights(data, {}, { follow: 0 });
    expect(r.scored).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.losses).toBe(1);
    expect(r.delta.mrr).toBeLessThan(0);
    expect(r.versionA).not.toBe(r.versionB);
    expect(r.limits.length).toBeGreaterThan(0);
  });

  it('a dismissed battle is left out of the replayed feed', () => {
    const s = { ...snap, signals: { ...snap.signals, dismissedMatches: ['fav'] } };
    expect(rankSnapshot(s, sanitizeFeedWeights({}))).not.toContain('fav');
  });
});
