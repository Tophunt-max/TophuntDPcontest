/**
 * Battle results: early settlement on read (lib/settleDue.ts) and the community
 * moderation hold on reported battles (migration 0060).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
const tally = { votesA: 3, votesB: 1 };
let finalizeCalls = 0;
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: tally.votesA, votesB: tally.votesB, total: tally.votesA + tally.votesB }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
  finalizeVotes: async () => {
    finalizeCalls += 1;
    return { votesA: tally.votesA, votesB: tally.votesB, total: tally.votesA + tally.votesB };
  },
}));
vi.mock('../src/lib/publish', () => ({ publish: async () => {}, publishMany: async () => {}, publishPresence: async () => {} }));

import { makeEnv, makeApp, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { memoReset } from '../src/lib/memo';
import { isDueForSettlement, kickSettlementIfDue } from '../src/lib/settleDue';
import { resolveContests } from '../src/cron';
import { MATCH_REPORT_HOLD_THRESHOLD } from '../src/routes/api';

const app = makeApp();
beforeEach(() => {
  memoReset();
  finalizeCalls = 0;
  tally.votesA = 3;
  tally.votesB = 1;
});

/** A ctx that records waitUntil work so the test can await it. */
function recordingCtx() {
  const work: Promise<unknown>[] = [];
  return {
    work,
    ctx: { waitUntil: (p: Promise<unknown>) => void work.push(p), passThroughOnException() {} } as any,
    settle: () => Promise.all(work),
  };
}

async function seed(env: TestEnv, opts: { expiresAt?: number; status?: string } = {}) {
  const ts = Date.now();
  const db = drizzleOf(env);
  // Reporter accounts must be older than a day to count toward the hold;
  // 'fresh' was created just now.
  for (const uid of ['alice', 'bob', 'r1', 'r2', 'r3', 'r4', 'fresh']) {
    const createdAt = uid === 'fresh' ? ts : ts - 2 * 86_400_000;
    await db.insert(schema.users).values({ uid, username: uid, fullName: uid, dpcoin: 100, createdAt, updatedAt: ts } as any);
  }
  await db.insert(schema.contestMatches).values({
    id: 'm1',
    status: opts.status ?? 'active',
    type: 'photo',
    title: 'Best Smile',
    entryFee: 20,
    userA: { uid: 'alice', username: 'alice', mediaUrl: 'a.jpg', votes: 0 },
    userB: { uid: 'bob', username: 'bob', mediaUrl: 'b.jpg', votes: 0 },
    totalVotes: 0,
    prizeCoins: 20,
    prizeType: 'coins',
    minVotesRequired: 0,
    createdAt: ts - 86_400_000,
    activatedAt: ts - 86_400_000,
    expiresAt: opts.expiresAt ?? ts - 1000,
  } as any);
}

async function readMatch(env: TestEnv, ctx: any) {
  const res = await app.request('/read/matches/m1', {}, env, ctx);
  return (await res.json()) as any;
}
const matchRow = (env: TestEnv) => drizzleOf(env).select().from(schema.contestMatches).get() as Promise<any>;

describe('early settlement on read', () => {
  it('isDueForSettlement: only active battles past their deadline', () => {
    const now = 1_000_000;
    expect(isDueForSettlement({ status: 'active', expiresAt: now - 1 } as any, now)).toBe(true);
    expect(isDueForSettlement({ status: 'active', expiresAt: now + 1 } as any, now)).toBe(false);
    expect(isDueForSettlement({ status: 'completed', expiresAt: now - 1 } as any, now)).toBe(false);
    expect(isDueForSettlement({ status: 'active', expiresAt: null } as any, now)).toBe(false);
  });

  it('a read after the deadline declares the winner without waiting for the cron', async () => {
    const { env } = makeEnv();
    await seed(env);
    const r = recordingCtx();
    const first = await readMatch(env, r.ctx);
    expect(first.status).toBe('active');
    expect(first.resultPending).toBe(true);
    await r.settle();
    const row = await matchRow(env);
    expect(row.status).toBe('completed');
    expect(row.winnerUid).toBe('alice');
    const after = await readMatch(env, recordingCtx().ctx);
    expect(after.status).toBe('completed');
    expect(after.resultPending).toBeUndefined();
  });

  it('a read BEFORE the deadline never settles', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    const r = recordingCtx();
    const body = await readMatch(env, r.ctx);
    expect(r.work).toHaveLength(0);
    expect(body.resultPending).toBeUndefined();
    expect((await matchRow(env)).status).toBe('active');
  });

  it('many readers + the cron at once pay the winner exactly once', async () => {
    const { env } = makeEnv();
    await seed(env);
    const r = recordingCtx();
    const row = await matchRow(env);
    // Two isolates (memo reset between) plus the cron, all racing.
    kickSettlementIfDue(env as any, r.ctx, row);
    memoReset();
    kickSettlementIfDue(env as any, r.ctx, row);
    await Promise.all([r.settle(), resolveContests(env as any)]);
    const wins = await env.DB.prepare("SELECT COUNT(*) n FROM coin_transactions WHERE type = 'contest_win_reward'").first<any>();
    expect(Number(wins.n)).toBe(1);
    const alice = await env.DB.prepare("SELECT dpcoin FROM users WHERE uid = 'alice'").first<any>();
    expect(Number(alice.dpcoin)).toBe(120);
    const notes = await env.DB.prepare("SELECT COUNT(*) n FROM notifications WHERE recipient_id = 'alice' AND type = 'contest-win'").first<any>();
    expect(Number(notes.n)).toBe(1);
  });

  it('throttles repeated reads in one isolate to one settlement attempt', async () => {
    const { env } = makeEnv();
    await seed(env);
    // Every read in the window would otherwise start its own settlement.
    const r = recordingCtx();
    const row = await matchRow(env);
    expect(kickSettlementIfDue(env as any, r.ctx, row)).toBe(true);
    for (let i = 0; i < 5; i++) expect(kickSettlementIfDue(env as any, r.ctx, row)).toBe(false);
    await r.settle();
    expect(finalizeCalls).toBe(1);
  });

  it('a tie settles as completed with no winner', async () => {
    tally.votesA = 2;
    tally.votesB = 2;
    const { env } = makeEnv();
    await seed(env);
    const r = recordingCtx();
    await readMatch(env, r.ctx);
    await r.settle();
    const row = await matchRow(env);
    expect(row.status).toBe('completed');
    expect(row.winnerUid).toBeNull();
  });
});

describe('community moderation hold', () => {
  async function report(env: TestEnv, uid: string, extra: Record<string, unknown> = {}) {
    const res = await app.request(
      '/api',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${uid}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'createReport', targetType: 'match', targetId: 'm1', reason: 'QR code / payment scam', ...extra }),
      },
      env,
      recordingCtx().ctx,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  }
  const feedIds = async (env: TestEnv) => {
    const res = await app.request('/read/matches?status=active&sort=recent', {}, env, recordingCtx().ctx);
    return ((await res.json()) as any[]).map((m) => m.id);
  };

  it(`hides a battle from feeds after ${MATCH_REPORT_HOLD_THRESHOLD} different reporters, not before`, async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    await report(env, 'r1');
    await report(env, 'r2');
    expect(await feedIds(env)).toEqual(['m1']);
    await report(env, 'r3');
    expect((await matchRow(env)).moderationHoldAt).toBeGreaterThan(0);
    memoReset();
    expect(await feedIds(env)).toEqual([]);
    // Still reachable by direct link, and still settles normally (status untouched).
    expect((await readMatch(env, recordingCtx().ctx)).id).toBe('m1');
    expect((await matchRow(env)).status).toBe('active');
  });

  it('one user reporting many times counts once', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    expect((await report(env, 'r1')).success).toBe(true);
    expect((await report(env, 'r1')).duplicate).toBe(true);
    expect((await report(env, 'r1')).duplicate).toBe(true);
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM reports').first<any>();
    expect(Number(n.n)).toBe(1);
    expect((await matchRow(env)).moderationHoldAt).toBeNull();
  });

  it('caps the free-text reason', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    await report(env, 'r1', { reason: 'x'.repeat(5000) });
    const r = await env.DB.prepare('SELECT reason FROM reports').first<any>();
    expect(String(r.reason)).toHaveLength(300);
  });

  const adminCall = async (env: TestEnv, path: string, init: RequestInit = {}) =>
    app.request(
      path,
      { ...init, headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret', ...(init.headers || {}) } },
      env,
      recordingCtx().ctx,
    );
  const resolve = (env: TestEnv, id: string, action: 'dismiss' | 'remove') =>
    adminCall(env, `/admin/reports/${id}/resolve`, { method: 'POST', body: JSON.stringify({ action }) });
  const reportIds = async (env: TestEnv) =>
    (await env.DB.prepare('SELECT id FROM reports ORDER BY created_at').all<any>()).results.map((r: any) => r.id as string);
  const coins = async (env: TestEnv, uid: string) =>
    Number((await env.DB.prepare('SELECT dpcoin FROM users WHERE uid = ?').bind(uid).first<any>()).dpcoin);

  it('participants and brand-new accounts do not count toward the hold', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    // A player mass-reporting their own opponent's battle, plus a throwaway account.
    await report(env, 'alice');
    await report(env, 'bob');
    await report(env, 'fresh');
    await report(env, 'r1');
    expect((await matchRow(env)).moderationHoldAt).toBeNull();
    await report(env, 'r2');
    await report(env, 'r3');
    expect((await matchRow(env)).moderationHoldAt).toBeGreaterThan(0);
  });

  it('the detail response flags a held battle', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    expect((await readMatch(env, recordingCtx().ctx)).moderationHeld).toBeUndefined();
    for (const u of ['r1', 'r2', 'r3']) await report(env, u);
    memoReset();
    expect((await readMatch(env, recordingCtx().ctx)).moderationHeld).toBe(true);
  });

  it("a held battle's VS stories leave the stories feed; other stories stay", async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    const ts = Date.now();
    const db = drizzleOf(env);
    await db.insert(schema.stories).values([
      { id: 'vs-a', userId: 'alice', mediaUrl: 'card.jpg', type: 'contest_vs', matchId: 'm1', visibility: 'public', createdAt: ts, expiresAt: ts + 86_400_000 },
      { id: 'plain-b', userId: 'bob', mediaUrl: 'b.jpg', type: 'photo', visibility: 'public', createdAt: ts, expiresAt: ts + 86_400_000 },
    ] as any);
    await env.DB.prepare("UPDATE contest_matches SET moderation_hold_at = ? WHERE id = 'm1'").bind(ts).run();
    const res = await app.request('/read/stories/feed', {}, env, recordingCtx().ctx);
    expect(res.status).toBe(200);
    const ids = ((await res.json()) as any[]).flatMap((g) => g.stories.map((st: any) => st.id));
    expect(ids).toContain('plain-b');
    expect(ids).not.toContain('vs-a');
  });

  it('admin dismissing every report releases the hold, and dismissed reports stay closed', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    for (const u of ['r1', 'r2', 'r3']) await report(env, u);
    const ids = await reportIds(env);
    await resolve(env, ids[0], 'dismiss');
    await resolve(env, ids[1], 'dismiss');
    // One open report remains: still held.
    expect((await matchRow(env)).moderationHoldAt).toBeGreaterThan(0);
    expect((await resolve(env, ids[2], 'dismiss')).status).toBe(200);
    expect((await matchRow(env)).moderationHoldAt).toBeNull();
    // Kept as 'dismissed' (dedupe) but gone from the admin queue.
    expect(await reportIds(env)).toHaveLength(3);
    const queue = (await (await adminCall(env, '/admin/reports')).json()) as any[];
    expect(queue).toHaveLength(0);
  });

  it('re-reporting after a dismissal is a duplicate and does not re-hold', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    for (const u of ['r1', 'r2', 'r3']) await report(env, u);
    for (const id of await reportIds(env)) await resolve(env, id, 'dismiss');
    for (const u of ['r1', 'r2', 'r3']) expect((await report(env, u)).duplicate).toBe(true);
    expect((await matchRow(env)).moderationHoldAt).toBeNull();
    // Dismissed reports never count toward the threshold again.
    await report(env, 'r4');
    expect((await matchRow(env)).moderationHoldAt).toBeNull();
  });

  it('deleting the last open report also releases the hold', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    for (const u of ['r1', 'r2', 'r3']) await report(env, u);
    for (const id of await reportIds(env)) {
      expect((await adminCall(env, `/admin/reports?id=${id}`, { method: 'DELETE' })).status).toBe(200);
    }
    expect((await matchRow(env)).moderationHoldAt).toBeNull();
  });

  it('removing a LIVE reported battle cancels it and refunds both entry fees exactly once', async () => {
    const { env } = makeEnv();
    await seed(env, { expiresAt: Date.now() + 3_600_000 });
    await report(env, 'r1');
    await report(env, 'r2');
    const [first, second] = await reportIds(env);
    expect((await resolve(env, first, 'remove')).status).toBe(200);
    const row = await matchRow(env);
    expect(row.status).toBe('cancelled');
    expect(row.settlementId).toBeTruthy();
    // entryFee 20 total -> 10 back to each player.
    expect(await coins(env, 'alice')).toBe(110);
    expect(await coins(env, 'bob')).toBe(110);
    // Removing again via the other report must not refund twice.
    await resolve(env, second, 'remove');
    expect(await coins(env, 'alice')).toBe(110);
    const refunds = await env.DB.prepare("SELECT COUNT(*) n FROM coin_transactions WHERE type = 'contest_refund'").first<any>();
    expect(Number(refunds.n)).toBe(2);
  });

  it('removing a COMPLETED reported battle takes it down but leaves the payout alone', async () => {
    const { env } = makeEnv();
    await seed(env);
    const r = recordingCtx();
    await readMatch(env, r.ctx);
    await r.settle();
    expect((await matchRow(env)).status).toBe('completed');
    const paid = await coins(env, 'alice');
    await report(env, 'r1');
    const [id] = await reportIds(env);
    expect((await resolve(env, id, 'remove')).status).toBe(200);
    expect((await matchRow(env)).status).toBe('cancelled');
    expect(await coins(env, 'alice')).toBe(paid);
    expect(await coins(env, 'bob')).toBe(100);
  });
});
