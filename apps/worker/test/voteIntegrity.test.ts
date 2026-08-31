/**
 * Vote-integrity guards on submitVote — the anti-cheating contract.
 *
 * A vote decides who takes the (real-money) entry-fee pot, so the checks that
 * sit in FRONT of the VoteCounter Durable Object are the app's defence against
 * rigged battles. They had NO test coverage: a refactor could quietly drop the
 * self-vote or candidate check and every request would still return 200, so the
 * regression would be invisible until someone farmed a payout.
 *
 * The DO itself owns dedup/tally and cannot start in this harness, so — exactly
 * like blocks.test.ts — `castVote` is mocked. That is the point: every rejection
 * below must happen BEFORE the vote reaches the counter, and the one allowed
 * vote must reach it with the right arguments. Asserting `castVote` was NOT
 * called is asserting the cheat was refused, not merely that an error was shown.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// A spy so we can assert whether a vote reached the counter at all. Default:
// a clean accepted vote; individual tests override the return to simulate the
// DO's dedup/close verdicts.
const castVoteMock = vi.hoisted(() =>
  vi.fn(async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false })),
);
vi.mock('../src/lib/voteCounter', () => ({
  castVote: castVoteMock,
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

beforeEach(() => {
  castVoteMock.mockClear();
  castVoteMock.mockResolvedValue({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false });
});

async function vote(env: TestEnv, uid: string, data: any) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
      body: JSON.stringify({ action: 'submitVote', ...data }),
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
    .values({ uid, username: uid, fullName: uid, status: 'active', dpcoin: 1000, createdAt: ts, updatedAt: ts, ...extra } as any);
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

/** alice vs bob, and a neutral third-party voter `carol`. */
async function scene(extra: Record<string, any> = {}) {
  const { env } = makeEnv();
  await seedUser(env, 'alice');
  await seedUser(env, 'bob');
  await seedUser(env, 'carol');
  await seedMatch(env, 'm1', 'alice', 'bob', extra);
  return env;
}

describe('submitVote — who and what is allowed', () => {
  it('accepts a neutral third party voting for a real participant, and reaches the counter with the right args', async () => {
    const env = await scene();
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice', deviceId: 'dev-carol' });
    expect(r.status).toBe(200);
    expect(r.body.success).toBe(true);
    expect(castVoteMock).toHaveBeenCalledTimes(1);
    // castVote(env, matchId, payload) — the vote details are the 3rd argument.
    const [, matchArg, payload] = castVoteMock.mock.calls[0] as any;
    expect(matchArg).toBe('m1');
    expect(payload).toMatchObject({ voterUid: 'carol', votedForUid: 'alice', deviceId: 'dev-carol', uidA: 'alice', uidB: 'bob' });
  });

  it('blocks a participant from voting in their OWN match (self-dealing)', async () => {
    const env = await scene();
    const r = await vote(env, 'alice', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(412);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('blocks the OTHER participant from voting too', async () => {
    const env = await scene();
    const r = await vote(env, 'bob', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(412);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('rejects a vote for a NON-participant uid (can only back one of the two)', async () => {
    const env = await scene();
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'stranger', deviceId: 'd1' });
    expect(r.status).toBe(400);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('requires a deviceId — the per-device anti-sockpuppet key cannot be omitted', async () => {
    const env = await scene();
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice' });
    expect(r.status).toBe(400);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('rejects an empty/whitespace deviceId', async () => {
    const env = await scene();
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice', deviceId: '   ' });
    expect(r.status).toBe(400);
    expect(castVoteMock).not.toHaveBeenCalled();
  });
});

describe('submitVote — when voting is allowed', () => {
  it('rejects voting on a non-active (completed) match', async () => {
    const env = await scene({ status: 'completed' });
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(412);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('rejects voting after the deadline has passed', async () => {
    const env = await scene({ expiresAt: Date.now() - 1000 });
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(412);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('rejects a match with no valid deadline', async () => {
    const env = await scene({ expiresAt: 0 });
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(412);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('404s on a match that does not exist', async () => {
    const env = await scene();
    const r = await vote(env, 'carol', { matchId: 'ghost', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(404);
    expect(castVoteMock).not.toHaveBeenCalled();
  });
});

describe('submitVote — who is eligible', () => {
  it('refuses a banned / non-active account', async () => {
    const env = await scene();
    await seedUser(env, 'banned', { status: 'banned' });
    const r = await vote(env, 'banned', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(403);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('refuses an isBlocked account', async () => {
    const env = await scene();
    await seedUser(env, 'flagged', { isBlocked: true });
    const r = await vote(env, 'flagged', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(403);
    expect(castVoteMock).not.toHaveBeenCalled();
  });

  it('refuses a voter with no account row at all', async () => {
    const env = await scene();
    const r = await vote(env, 'nobody', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(castVoteMock).not.toHaveBeenCalled();
  });
});

describe('submitVote — the DO verdict is surfaced faithfully', () => {
  it('maps alreadyVoted to 409 (no double voting)', async () => {
    const env = await scene();
    castVoteMock.mockResolvedValueOnce({ votesA: 1, votesB: 0, total: 1, alreadyVoted: true, deviceUsed: false, votingClosed: false });
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(409);
    expect(castVoteMock).toHaveBeenCalledTimes(1);
  });

  it('maps deviceUsed to 412 (one device, one vote per match)', async () => {
    const env = await scene();
    castVoteMock.mockResolvedValueOnce({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: true, votingClosed: false });
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice', deviceId: 'shared' });
    expect(r.status).toBe(412);
  });

  it('maps votingClosed to 412 (the actor closed after the API deadline check)', async () => {
    const env = await scene();
    castVoteMock.mockResolvedValueOnce({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: true });
    const r = await vote(env, 'carol', { matchId: 'm1', votedForUid: 'alice', deviceId: 'd1' });
    expect(r.status).toBe(412);
  });
});
