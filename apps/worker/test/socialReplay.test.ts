/**
 * Social actions the client's offline outbox replays (apps/expo/src/sync/outbox.ts).
 *
 * A replay must be a no-op, never an undo or a double count:
 *  - likeContest / toggleBookmark take an explicit `liked` / `bookmarked`, so
 *    the same request delivered twice leaves the same state. Without it they
 *    stay toggles for shipped clients.
 *  - toggleFollow with an explicit `intent` already was a no-op on replay. Two
 *    CONCURRENT follows, however, both passed the edge read: the second insert
 *    failed on the primary key, and an OR IGNORE alone would have counted twice.
 *    The race is injected at the exact point it occurs.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
const bumps: Array<[string, string, number]> = [];
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async (_env: unknown, matchId: string, name: string, delta: number) => {
    bumps.push([matchId, name, delta]);
    return { like: 1, comment: 0, share: 0 };
  },
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

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

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, followersCount: 0, followingCount: 0, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function seedMatch(env: TestEnv, id: string) {
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
      userA: { uid: 'carol', username: 'carol', mediaUrl: 'a.jpg', votes: 0 },
      userB: { uid: 'dave', username: 'dave', mediaUrl: 'b.jpg', votes: 0 },
      totalVotes: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      minVotesRequired: 0,
      prizeCoins: 20,
      createdAt: ts,
      activatedAt: ts,
      expiresAt: ts + 86_400_000,
    } as any);
}

async function setup() {
  const { env } = makeEnv();
  for (const u of ['alice', 'bob', 'carol', 'dave']) await seedUser(env, u);
  await seedMatch(env, 'm1');
  bumps.length = 0;
  return env;
}

const likes = (env: TestEnv) => drizzleOf(env).select().from(schema.matchLikes).all();
const user = (env: TestEnv, uid: string) => drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();

describe('likeContest with an explicit target state', () => {
  it('liked:true twice likes once and counts once', async () => {
    const env = await setup();
    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1', liked: true })).body.liked).toBe(true);
    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1', liked: true })).body.liked).toBe(true);
    expect(await likes(env)).toHaveLength(1);
    expect(bumps).toEqual([['m1', 'like', 1]]);
  });

  it('liked:false twice unlikes once and counts once', async () => {
    const env = await setup();
    await call(env, 'alice', 'likeContest', { matchId: 'm1', liked: true });
    bumps.length = 0;
    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1', liked: false })).body.liked).toBe(false);
    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1', liked: false })).body.liked).toBe(false);
    expect(await likes(env)).toHaveLength(0);
    expect(bumps).toEqual([['m1', 'like', -1]]);
  });

  it('liked:false when not liked is a no-op', async () => {
    const env = await setup();
    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1', liked: false })).status).toBe(200);
    expect(bumps).toEqual([]);
  });

  it('without `liked` it is still a toggle (shipped clients)', async () => {
    const env = await setup();
    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1' })).body.liked).toBe(true);
    expect((await call(env, 'alice', 'likeContest', { matchId: 'm1' })).body.liked).toBe(false);
    expect(bumps.map((b) => b[2])).toEqual([1, -1]);
  });

  it('a like that loses a race to a concurrent like is a no-op, not a 500 or a second count', async () => {
    const env = await setup();
    // The competing request inserts the row after this one's read.
    const db = drizzleOf(env);
    const realPrepare = env.DB.prepare.bind(env.DB);
    let injected = false;
    (env.DB as any).prepare = (sql: string) => {
      if (!injected && /insert into "match_likes"/i.test(sql)) {
        injected = true;
        void db.insert(schema.matchLikes).values({ matchId: 'm1', userId: 'alice', createdAt: 1 }).run();
      }
      return realPrepare(sql);
    };
    const res = await call(env, 'alice', 'likeContest', { matchId: 'm1', liked: true });
    expect(injected).toBe(true);
    expect(res.status).toBe(200);
    expect(res.body.liked).toBe(true);
    expect(await likes(env)).toHaveLength(1);
    expect(bumps).toEqual([]); // the winner counted it, not this request
  });
});

describe('toggleBookmark with an explicit target state', () => {
  const rows = (env: TestEnv) => drizzleOf(env).select().from(schema.bookmarks).all();

  it('bookmarked:true/false are idempotent', async () => {
    const env = await setup();
    for (let i = 0; i < 2; i++) {
      expect((await call(env, 'alice', 'toggleBookmark', { matchId: 'm1', bookmarked: true })).body.bookmarked).toBe(true);
    }
    expect(await rows(env)).toHaveLength(1);
    for (let i = 0; i < 2; i++) {
      expect((await call(env, 'alice', 'toggleBookmark', { matchId: 'm1', bookmarked: false })).body.bookmarked).toBe(false);
    }
    expect(await rows(env)).toHaveLength(0);
  });

  it('without `bookmarked` it is still a toggle', async () => {
    const env = await setup();
    expect((await call(env, 'alice', 'toggleBookmark', { matchId: 'm1' })).body.bookmarked).toBe(true);
    expect((await call(env, 'alice', 'toggleBookmark', { matchId: 'm1' })).body.bookmarked).toBe(false);
  });
});

describe('toggleFollow replay and race', () => {
  it('intent:follow replayed counts once', async () => {
    const env = await setup();
    for (let i = 0; i < 3; i++) {
      const r = await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob', intent: 'follow' });
      expect(r.status).toBe(200);
      expect(r.body.isFollowing).toBe(true);
    }
    expect((await user(env, 'alice'))?.followingCount).toBe(1);
    expect((await user(env, 'bob'))?.followersCount).toBe(1);
  });

  it('a follow that loses the race to a concurrent follow is a no-op, not a 500 or a double count', async () => {
    const env = await setup();
    const realBatch = env.DB.batch.bind(env.DB);
    let injected = false;
    (env.DB as any).batch = async (stmts: any[]) => {
      if (!injected) {
        injected = true;
        // The other request wins: edge inserted and counted before this batch.
        await realBatch([
          env.DB.prepare('INSERT INTO follows (follower_id, following_id, created_at) VALUES (?, ?, ?)').bind('alice', 'bob', 1),
          env.DB.prepare('UPDATE users SET following_count = 1 WHERE uid = ?').bind('alice'),
          env.DB.prepare('UPDATE users SET followers_count = 1 WHERE uid = ?').bind('bob'),
        ]);
      }
      return realBatch(stmts);
    };
    const r = await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob', intent: 'follow' });
    expect(injected).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body.isFollowing).toBe(true);
    expect((await user(env, 'alice'))?.followingCount).toBe(1);
    expect((await user(env, 'bob'))?.followersCount).toBe(1);
  });

  it('a normal follow still counts both sides once', async () => {
    const env = await setup();
    await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob', intent: 'follow' });
    await call(env, 'carol', 'toggleFollow', { targetUserId: 'bob', intent: 'follow' });
    expect((await user(env, 'bob'))?.followersCount).toBe(2);
    expect((await user(env, 'alice'))?.followingCount).toBe(1);
    expect((await user(env, 'carol'))?.followingCount).toBe(1);
  });
});
