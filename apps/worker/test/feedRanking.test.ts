/**
 * For You ranking controls: bounded/audited weights and the ranking version,
 * ordered affinity lookbacks, the ranked-path status/type guard, new-creator
 * exploration, "Not interested", and the signed-in search rate limit.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

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
import {
  FEED_DEFAULT_WEIGHTS,
  FEED_WEIGHT_BOUNDS,
  rankingVersion,
  sanitizeFeedWeights,
  validateFeedWeightsPatch,
} from '../src/lib/feedWeights';
import { FEED_DISMISSAL_RETENTION_MS } from '../src/lib/feedDismissals';
import { SEARCH_LIMIT_PER_UID } from '../src/routes/read';

const app = makeApp();
const DAY = 86_400_000;

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
async function adminSave(env: TestEnv, body: unknown) {
  const res = await app.request(
    '/admin/app-settings',
    { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' }, body: JSON.stringify(body) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function user(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  // Established by default: an old account with an audience.
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: 1, updatedAt: 1, followersCount: 500, ...extra } as any);
}
const T0 = Date.now() - 3_600_000;
async function match(env: TestEnv, id: string, a: string, b: string, extra: Record<string, any> = {}) {
  await drizzleOf(env)
    .insert(schema.contestMatches)
    .values({
      id,
      status: 'active',
      type: 'photo',
      title: `Battle ${id}`,
      userA: { uid: a, username: a, mediaUrl: 'https://media.example.com/a.jpg' },
      userB: { uid: b, username: b, mediaUrl: 'https://media.example.com/b.jpg' },
      entryFee: 0,
      createdAt: T0,
      activatedAt: T0,
      expiresAt: T0 + 3 * DAY,
      ...extra,
    } as any);
}
const forYou = async (env: TestEnv, uid?: string) => {
  const r = await get(env, '/matches?status=active&sort=foryou&limit=20', uid);
  return { ids: (r.body.items as any[]).map((m) => m.id), headers: r.headers };
};

// ===========================================================================
describe('feed weights', () => {
  it('clamps stored values into range and ignores unknown or non-numeric keys', () => {
    const w = sanitizeFeedWeights({ votedPenalty: -4, follow: 1e9, seenCap: 3.6, velocity: 'x', bogus: 7 });
    expect(w.votedPenalty).toBe(0);
    expect(w.follow).toBe(FEED_WEIGHT_BOUNDS.follow[1]);
    expect(w.seenCap).toBe(4);
    expect(w.velocity).toBe(FEED_DEFAULT_WEIGHTS.velocity);
    expect('bogus' in w).toBe(false);
    expect(sanitizeFeedWeights(null)).toEqual(FEED_DEFAULT_WEIGHTS);
    expect(sanitizeFeedWeights([1, 2])).toEqual(FEED_DEFAULT_WEIGHTS);
  });

  it('every default sits inside its own bounds', () => {
    for (const [k, v] of Object.entries(FEED_DEFAULT_WEIGHTS)) {
      const [lo, hi] = (FEED_WEIGHT_BOUNDS as any)[k];
      expect(v >= lo && v <= hi, k).toBe(true);
    }
  });

  it('save-time validation names the bad key', () => {
    expect(() => validateFeedWeightsPatch(undefined)).not.toThrow();
    expect(() => validateFeedWeightsPatch(null)).not.toThrow();
    expect(() => validateFeedWeightsPatch({ follow: 4 })).not.toThrow();
    expect(() => validateFeedWeightsPatch({ follow: -1 })).toThrow(/feedWeights.follow must be a number from 0 to 10/);
    expect(() => validateFeedWeightsPatch({ follow: '3' })).toThrow(/feedWeights.follow/);
    expect(() => validateFeedWeightsPatch({ folow: 3 })).toThrow(/not a ranking weight/);
    expect(() => validateFeedWeightsPatch({ seenCap: 2.5 })).toThrow(/whole number/);
    expect(() => validateFeedWeightsPatch([1])).toThrow(/must be an object/);
  });

  it('the ranking version is stable for equal weights and changes with them', () => {
    const a = rankingVersion(sanitizeFeedWeights({}));
    expect(a).toMatch(/^foryou-2\.[0-9a-f]{8}$/);
    expect(rankingVersion(sanitizeFeedWeights({}))).toBe(a);
    expect(rankingVersion(sanitizeFeedWeights({ follow: 4 }))).not.toBe(a);
  });

  it('admin save rejects an out-of-range weight and stores nothing', async () => {
    const { env } = makeEnv();
    const r = await adminSave(env, { feedWeights: { votedPenalty: -2 } });
    expect(r.status).toBe(400);
    const row = await env.DB.prepare("SELECT data FROM settings WHERE id = 'appConfig'").first<any>();
    expect(row?.data ? JSON.parse(row.data).feedWeights : undefined).toBeUndefined();
  });

  it('admin save is audited and changes the X-Feed-Ranking version at once', async () => {
    const { env } = makeEnv();
    await user(env, 'pa');
    await user(env, 'pb');
    await match(env, 'm1', 'pa', 'pb');
    const before = (await forYou(env)).headers.get('X-Feed-Ranking');
    expect(before).toBe(rankingVersion(sanitizeFeedWeights({})));

    expect((await adminSave(env, { feedWeights: { follow: 4.5 } })).status).toBe(200);
    const audit = await env.DB.prepare("SELECT detail FROM admin_audit_log WHERE action = 'settings.feedWeights.update'").all<any>();
    expect(audit.results).toHaveLength(1);
    expect(audit.results[0].detail).toContain('4.5');

    const after = (await forYou(env)).headers.get('X-Feed-Ranking');
    expect(after).toBe(rankingVersion(sanitizeFeedWeights({ follow: 4.5 })));
    expect(after).not.toBe(before);
  });
});

// ===========================================================================
describe('ranked path guard', () => {
  it('answers an unknown status or type with an empty page and caches nothing', async () => {
    const { env } = makeEnv();
    await user(env, 'pa');
    await user(env, 'pb');
    await match(env, 'm1', 'pa', 'pb');
    for (const q of ['status=whatever', 'status=active&type=gif']) {
      const r = await get(env, `/matches?${q}&sort=foryou`);
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ items: [], nextCursor: null });
    }
    expect((await forYou(env)).ids).toEqual(['m1']);
  });
});

// ===========================================================================
describe('affinity lookback', () => {
  it('uses the viewer\'s most recent votes, not the oldest rows', async () => {
    const { env } = makeEnv();
    for (const u of ['me', 'fav', 'x1', 'y1', 'y2']) await user(env, u);
    // 'plain' wins on prize alone; the votedAffinity bump (1.5) must lift 'liked' above it.
    await match(env, 'liked', 'fav', 'x1');
    await match(env, 'plain', 'y1', 'y2', { entryFee: 20 });
    // 500 old votes (the whole lookback) for nobody in the pool, then one recent vote for 'fav'.
    const insert = 'INSERT INTO votes (id, match_id, voter_uid, voted_for_uid, created_at) VALUES (?, ?, ?, ?, ?)';
    await env.DB.batch(Array.from({ length: 500 }, (_, i) => env.DB.prepare(insert).bind(`old${i}_me`, `old${i}`, 'me', `ghost${i}`, 1000 + i)));
    await env.DB.prepare('INSERT INTO votes (id, match_id, voter_uid, voted_for_uid, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('past_me', 'past', 'me', 'fav', Date.now())
      .run();
    expect((await forYou(env, 'me')).ids).toEqual(['liked', 'plain']);
  });
});

// ===========================================================================
describe('new-creator exploration', () => {
  async function setup(newCreator: Record<string, any>) {
    const { env } = makeEnv();
    for (const u of ['pa', 'pb', 'pd']) await user(env, u);
    await user(env, 'nc', newCreator);
    // 'est' leads on prize (+0.21); the exploration bump (0.8) must lift 'fresh' over it.
    await match(env, 'est', 'pa', 'pb', { entryFee: 1 });
    await match(env, 'fresh', 'nc', 'pd');
    return env;
  }

  it('lifts a live battle with a new, small creator', async () => {
    const env = await setup({ createdAt: Date.now() - 2 * DAY, followersCount: 3 });
    expect((await forYou(env)).ids).toEqual(['fresh', 'est']);
    expect((await forYou(env, 'pa')).ids[0]).toBe('fresh');
  });

  it('does not lift an account older than 30 days or with 50+ followers', async () => {
    expect((await forYou(await setup({ createdAt: Date.now() - 40 * DAY, followersCount: 3 }))).ids).toEqual(['est', 'fresh']);
    expect((await forYou(await setup({ createdAt: Date.now() - 2 * DAY, followersCount: 50 }))).ids).toEqual(['est', 'fresh']);
  });

  it('is switched off by newCreator: 0', async () => {
    const env = await setup({ createdAt: Date.now() - 2 * DAY, followersCount: 3 });
    expect((await adminSave(env, { feedWeights: { newCreator: 0 } })).status).toBe(200);
    expect((await forYou(env)).ids).toEqual(['est', 'fresh']);
  });
});

// ===========================================================================
describe('"Not interested"', () => {
  async function setup() {
    const { env } = makeEnv();
    for (const u of ['me', 'pa', 'pb', 'pc', 'pd', 'pe']) await user(env, u);
    // Prize sets the starting order d2 > n1 > d1 (d2 leads n1 by ~0.2).
    // d1 and d2 share creator 'pa'.
    await match(env, 'd2', 'pa', 'pc', { entryFee: 3 });
    await match(env, 'n1', 'pd', 'pe', { entryFee: 1 });
    await match(env, 'd1', 'pa', 'pb');
    return env;
  }

  it('removes the battle at once (even over a cached order) and demotes the creator', async () => {
    const env = await setup();
    const first = (await forYou(env, 'me')).ids;
    expect(first.indexOf('d2')).toBeLessThan(first.indexOf('n1'));

    const r = await api(env, 'me', 'setFeedDismissal', { matchId: 'd1', dismissed: true });
    expect(r).toMatchObject({ status: 200, body: { dismissed: true } });
    expect((await forYou(env, 'me')).ids).toEqual(['n1', 'd2']);
    // Only this viewer's feed changes.
    expect((await forYou(env, 'pd')).ids).toContain('d1');
    expect((await forYou(env)).ids).toContain('d1');
  });

  it('is idempotent and undoable', async () => {
    const env = await setup();
    await api(env, 'me', 'setFeedDismissal', { matchId: 'd1', dismissed: true });
    expect((await api(env, 'me', 'setFeedDismissal', { matchId: 'd1', dismissed: true })).status).toBe(200);
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM feed_dismissals WHERE viewer_uid = 'me'").first<any>();
    expect(n.n).toBe(1);

    await api(env, 'me', 'setFeedDismissal', { matchId: 'd1', dismissed: false });
    const ids = (await forYou(env, 'me')).ids;
    expect(ids).toContain('d1');
    expect(ids.indexOf('d2')).toBeLessThan(ids.indexOf('n1'));
  });

  it('refuses your own battle, an unknown battle and a missing target state', async () => {
    const env = await setup();
    expect((await api(env, 'pa', 'setFeedDismissal', { matchId: 'd1', dismissed: true })).status).toBe(400);
    expect((await api(env, 'me', 'setFeedDismissal', { matchId: 'nope', dismissed: true })).status).toBe(404);
    expect((await api(env, 'me', 'setFeedDismissal', { matchId: 'd1' })).status).toBe(400);
  });

  it('prunes the viewer\'s rows past retention on the next dismissal', async () => {
    const env = await setup();
    await env.DB.prepare('INSERT INTO feed_dismissals (viewer_uid, match_id, creator_a, creator_b, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('me', 'ancient', 'pd', 'pe', Date.now() - FEED_DISMISSAL_RETENTION_MS - DAY)
      .run();
    await api(env, 'me', 'setFeedDismissal', { matchId: 'd2', dismissed: true });
    const rows = await env.DB.prepare("SELECT match_id FROM feed_dismissals WHERE viewer_uid = 'me'").all<any>();
    expect(rows.results.map((r: any) => r.match_id)).toEqual(['d2']);
  });

  it('goes with account deletion', async () => {
    const env = await setup();
    await env.DB.prepare('INSERT INTO feed_dismissals (viewer_uid, match_id, creator_a, creator_b, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind('me', 'd1', 'pa', 'pb', Date.now())
      .run();
    const { executeAccountDeletion } = await import('../src/lib/accountDeletion');
    await drizzleOf(env).update(schema.users).set({ status: 'pending_deletion' } as any).where(eq(schema.users.uid, 'me'));
    await executeAccountDeletion(env as any, 'me').catch(() => {});
    const n = await env.DB.prepare("SELECT COUNT(*) n FROM feed_dismissals WHERE viewer_uid = 'me'").first<any>();
    expect(n.n).toBe(0);
  });
});

// ===========================================================================
describe('signed-in search rate limit', () => {
  it(`allows ${SEARCH_LIMIT_PER_UID} searches a minute per account, then 429`, async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    for (let i = 0; i < SEARCH_LIMIT_PER_UID; i++) expect((await get(env, '/search?q=ab', 'me')).status).toBe(200);
    expect((await get(env, '/search?q=ab', 'me')).status).toBe(429);
    // Per account: someone else is unaffected.
    await user(env, 'you');
    expect((await get(env, '/search?q=ab', 'you')).status).toBe(200);
  });
});
