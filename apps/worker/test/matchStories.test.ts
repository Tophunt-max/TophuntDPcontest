/**
 * Auto-posted battle stories.
 *
 * The behaviour that matters: once a battle fills up, BOTH participants get a
 * story about it, the creator's now-stale solo announcement is gone, and none of
 * it can turn a paid join into an error.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// The vote/engagement counters live in a Durable Object that cannot start here.
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 0, votesB: 0, total: 0, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { publishVsStories, storyMediaType } from '../src/lib/matchStories';

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

async function seedUser(env: TestEnv, uid: string, dpcoin = 1000) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin, createdAt: ts, updatedAt: ts } as any);
}

async function seedContest(env: TestEnv, id: string, totalEntryFee = 40) {
  await drizzleOf(env)
    .insert(schema.contests)
    .values({
      id, title: 'Best Smile', type: 'photo', status: 'live',
      totalEntryFee, rewardCoins: totalEntryFee, voteDurationDays: 1, autoCancelHours: 24,
      minVotes: 0, createdAt: Date.now(),
    } as any);
}

const stories = (env: TestEnv) => drizzleOf(env).select().from(schema.stories).all();

// ===========================================================================
describe('storyMediaType', () => {
  it('treats everything that is not a video as an image', () => {
    // The contest flows used to write "photo", which the story viewer did not
    // recognise, so the story rendered as an empty video player.
    expect(storyMediaType('photo')).toBe('image');
    expect(storyMediaType('image')).toBe('image');
    expect(storyMediaType(undefined)).toBe('image');
    expect(storyMediaType(null)).toBe('image');
    expect(storyMediaType('video')).toBe('video');
  });
});

// ===========================================================================
describe('creating a battle', () => {
  it('posts a solo announcement story that the viewer can actually render', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedContest(env, 'c1');

    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'alice.jpg', mediaType: 'photo', deviceId: 'd1',
    });
    expect(res.status).toBe(200);

    const rows = await stories(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe('alice');
    expect(rows[0].type).toBe('contest_announcement');
    expect(rows[0].matchId).toBe(res.body.matchId);
    // NOT "photo" — that value never rendered.
    expect(rows[0].mediaType).toBe('image');
  });
});

// ===========================================================================
describe('joining a battle', () => {
  /** Create a battle as alice, ready for bob to join. */
  async function waitingMatch(env: TestEnv) {
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedContest(env, 'c1');
    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'alice.jpg', mediaType: 'photo', deviceId: 'device-a',
    });
    return res.body.matchId as string;
  }

  it('gives BOTH participants a head-to-head story', async () => {
    const { env } = makeEnv();
    const matchId = await waitingMatch(env);

    const join = await call(env, 'bob', 'joinMatch', {
      matchId, mediaUrl: 'bob.jpg', mediaType: 'photo', deviceId: 'device-b',
    });
    expect(join.status).toBe(200);

    const rows = await stories(env);
    // Exactly two: one per participant. Alice's solo announcement is gone.
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.type === 'contest_vs')).toBe(true);
    expect(rows.map((r: any) => r.userId).sort()).toEqual(['alice', 'bob']);
    // Both point at the battle, which is what the client builds the VS frame from.
    expect(rows.every((r: any) => r.matchId === matchId)).toBe(true);
    expect(rows.every((r: any) => r.mediaType === 'image')).toBe(true);
  });

  it('retires the creator\'s now-stale solo announcement', async () => {
    const { env } = makeEnv();
    const matchId = await waitingMatch(env);
    expect((await stories(env)).map((r: any) => r.type)).toEqual(['contest_announcement']);

    await call(env, 'bob', 'joinMatch', {
      matchId, mediaUrl: 'bob.jpg', mediaType: 'photo', deviceId: 'device-b',
    });

    // Alice must not end up with two stories about the same battle, one of them
    // still saying "waiting for an opponent".
    const aliceStories = (await stories(env)).filter((r: any) => r.userId === 'alice');
    expect(aliceStories).toHaveLength(1);
    expect(aliceStories[0].type).toBe('contest_vs');
  });

  it('carries each participant\'s own entry as the story media', async () => {
    // Each row stands alone if a client only understands `media_url`, and it is
    // the fallback the VS frame uses while the match loads.
    const { env } = makeEnv();
    const matchId = await waitingMatch(env);

    await call(env, 'bob', 'joinMatch', {
      matchId, mediaUrl: 'bob.jpg', mediaType: 'photo', deviceId: 'device-b',
    });

    const byUser = Object.fromEntries((await stories(env)).map((r: any) => [r.userId, r]));
    expect(byUser.alice.mediaUrl).toBe('alice.jpg');
    expect(byUser.bob.mediaUrl).toBe('bob.jpg');
    expect(byUser.alice.contestTitle).toBe('Best Smile');
  });

  it('keeps a video battle a video on both sides', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedContest(env, 'c1');
    const created = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'alice.mp4', mediaType: 'video', deviceId: 'device-a',
    });
    await call(env, 'bob', 'joinMatch', {
      matchId: created.body.matchId, mediaUrl: 'bob.mp4', mediaType: 'video', deviceId: 'device-b',
    });

    const rows = await stories(env);
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.mediaType === 'video')).toBe(true);
  });

  it('both stories expire together, 24h out', async () => {
    const { env } = makeEnv();
    const matchId = await waitingMatch(env);
    await call(env, 'bob', 'joinMatch', {
      matchId, mediaUrl: 'bob.jpg', mediaType: 'photo', deviceId: 'device-b',
    });

    const rows = await stories(env);
    const [a, b] = rows as any[];
    expect(a.expiresAt).toBe(b.expiresAt);
    expect(a.expiresAt - a.createdAt).toBe(24 * 60 * 60 * 1000);
  });
});

// ===========================================================================
describe('a story problem never breaks the join', () => {
  it('swallows a write failure instead of throwing', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    // Reject only `batch`, leaving the rest of the D1 shim intact. Built with
    // Object.create so the shim's prototype methods (`prepare`) still resolve —
    // a plain spread would break the driver for an unrelated reason and the test
    // would pass without exercising the path it claims to.
    const brokenDb: any = Object.assign(Object.create(Object.getPrototypeOf(env.DB)), env.DB);
    brokenDb.batch = async () => { throw new Error('D1 unavailable'); };
    const broken = { ...env, DB: brokenDb };

    await expect(
      publishVsStories(broken as any, {
        matchId: 'm1',
        contestTitle: 'Best Smile',
        userA: { uid: 'alice', username: 'alice', mediaUrl: 'a.jpg' },
        userB: { uid: 'bob', username: 'bob', mediaUrl: 'b.jpg' },
        ts: Date.now(),
      }),
    ).resolves.toBeUndefined();

    expect(await stories(env)).toHaveLength(0);
  });

  it('does nothing when a participant is missing', async () => {
    const { env } = makeEnv();
    await publishVsStories(env as any, {
      matchId: 'm1',
      contestTitle: 'Best Smile',
      userA: { uid: 'alice' },
      userB: { uid: '' },
      ts: Date.now(),
    });
    expect(await stories(env)).toHaveLength(0);
  });

  it('still activates the battle and charges the fee when stories fail', async () => {
    // The join is a paid transaction; the story is decoration on top of it.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedContest(env, 'c1');
    const created = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'alice.jpg', mediaType: 'photo', deviceId: 'device-a',
    });
    // Drop the table the story insert needs, so the story write cannot succeed.
    (env.DB as any).db.exec('DROP TABLE stories');

    const join = await call(env, 'bob', 'joinMatch', {
      matchId: created.body.matchId, mediaUrl: 'bob.jpg', mediaType: 'photo', deviceId: 'device-b',
    });

    expect(join.status).toBe(200);
    expect(join.body.status).toBe('active');
    const bob = await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, 'bob')).get();
    expect(Number(bob?.dpcoin)).toBe(980); // 20 = half of the 40 entry fee
  });
});
