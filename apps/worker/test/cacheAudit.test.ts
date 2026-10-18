/**
 * Regression guards for the 2026-10 cache / D1-load audit (see CACHE_POLICY.md).
 *
 * Each block pins one confirmed gap that was fixed:
 *   - shared cache keys built from normalised, bounded values (no raw query strings);
 *   - viewer-dependent responses carry `Vary: Authorization`;
 *   - the comments first-page entry cannot be poisoned by an odd `limit`;
 *   - not-found contest details are not cached;
 *   - the notifications list can return the badge count in the same request;
 *   - the feed-ranking weights stop costing a KV read per feed request;
 *   - the expired-story sweep never deletes a row whose media it did not clean.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/firebaseAdmin', () => ({
  revokeRefreshTokens: async () => undefined,
  deleteAuthUser: async () => undefined,
  updateAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  getUserByEmail: async () => null,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
  finalizeVotes: async () => ({ votesA: 0, votesB: 0, total: 0 }),
}));
vi.mock('../src/lib/publish', () => ({ publish: async () => {}, publishMany: async () => {} }));
const deletedMedia: string[] = [];
let failMedia = false;
vi.mock('../src/lib/mediaDelete', () => ({
  deleteMediaByUrl: async (_env: unknown, url: string) => {
    if (failMedia && url.includes('FAIL')) throw new Error('provider outage');
    deletedMedia.push(url);
  },
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, installEdgeCache, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { memoReset } from '../src/lib/memo';
import { invalidateSetting } from '../src/lib/settings';
import { resolveContests, EXPIRED_STORY_BATCH, STORY_MEDIA_GIVE_UP_MS } from '../src/cron';

const app = makeApp();
let edge: ReturnType<typeof installEdgeCache>;
beforeEach(() => {
  edge = installEdgeCache();
  memoReset();
  deletedMedia.length = 0;
});
afterEach(() => edge.restore());

async function get(env: TestEnv, path: string, uid?: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

async function seedUsersAndBattle(env: TestEnv) {
  const ts = Date.now();
  const db = drizzleOf(env);
  for (const uid of ['alice', 'bob', 'carol']) {
    await db.insert(schema.users).values({ uid, username: uid, fullName: uid, createdAt: ts, updatedAt: ts } as any);
  }
  await db.insert(schema.contestMatches).values({
    id: 'm1',
    status: 'active',
    type: 'photo',
    title: 'Battle m1',
    userA: { uid: 'alice', username: 'alice', mediaUrl: 'a.jpg', votes: 0 },
    userB: { uid: 'bob', username: 'bob', mediaUrl: 'b.jpg', votes: 0 },
    totalVotes: 0,
    likeCount: 0,
    commentCount: 0,
    shareCount: 0,
    createdAt: ts,
    activatedAt: ts,
    expiresAt: ts + 86_400_000,
  } as any);
}

describe('/read/matches page-cache keys are normalised and bounded', () => {
  it('an unparseable cursor shares the first-page entry instead of minting a new one', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    await get(env, '/matches?status=active&sort=recent');
    await get(env, '/matches?status=active&sort=recent&cursor=abc');
    await get(env, '/matches?status=active&sort=recent&cursor=');
    const keys = edge.logicalKeys().filter((k) => k.startsWith('cache:matches:'));
    expect(keys).toEqual(['cache:matches:active:all:recent:30:first']);
  });

  it('cursor=0 (an empty keyset page) cannot poison the first-page entry', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    for (const cursor of ['0', '0.0', '-0', '0x0', ' ']) {
      await get(env, `/matches?status=active&sort=recent&cursor=${encodeURIComponent(cursor)}`);
    }
    // Every viewer's default list still has the battle.
    expect((await get(env, '/matches?status=active&sort=recent')).body).toHaveLength(1);
    expect((await get(env, '/matches?status=active&sort=recent', 'carol')).body).toHaveLength(1);
  });

  it('answers an unknown status or type but never caches it', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    for (let i = 0; i < 3; i++) {
      expect((await get(env, `/matches?status=bogus${i}&sort=recent`)).body).toEqual([]);
      expect((await get(env, `/matches?status=active&type=gif${i}&sort=recent`)).body).toEqual([]);
    }
    expect(edge.logicalKeys().filter((k) => k.startsWith('cache:matches:'))).toEqual([]);
  });

  it('hot-sort offsets are floored, so 8 and 8.7 are one entry', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    // A fractional offset used to reach SQL as `OFFSET 8.7` and fail the request.
    expect((await get(env, '/matches?status=active&sort=hot&cursor=8')).status).toBe(200);
    expect((await get(env, '/matches?status=active&sort=hot&cursor=8.7')).status).toBe(200);
    expect(edge.logicalKeys().filter((k) => k.startsWith('cache:matches:'))).toEqual([
      'cache:matches:active:all:hot:30:o8',
    ]);
  });
});

describe('cache outcome is observable', () => {
  it('records miss, hit and skip on the request context, never the key', async () => {
    const { env } = makeEnv();
    const { cachedJson } = await import('../src/lib/edgeCache');
    const seen: string[] = [];
    const ctx: any = {
      env,
      req: { url: 'https://api.example/read/x' },
      executionCtx: fakeCtx(),
      set: (k: string, v: string) => seen.push(`${k}=${v}`),
    };
    const opts = { key: 'cache:test:1', edgeTtlSec: 30, kvTtlSec: null, load: async () => ({ v: 1 }) };
    await cachedJson(ctx, opts);
    await new Promise((r) => setTimeout(r, 0)); // let the waitUntil put land
    await cachedJson(ctx, opts);
    await cachedJson(ctx, { ...opts, key: 'cache:test:2', skipCache: () => true });
    expect(seen).toEqual(['edgeCache=miss', 'edgeCache=hit', 'edgeCache=skip']);
  });
});

describe('viewer-dependent match lists declare Vary: Authorization', () => {
  it('recent list, guest and signed-in', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    const guest = await get(env, '/matches?status=active&sort=recent');
    expect(guest.headers.get('Vary')).toBe('Authorization');
    expect(guest.headers.get('Cache-Control')).toBe('public, max-age=15');
    const me = await get(env, '/matches?status=active&sort=recent', 'carol');
    expect(me.headers.get('Vary')).toBe('Authorization');
    expect(me.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('personalised feed, including the empty guest Following tab', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    for (const [sort, uid] of [
      ['foryou', undefined],
      ['foryou', 'carol'],
      ['following', undefined],
      ['following', 'carol'],
    ] as const) {
      const r = await get(env, `/matches?status=active&sort=${sort}&limit=8`, uid);
      expect(r.status).toBe(200);
      expect(r.headers.get('Vary'), `${sort}/${uid}`).toBe('Authorization');
      expect(r.headers.get('Cache-Control'), `${sort}/${uid}`).toBe(uid ? 'private, no-store' : 'public, max-age=15');
    }
  });

  it('the guest feed carries no viewer-specific flags', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    // Warm the shared pool with a signed-in request first.
    await get(env, '/matches?status=active&sort=foryou&limit=8', 'carol');
    const guest = await get(env, '/matches?status=active&sort=foryou&limit=8');
    for (const item of guest.body.items) {
      for (const flag of ['hasVoted', 'votedForUid', 'isLiked', 'isBookmarked']) {
        expect(item, flag).not.toHaveProperty(flag);
      }
    }
  });
});

describe('comments first-page cache', () => {
  async function seedThread(env: TestEnv, n: number) {
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.matchComments)
      .values(
        Array.from({ length: n }, (_, i) => ({ id: `c${i}`, matchId: 'm1', userId: 'carol', text: `t${i}`, createdAt: ts + i })) as any,
      );
  }

  it('an odd limit cannot fix the page size every other viewer receives', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    await seedThread(env, 5);
    const tiny = await get(env, '/comments?targetType=matches&targetId=m1&limit=1');
    expect(tiny.body.items).toHaveLength(1);
    // Previously this was served the cached 1-item page for the whole TTL.
    const normal = await get(env, '/comments?targetType=matches&targetId=m1');
    expect(normal.body.items).toHaveLength(5);
  });

  it('the canonical page size is still served from the edge', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    await seedThread(env, 3);
    await get(env, '/comments?targetType=matches&targetId=m1&limit=20');
    await drizzleOf(env).delete(schema.matchComments);
    // Only a cache hit can still return the rows.
    expect((await get(env, '/comments?targetType=matches&targetId=m1&limit=20')).body.items).toHaveLength(3);
  });
});

describe('comment deletion purges the thread the comment actually belonged to', () => {
  it('even when the client sends the wrong targetId', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.matchComments)
      .values([
        { id: 'c1', matchId: 'm1', userId: 'carol', text: 'one', createdAt: ts },
        { id: 'c2', matchId: 'm1', userId: 'carol', text: 'two', createdAt: ts + 1 },
      ] as any);
    expect((await get(env, '/comments?targetType=matches&targetId=m1')).body.items).toHaveLength(2); // fills the edge

    const res = await app.request(
      '/api',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer carol', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'deleteComment', targetType: 'matches', targetId: 'some-other-thread', commentId: 'c1' }),
      },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);
    const after = await get(env, '/comments?targetType=matches&targetId=m1');
    expect(after.body.items.map((i: any) => i.id)).toEqual(['c2']);
  });
});

describe('leaderboard and contest-detail keys', () => {
  it('an unknown ?by= shares the wins entry', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    await get(env, '/leaderboard?by=wins');
    await get(env, '/leaderboard?by=whatever');
    await get(env, '/leaderboard');
    expect(edge.logicalKeys().filter((k) => k.startsWith('cache:leaderboard:'))).toEqual(['cache:leaderboard:wins:20']);
  });

  it('does not cache a contest that does not exist', async () => {
    const { env } = makeEnv();
    for (let i = 0; i < 3; i++) await get(env, `/contests/nope-${i}`);
    expect(edge.logicalKeys().filter((k) => k.startsWith('cache:contest:detail:'))).toEqual([]);
  });
});

describe('notifications list can carry the badge count', () => {
  async function seedNotifications(env: TestEnv) {
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.notifications)
      .values([
        { id: 'n1', recipientId: 'bob', title: 'a', body: 'a', type: 'follow', seen: false, createdAt: ts },
        { id: 'n2', recipientId: 'bob', title: 'b', body: 'b', type: 'follow', seen: false, createdAt: ts + 1 },
        { id: 'n3', recipientId: 'bob', title: 'c', body: 'c', type: 'follow', seen: true, createdAt: ts + 2 },
        { id: 'n4', recipientId: 'alice', title: 'd', body: 'd', type: 'follow', seen: false, createdAt: ts },
      ] as any);
  }

  it('X-Unread-Count equals /unread-count when asked for, and only then', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    await seedNotifications(env);
    const count = await get(env, '/notifications/unread-count', 'bob');
    expect(count.body).toEqual({ count: 2 });

    const withUnread = await get(env, '/notifications?limit=50&withUnread=1', 'bob');
    expect(withUnread.body).toHaveLength(3);
    expect(withUnread.headers.get('X-Unread-Count')).toBe('2');
    expect(withUnread.headers.get('Cache-Control')).toBe('private, no-store');

    const plain = await get(env, '/notifications?limit=50', 'bob');
    expect(plain.headers.get('X-Unread-Count')).toBeNull();

    // Deeper pages never pay for the count.
    const deeper = await get(env, `/notifications?limit=1&cursor=${Date.now() + 10_000}&withUnread=1`, 'bob');
    expect(deeper.headers.get('X-Unread-Count')).toBeNull();
  });

  it('is exposed to browsers through CORS', async () => {
    const { API_EXPOSED_HEADERS } = await import('../src/lib/apiCors');
    expect(API_EXPOSED_HEADERS).toContain('X-Unread-Count');
  });
});

describe('feed ranking weights', () => {
  function countSettingsReads(env: TestEnv) {
    let n = 0;
    const orig = env.CACHE_KV.get.bind(env.CACHE_KV);
    env.CACHE_KV.get = (async (key: string, type?: any) => {
      if (key === 'settings:appConfig') n++;
      return orig(key, type);
    }) as any;
    return () => n;
  }

  it('cost one appConfig read per isolate window, not one per feed request', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    const reads = countSettingsReads(env);
    for (let i = 0; i < 5; i++) await get(env, '/matches?status=active&sort=foryou&limit=8', 'carol');
    expect(reads()).toBe(1);
  });

  it('an appConfig invalidation drops the memo in the writer isolate', async () => {
    const { env } = makeEnv();
    await seedUsersAndBattle(env);
    const reads = countSettingsReads(env);
    await get(env, '/matches?status=active&sort=foryou&limit=8', 'carol');
    await invalidateSetting(env as any, 'appConfig');
    await get(env, '/matches?status=active&sort=foryou&limit=8', 'carol');
    expect(reads()).toBe(2);
  });
});

describe('expired-story sweep', () => {
  it('never deletes a personal story row whose media it did not clean up', async () => {
    const { env } = makeEnv();
    const now = Date.now();
    const total = EXPIRED_STORY_BATCH + 7;
    const rows = Array.from({ length: total }, (_, i) => ({
      id: `s${i}`,
      userId: 'alice',
      mediaUrl: `https://cdn.example/stories/s${i}.jpg`,
      type: 'user',
      createdAt: now - 90_000_000,
      expiresAt: now - 1000 - i,
    }));
    const db = drizzleOf(env);
    for (let i = 0; i < rows.length; i += 50) await db.insert(schema.stories).values(rows.slice(i, i + 50) as any);
    // A contest story owns no media and is always removed once expired.
    await db.insert(schema.stories).values({
      id: 'vs1', userId: 'alice', mediaUrl: 'https://cdn.example/entry.jpg', type: 'contest_vs', matchId: 'mx',
      createdAt: now - 90_000_000, expiresAt: now - 1000,
    } as any);

    await resolveContests(env as any);
    let left = await db.select({ id: schema.stories.id }).from(schema.stories).all();
    expect(deletedMedia).toHaveLength(EXPIRED_STORY_BATCH);
    expect(left).toHaveLength(7);
    expect(left.map((r) => r.id)).not.toContain('vs1');

    // The next tick drains the remainder — with their media.
    await resolveContests(env as any);
    left = await db.select({ id: schema.stories.id }).from(schema.stories).all();
    expect(left).toHaveLength(0);
    expect(new Set(deletedMedia).size).toBe(total);
  });

  it('keeps the row when its media delete fails, until the give-up window', async () => {
    const { env } = makeEnv();
    const now = Date.now();
    const db = drizzleOf(env);
    await db.insert(schema.stories).values([
      { id: 'fresh', userId: 'alice', mediaUrl: 'https://cdn.example/FAIL-fresh.jpg', type: 'user', createdAt: now - 90_000_000, expiresAt: now - 1000 },
      { id: 'ancient', userId: 'alice', mediaUrl: 'https://cdn.example/FAIL-old.jpg', type: 'user', createdAt: now - 30 * 86_400_000, expiresAt: now - STORY_MEDIA_GIVE_UP_MS - 1000 },
      { id: 'ok', userId: 'alice', mediaUrl: 'https://cdn.example/ok.jpg', type: 'user', createdAt: now - 90_000_000, expiresAt: now - 1000 },
    ] as any);
    failMedia = true;
    try {
      await resolveContests(env as any);
    } finally {
      failMedia = false;
    }
    const left = (await db.select({ id: schema.stories.id }).from(schema.stories).all()).map((r) => r.id);
    // The fresh failure keeps its row (the only pointer to the object) for a retry;
    // the ancient one is given up on so it cannot pin the batch forever.
    expect(left).toEqual(['fresh']);
  });
});
