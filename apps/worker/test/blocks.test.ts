import { vi, describe, it, expect } from 'vitest';
import { eq, and } from 'drizzle-orm';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// The vote/engagement counters live in a Durable Object, which cannot start in
// this harness. Stubbed so the actions under test run end to end — the block
// guards all sit BEFORE these calls, so the rejection paths never reach them and
// the allow paths need them to return something plausible.
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({ like: 1, comment: 1, share: 1 }),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { createNotification } from '../src/lib/notify';

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

/** GET a /read endpoint as `uid`, or as a guest when uid is null. */
async function read(env: TestEnv, uid: string | null, path: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 1000, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function seedMatch(env: TestEnv, id: string, uidA: string, uidB: string | null, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.contestMatches)
    .values({
      id,
      status: uidB ? 'active' : 'waiting_for_opponent',
      type: 'photo',
      title: `Battle ${id}`,
      entryFee: 20,
      joinIdA: `${id}-a`,
      userA: { uid: uidA, username: uidA, mediaUrl: `${uidA}.jpg`, votes: 0 },
      userB: uidB ? { uid: uidB, username: uidB, mediaUrl: `${uidB}.jpg`, votes: 0 } : null,
      totalVotes: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      minVotesRequired: 0,
      prizeCoins: 20,
      createdAt: ts,
      activatedAt: uidB ? ts : null,
      expiresAt: ts + 86_400_000,
      ...extra,
    } as any);
}

async function seedFollow(env: TestEnv, followerId: string, followingId: string) {
  const db = drizzleOf(env);
  await db.insert(schema.follows).values({ followerId, followingId, createdAt: Date.now() } as any);
  await db
    .update(schema.users)
    .set({ followingCount: 1 })
    .where(eq(schema.users.uid, followerId));
  await db
    .update(schema.users)
    .set({ followersCount: 1 })
    .where(eq(schema.users.uid, followingId));
}

async function isBlocked(env: TestEnv, blockerId: string, blockedId: string) {
  const row = await drizzleOf(env)
    .select()
    .from(schema.userBlocks)
    .where(and(eq(schema.userBlocks.blockerId, blockerId), eq(schema.userBlocks.blockedId, blockedId)))
    .get();
  return !!row;
}

async function getUser(env: TestEnv, uid: string) {
  return drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();
}

/** Two users who have never interacted. */
async function pair(extra: Record<string, any> = {}) {
  const { env } = makeEnv();
  await seedUser(env, 'alice', extra);
  await seedUser(env, 'bob', extra);
  return env;
}

// ===========================================================================
describe('blockUser', () => {
  it('records the block and is idempotent', async () => {
    const env = await pair();

    const first = await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    expect(first.status).toBe(200);
    expect(first.body.blocked).toBe(true);
    expect(await isBlocked(env, 'alice', 'bob')).toBe(true);

    // A retried request must not error and must not double-write.
    const second = await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    expect(second.status).toBe(200);
    const rows = await drizzleOf(env).select().from(schema.userBlocks).all();
    expect(rows).toHaveLength(1);
  });

  it('removes the follow edge in BOTH directions and fixes all four counters', async () => {
    const env = await pair();
    await seedFollow(env, 'alice', 'bob');
    await seedFollow(env, 'bob', 'alice');

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const edges = await drizzleOf(env).select().from(schema.follows).all();
    expect(edges).toHaveLength(0);
    const alice = await getUser(env, 'alice');
    const bob = await getUser(env, 'bob');
    expect(alice?.followingCount).toBe(0);
    expect(alice?.followersCount).toBe(0);
    expect(bob?.followingCount).toBe(0);
    expect(bob?.followersCount).toBe(0);
  });

  it('does not touch counters for a follow edge that never existed', async () => {
    const env = await pair();
    // Only alice follows bob. Bob's followingCount must stay where it was.
    await seedFollow(env, 'alice', 'bob');

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const bob = await getUser(env, 'bob');
    expect(bob?.followingCount).toBe(0);
    expect(bob?.followersCount).toBe(0);
  });

  it('rejects blocking yourself and blocking an unknown account', async () => {
    const env = await pair();
    expect((await call(env, 'alice', 'blockUser', { targetUserId: 'alice' })).status).toBe(400);
    expect((await call(env, 'alice', 'blockUser', { targetUserId: 'ghost' })).status).toBe(404);
  });

  it('sends no notification to the blocked user', async () => {
    const env = await pair();
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    const notifs = await drizzleOf(env).select().from(schema.notifications).all();
    expect(notifs).toHaveLength(0);
  });
});

describe('unblockUser', () => {
  it('clears the block without restoring the follow edges', async () => {
    const env = await pair();
    await seedFollow(env, 'alice', 'bob');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const res = await call(env, 'alice', 'unblockUser', { targetUserId: 'bob' });

    expect(res.status).toBe(200);
    expect(res.body.blocked).toBe(false);
    expect(await isBlocked(env, 'alice', 'bob')).toBe(false);
    // Following again has to be a fresh, deliberate decision.
    expect(await drizzleOf(env).select().from(schema.follows).all()).toHaveLength(0);
  });

  it('is a no-op when no block exists', async () => {
    const env = await pair();
    expect((await call(env, 'alice', 'unblockUser', { targetUserId: 'bob' })).status).toBe(200);
  });
});

describe('muteUser', () => {
  it('is one-way and does not restrict the muted user', async () => {
    const env = await pair();
    await call(env, 'alice', 'muteUser', { targetUserId: 'bob' });

    const mutes = await drizzleOf(env).select().from(schema.userMutes).all();
    expect(mutes).toHaveLength(1);
    // A mute must NOT behave like a block: bob can still follow alice.
    expect((await call(env, 'bob', 'toggleFollow', { targetUserId: 'alice' })).status).toBe(200);
    // ...and alice can still follow bob.
    expect((await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob' })).status).toBe(200);

    const un = await call(env, 'alice', 'unmuteUser', { targetUserId: 'bob' });
    expect(un.body.muted).toBe(false);
    expect(await drizzleOf(env).select().from(schema.userMutes).all()).toHaveLength(0);
  });
});

// ===========================================================================
describe('write paths are refused once a block exists', () => {
  it('refuses a follow in BOTH directions but still allows unfollowing', async () => {
    const env = await pair();
    await seedFollow(env, 'bob', 'alice');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // The blocker cannot follow.
    expect((await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob' })).status).toBe(403);
    // And neither can the person who was blocked — the relation is mutual.
    expect((await call(env, 'bob', 'toggleFollow', { targetUserId: 'alice' })).status).toBe(403);
  });

  it('allows an unfollow that predates the block', async () => {
    const env = await pair();
    // A block normally tears the edge down, so construct the awkward case
    // directly: an edge that outlived a block created out of band.
    await seedFollow(env, 'alice', 'bob');
    await drizzleOf(env)
      .insert(schema.userBlocks)
      .values({ blockerId: 'alice', blockedId: 'bob', createdAt: Date.now() } as any);

    const res = await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob' });

    expect(res.status).toBe(200);
    expect(res.body.isFollowing).toBe(false);
  });

  it('refuses opening a DM', async () => {
    const env = await pair();
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    expect((await call(env, 'alice', 'startChat', { otherUserId: 'bob' })).status).toBe(403);
    expect((await call(env, 'bob', 'startChat', { otherUserId: 'alice' })).status).toBe(403);
  });

  it('refuses sending into a chat that predates the block', async () => {
    const env = await pair();
    const chat = await call(env, 'alice', 'startChat', { otherUserId: 'bob' });
    const chatId = chat.body.chatId;
    expect((await call(env, 'bob', 'sendMessage', { chatId, text: 'hi' })).status).toBe(200);

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // Membership is not consent: the thread exists, but the send is refused.
    expect((await call(env, 'bob', 'sendMessage', { chatId, text: 'again' })).status).toBe(403);
    expect((await call(env, 'alice', 'sendMessage', { chatId, text: 'again' })).status).toBe(403);
  });

  it('refuses voting in a battle involving a blocked participant', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'bob', 'carol');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const res = await call(env, 'alice', 'submitVote', {
      matchId: 'm1',
      votedForUid: 'carol',
      deviceId: 'device-1',
    });

    expect(res.status).toBe(403);
    // The prize pot must not be influenced either way.
    expect(await drizzleOf(env).select().from(schema.votes).all()).toHaveLength(0);
  });

  it('refuses match engagement (like / comment / react / share)', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'bob', 'carol');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1' })).status).toBe(403);
    expect((await call(env, 'alice', 'commentContest', { matchId: 'm1', text: 'hey' })).status).toBe(403);
    expect((await call(env, 'alice', 'reactToMatch', { matchId: 'm1', type: 'fire' })).status).toBe(403);
    expect((await call(env, 'alice', 'shareContest', { matchId: 'm1' })).status).toBe(403);
    expect((await call(env, 'alice', 'addComment', { targetType: 'matches', targetId: 'm1', text: 'hey' })).status).toBe(403);
  });

  it('refuses commenting on a blocked user\'s post', async () => {
    const env = await pair();
    await drizzleOf(env)
      .insert(schema.posts)
      .values({ id: 'p1', userId: 'bob', mediaUrl: 'x.jpg', createdAt: Date.now() } as any);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const res = await call(env, 'alice', 'addComment', { targetType: 'posts', targetId: 'p1', text: 'hey' });

    expect(res.status).toBe(403);
    expect(await drizzleOf(env).select().from(schema.postComments).all()).toHaveLength(0);
  });

  it('refuses joining a blocked user\'s battle before any coins move', async () => {
    const env = await pair();
    await seedMatch(env, 'm2', 'bob', null);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const res = await call(env, 'alice', 'joinMatch', {
      matchId: 'm2',
      mediaUrl: 'a.jpg',
      mediaType: 'photo',
      deviceId: 'device-2',
    });

    expect(res.status).toBe(403);
    const alice = await getUser(env, 'alice');
    expect(alice?.dpcoin).toBe(1000); // no entry fee debited
    expect(await drizzleOf(env).select().from(schema.coinTransactions).all()).toHaveLength(0);
  });

  it('refuses viewing and reacting to a blocked user\'s story', async () => {
    const env = await pair();
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.stories)
      .values({ id: 's1', userId: 'bob', mediaUrl: 's.jpg', createdAt: ts, expiresAt: ts + 86_400_000 } as any);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    expect((await call(env, 'alice', 'viewStory', { storyId: 's1' })).status).toBe(403);
    expect((await call(env, 'alice', 'reactToStory', { storyId: 's1', emoji: '🔥' })).status).toBe(403);
    expect(await drizzleOf(env).select().from(schema.storyViews).all()).toHaveLength(0);
  });

  it('drops a profile visit silently instead of erroring', async () => {
    const env = await pair();
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // Passive telemetry the client fires on navigation — it must not surface as
    // a failure, but it must not be recorded either (it feeds feed affinity).
    const res = await call(env, 'alice', 'profileVisit', { targetId: 'bob' });

    expect(res.status).toBe(200);
    expect(await drizzleOf(env).select().from(schema.profileVisits).all()).toHaveLength(0);
  });
});

// ===========================================================================
describe('read paths hide blocked users', () => {
  it('removes battles with a blocked participant from the feed, in both directions', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'visible', 'carol', 'alice');
    await seedMatch(env, 'hidden', 'bob', 'carol');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const forAlice = await read(env, 'alice', '/matches?status=active');
    expect(forAlice.body.map((m: any) => m.id)).toEqual(['visible']);

    // Mutual: the user who was blocked also stops seeing the blocker's battles.
    const forBob = await read(env, 'bob', '/matches?status=active');
    expect(forBob.body.map((m: any) => m.id)).toEqual(['hidden']);
  });

  it('does not let one viewer\'s block leak into another viewer\'s cached feed page', async () => {
    // This is the whole reason filtering happens AFTER the cache read: /matches
    // stores one shared page in KV and layers per-viewer state on top.
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'bob', 'carol');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // Alice populates the shared page cache and sees nothing.
    expect((await read(env, 'alice', '/matches?status=active')).body).toHaveLength(0);
    // Carol reads the SAME cached page and must still see the battle.
    expect((await read(env, 'carol', '/matches?status=active')).body.map((m: any) => m.id)).toEqual(['m1']);
    // And a guest is unaffected.
    expect((await read(env, null, '/matches?status=active')).body).toHaveLength(1);
  });

  it('applies a block to the ranked For You feed immediately, despite the order cache', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'bob', 'carol');

    // Prime the per-viewer order cache BEFORE the block exists.
    expect((await read(env, 'alice', '/matches?status=active&sort=foryou')).body.items).toHaveLength(1);

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // Must take effect now, not after the 60s order-cache TTL.
    expect((await read(env, 'alice', '/matches?status=active&sort=foryou')).body.items).toHaveLength(0);
  });

  it('hides muted users from the feed without restricting them', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'bob', 'carol');
    await call(env, 'alice', 'muteUser', { targetUserId: 'bob' });

    expect((await read(env, 'alice', '/matches?status=active')).body).toHaveLength(0);
    // But bob's profile stays reachable — mute is feed curation, not a block.
    expect((await read(env, 'alice', '/users/bob')).body?.uid).toBe('bob');
  });

  it('makes a blocked battle unreachable by direct link, but not a muted one', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'bob', 'carol');

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    expect((await read(env, 'alice', '/matches/m1')).body).toBeNull();

    await call(env, 'alice', 'unblockUser', { targetUserId: 'bob' });
    await call(env, 'alice', 'muteUser', { targetUserId: 'bob' });
    expect((await read(env, 'alice', '/matches/m1')).body?.id).toBe('m1');
  });

  it('reports the two directions of a block asymmetrically on a profile', async () => {
    const env = await pair();
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // The blocker gets a shell so the client can offer "Unblock".
    const forAlice = await read(env, 'alice', '/users/bob');
    expect(forAlice.body).toMatchObject({ uid: 'bob', isBlockedByMe: true });
    expect(forAlice.body.profileImageUrl).toBeNull();

    // The blocked user cannot tell they were blocked: the account simply is not
    // there, exactly as for a uid that never existed.
    expect((await read(env, 'bob', '/users/alice')).body).toBeNull();
    expect((await read(env, 'bob', '/users/nobody-at-all')).body).toBeNull();
  });

  it('hides every profile sub-resource, not just the profile', async () => {
    const env = await pair();
    const ts = Date.now();
    const db = drizzleOf(env);
    await db.insert(schema.posts).values({ id: 'p1', userId: 'bob', mediaUrl: 'x.jpg', createdAt: ts } as any);
    await db.insert(schema.stories).values({ id: 's1', userId: 'bob', mediaUrl: 's.jpg', createdAt: ts, expiresAt: ts + 86_400_000 } as any);
    await db.insert(schema.highlights).values({ id: 'h1', userId: 'bob', name: 'Best', storyIds: ['s1'], createdAt: ts } as any);
    await seedMatch(env, 'm1', 'bob', 'alice');
    await seedFollow(env, 'carol', 'bob');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    expect((await read(env, 'alice', '/users/bob/posts')).body.posts).toHaveLength(0);
    expect((await read(env, 'alice', '/users/bob/matches')).body).toHaveLength(0);
    expect((await read(env, 'alice', '/users/bob/stories')).body).toBeNull();
    expect((await read(env, 'alice', '/users/bob/highlights')).body).toHaveLength(0);
    expect((await read(env, 'alice', '/highlights/h1/stories')).body).toBeNull();
    expect((await read(env, 'alice', '/users/bob/followers')).body).toHaveLength(0);
  });

  it('excludes blocked users from search, suggestions, the leaderboard and the stories bar', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.stories)
      .values({ id: 's1', userId: 'bob', mediaUrl: 's.jpg', createdAt: ts, expiresAt: ts + 86_400_000 } as any);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const uids = (rows: any[]) => rows.map((r) => r.id ?? r.uid ?? r.userId);
    expect(uids((await read(env, 'alice', '/users/search?q=bo')).body)).not.toContain('bob');
    expect(uids((await read(env, 'alice', '/users/suggested')).body)).not.toContain('bob');
    expect(uids((await read(env, 'alice', '/leaderboard')).body)).not.toContain('bob');
    expect(uids((await read(env, 'alice', '/stories/feed')).body)).not.toContain('bob');

    // Carol, who blocked nobody, still sees him everywhere.
    expect(uids((await read(env, 'carol', '/users/search?q=bo')).body)).toContain('bob');
    expect(uids((await read(env, 'carol', '/stories/feed')).body)).toContain('bob');
  });

  it('hides a blocked user\'s comments while leaving a muted user\'s visible', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'carol', 'alice');
    const ts = Date.now();
    await drizzleOf(env).insert(schema.matchComments).values([
      { id: 'c1', matchId: 'm1', userId: 'bob', text: 'from bob', createdAt: ts } as any,
      { id: 'c2', matchId: 'm1', userId: 'carol', text: 'from carol', createdAt: ts + 1 } as any,
    ]);

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    const blocked = await read(env, 'alice', '/comments?targetType=matches&targetId=m1');
    expect(blocked.body.items.map((i: any) => i.id)).toEqual(['c2']);

    // A mute does not silence someone inside a thread you chose to open.
    await call(env, 'alice', 'unblockUser', { targetUserId: 'bob' });
    await call(env, 'alice', 'muteUser', { targetUserId: 'bob' });
    const muted = await read(env, 'alice', '/comments?targetType=matches&targetId=m1');
    expect(muted.body.items.map((i: any) => i.id).sort()).toEqual(['c1', 'c2']);
  });

  it('hides the chat with a blocked user from the inbox', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await call(env, 'alice', 'startChat', { otherUserId: 'bob' });
    await call(env, 'alice', 'startChat', { otherUserId: 'carol' });
    expect((await read(env, 'alice', '/chats')).body).toHaveLength(2);

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const chats = (await read(env, 'alice', '/chats')).body;
    expect(chats).toHaveLength(1);
    expect(chats[0].users).toContain('carol');
  });

  it('filters pre-existing notifications and strips hidden actors from grouped rows', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    const ts = Date.now();
    await drizzleOf(env).insert(schema.notifications).values([
      // Solely from bob — the whole row must disappear.
      { id: 'n1', recipientId: 'alice', title: 'Like', body: 'bob liked your entry', type: 'match_like', targetId: 'm1', actorId: 'bob', actors: [{ uid: 'bob', username: 'bob' }], actorCount: 1, createdAt: ts } as any,
      // Grouped: bob must be stripped out but the row survives for carol.
      { id: 'n2', recipientId: 'alice', title: 'Like', body: 'carol and 1 other liked your entry', type: 'match_like', targetId: 'm2', actorId: 'carol', actors: [{ uid: 'carol', username: 'carol' }, { uid: 'bob', username: 'bob' }], actorCount: 2, createdAt: ts + 1 } as any,
    ]);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const items = (await read(env, 'alice', '/notifications')).body;

    expect(items.map((n: any) => n.id)).toEqual(['n2']);
    expect(items[0].actors.map((a: any) => a.uid)).toEqual(['carol']);
    expect(items[0].actorCount).toBe(1);
  });

  it('hides blocked viewers from a story\'s viewer list', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    const ts = Date.now();
    const db = drizzleOf(env);
    await db.insert(schema.stories).values({ id: 's1', userId: 'alice', mediaUrl: 's.jpg', createdAt: ts, expiresAt: ts + 86_400_000 } as any);
    await db.insert(schema.storyViews).values([
      { storyId: 's1', viewerId: 'bob', createdAt: ts } as any,
      { storyId: 's1', viewerId: 'carol', createdAt: ts } as any,
    ]);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const viewers = (await read(env, 'alice', '/stories/s1/viewers')).body;
    expect(viewers.map((v: any) => v.uid)).toEqual(['carol']);
  });
});

// ===========================================================================
// Regressions found in review. Each of these was a real defect.
describe('two-sided content: the opponent must be filtered too', () => {
  it('hides a blocked OPPONENT from a third party\'s profile grid', async () => {
    // profileHiddenFrom only answers "is this profile's owner blocked", which is
    // the wrong question for a battle: it has two participants.
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'carol', 'bob');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const grid = await read(env, 'alice', '/users/carol/matches?type=photo');

    expect(grid.body).toHaveLength(0);
    expect(JSON.stringify(grid.body)).not.toContain('bob');
  });

  it('hides a blocked opponent from the Wins list', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'carol', 'bob', { status: 'completed', winnerUid: 'carol' });
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    expect((await read(env, 'alice', '/users/carol/matches?won=1')).body).toHaveLength(0);
  });

  it('hides a battle with a blocked opponent from the viewer\'s own Saved tab', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'carol', 'bob');
    await call(env, 'alice', 'toggleBookmark', { matchId: 'm1' });
    expect((await read(env, 'alice', '/users/alice/bookmarks')).body).toHaveLength(1);

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    expect((await read(env, 'alice', '/users/alice/bookmarks')).body).toHaveLength(0);
  });

  it('never shows a card it would then refuse to act on', async () => {
    // The invariant behind the three tests above: the read filters must be at
    // least as strict as the write guards, or the UI offers a like/vote that
    // comes back "This action isn't available for this account."
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'carol', 'bob');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const visibleIds = new Set<string>([
      ...(await read(env, 'alice', '/matches?status=active')).body.map((m: any) => m.id),
      ...(await read(env, 'alice', '/users/carol/matches?type=photo')).body.map((m: any) => m.id),
      ...(await read(env, 'alice', '/users/alice/bookmarks')).body.map((m: any) => m.id),
    ]);
    expect(visibleIds.has('m1')).toBe(false);
    // And the write is indeed refused, which is what makes showing it a bug.
    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1' })).status).toBe(403);
  });
});

describe('notification pagination', () => {
  it('does not crash when every row on a page is filtered away', async () => {
    // hasMore was computed before the filter and the cursor read off the last
    // SURVIVING row, so a fully filtered page dereferenced page[-1] and 500d.
    const env = await pair();
    const ts = Date.now();
    await drizzleOf(env).insert(schema.notifications).values(
      [1, 2, 3].map((n) => ({
        id: `n${n}`,
        recipientId: 'alice',
        title: 'Like',
        body: 'bob liked your entry',
        type: 'match_like',
        targetId: `m${n}`,
        actorId: 'bob',
        actors: [{ uid: 'bob', username: 'bob' }],
        actorCount: 1,
        createdAt: ts + n,
      })) as any,
    );
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const res = await read(env, 'alice', '/notifications?limit=1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(0);
    // The cursor must still describe the last SCANNED row so the next page makes
    // progress instead of re-scanning what was just discarded.
    expect(res.headers.get('X-Next-Cursor')).toBe(String(ts + 3));
  });

  it('keeps the unread badge consistent with the list it opens', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    const ts = Date.now();
    await drizzleOf(env).insert(schema.notifications).values([
      { id: 'n1', recipientId: 'alice', title: 'x', body: 'x', type: 'match_like', targetId: 'm1', actorId: 'bob', actorCount: 1, seen: false, createdAt: ts } as any,
      { id: 'n2', recipientId: 'alice', title: 'x', body: 'x', type: 'match_like', targetId: 'm2', actorId: 'carol', actorCount: 1, seen: false, createdAt: ts + 1 } as any,
      // Actor-less system notification — must always count.
      { id: 'n3', recipientId: 'alice', title: 'Payout', body: 'sent', type: 'wallet', targetId: 'wallet', actorCount: 1, seen: false, createdAt: ts + 2 } as any,
    ]);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const listed = (await read(env, 'alice', '/notifications')).body.length;
    const badge = (await read(env, 'alice', '/notifications/unread-count')).body.count;

    expect(listed).toBe(2);
    expect(badge).toBe(2);
  });
});

describe('remaining write guards', () => {
  it('refuses liking a blocked user\'s comment but allows withdrawing a like', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'carol', 'alice');
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.matchComments)
      .values({ id: 'c1', matchId: 'm1', userId: 'bob', text: 'hi', createdAt: ts } as any);

    // Like it first, THEN block — the existing like must remain removable.
    expect((await call(env, 'alice', 'likeComment', { commentId: 'c1', targetType: 'matches' })).status).toBe(200);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const unlike = await call(env, 'alice', 'likeComment', { commentId: 'c1', targetType: 'matches' });
    expect(unlike.status).toBe(200);
    expect(unlike.body.liked).toBe(false);
    // But re-liking is now refused.
    expect((await call(env, 'alice', 'likeComment', { commentId: 'c1', targetType: 'matches' })).status).toBe(403);
  });

  it('refuses bookmarking a blocked user\'s battle but allows un-bookmarking', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'carol', 'bob');
    await call(env, 'alice', 'toggleBookmark', { matchId: 'm1' });
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // Removing the pre-existing bookmark still works...
    const off = await call(env, 'alice', 'toggleBookmark', { matchId: 'm1' });
    expect(off.status).toBe(200);
    expect(off.body.bookmarked).toBe(false);
    // ...but adding it back is refused.
    expect((await call(env, 'alice', 'toggleBookmark', { matchId: 'm1' })).status).toBe(403);
  });

  it('refuses inviting a blocked user before charging the entry fee', async () => {
    const env = await pair();
    await drizzleOf(env)
      .insert(schema.contests)
      .values({ id: 'ct1', title: 'Test', type: 'photo', status: 'live', totalEntryFee: 20, rewardCoins: 20, voteDurationDays: 1, createdAt: Date.now() } as any);
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'ct1',
      mediaUrl: 'a.jpg',
      mediaType: 'photo',
      deviceId: 'd1',
      invitedUid: 'bob',
    });

    expect(res.status).toBe(403);
    // joinMatch would have refused bob, leaving the fee locked until auto-cancel.
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(1000);
    expect(await drizzleOf(env).select().from(schema.contestMatches).all()).toHaveLength(0);
  });

  it('rejects muting an account that does not exist', async () => {
    // Otherwise the row is invisible in /read/blocked and can never be undone.
    const env = await pair();
    expect((await call(env, 'alice', 'muteUser', { targetUserId: 'ghost' })).status).toBe(404);
    expect(await drizzleOf(env).select().from(schema.userMutes).all()).toHaveLength(0);
  });
});

describe('unblocking takes effect immediately', () => {
  it('restores the ranked feed without waiting for the order cache to expire', async () => {
    // The per-viewer order cache is derived from the filtered pool, so an unblock
    // would otherwise leave the user missing for the KV 60s TTL floor. The cache
    // key carries an exclusion-set version to prevent that.
    const env = await pair();
    await seedUser(env, 'carol');
    await seedMatch(env, 'm1', 'bob', 'carol');

    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    expect((await read(env, 'alice', '/matches?status=active&sort=foryou')).body.items).toHaveLength(0);

    await call(env, 'alice', 'unblockUser', { targetUserId: 'bob' });

    expect((await read(env, 'alice', '/matches?status=active&sort=foryou')).body.items).toHaveLength(1);
  });
});

// ===========================================================================
describe('GET /read/blocked', () => {
  it('lists outgoing blocks and mutes, and never incoming blocks', async () => {
    const env = await pair();
    await seedUser(env, 'carol');
    await seedUser(env, 'dave');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    await call(env, 'alice', 'muteUser', { targetUserId: 'carol' });
    // Dave blocked alice. Alice must not be able to learn that.
    await call(env, 'dave', 'blockUser', { targetUserId: 'alice' });

    const { body } = await read(env, 'alice', '/blocked');

    expect(body.blocked.map((u: any) => u.uid)).toEqual(['bob']);
    expect(body.muted.map((u: any) => u.uid)).toEqual(['carol']);
    expect(JSON.stringify(body)).not.toContain('dave');
  });
});

// ===========================================================================
describe('notification suppression', () => {
  it('writes no notification row at all between blocked users', async () => {
    const env = await pair();
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    await createNotification(env as any, 'alice', {
      title: 'New Follower',
      body: 'bob started following you',
      type: 'follow',
      targetId: 'bob',
      actor: { uid: 'bob', username: 'bob' },
    });

    // Deliberately stricter than the preference system, which suppresses only
    // the push: a blocked user's name must not reach the notification centre.
    expect(await drizzleOf(env).select().from(schema.notifications).all()).toHaveLength(0);
  });

  it('suppresses notifications from a muted user too', async () => {
    const env = await pair();
    await call(env, 'alice', 'muteUser', { targetUserId: 'bob' });

    await createNotification(env as any, 'alice', {
      title: 'New Follower',
      body: 'bob started following you',
      type: 'follow',
      targetId: 'bob',
      actor: { uid: 'bob', username: 'bob' },
    });

    expect(await drizzleOf(env).select().from(schema.notifications).all()).toHaveLength(0);
  });

  it('still delivers actor-less system notifications', async () => {
    const env = await pair();
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    await createNotification(env as any, 'alice', {
      title: 'Withdrawal paid',
      body: 'Your payout was sent.',
      type: 'wallet',
      targetId: 'wallet',
    });

    const rows = await drizzleOf(env).select().from(schema.notifications).all();
    expect(rows).toHaveLength(1);
  });
});
