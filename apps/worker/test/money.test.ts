import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

async function call(env: TestEnv, uid: string, action: string, data: any = {}, role = 'user') {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}:${role}` },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function seedUser(env: TestEnv, uid: string, dpcoin = 0, extra: Record<string, any> = {}) {
  const db = drizzleOf(env);
  const ts = Date.now();
  await db.insert(schema.users).values({ uid, username: uid, fullName: uid, dpcoin, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function getUser(env: TestEnv, uid: string) {
  const db = drizzleOf(env);
  return db.select().from(schema.users).where(eq(schema.users.uid, uid)).get();
}

async function seedContest(env: TestEnv, id: string, totalEntryFee: number, extra: Record<string, any> = {}) {
  const db = drizzleOf(env);
  await db.insert(schema.contests).values({ id, title: `Contest ${id}`, type: 'photo', totalEntryFee, rewardCoins: totalEntryFee, createdAt: Date.now(), ...extra } as any);
}

async function seedPackage(env: TestEnv, id: string, coins: number, bonusCoins: number, priceInr: number, active = true) {
  const db = drizzleOf(env);
  const ts = Date.now();
  await db.insert(schema.coinPackages).values({ id, name: `${coins} coins`, coins, bonusCoins, priceInr, active, sortOrder: 0, createdAt: ts, updatedAt: ts } as any);
}

// drizzle eq used in helpers above.
import { eq } from 'drizzle-orm';

/** Valid Razorpay signature = HMAC_SHA256(orderId|paymentId, secret), hex. */
function sign(orderId: string, paymentId: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
describe('createOrder', () => {
  it('creates a server-priced order and stores the intent in KV', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedPackage(env, 'pkg1', 100, 20, 199);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'order_abc' }), { status: 200 })));

    const { status, body } = await call(env, 'alice', 'createOrder', { packageId: 'pkg1' });

    expect(status).toBe(200);
    expect(body.orderId).toBe('order_abc');
    expect(body.amount).toBe(19900); // paise
    expect(body.coins).toBe(120); // coins + bonus
    const stored = await env.CACHE_KV.get('rzp_order:order_abc', 'json');
    expect(stored).toMatchObject({ uid: 'alice', coins: 120 });
  });

  it('rejects an unknown / inactive package', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedPackage(env, 'pkgOff', 100, 0, 99, false);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    const { status, body } = await call(env, 'alice', 'createOrder', { packageId: 'pkgOff' });
    expect(status).toBe(404);
    expect(body.error.status).toBe('NOT_FOUND');
  });

  it('fails closed when the gateway is not configured', async () => {
    const { env } = makeEnv({ RAZORPAY_KEY_SECRET: '', RAZORPAY_KEY_ID: '' });
    await seedUser(env, 'alice');
    await seedPackage(env, 'pkg1', 100, 20, 199);
    const { status } = await call(env, 'alice', 'createOrder', { packageId: 'pkg1' });
    expect(status).toBe(412);
  });
});

// ===========================================================================
describe('topup', () => {
  async function primeOrder(env: TestEnv, uid: string, orderId = 'order_abc') {
    await seedUser(env, uid, 0);
    await seedPackage(env, 'pkg1', 100, 20, 199);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: orderId }), { status: 200 })));
    await call(env, uid, 'createOrder', { packageId: 'pkg1' });
  }

  it('credits server-authoritative coins for a verified payment', async () => {
    const { env } = makeEnv();
    await primeOrder(env, 'alice');
    const sig = sign('order_abc', 'pay_1', env.RAZORPAY_KEY_SECRET);

    const { status, body } = await call(env, 'alice', 'topup', { paymentId: 'pay_1', orderId: 'order_abc', signature: sig });

    expect(status).toBe(200);
    expect(body.coins).toBe(120);
    const u = await getUser(env, 'alice');
    expect(u?.dpcoin).toBe(120);
  });

  it('rejects a tampered signature', async () => {
    const { env } = makeEnv();
    await primeOrder(env, 'alice');
    const { status } = await call(env, 'alice', 'topup', { paymentId: 'pay_1', orderId: 'order_abc', signature: 'deadbeef' });
    expect(status).toBe(403);
    const u = await getUser(env, 'alice');
    expect(u?.dpcoin).toBe(0);
  });

  it("rejects an order that doesn't belong to the caller", async () => {
    const { env } = makeEnv();
    await primeOrder(env, 'alice');
    await seedUser(env, 'bob', 0);
    const sig = sign('order_abc', 'pay_1', env.RAZORPAY_KEY_SECRET);
    const { status } = await call(env, 'bob', 'topup', { paymentId: 'pay_1', orderId: 'order_abc', signature: sig });
    expect(status).toBe(403);
  });

  it('does not double-credit on replay', async () => {
    const { env } = makeEnv();
    await primeOrder(env, 'alice');
    const sig = sign('order_abc', 'pay_1', env.RAZORPAY_KEY_SECRET);
    const first = await call(env, 'alice', 'topup', { paymentId: 'pay_1', orderId: 'order_abc', signature: sig });
    expect(first.status).toBe(200);
    const second = await call(env, 'alice', 'topup', { paymentId: 'pay_1', orderId: 'order_abc', signature: sig });
    expect(second.status).toBeGreaterThanOrEqual(400);
    const u = await getUser(env, 'alice');
    expect(u?.dpcoin).toBe(120); // credited exactly once
  });
});

// ===========================================================================
describe('claimDailyReward', () => {
  it('credits base + streak bonus and sets streak=1 on first claim', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    const { status, body } = await call(env, 'alice', 'claimDailyReward', { dayIndex: 0 });
    expect(status).toBe(200);
    // default settings: 10 + streak(1)*2 = 12
    expect(body.coinsEarned).toBe(12);
    expect(body.streak).toBe(1);
    const u = await getUser(env, 'alice');
    expect(u?.dpcoin).toBe(12);
    expect(u?.xp).toBe(50);
  });

  it('rejects a second claim on the same day', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await call(env, 'alice', 'claimDailyReward', {});
    const { status } = await call(env, 'alice', 'claimDailyReward', {});
    expect(status).toBe(409);
    const u = await getUser(env, 'alice');
    expect(u?.dpcoin).toBe(12); // still just one reward
  });
});

// ===========================================================================
describe('startMatch (entry fee)', () => {
  it('deducts half the entry fee and records a ledger entry', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    await seedContest(env, 'c1', 100); // fee = 50

    const { status, body } = await call(env, 'alice', 'startMatch', { contestId: 'c1', mediaUrl: 'm', mediaType: 'photo' });
    expect(status).toBe(200);
    expect(body.matchId).toBeTruthy();

    const u = await getUser(env, 'alice');
    expect(u?.dpcoin).toBe(50);

    const db = drizzleOf(env);
    const txns = await db.select().from(schema.coinTransactions).where(eq(schema.coinTransactions.uid, 'alice')).all();
    expect(txns.some((t: any) => t.type === 'contest_entry_fee' && t.amount === -50)).toBe(true);
  });

  it('rejects when the user cannot afford the fee (no deduction)', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'poor', 10);
    await seedContest(env, 'c1', 100); // fee = 50
    const { status } = await call(env, 'poor', 'startMatch', { contestId: 'c1', mediaUrl: 'm', mediaType: 'photo' });
    expect(status).toBe(412);
    const u = await getUser(env, 'poor');
    expect(u?.dpcoin).toBe(10);
  });
});

// ===========================================================================
describe('joinMatch', () => {
  async function startWaitingMatch(env: TestEnv) {
    await seedContest(env, 'c1', 100); // fee = 50
    await seedUser(env, 'alice', 100);
    const { body } = await call(env, 'alice', 'startMatch', { contestId: 'c1', mediaUrl: 'ma', mediaType: 'photo' });
    return body.matchId as string;
  }

  it('activates the match and deducts the joiner fee', async () => {
    const { env } = makeEnv();
    const matchId = await startWaitingMatch(env);
    await seedUser(env, 'bob', 100);

    const { status, body } = await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: 'mb', mediaType: 'photo' });
    expect(status).toBe(200);
    expect(body.status).toBe('active');

    const bob = await getUser(env, 'bob');
    expect(bob?.dpcoin).toBe(50);

    const db = drizzleOf(env);
    const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
    expect(match?.status).toBe('active');
  });

  it('forbids joining your own match', async () => {
    const { env } = makeEnv();
    const matchId = await startWaitingMatch(env);
    const { status } = await call(env, 'alice', 'joinMatch', { matchId, mediaUrl: 'x', mediaType: 'photo' });
    expect(status).toBe(412);
  });

  it('rejects a second joiner once the match is active', async () => {
    const { env } = makeEnv();
    const matchId = await startWaitingMatch(env);
    await seedUser(env, 'bob', 100);
    await seedUser(env, 'carol', 100);
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: 'mb', mediaType: 'photo' });
    const { status } = await call(env, 'carol', 'joinMatch', { matchId, mediaUrl: 'mc', mediaType: 'photo' });
    expect(status).toBe(412);
    const carol = await getUser(env, 'carol');
    expect(carol?.dpcoin).toBe(100); // not charged
  });
});

// ===========================================================================
describe('submitVote (validation)', () => {
  async function activeMatch(env: TestEnv) {
    await seedContest(env, 'c1', 100);
    await seedUser(env, 'alice', 100);
    await seedUser(env, 'bob', 100);
    const { body } = await call(env, 'alice', 'startMatch', { contestId: 'c1', mediaUrl: 'ma', mediaType: 'photo' });
    await call(env, 'bob', 'joinMatch', { matchId: body.matchId, mediaUrl: 'mb', mediaType: 'photo' });
    return body.matchId as string;
  }

  it('rejects missing fields', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'carol', 0);
    const { status } = await call(env, 'carol', 'submitVote', { matchId: 'x' });
    expect(status).toBe(400);
  });

  it('rejects voting on a non-active match', async () => {
    const { env } = makeEnv();
    await seedContest(env, 'c1', 100);
    await seedUser(env, 'alice', 100);
    await seedUser(env, 'carol', 0);
    const { body } = await call(env, 'alice', 'startMatch', { contestId: 'c1', mediaUrl: 'ma', mediaType: 'photo' });
    const { status } = await call(env, 'carol', 'submitVote', { matchId: body.matchId, votedForUid: 'alice', deviceId: 'd1' });
    expect(status).toBe(412);
  });

  it('forbids a participant from voting in their own match', async () => {
    const { env } = makeEnv();
    const matchId = await activeMatch(env);
    const { status } = await call(env, 'alice', 'submitVote', { matchId, votedForUid: 'bob', deviceId: 'd1' });
    expect(status).toBe(412);
  });

  it('rejects a vote for a non-participant', async () => {
    const { env } = makeEnv();
    const matchId = await activeMatch(env);
    await seedUser(env, 'carol', 0);
    const { status } = await call(env, 'carol', 'submitVote', { matchId, votedForUid: 'nobody', deviceId: 'd1' });
    expect(status).toBe(400);
  });
});


// ===========================================================================
describe('claimAdReward', () => {
  it('credits a capped reward and enforces the daily limit', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);

    // Daily cap is 10 × 5 coins.
    for (let i = 0; i < 10; i++) {
      const { status, body } = await call(env, 'alice', 'claimAdReward', {});
      expect(status).toBe(200);
      expect(body.coinsEarned).toBe(5);
    }
    const u = await getUser(env, 'alice');
    expect(u?.dpcoin).toBe(50);

    // 11th call in the same day is rejected, and no extra coins are credited.
    const over = await call(env, 'alice', 'claimAdReward', {});
    expect(over.status).toBe(429);
    const after = await getUser(env, 'alice');
    expect(after?.dpcoin).toBe(50);
  });
});
