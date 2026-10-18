/**
 * Private accounts: follow requests and the profile lock (migration 0057,
 * lib/privateAccount.ts, lib/followRequests.ts).
 *
 * The rule under test: a private account's profile header is public, but its
 * battles grid, Wins, posts, followers/following lists and `following[]` are
 * for the owner and APPROVED followers only. Following a private account
 * creates a pending request that never counts as a follow.
 */
import { vi, describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({ like: 1, comment: 1, share: 1 }),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

// Lets one test reproduce the switch-to-public race: toggleFollow's privacy READ
// says private while the row (as the gated insert sees it) is already public.
const race = vi.hoisted(() => ({ staleReadSaysPrivate: false }));
vi.mock('../src/lib/privateAccount', async (importOriginal) => {
  const real: any = await importOriginal();
  return {
    ...real,
    isPrivateAccount: async (env: any, uid: string) => race.staleReadSaysPrivate || real.isPrivateAccount(env, uid),
  };
});

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { cancelAccountDeletion, purgeScheduledDeletions, requestAccountDeletion } from '../src/lib/accountDeletion';

const app = makeApp();

async function call(env: TestEnv, uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function read(env: TestEnv, uid: string | null, path: string, headers: Record<string, string> = {}) {
  const res = await app.request(
    `/read${path}`,
    { headers: { ...(uid ? { Authorization: `Bearer ${uid}` } : {}), ...headers } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 1000, followersCount: 0, followingCount: 0, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function seedMatch(env: TestEnv, id: string, uidA: string, uidB: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.contestMatches)
    .values({
      id,
      status: 'active',
      type: 'photo',
      title: `Battle ${id}`,
      entryFee: 20,
      joinIdA: `${id}-a`,
      userA: { uid: uidA, username: uidA, mediaUrl: `${uidA}.jpg`, votes: 0 },
      userB: { uid: uidB, username: uidB, mediaUrl: `${uidB}.jpg`, votes: 0 },
      totalVotes: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      minVotesRequired: 0,
      prizeCoins: 20,
      createdAt: ts,
      activatedAt: ts,
      expiresAt: ts + 86_400_000,
      ...extra,
    } as any);
}

async function counts(env: TestEnv, uid: string) {
  const row = await drizzleOf(env)
    .select({ followers: schema.users.followersCount, following: schema.users.followingCount })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  return { followers: Number(row?.followers ?? 0), following: Number(row?.following ?? 0) };
}

async function follows(env: TestEnv, a: string, b: string) {
  return !!(await drizzleOf(env)
    .select()
    .from(schema.follows)
    .where(and(eq(schema.follows.followerId, a), eq(schema.follows.followingId, b)))
    .get());
}

async function notificationsOf(env: TestEnv, uid: string, type: string) {
  return drizzleOf(env)
    .select()
    .from(schema.notifications)
    .where(and(eq(schema.notifications.recipientId, uid), eq(schema.notifications.type, type)))
    .all();
}

/** priv (private, with a battle vs pub and a follower `fan`), pub (public), and `stranger`. */
async function world() {
  const { env } = makeEnv();
  await seedUser(env, 'priv', { isPrivate: true });
  await seedUser(env, 'pub');
  await seedUser(env, 'stranger');
  await seedMatch(env, 'm1', 'priv', 'pub');
  return env;
}

describe('following a private account creates a request, not a follow', () => {
  it('requests, notifies the owner, and changes no counters', async () => {
    const env = await world();
    const res = await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ isFollowing: false, requested: true });
    expect(await follows(env, 'stranger', 'priv')).toBe(false);
    expect(await counts(env, 'priv')).toEqual({ followers: 0, following: 0 });
    expect(await counts(env, 'stranger')).toEqual({ followers: 0, following: 0 });
    const n = await notificationsOf(env, 'priv', 'follow_request');
    expect(n).toHaveLength(1);
    expect(n[0].actorId).toBe('stranger');
    expect((await read(env, 'stranger', '/users/priv/relationship')).body).toEqual({ state: 'requested' });
  });

  it('tapping "Requested" withdraws the request and its notification', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    const res = await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    expect(res.body).toMatchObject({ isFollowing: false, requested: false });
    expect(await notificationsOf(env, 'priv', 'follow_request')).toHaveLength(0);
    expect((await read(env, 'priv', '/follow-requests')).body).toEqual([]);
    expect((await read(env, 'stranger', '/users/priv/relationship')).body).toEqual({ state: 'none' });
  });

  it('a public account is still followed directly', async () => {
    const env = await world();
    const res = await call(env, 'stranger', 'toggleFollow', { targetUserId: 'pub' });
    expect(res.body).toMatchObject({ isFollowing: true, requested: false });
    expect(await follows(env, 'stranger', 'pub')).toBe(true);
    expect((await read(env, 'stranger', '/users/pub/relationship')).body).toEqual({ state: 'following' });
  });

  it('a blocked account cannot request', async () => {
    const env = await world();
    await call(env, 'priv', 'blockUser', { targetUserId: 'stranger' });
    expect((await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' })).status).toBe(403);
  });
});

describe('the private-profile lock', () => {
  for (const viewer of [null, 'stranger'] as const) {
    const who = viewer ?? 'guest';
    it(`${who}: header visible, everything behind it locked`, async () => {
      const env = await world();
      // A pending request is NOT access.
      if (viewer) await call(env, viewer, 'toggleFollow', { targetUserId: 'priv' });
      await call(env, 'priv', 'toggleFollow', { targetUserId: 'pub' });

      const profile = await read(env, viewer, '/users/priv');
      expect(profile.body).toMatchObject({ uid: 'priv', username: 'priv', isPrivate: true, locked: true, following: [] });
      expect(profile.body.followingCount).toBe(1);

      expect((await read(env, viewer, '/users/priv/matches')).body).toEqual([]);
      expect((await read(env, viewer, '/users/priv/matches?won=1')).body).toEqual([]);
      expect((await read(env, viewer, '/users/priv/posts')).body).toMatchObject({ posts: [], locked: true });
      expect((await read(env, viewer, '/users/priv/followers')).body).toEqual([]);
      const following = await read(env, viewer, '/users/priv/following');
      expect(following.body).toEqual([]);
      expect(following.headers.get('Cache-Control')).toBe('private, no-store');
      expect(following.headers.get('Vary')).toContain('Authorization');
    });
  }

  it('the owner sees everything', async () => {
    const env = await world();
    await call(env, 'priv', 'toggleFollow', { targetUserId: 'pub' });
    expect((await read(env, 'priv', '/users/priv')).body).toMatchObject({ locked: false, following: ['pub'] });
    expect((await read(env, 'priv', '/users/priv/matches')).body).toHaveLength(1);
    expect((await read(env, 'priv', '/users/priv/following')).body.map((u: any) => u.id)).toEqual(['pub']);
  });

  it('a public account is never locked, and stays shared-cacheable', async () => {
    const env = await world();
    const res = await read(env, null, '/users/pub');
    expect(res.body).toMatchObject({ locked: false });
    expect((await read(env, null, '/users/pub/matches')).body).toHaveLength(1);
    expect((await read(env, null, '/users/pub/followers')).headers.get('Cache-Control')).toBe('public, max-age=30');
  });

  it("the battle itself stays public (feed and /battle/<id>), only the profile grid locks", async () => {
    const env = await world();
    const res = await read(env, null, '/matches/m1');
    expect(res.status).toBe(200);
    expect(res.body?.id).toBe('m1');
  });
});

describe('the owner answers requests', () => {
  it('confirm: becomes a follower once, unlocks, and tells the requester', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    expect((await read(env, 'priv', '/follow-requests/count')).body).toEqual({ count: 1 });
    const list = await read(env, 'priv', '/follow-requests');
    expect(list.body.map((r: any) => r.id)).toEqual(['stranger']);
    expect(list.headers.get('Cache-Control')).toBe('private, no-store');

    const res = await call(env, 'priv', 'respondFollowRequest', { requesterId: 'stranger', accept: true });
    expect(res.body).toMatchObject({ accepted: true });
    // A double tap is a harmless no-op, not a second follower.
    const again = await call(env, 'priv', 'respondFollowRequest', { requesterId: 'stranger', accept: true });
    expect(again.body).toMatchObject({ accepted: false });

    expect(await follows(env, 'stranger', 'priv')).toBe(true);
    expect(await counts(env, 'priv')).toEqual({ followers: 1, following: 0 });
    expect(await counts(env, 'stranger')).toEqual({ followers: 0, following: 1 });
    expect(await notificationsOf(env, 'priv', 'follow_request')).toHaveLength(0);
    expect(await notificationsOf(env, 'stranger', 'follow_accept')).toHaveLength(1);
    expect((await read(env, 'priv', '/follow-requests/count')).body).toEqual({ count: 0 });

    expect((await read(env, 'stranger', '/users/priv')).body).toMatchObject({ locked: false });
    expect((await read(env, 'stranger', '/users/priv/matches')).body).toHaveLength(1);
    expect((await read(env, 'stranger', '/users/priv/relationship')).body).toEqual({ state: 'following' });
  });

  it('delete: removes the request silently', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    const res = await call(env, 'priv', 'respondFollowRequest', { requesterId: 'stranger', accept: false });
    expect(res.body).toMatchObject({ accepted: false });
    expect(await follows(env, 'stranger', 'priv')).toBe(false);
    expect(await notificationsOf(env, 'stranger', 'follow_accept')).toHaveLength(0);
    expect((await read(env, 'stranger', '/users/priv/relationship')).body).toEqual({ state: 'none' });
  });

  it('only the owner can confirm: a third party "confirming" changes nothing', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    const res = await call(env, 'pub', 'respondFollowRequest', { requesterId: 'stranger', accept: true });
    expect(res.body).toMatchObject({ accepted: false });
    expect(await follows(env, 'stranger', 'priv')).toBe(false);
    expect(await follows(env, 'stranger', 'pub')).toBe(false);
  });

  it('removeFollower takes access back and fixes both counters', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    await call(env, 'priv', 'respondFollowRequest', { requesterId: 'stranger', accept: true });
    await call(env, 'priv', 'removeFollower', { followerId: 'stranger' });
    await call(env, 'priv', 'removeFollower', { followerId: 'stranger' });
    expect(await follows(env, 'stranger', 'priv')).toBe(false);
    expect(await counts(env, 'priv')).toEqual({ followers: 0, following: 0 });
    expect(await counts(env, 'stranger')).toEqual({ followers: 0, following: 0 });
    expect((await read(env, 'stranger', '/users/priv')).body).toMatchObject({ locked: true });
  });
});

describe('switching privacy and safety paths', () => {
  it('going public approves every pending request', async () => {
    const env = await world();
    await seedUser(env, 'fan');
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    await call(env, 'fan', 'toggleFollow', { targetUserId: 'priv' });
    const res = await call(env, 'priv', 'updateProfile', { isPrivate: false });
    expect(res.body).toMatchObject({ success: true, approvedRequests: 2 });
    expect(await follows(env, 'stranger', 'priv')).toBe(true);
    expect(await follows(env, 'fan', 'priv')).toBe(true);
    expect(await counts(env, 'priv')).toEqual({ followers: 2, following: 0 });
    expect(await counts(env, 'fan')).toEqual({ followers: 0, following: 1 });
    expect(await notificationsOf(env, 'priv', 'follow_request')).toHaveLength(0);
    expect((await read(env, null, '/users/priv')).body).toMatchObject({ locked: false });
  });

  it('going private keeps existing followers and locks everyone else', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'pub' });
    await call(env, 'pub', 'updateProfile', { isPrivate: true });
    expect((await read(env, 'stranger', '/users/pub')).body).toMatchObject({ locked: false });
    expect((await read(env, null, '/users/pub')).body).toMatchObject({ locked: true });
    expect((await read(env, 'priv', '/users/pub/matches')).body).toEqual([]);
  });

  it('a block removes pending requests both ways, and a later confirm is refused', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    await call(env, 'priv', 'blockUser', { targetUserId: 'stranger' });
    expect((await read(env, 'priv', '/follow-requests/count')).body).toEqual({ count: 0 });
    await call(env, 'priv', 'unblockUser', { targetUserId: 'stranger' });
    const res = await call(env, 'priv', 'respondFollowRequest', { requesterId: 'stranger', accept: true });
    expect(res.body).toMatchObject({ accepted: false });
    expect(await follows(env, 'stranger', 'priv')).toBe(false);
  });

  it('account deletion purges requests both ways and the "wants to follow you" rows', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    await requestAccountDeletion(env as any, 'stranger');
    await drizzleOf(env)
      .update(schema.deletionRequests)
      .set({ scheduledFor: Date.now() - 1000 })
      .where(eq(schema.deletionRequests.uid, 'stranger'));
    expect((await purgeScheduledDeletions(env as any)).purged).toBe(1);
    expect(await drizzleOf(env).select().from(schema.followRequests).all()).toEqual([]);
    expect(await notificationsOf(env, 'priv', 'follow_request')).toHaveLength(0);
  });
});

describe('explicit follow intent (list screens that cannot see pending requests)', () => {
  it('"follow" on a pending request keeps it; "cancel" withdraws it', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv', intent: 'follow' });
    const again = await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv', intent: 'follow' });
    expect(again.body).toMatchObject({ isFollowing: false, requested: true });
    expect((await read(env, 'priv', '/follow-requests/count')).body).toEqual({ count: 1 });
    const cancel = await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv', intent: 'cancel' });
    expect(cancel.body).toMatchObject({ requested: false });
    expect((await read(env, 'priv', '/follow-requests/count')).body).toEqual({ count: 0 });
  });

  it('"follow" when already following and "unfollow" when not are no-ops', async () => {
    const env = await world();
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'pub', intent: 'follow' });
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'pub', intent: 'follow' });
    expect(await follows(env, 'stranger', 'pub')).toBe(true);
    expect(await counts(env, 'pub')).toEqual({ followers: 1, following: 0 });
    const off = await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv', intent: 'unfollow' });
    expect(off.body).toMatchObject({ isFollowing: false, requested: false });
    expect((await read(env, 'priv', '/follow-requests/count')).body).toEqual({ count: 0 });
  });

  it('a request racing the switch to public becomes a direct follow, never a stranded request', async () => {
    const env = await world();
    race.staleReadSaysPrivate = true;
    try {
      const res = await call(env, 'stranger', 'toggleFollow', { targetUserId: 'pub', intent: 'follow' });
      expect(res.body).toMatchObject({ isFollowing: true, requested: false });
    } finally {
      race.staleReadSaysPrivate = false;
    }
    expect(await follows(env, 'stranger', 'pub')).toBe(true);
    expect(await drizzleOf(env).select().from(schema.followRequests).all()).toEqual([]);
  });
});

describe('request badge and deletion', () => {
  it('the badge counts only requesters the list can show', async () => {
    const env = await world();
    await seedUser(env, 'leaving');
    await call(env, 'stranger', 'toggleFollow', { targetUserId: 'priv' });
    await call(env, 'leaving', 'toggleFollow', { targetUserId: 'priv' });
    await requestAccountDeletion(env as any, 'leaving');
    expect((await read(env, 'priv', '/follow-requests')).body.map((r: any) => r.id)).toEqual(['stranger']);
    expect((await read(env, 'priv', '/follow-requests/count')).body).toEqual({ count: 1 });
  });

  it('cancelling a deletion restores the privacy the user had chosen', async () => {
    const env = await world();
    const isPrivate = async (uid: string) =>
      !!(await drizzleOf(env).select({ p: schema.users.isPrivate }).from(schema.users).where(eq(schema.users.uid, uid)).get())?.p;
    for (const [uid, before] of [['pub', false], ['priv', true]] as const) {
      await requestAccountDeletion(env as any, uid);
      expect(await isPrivate(uid)).toBe(true);
      await cancelAccountDeletion(env as any, uid);
      expect(await isPrivate(uid), uid).toBe(before);
    }
  });

  it('a request made before migration 0057 (no recorded value) stays private on cancel', async () => {
    const env = await world();
    await requestAccountDeletion(env as any, 'pub');
    await drizzleOf(env).update(schema.deletionRequests).set({ wasPrivate: null } as any).where(eq(schema.deletionRequests.uid, 'pub'));
    await cancelAccountDeletion(env as any, 'pub');
    const row = await drizzleOf(env).select({ p: schema.users.isPrivate }).from(schema.users).where(eq(schema.users.uid, 'pub')).get();
    expect(!!row?.p).toBe(true);
  });
});

describe('guest read throttle', () => {
  it('limits guests by IP, never signed-in users, and fails open without the binding', async () => {
    const env = await world();
    // Without the binding (local/tests) nothing is limited.
    expect((await read(env, null, '/users/pub')).status).toBe(200);

    const seen: string[] = [];
    (env as any).GUEST_READ_LIMITER = {
      limit: async ({ key }: { key: string }) => {
        seen.push(key);
        return { success: false };
      },
    };
    const guest = await read(env, null, '/users/pub', { 'CF-Connecting-IP': '203.0.113.9' });
    expect(guest.status).toBe(429);
    expect(guest.headers.get('Retry-After')).toBe('60');
    expect(seen).toEqual(['guestread:203.0.113.9']);
    // A bogus token is still a guest.
    expect((await read(env, null, '/users/pub', { Authorization: 'Bearer' })).status).toBe(429);
    expect((await read(env, 'stranger', '/users/pub')).status).toBe(200);
  });
});
