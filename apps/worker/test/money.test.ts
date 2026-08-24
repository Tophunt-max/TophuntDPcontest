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
import { clawbackPaymentOrder, creditPaymentOrder } from '../src/lib/coinOrders';

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

/** Write an admin App Control settings document (settings/{id}.data). */
async function seedSettings(env: TestEnv, id: string, data: Record<string, any>) {
  const db = drizzleOf(env);
  await db.insert(schema.settings).values({ id, data: data as any, updatedAt: Date.now() } as any);
  await env.CACHE_KV.delete(`settings:${id}`);
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
  // Rewarded ads mint withdrawable currency on the client's word alone, so the
  // feature is fail-closed: disabled unless an admin turns it on, and even then
  // it must be an explicit decision to trust an unverified client.
  const adsOn = { ads: { enabled: true, trustClient: true, provider: 'test', reward: 5, dailyCap: 10 } };

  it('is rejected when rewarded ads are not configured', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);

    const { status } = await call(env, 'alice', 'claimAdReward', {});
    expect(status).toBe(412);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(0);
  });

  it('is rejected when the provider has no server-side verification', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedSettings(env, 'appConfig', { ads: { enabled: true, trustClient: false } });

    const { status } = await call(env, 'alice', 'claimAdReward', {});
    expect(status).toBe(412);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(0);
  });

  it('credits a capped reward and enforces the daily limit', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedSettings(env, 'appConfig', adsOn);

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

  it('writes exactly one ledger row per credited claim', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedSettings(env, 'appConfig', adsOn);

    await call(env, 'alice', 'claimAdReward', {});
    await call(env, 'alice', 'claimAdReward', {});

    const db = drizzleOf(env);
    const ledger = await db
      .select()
      .from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.type, 'ad_reward'))
      .all();
    expect(ledger).toHaveLength(2);
    // Ledger total must equal the balance — the invariant the KV counter broke.
    const total = ledger.reduce((sum, row) => sum + Number(row.amount), 0);
    expect(total).toBe(Number((await getUser(env, 'alice'))?.dpcoin));
  });
});



// ===========================================================================
// Refund / chargeback clawback. Before this existed, a user could pay, receive
// coins, refund the payment and keep the coins — the webhook 200'd every event
// that was not a successful capture and did nothing.
describe('clawbackPaymentOrder', () => {
  async function seedPaidOrder(
    env: TestEnv,
    uid: string,
    { coins = 100, paise = 10000, orderId = 'order_1', paymentId = 'pay_1' } = {},
  ) {
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.paymentOrders).values({
      orderId, userId: uid, packageId: 'p1', coins, bonusCoins: 0, amountPaise: paise,
      currency: 'INR', status: 'paid', paymentId, source: 'callback', creditedAt: ts,
      createdAt: ts, updatedAt: ts,
    } as any);
    await db.insert(schema.payments).values({
      id: paymentId, userId: uid, amount: coins, status: 'success', createdAt: ts,
    } as any);
    return { orderId, paymentId, coins };
  }

  it('reverses the credit, ledgers it, and makes the order terminal', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId } = await seedPaidOrder(env, 'alice');

    const res = await clawbackPaymentOrder(env as any, drizzleOf(env), { paymentId, kind: 'refund' });

    expect(res.clawedBack).toBe(true);
    expect(res.coins).toBe(100);
    expect(res.shortfall).toBe(0);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(0);

    const db = drizzleOf(env);
    const ledger = await db.select().from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.type, 'refund_clawback')).all();
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBe(-100);

    const order = await db.select().from(schema.paymentOrders)
      .where(eq(schema.paymentOrders.paymentId, paymentId)).get();
    expect(order?.status).toBe('refunded');
    // Revenue reporting must stop counting a refunded payment.
    const payment = await db.select().from(schema.payments)
      .where(eq(schema.payments.id, paymentId)).get();
    expect(payment?.status).toBe('refunded');
  });

  it('is idempotent — a duplicate refund event debits nothing further', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId } = await seedPaidOrder(env, 'alice');

    await clawbackPaymentOrder(env as any, drizzleOf(env), { paymentId, kind: 'refund' });
    const second = await clawbackPaymentOrder(env as any, drizzleOf(env), { paymentId, kind: 'refund' });

    expect(second.clawedBack).toBe(false);
    expect(second.reason).toBe('already');
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(0);
    const ledger = await drizzleOf(env).select().from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.type, 'refund_clawback')).all();
    expect(ledger).toHaveLength(1);
  });

  it('claws back proportionally on a partial refund, rounding against the refunder', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { paymentId } = await seedPaidOrder(env, 'alice', { coins: 100, paise: 10000 });

    // 30% refunded -> 30 coins. Rounding is ceil so it never favours the refunder.
    const res = await clawbackPaymentOrder(env as any, drizzleOf(env), {
      paymentId, kind: 'refund', refundedAmountPaise: 3000,
    });

    expect(res.coins).toBe(30);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(70);
  });

  it('records a shortfall and goes negative when the coins were already spent', async () => {
    const { env } = makeEnv();
    // The user spent 80 of the 100 purchased coins before refunding.
    await seedUser(env, 'alice', 20);
    const { paymentId } = await seedPaidOrder(env, 'alice');

    const res = await clawbackPaymentOrder(env as any, drizzleOf(env), { paymentId, kind: 'dispute' });

    expect(res.clawedBack).toBe(true);
    expect(res.shortfall).toBe(80);
    // Negative balance is deliberate: every spend path guards on `dpcoin >= amt`,
    // so the loss blocks further spending instead of silently disappearing.
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(-80);
    const order = await drizzleOf(env).select().from(schema.paymentOrders)
      .where(eq(schema.paymentOrders.paymentId, paymentId)).get();
    expect(order?.status).toBe('disputed');
    expect(Number(order?.clawbackShortfall)).toBe(80);
  });

  it('never lets a refunded order be re-credited by a late duplicate capture', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    const { orderId, paymentId } = await seedPaidOrder(env, 'alice');
    await clawbackPaymentOrder(env as any, drizzleOf(env), { paymentId, kind: 'refund' });

    // This is the bug a naive `status != 'paid'` CAS would reintroduce.
    const credit = await creditPaymentOrder(env as any, drizzleOf(env), {
      orderId, paymentId, source: 'webhook', capturedAmountPaise: 10000,
    });

    expect(credit.credited).toBe(false);
    expect(credit.reason).toBe('already');
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(0);
  });
});



// ===========================================================================
describe('requestWithdrawal', () => {
  const payoutOn = (extra: Record<string, any> = {}) => ({
    withdrawal: { enabled: true, minAmount: 100, conversionRate: 0.1, ...extra },
  });

  it('escrows coins, creates the row and writes the hold ledger atomically', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 500);
    await seedSettings(env, 'appConfig', payoutOn());

    const { status, body } = await call(env, 'alice', 'requestWithdrawal', {
      amount: 300, method: 'upi', accountDetails: 'alice@okhdfc',
    });

    expect(status).toBe(200);
    expect(body.cashAmount).toBe(30);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(200);

    const db = drizzleOf(env);
    const rows = await db.select().from(schema.withdrawals).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].reserved).toBe(true);
    expect(rows[0].accountDetails).toBe('alice@okhdfc');

    // The escrow debit must be ledgered — it used to be possible for the coins to
    // vanish with no withdrawal row and no ledger entry at all.
    const hold = await db.select().from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.type, 'withdrawal_hold')).all();
    expect(hold).toHaveLength(1);
    expect(Number(hold[0].amount)).toBe(-300);
  });

  it('rejects an amount larger than the balance without touching anything', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 150);
    await seedSettings(env, 'appConfig', payoutOn());

    const { status } = await call(env, 'alice', 'requestWithdrawal', {
      amount: 200, method: 'upi', accountDetails: 'alice@okhdfc',
    });

    expect(status).toBe(412);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(150);
    expect(await drizzleOf(env).select().from(schema.withdrawals).all()).toHaveLength(0);
    expect(await drizzleOf(env).select().from(schema.coinTransactions).all()).toHaveLength(0);
  });

  it('rejects a malformed payout destination before reserving coins', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 500);
    await seedSettings(env, 'appConfig', payoutOn());

    const upi = await call(env, 'alice', 'requestWithdrawal', {
      amount: 200, method: 'upi', accountDetails: 'not-a-upi-id',
    });
    expect(upi.status).toBe(400);

    const bank = await call(env, 'alice', 'requestWithdrawal', {
      amount: 200, method: 'bank', accountDetails: { accountNumber: '123', ifsc: 'nope', holderName: 'A' },
    });
    expect(bank.status).toBe(400);

    // Nothing reserved by either failed attempt.
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(500);
    expect(await drizzleOf(env).select().from(schema.withdrawals).all()).toHaveLength(0);
  });

  it('enforces min, max and the rolling 24h total', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 10_000);
    await seedSettings(env, 'appConfig', payoutOn({ minAmount: 100, maxAmount: 500, maxPerDay: 800 }));

    expect((await call(env, 'alice', 'requestWithdrawal', { amount: 50, method: 'upi', accountDetails: 'a@ok' })).status).toBe(412);
    expect((await call(env, 'alice', 'requestWithdrawal', { amount: 600, method: 'upi', accountDetails: 'a@ok' })).status).toBe(412);

    // 500 + 400 would exceed the 800/day cap; the whole balance can no longer
    // leave in a burst of individually-legal requests.
    expect((await call(env, 'alice', 'requestWithdrawal', { amount: 500, method: 'upi', accountDetails: 'a@ok' })).status).toBe(200);
    expect((await call(env, 'alice', 'requestWithdrawal', { amount: 400, method: 'upi', accountDetails: 'a@ok' })).status).toBe(412);
    expect((await call(env, 'alice', 'requestWithdrawal', { amount: 300, method: 'upi', accountDetails: 'a@ok' })).status).toBe(200);

    expect((await getUser(env, 'alice'))?.dpcoin).toBe(9_200);
  });

  it('refuses fractional and non-numeric amounts', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 500);
    await seedSettings(env, 'appConfig', payoutOn({ minAmount: 0 }));

    for (const amount of [100.5, 'abc', -100, 0, null, Infinity]) {
      const { status } = await call(env, 'alice', 'requestWithdrawal', {
        amount, method: 'upi', accountDetails: 'alice@okhdfc',
      });
      expect(status).toBe(400);
    }
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(500);
  });
});

// ===========================================================================
describe('claimDailyReward', () => {
  it('credits and ledgers in one transaction, once per UTC day', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);

    const first = await call(env, 'alice', 'claimDailyReward', {});
    expect(first.status).toBe(200);

    const second = await call(env, 'alice', 'claimDailyReward', {});
    expect(second.status).toBe(409);

    const db = drizzleOf(env);
    const ledger = await db.select().from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.type, 'daily_reward')).all();
    // Exactly one ledger row, and it reconciles with the balance.
    expect(ledger).toHaveLength(1);
    expect(Number(ledger[0].amount)).toBe(Number((await getUser(env, 'alice'))?.dpcoin));
  });
});
