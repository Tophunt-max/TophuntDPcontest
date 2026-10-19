/**
 * Guest-first access: what a signed-out visitor may read, and everything that
 * must stay behind an account.
 *
 * The rule under test: guest READABILITY is decided per endpoint on the server
 * (optionalAuth + content rules), never by a client redirect, and opening read
 * paths to guests must not open private data or any mutation.
 */
import { vi, describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  // Bearer "<uid>" or "<uid>@<authTime>" (seconds), so revocation can be tested.
  verifyIdToken: async (token: string) => {
    const at = /^(.+)@(\d+)$/.exec(token);
    if (at) return { uid: at[1], role: 'user', authTime: Number(at[2]) };
    return { uid: token, role: 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
  finalizeVotes: async () => ({ votesA: 0, votesB: 0, total: 0 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, installEdgeCache, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();
const DAY = 86_400_000;
let phoneSeq = 0;

async function get(env: TestEnv, path: string, token?: string) {
  const res = await app.request(path, { headers: token ? { Authorization: `Bearer ${token}` } : {} }, env, fakeCtx());
  return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
}
async function api(env: TestEnv, action: string, data: any = {}, token?: string) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.users).values({ signupCompleted: true,
    uid, username: uid, fullName: `${uid} full`, email: `${uid}@mail.test`, phone: `+91${String(++phoneSeq).padStart(10, '9')}`,
    dpcoin: 500, createdAt: ts, updatedAt: ts, ...extra,
  } as any);
}
async function seedStory(env: TestEnv, id: string, userId: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.stories).values({
    id, userId, username: userId, mediaUrl: `https://cdn.test/stories/images/${id}.jpg`, mediaType: 'image',
    visibility: 'public', type: 'user', createdAt: ts, expiresAt: ts + DAY, ...extra,
  } as any);
}
async function seedBattle(env: TestEnv, id = 'm1', extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.contestMatches).values({
    id, status: 'active', type: 'photo', title: 'Best Smile', createdAt: ts, activatedAt: ts, expiresAt: ts + DAY,
    joinIdA: 'A', joinIdB: 'B',
    userA: { uid: 'alice', username: 'alice', mediaUrl: 'https://cdn.test/contests/a.jpg', mediaType: 'photo', votes: 0 },
    userB: { uid: 'bob', username: 'bob', mediaUrl: 'https://cdn.test/contests/b.jpg', mediaType: 'photo', votes: 0 },
    ...extra,
  } as any);
}
const follow = (env: TestEnv, followerId: string, followingId: string) =>
  drizzleOf(env).insert(schema.follows).values({ followerId, followingId, createdAt: Date.now() } as any);

/** Story ids in a /stories/feed response. */
const feedIds = (body: any[]) => (body || []).flatMap((g: any) => g.stories.map((s: any) => s.id)).sort();

// ===========================================================================
describe('guest-readable public content', () => {
  it('home feed: public battles, with no viewer-specific state', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedBattle(env);
    const res = await get(env, '/read/matches?status=active&sort=foryou&limit=8');
    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    expect(items.map((m: any) => m.id)).toContain('m1');
    for (const m of items) {
      // Viewer flags absent or safely false for a guest.
      expect(m.hasVoted ?? false).toBe(false);
      expect(m.isLiked ?? false).toBe(false);
      expect(m.isBookmarked ?? false).toBe(false);
    }
  });

  it('a shared battle link loads for a guest; a missing one is a clean not-found', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedBattle(env);
    const ok = await get(env, '/read/matches/m1');
    expect(ok.status).toBe(200);
    expect(ok.body.id).toBe('m1');
    const missing = await get(env, '/read/matches/does-not-exist');
    expect(missing.body ?? null).toBeNull();
  });

  it('contest listings and the leaderboard are guest-readable', async () => {
    const { env } = makeEnv();
    expect((await get(env, '/read/contests')).status).toBe(200);
    expect((await get(env, '/read/leaderboard')).status).toBe(200);
  });

  it('a public profile is guest-readable and exposes only public fields', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { bio: 'hello' });
    for (const path of ['/read/users/alice', '/read/users/by-username/alice']) {
      const res = await get(env, path);
      expect(res.status).toBe(200);
      expect(res.body.username).toBe('alice');
      const flat = JSON.stringify(res.body);
      for (const secret of ['alice@mail.test', '+919999', 'dpcoin', 'Dpcoin', 'fcmTokens', '"email"', '"phone"']) {
        expect(flat, secret).not.toContain(secret);
      }
    }
  });

  it('deleted and pending-deletion accounts are unavailable to guests', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'gone', { status: 'deleted' });
    await seedUser(env, 'leaving', { status: 'pending_deletion' });
    expect((await get(env, '/read/users/gone')).body ?? null).toBeNull();
    expect((await get(env, '/read/users/leaving')).body ?? null).toBeNull();
  });
});

// ===========================================================================
describe('Stories: guest-browsable, never wider than their audience', () => {
  async function storyWorld() {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'priv', { isPrivate: true });
    await seedUser(env, 'banned', { isBlocked: true });
    await seedUser(env, 'gone', { status: 'deleted' });
    await seedUser(env, 'fan');
    await seedUser(env, 'stranger');
    await seedStory(env, 'pub', 'alice');
    await seedStory(env, 'legacy-null', 'alice', { visibility: null });
    await seedStory(env, 'fol', 'alice', { visibility: 'followers' });
    await seedStory(env, 'priv-pub', 'priv');
    await seedStory(env, 'banned-pub', 'banned');
    await seedStory(env, 'gone-pub', 'gone');
    await seedStory(env, 'expired', 'alice', { expiresAt: Date.now() - 1 });
    await follow(env, 'fan', 'alice');
    await follow(env, 'fan', 'priv');
    return env;
  }

  it('a guest sees only public Stories of public accounts', async () => {
    const env = await storyWorld();
    const res = await get(env, '/read/stories/feed');
    expect(res.status).toBe(200);
    expect(feedIds(res.body)).toEqual(['legacy-null', 'pub']);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=30');
    // No viewer data in a guest answer.
    expect(JSON.stringify(res.body)).not.toMatch(/viewer|reaction/i);
  });

  it('a follower additionally sees followers-only and private-account Stories', async () => {
    const env = await storyWorld();
    const res = await get(env, '/read/stories/feed', 'fan');
    expect(feedIds(res.body)).toEqual(['fol', 'legacy-null', 'priv-pub', 'pub']);
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('a signed-in non-follower does not see followers-only Stories (previously leaked)', async () => {
    const env = await storyWorld();
    expect(feedIds((await get(env, '/read/stories/feed', 'stranger')).body)).toEqual(['legacy-null', 'pub']);
  });

  it('owners always see their own, first', async () => {
    const env = await storyWorld();
    const res = await get(env, '/read/stories/feed', 'priv');
    expect(res.body[0].userId).toBe('priv');
    expect(feedIds(res.body)).toContain('priv-pub');
  });

  it('the shared edge cache never carries one viewer\'s view to another', async () => {
    const cache = installEdgeCache();
    try {
      const env = await storyWorld();
      await get(env, '/read/stories/feed', 'fan'); // fills the shared base
      expect(feedIds((await get(env, '/read/stories/feed')).body)).toEqual(['legacy-null', 'pub']);
      expect(feedIds((await get(env, '/read/stories/feed', 'stranger')).body)).toEqual(['legacy-null', 'pub']);
    } finally {
      cache.restore();
    }
  });

  it('profile rings and highlights apply the same audience', async () => {
    const env = await storyWorld();
    const ring = await get(env, '/read/users/alice/stories');
    expect(ring.body.stories.map((s: any) => s.id).sort()).toEqual(['legacy-null', 'pub']);
    expect((await get(env, '/read/users/priv/stories')).body).toBeNull();
    const fanRing = await get(env, '/read/users/priv/stories', 'fan');
    expect(fanRing.body.stories.map((s: any) => s.id)).toEqual(['priv-pub']);

    await drizzleOf(env).insert(schema.highlights).values({
      id: 'h1', userId: 'alice', name: 'mine', storyIds: ['pub', 'fol'], createdAt: Date.now(),
    } as any);
    const hl = await get(env, '/read/highlights/h1/stories');
    expect(hl.body.stories.map((s: any) => s.id)).toEqual(['pub']);
  });

  it('the highlight shelf never publishes media of Stories the viewer may not see', async () => {
    const env = await storyWorld();
    const FOL = 'https://cdn.test/stories/images/fol.jpg';
    const PUB = 'https://cdn.test/stories/images/pub.jpg';
    await drizzleOf(env).insert(schema.highlights).values([
      { id: 'h-mixed', userId: 'alice', name: 'mixed', coverImageUrl: FOL, storyIds: ['fol', 'pub'], createdAt: Date.now() },
      { id: 'h-fol', userId: 'alice', name: 'close friends', coverImageUrl: FOL, storyIds: ['fol'], createdAt: Date.now() - 1 },
      { id: 'h-priv', userId: 'priv', name: 'private', coverImageUrl: 'https://cdn.test/stories/images/priv-pub.jpg', storyIds: ['priv-pub'], createdAt: Date.now() },
    ] as any);
    const guest = await get(env, '/read/users/alice/highlights');
    expect(guest.body.map((h: any) => h.id)).toEqual(['h-mixed']);
    expect(guest.body[0].storyIds).toEqual(['pub']);
    expect(guest.body[0].coverImageUrl).toBe(PUB);
    expect(JSON.stringify(guest.body)).not.toContain(FOL);
    expect(guest.headers.get('Vary')).toContain('Authorization');
    expect((await get(env, '/read/users/priv/highlights')).body).toEqual([]);
    // A follower sees the whole shelf; so does the owner.
    expect((await get(env, '/read/users/alice/highlights', 'fan')).body.map((h: any) => h.id).sort()).toEqual(['h-fol', 'h-mixed']);
    expect((await get(env, '/read/users/alice/highlights', 'alice')).body).toHaveLength(2);
  });

  it('guest Story answers vary on Authorization so a browser cannot replay them after sign-in', async () => {
    const env = await storyWorld();
    for (const path of ['/read/stories/feed', '/read/users/alice/stories']) {
      expect((await get(env, path)).headers.get('Vary'), path).toContain('Authorization');
    }
  });

  it('going private takes an account out of the shared stories bar immediately', async () => {
    const cache = installEdgeCache();
    try {
      const env = await storyWorld();
      expect(feedIds((await get(env, '/read/stories/feed')).body)).toContain('pub');
      expect((await api(env, 'updateProfile', { isPrivate: true }, 'alice')).status).toBe(200);
      expect(feedIds((await get(env, '/read/stories/feed')).body)).not.toContain('pub');
    } finally {
      cache.restore();
    }
  });

  it('a Story\'s viewer list stays owner-only', async () => {
    const env = await storyWorld();
    expect((await get(env, '/read/stories/pub/viewers')).status).toBe(401);
    expect((await get(env, '/read/stories/pub/viewers', 'stranger')).status).toBe(403);
    expect((await get(env, '/read/stories/pub/viewers', 'alice')).status).toBe(200);
  });

  it('a blocked viewer does not see the blocker\'s Stories', async () => {
    const env = await storyWorld();
    await api(env, 'blockUser', { targetUserId: 'stranger' }, 'alice');
    expect(feedIds((await get(env, '/read/stories/feed', 'stranger')).body)).toEqual([]);
  });
});

// ===========================================================================
describe('guest sharing', () => {
  it('a guest can resolve the canonical share image for a public battle', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedBattle(env, 'm1', { vsStoryStatus: 'pending' });
    const res = await get(env, '/read/matches/m1/share-image');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matchId: 'm1', status: 'preparing', url: null });
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('a waiting battle has no image; a blocked signed-in viewer is refused', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedUser(env, 'carol');
    await seedBattle(env, 'w1', { status: 'waiting_for_opponent', userB: null });
    expect((await get(env, '/read/matches/w1/share-image')).body.status).toBe('waiting_for_opponent');
    await seedBattle(env, 'm2');
    await api(env, 'blockUser', { targetUserId: 'carol' }, 'alice');
    expect((await get(env, '/read/matches/m2/share-image', 'carol')).status).toBe(403);
  });
});

// ===========================================================================
describe('protected reads and every mutation stay behind an account', () => {
  it('private reads refuse guests', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    for (const path of [
      '/read/chats',
      '/read/chats/c1/messages',
      '/read/notifications',
      '/read/notifications/unread-count',
      '/read/transactions',
      '/read/deposits',
      '/read/withdrawals',
      '/read/me/status',
      '/read/me/verification',
      '/read/users/alice/bookmarks',
      '/read/blocked',
      '/read/announcements/active',
      '/read/prizes',
    ]) {
      expect((await get(env, path)).status, path).toBe(401);
    }
  });

  it('guest mutations are rejected before any handler runs', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedBattle(env);
    for (const [action, data] of [
      ['likeContest', { matchId: 'm1' }],
      ['commentContest', { matchId: 'm1', text: 'hi' }],
      ['submitVote', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd' }],
      ['toggleFollow', { targetUserId: 'alice' }],
      ['toggleBookmark', { matchId: 'm1' }],
      ['reactToStory', { storyId: 's1', emoji: '❤' }],
      ['viewStory', { storyId: 's1' }],
      ['createStory', { mediaUrl: 'x' }],
      ['startMatch', { contestId: 'c1', mediaUrl: 'x' }],
      ['joinMatch', { matchId: 'm1', mediaUrl: 'x' }],
      ['sendMessage', { chatId: 'c1', text: 'hi' }],
      ['createOrder', { packageId: 'p1' }],
      ['requestWithdrawal', { amount: 100 }],
      ['claimReferral', { code: 'X' }],
      ['updateProfile', { bio: 'x' }],
      ['deleteAccount', {}],
      ['getMatchShareImage', { matchId: 'm1' }],
    ] as const) {
      const res = await api(env, action, data);
      expect(res.status, action).toBe(401);
    }
    // Nothing changed.
    const alice = await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(Number(alice?.dpcoin)).toBe(500);
    expect(await drizzleOf(env).select().from(schema.follows).all()).toHaveLength(0);
  });

  it('one user cannot read another user\'s private data', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'mallory');
    expect((await get(env, '/read/users/alice/bookmarks', 'mallory')).status).toBe(403);
    const ts = Date.now();
    await drizzleOf(env).insert(schema.chats).values({ id: 'c1', users: ['alice', 'bob'], createdAt: ts, updatedAt: ts } as any);
    const msgs = await get(env, '/read/chats/c1/messages', 'mallory');
    expect([403, 404]).toContain(msgs.status);
  });
});

// ===========================================================================
describe('sessions', () => {
  it('a revoked token reads public content as a guest, and nothing private', async () => {
    const { env } = makeEnv();
    const now = Math.floor(Date.now() / 1000);
    await seedUser(env, 'alice', { tokensValidAfter: now + 60 });
    await seedStory(env, 'fol', 'alice', { visibility: 'followers' });
    await seedStory(env, 'pub', 'alice');
    const stale = `alice@${now - 10}`;
    const feed = await get(env, '/read/stories/feed', stale);
    expect(feed.status).toBe(200);
    // Treated as a guest: not even the owner's own followers-only Story.
    expect(feedIds(feed.body)).toEqual(['pub']);
    expect((await get(env, '/read/notifications', stale)).status).toBe(401);
    expect((await api(env, 'createStory', { mediaUrl: 'x' }, stale)).status).toBe(401);
  });
});

// ===========================================================================
describe('abuse limits on guest reads', () => {
  afterEach(() => undefined);
  it('guest user search is throttled per IP; signed-in search is not', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    let last = 0;
    // Generous (300/min) because many guests share one carrier-NAT address.
    for (let i = 0; i < 301; i++) {
      const res = await app.request('/read/users/search?q=al', { headers: { 'CF-Connecting-IP': '203.0.113.9' } }, env, fakeCtx());
      last = res.status;
      if (i < 300) expect(res.status).toBe(200);
    }
    expect(last).toBe(429);
    const signedIn = await app.request('/read/users/search?q=al', { headers: { 'CF-Connecting-IP': '203.0.113.9', Authorization: 'Bearer alice' } }, env, fakeCtx());
    expect(signedIn.status).toBe(200);
  });

  it('guest lists are bounded however large a limit is asked for', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    for (let i = 0; i < 3; i++) await seedBattle(env, `m${i}`);
    const res = await get(env, '/read/matches?status=active&limit=100000');
    expect(res.status).toBe(200);
    const items = Array.isArray(res.body) ? res.body : res.body.items;
    expect(items.length).toBeLessThanOrEqual(100);
  });
});
