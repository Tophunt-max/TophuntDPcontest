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
import { resolveContests } from '../src/cron';

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

  it('gives both users the SAME story, not two different ones', async () => {
    // This is the actual product requirement: one story, shown to both. There are
    // two rows only because stories are per-user in this app — each participant
    // needs it on their own ring — but the two rows must describe the same battle
    // in the same way, or the client would draw two different frames from them.
    //
    // Guard against a future "optimisation" that denormalises per-user opponent
    // data into each row and lets the two drift apart.
    const { env } = makeEnv();
    const matchId = await waitingMatch(env);

    await call(env, 'bob', 'joinMatch', {
      matchId, mediaUrl: 'bob.jpg', mediaType: 'photo', deviceId: 'device-b',
    });

    const [a, b] = (await stories(env)) as any[];
    // Everything that decides what gets DRAWN is identical.
    expect(a.matchId).toBe(b.matchId);
    expect(a.type).toBe(b.type);
    expect(a.contestTitle).toBe(b.contestTitle);
    expect(a.createdAt).toBe(b.createdAt);
    expect(a.expiresAt).toBe(b.expiresAt);
    // Only ownership differs — that is what puts it on both rings.
    expect(a.userId).not.toBe(b.userId);
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
describe('setMatchVsImage', () => {
  const CARD = 'https://cdn.test/vs-cards/images/card.png';

  /** A live battle between alice and bob, with both VS stories written. */
  async function liveMatch(env: TestEnv) {
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedUser(env, 'carol');
    await seedContest(env, 'c1');
    const created = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'alice.jpg', mediaType: 'photo', deviceId: 'device-a',
    });
    const matchId = created.body.matchId as string;
    await call(env, 'bob', 'joinMatch', {
      matchId, mediaUrl: 'bob.jpg', mediaType: 'photo', deviceId: 'device-b',
    });
    return matchId;
  }

  const matchRow = (env: TestEnv, id: string) =>
    drizzleOf(env).select().from(schema.contestMatches).where(eq(schema.contestMatches.id, id)).get();

  it('records the card on the match', async () => {
    const { env } = makeEnv();
    const matchId = await liveMatch(env);

    const res = await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: CARD });

    expect(res.status).toBe(200);
    expect(res.body.vsImageUrl).toBe(CARD);
    expect((await matchRow(env, matchId))?.vsImageUrl).toBe(CARD);
  });

  it('leaves each story row pointing at that user\'s OWN entry', async () => {
    // Copying the card into `stories.media_url` is the obvious convenience and it
    // is wrong twice over, so it is pinned here rather than left to a comment.
    //
    // It would defeat blocking: `/read/matches/:id` returns nothing when a
    // participant is blocked by the viewer, and the story then falls back to the
    // row's own media — which would be the composite showing the blocked user.
    //
    // And it would give one R2 object two owners: account deletion collects
    // `stories.media_url` for the departing user and deletes those objects, so one
    // participant leaving would delete the image the other's story is displaying.
    const { env } = makeEnv();
    const matchId = await liveMatch(env);

    await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: CARD });

    const rows = await stories(env);
    expect(rows).toHaveLength(2);
    expect(rows.some((r: any) => r.mediaUrl === CARD)).toBe(false);
    expect(rows.map((r: any) => r.mediaUrl).sort()).toEqual(['alice.jpg', 'bob.jpg']);
  });

  it('refuses a url that is not one of our uploaded cards', async () => {
    // This action writes into the OTHER participant's story, so an unchecked url
    // would let one user put an arbitrary remote image on someone else's story.
    const { env } = makeEnv();
    const matchId = await liveMatch(env);

    for (const hostile of [
      'https://evil.example/card.png',              // foreign host
      'http://cdn.test/vs-cards/images/card.png',   // wrong protocol
      'https://cdn.test/stories/images/card.png',   // our host, wrong prefix
      'https://cdn.test/vs-cards/images/../../a.png', // traversal
      'https://cdn.test/vs-cards/images/card.png?x=1', // query string
    ]) {
      const res = await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: hostile });
      expect(res.status).toBe(400);
    }

    expect((await matchRow(env, matchId))?.vsImageUrl).toBeFalsy();
    // A url we could not validate is not ours to reason about, so nothing is
    // deleted on this path either.
    expect(env.MEDIA._deleted).toEqual([]);
  });

  it('refuses a caller who is not in the battle, and bins their upload', async () => {
    const { env } = makeEnv();
    const matchId = await liveMatch(env);

    const res = await call(env, 'carol', 'setMatchVsImage', { matchId, imageUrl: CARD });

    expect(res.status).toBe(403);
    expect((await matchRow(env, matchId))?.vsImageUrl).toBeFalsy();
    // The caller uploaded before calling, so every rejection past validation
    // orphans an object unless it is cleaned up here.
    expect(env.MEDIA._deleted).toEqual(['vs-cards/images/card.png']);
  });

  it('refuses a battle that nobody has joined yet', async () => {
    // Without this the creator of a pending match could claim `vs_image_url` with
    // any image they can upload, before an opponent exists — and first-writer-wins
    // would make it the card both users see for the life of the battle.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedContest(env, 'c1');
    const created = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'alice.jpg', mediaType: 'photo', deviceId: 'device-a',
    });
    const matchId = created.body.matchId as string;

    const res = await call(env, 'alice', 'setMatchVsImage', { matchId, imageUrl: CARD });

    expect(res.status).toBe(412);
    expect((await matchRow(env, matchId))?.vsImageUrl).toBeFalsy();
    expect(env.MEDIA._deleted).toEqual(['vs-cards/images/card.png']);
  });

  it('lets the creator set it too, not just the joiner', async () => {
    const { env } = makeEnv();
    const matchId = await liveMatch(env);
    expect((await call(env, 'alice', 'setMatchVsImage', { matchId, imageUrl: CARD })).status).toBe(200);
    expect((await matchRow(env, matchId))?.vsImageUrl).toBe(CARD);
  });

  it('first writer wins — a second card never replaces the first', async () => {
    // Swapping the image under a story that is already being viewed is worse
    // than keeping the first good one.
    const { env } = makeEnv();
    const matchId = await liveMatch(env);
    await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: CARD });

    const second = 'https://cdn.test/vs-cards/images/other.png';
    const res = await call(env, 'alice', 'setMatchVsImage', { matchId, imageUrl: second });

    expect(res.status).toBe(200);
    expect(res.body.alreadySet).toBe(true);
    expect(res.body.vsImageUrl).toBe(CARD);
    expect((await matchRow(env, matchId))?.vsImageUrl).toBe(CARD);
  });

  it('throws away the card that lost the race instead of paying to store it', async () => {
    // Nothing else ever cleans these up — the story-expiry cron only touches
    // `type = 'user'` media — so an unrecorded card would sit in R2 forever.
    // Both participants can plausibly capture at the same moment, so without
    // this every contested battle leaks an object.
    const { env } = makeEnv();
    const matchId = await liveMatch(env);
    await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: CARD });

    const loser = 'https://cdn.test/vs-cards/images/loser.png';
    await call(env, 'alice', 'setMatchVsImage', { matchId, imageUrl: loser });

    expect(env.MEDIA._deleted).toEqual(['vs-cards/images/loser.png']);
  });

  it('never deletes the card it is reporting back as the winner', async () => {
    // A retry of a call that actually succeeded sends the SAME url again. Reading
    // that as "you lost, discard it" would delete the object both live stories
    // point at, blanking the story for both users.
    const { env } = makeEnv();
    const matchId = await liveMatch(env);
    await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: CARD });

    const retry = await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: CARD });

    expect(retry.body.alreadySet).toBe(true);
    expect(retry.body.vsImageUrl).toBe(CARD);
    expect(env.MEDIA._deleted).toEqual([]);
  });

  it('404s an unknown battle and bins the upload', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    expect((await call(env, 'alice', 'setMatchVsImage', { matchId: 'nope', imageUrl: CARD })).status).toBe(404);
    // Nothing references it and nothing else ever will.
    expect(env.MEDIA._deleted).toEqual(['vs-cards/images/card.png']);
  });

  it('is surfaced on the match read so clients can prefer it', async () => {
    const { env } = makeEnv();
    const matchId = await liveMatch(env);
    await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: CARD });

    const res = await app.request(
      `/read/matches/${matchId}`,
      { headers: { Authorization: 'Bearer bob' } },
      env,
      fakeCtx(),
    );
    const match: any = await res.json();
    expect(match.vsImageUrl).toBe(CARD);
  });

  it('is deleted from R2, and cleared, when the battle stories expire', async () => {
    // The card is the ONE contest-story object that has no other owner: nothing
    // else displays it, so when the stories go it is unreachable. The `type =
    // 'user'` media sweep does not cover it, so without this pass every battle
    // that generated a card would leave a permanent full-screen JPEG behind.
    const { env } = makeEnv();
    const matchId = await liveMatch(env);
    await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: CARD });

    // Age both battle stories past their expiry, the way 24h would.
    await drizzleOf(env).update(schema.stories).set({ expiresAt: Date.now() - 1000 } as any).run();

    await resolveContests(env);

    expect(env.MEDIA._deleted).toEqual(['vs-cards/images/card.png']);
    // Cleared too: a match outlives its stories, and a client reading a url that
    // points at a deleted object would render an empty frame instead of falling
    // back to the live layout.
    expect((await matchRow(env, matchId))?.vsImageUrl).toBeNull();
  });

  it('reports null rather than omitting the field when no card exists', async () => {
    // Battles created before this feature must read as "no card", not undefined,
    // so the client's fallback is an explicit branch.
    const { env } = makeEnv();
    const matchId = await liveMatch(env);

    const res = await app.request(
      `/read/matches/${matchId}`,
      { headers: { Authorization: 'Bearer bob' } },
      env,
      fakeCtx(),
    );
    const match: any = await res.json();
    expect(match.vsImageUrl).toBeNull();
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
