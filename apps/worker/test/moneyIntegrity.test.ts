/**
 * Balance/ledger integrity.
 *
 * money.test.ts covers the happy paths of buying, spending and withdrawing.
 * This file covers the invariant underneath all of them, stated in the README as
 * "every balance change and its ledger row are written in one D1 transaction,
 * gated on the same claim token" — and specifically the places that used to break
 * it. Every `describe` below corresponds to a real defect, so these are
 * regression tests first and documentation second.
 */
import { vi, describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// Firebase Admin is only reachable from a deployed worker. Account deletion calls
// deleteAuthUser; nothing here asserts on it.
vi.mock('../src/lib/firebaseAdmin', () => ({
  deleteAuthUser: async () => undefined,
  updateAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  getUserByEmail: async () => null,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { getSettings } from '../src/lib/gamification';
import { refundRejectedWithdrawal } from '../src/lib/payouts';
import { reconcilePaymentOrders } from '../src/lib/coinOrders';
import { deleteOwnAccount } from '../src/lib/accountDeletion';

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

/** Call an /admin route with the shared server secret (treated as superadmin). */
async function admin(env: TestEnv, method: string, path: string, body?: any) {
  const res = await app.request(
    `/admin${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function seedUser(env: TestEnv, uid: string, dpcoin = 0, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function getUser(env: TestEnv, uid: string) {
  return drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();
}

async function ledger(env: TestEnv, uid: string) {
  return drizzleOf(env).select().from(schema.coinTransactions).where(eq(schema.coinTransactions.uid, uid)).all();
}

/** The ledger must always explain the balance. */
async function ledgerSum(env: TestEnv, uid: string) {
  return (await ledger(env, uid)).reduce((total, row: any) => total + Number(row.amount), 0);
}

async function seedContest(env: TestEnv, id: string, totalEntryFee: number, extra: Record<string, any> = {}) {
  await drizzleOf(env)
    .insert(schema.contests)
    .values({
      id, title: `Contest ${id}`, type: 'photo', status: 'live',
      totalEntryFee, rewardCoins: totalEntryFee, voteDurationDays: 1, autoCancelHours: 24,
      minVotes: 0, createdAt: Date.now(), ...extra,
    } as any);
}

async function seedWithdrawal(env: TestEnv, id: string, uid: string, amount: number, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.withdrawals)
    .values({
      id, userId: uid, amount, cashAmount: amount, method: 'upi',
      accountDetails: 'someone@upi', status: 'pending', reserved: true,
      createdAt: ts, updatedAt: ts, ...extra,
    } as any);
}

// ===========================================================================
describe('rejected withdrawal refunds exactly once', () => {
  // The balance UPDATE used to be unconditional while its ledger insert was
  // guarded by a deterministic id + onConflictDoNothing. A retry therefore
  // re-credited the coins while the ledger silently no-opped — a double refund
  // recorded as one. The reject path IS retryable: a failure in the accounting
  // step calls revertClaim() so an admin can try again.
  it('credits the balance and ledger once, and a second call moves nothing', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0); // coins already escrowed at request time
    await seedWithdrawal(env, 'w1', 'alice', 100);

    expect(await refundRejectedWithdrawal(env as any, 'w1', 'alice', 100, Date.now())).toBe(true);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(100);

    // The retry an admin would perform after a partial failure.
    expect(await refundRejectedWithdrawal(env as any, 'w1', 'alice', 100, Date.now())).toBe(false);

    expect((await getUser(env, 'alice'))?.dpcoin).toBe(100);
    const rows = await ledger(env, 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('withdrawal_refund:w1');
    expect(await ledgerSum(env, 'alice')).toBe(100);
  });

  it('does not refund a deleted account or leave an orphan ledger row', async () => {
    const { env } = makeEnv();
    // No users row at all — the account was already anonymised and its coins
    // forfeited, so there is nothing to refund to.
    expect(await refundRejectedWithdrawal(env as any, 'w1', 'ghost', 100, Date.now())).toBe(false);
    expect(await ledger(env, 'ghost')).toHaveLength(0);
  });

  it('refunds through the admin route and stays balanced', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedWithdrawal(env, 'w1', 'alice', 250);
    // The hold written when the request was made.
    await drizzleOf(env).insert(schema.coinTransactions).values({
      id: 'withdrawal_hold:w1', uid: 'alice', amount: -250, type: 'withdrawal_hold',
      description: 'hold', createdAt: Date.now(),
    } as any);

    const res = await admin(env, 'PATCH', '/withdrawals/w1', { action: 'reject', adminNote: 'bad details' });

    expect(res.status).toBe(200);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(250);
    // hold (-250) + refund (+250) = 0, and the balance moved from 0 to 250 only
    // because the hold had already taken it out.
    expect(await ledgerSum(env, 'alice')).toBe(0);
  });

  it('refunds a legacy (non-reserved) request rejected after approval', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedWithdrawal(env, 'w1', 'alice', 80, { reserved: false, status: 'approved' });

    const res = await admin(env, 'PATCH', '/withdrawals/w1', { action: 'reject' });

    expect(res.status).toBe(200);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(80);
    expect((await ledger(env, 'alice')).map((r: any) => r.id)).toEqual(['withdrawal_refund:w1']);
  });

  it('marking a reserved payout paid leaves the balance alone and closes the hold', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedWithdrawal(env, 'w1', 'alice', 60, { status: 'approved' });

    const res = await admin(env, 'PATCH', '/withdrawals/w1', { action: 'paid', payoutRef: 'UTR12345' });

    expect(res.status).toBe(200);
    // Coins left at request time; paying must not deduct a second time.
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(0);
    const ids = (await ledger(env, 'alice')).map((r: any) => r.id).sort();
    expect(ids).toEqual(['withdrawal_hold_release:w1', 'withdrawal_settled:w1']);
    // The pair is zero-sum: it explains the payout without moving the balance.
    expect(await ledgerSum(env, 'alice')).toBe(0);
  });
});

// ===========================================================================
describe('startMatch charges atomically', () => {
  it('writes the debit and its ledger row together', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    await seedContest(env, 'c1', 40); // 20 per player

    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'a.jpg', mediaType: 'photo', deviceId: 'd1',
    });

    expect(res.status).toBe(200);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(80);
    const rows = await ledger(env, 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('contest_entry_fee');
    expect(Number(rows[0].amount)).toBe(-20);
    // The ledger explains the balance change exactly.
    expect(await ledgerSum(env, 'alice')).toBe(-20);
    expect(rows[0].id).toBe(`contest_entry:${res.body.matchId}:alice`);
  });

  it('leaves absolutely nothing behind when the user cannot afford it', async () => {
    // The old shape deducted first and compensated in a `catch`. If that refund
    // failed the coins were gone, so the important assertion is that a rejected
    // attempt writes no balance change, no ledger row AND no match.
    const { env } = makeEnv();
    await seedUser(env, 'alice', 5);
    await seedContest(env, 'c1', 40);

    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'a.jpg', mediaType: 'photo', deviceId: 'd1',
    });

    expect(res.status).toBe(412);
    expect((await getUser(env, 'alice'))?.dpcoin).toBe(5);
    expect(await ledger(env, 'alice')).toHaveLength(0);
    expect(await drizzleOf(env).select().from(schema.contestMatches).all()).toHaveLength(0);
  });

  it('creates the match with the prize capped at the entry-fee pot', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    // A template promising more than two players fund would mint coins.
    await seedContest(env, 'c1', 40, { rewardCoins: 500 });

    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'a.jpg', mediaType: 'photo', deviceId: 'd1',
    });

    const match: any = await drizzleOf(env)
      .select().from(schema.contestMatches).where(eq(schema.contestMatches.id, res.body.matchId)).get();
    expect(Number(match.prizeCoins)).toBe(40); // pot, not the 500 advertised
    expect(match.status).toBe('waiting_for_opponent');
    expect(match.userA.uid).toBe('alice');
    expect(match.joinIdA).toBeTruthy();
  });

  it('stores an invite as a private match', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 100);
    await seedUser(env, 'bob', 100);
    await seedContest(env, 'c1', 40);

    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: 'a.jpg', mediaType: 'photo', deviceId: 'd1', invitedUid: 'bob',
    });

    const match: any = await drizzleOf(env)
      .select().from(schema.contestMatches).where(eq(schema.contestMatches.id, res.body.matchId)).get();
    expect(match.isPrivate).toBe(true);
    expect(match.invitedUid).toBe('bob');
  });
});

// ===========================================================================
describe('reward settings cannot corrupt a balance', () => {
  it('rejects a fractional or negative coin reward at the admin API', async () => {
    const { env } = makeEnv();

    // Coins are a whole-number currency; a fraction would break every balance
    // that claimed it.
    expect((await admin(env, 'POST', '/rewards', { dailyLoginReward: 10.5 })).status).toBe(400);
    // A negative "reward" would silently DEBIT users.
    expect((await admin(env, 'POST', '/rewards', { referralBonus: -50 })).status).toBe(400);
    expect((await admin(env, 'POST', '/rewards', { signupBonus: 'free' })).status).toBe(400);
    // Nothing was stored.
    expect(await drizzleOf(env).select().from(schema.settings).all()).toHaveLength(0);

    // A sane value is accepted.
    expect((await admin(env, 'POST', '/rewards', { dailyLoginReward: 25 })).status).toBe(200);
  });

  it('floors a fractional value that was stored before validation existed', async () => {
    const { env } = makeEnv();
    await drizzleOf(env).insert(schema.settings).values({
      id: 'gamification',
      data: { dailyLoginReward: 10.9, referralBonus: -5, xpThreshold: 0 } as any,
      updatedAt: Date.now(),
    } as any);

    const settings = await getSettings(env as any);

    expect(settings.dailyLoginReward).toBe(10); // floored, never rounded up
    expect(settings.referralBonus).toBe(50); // negative → back to the default
    expect(settings.xpThreshold).toBeGreaterThanOrEqual(1); // 0 would loop forever
  });

  it('pays a whole number of coins for a daily claim even from a bad setting', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await drizzleOf(env).insert(schema.settings).values({
      id: 'gamification', data: { dailyLoginReward: 7.9, dailyStreakBonus: 0 } as any, updatedAt: Date.now(),
    } as any);

    const res = await call(env, 'alice', 'claimDailyReward');

    expect(res.status).toBe(200);
    const balance = Number((await getUser(env, 'alice'))?.dpcoin);
    expect(Number.isInteger(balance)).toBe(true);
    expect(balance).toBe(7);
    expect(await ledgerSum(env, 'alice')).toBe(7);
  });
});

// ===========================================================================
describe('the signup bonus is ledgered with the balance that grants it', () => {
  /** The bonus amount comes from appConfig.rewardSettings, not the gamification row. */
  async function seedSignupBonus(env: TestEnv, signupBonus: number) {
    await drizzleOf(env).insert(schema.settings).values({
      id: 'appConfig', data: { rewardSettings: { signupBonus } } as any, updatedAt: Date.now(),
    } as any);
    await env.CACHE_KV.delete('settings:appConfig');
  }

  /** `createProfile` takes the uid from the verified token, so no Firebase user is needed. */
  const createProfile = (env: TestEnv, uid: string) =>
    app.request(
      '/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
        body: JSON.stringify({ action: 'createProfile', username: uid, fullName: uid }),
      },
      env,
      fakeCtx(),
    );

  it('writes the balance and exactly one ledger row', async () => {
    const { env } = makeEnv();
    await seedSignupBonus(env, 100);

    const res = await createProfile(env, 'newbie');
    expect(res.status).toBe(200);

    expect(Number((await getUser(env, 'newbie'))?.dpcoin)).toBe(100);
    const rows = await ledger(env, 'newbie');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('signup_bonus');
    expect(rows[0].id).toBe('signup_bonus:newbie');
    // The ledger explains the whole balance — nothing appeared from nowhere.
    expect(await ledgerSum(env, 'newbie')).toBe(100);
  });

  it('never re-grants or duplicates on a repeated signup', async () => {
    const { env } = makeEnv();
    await seedSignupBonus(env, 100);

    await createProfile(env, 'newbie');
    await createProfile(env, 'newbie');

    expect(Number((await getUser(env, 'newbie'))?.dpcoin)).toBe(100);
    expect(await ledger(env, 'newbie')).toHaveLength(1);
  });

  it('writes no ledger row when the bonus is switched off', async () => {
    const { env } = makeEnv();
    await seedSignupBonus(env, 0);

    await createProfile(env, 'newbie');

    expect(Number((await getUser(env, 'newbie'))?.dpcoin)).toBe(0);
    expect(await ledger(env, 'newbie')).toHaveLength(0);
  });
});

// ===========================================================================
describe('account deletion records the forfeiture in the ledger', () => {
  it('zeroes the balance and explains it with a matching debit', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 250);
    // Give the balance a provenance so the ledger starts consistent.
    await drizzleOf(env).insert(schema.coinTransactions).values({
      id: 'purchase:seed', uid: 'alice', amount: 250, type: 'purchase',
      description: 'seed', createdAt: Date.now(),
    } as any);

    const result = await deleteOwnAccount(env as any, 'alice', 'no longer needed');

    expect(result.forfeitedCoins).toBe(250);
    expect(Number((await getUser(env, 'alice'))?.dpcoin)).toBe(0);

    const rows = await ledger(env, 'alice');
    const forfeit: any = rows.find((r: any) => r.type === 'account_deletion_forfeit');
    expect(forfeit).toBeTruthy();
    expect(Number(forfeit.amount)).toBe(-250);
    expect(forfeit.id).toBe('account_deletion:alice');
    // Ledger still sums to the (now zero) balance.
    expect(await ledgerSum(env, 'alice')).toBe(0);
  });

  it('writes no forfeiture row when there was nothing to forfeit', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);

    await deleteOwnAccount(env as any, 'alice');

    expect((await ledger(env, 'alice')).filter((r: any) => r.type === 'account_deletion_forfeit')).toHaveLength(0);
  });
});

// ===========================================================================
describe('payment orders stranded at paid are recovered', () => {
  /** An order whose status CAS committed but whose credit batch never ran. */
  async function seedStrandedOrder(env: TestEnv, overrides: Record<string, any> = {}) {
    const old = Date.now() - 60 * 60 * 1000; // an hour ago, past the min age
    await drizzleOf(env).insert(schema.paymentOrders).values({
      orderId: 'order_stranded', userId: 'alice', coins: 120, bonusCoins: 20,
      amountPaise: 19900, status: 'paid', paymentId: 'pay_stranded',
      source: 'callback', reconcileAttempts: 0,
      createdAt: old, updatedAt: old, ...overrides,
    } as any);
  }

  it('credits the customer whose coins were lost, exactly once', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedStrandedOrder(env);
    // The gateway is never called for this phase — the captured payment id was
    // already recorded by the claim — but credentials gate the whole sweeper.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));

    const first = await reconcilePaymentOrders(env as any);

    expect(first.recovered).toBe(1);
    expect(first.coins).toBe(120);
    expect(Number((await getUser(env, 'alice'))?.dpcoin)).toBe(120);
    const rows = await ledger(env, 'alice');
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('purchase');
    expect(rows[0].id).toBe('purchase:pay_stranded');
    // The payments marker is now present, which is what makes it exactly-once.
    const payment: any = await drizzleOf(env)
      .select().from(schema.payments).where(eq(schema.payments.id, 'pay_stranded')).get();
    expect(Number(payment.coins)).toBe(120);
    expect(Number(payment.amountPaise)).toBe(19900);

    // Running the sweeper again must not credit a second time.
    const second = await reconcilePaymentOrders(env as any);
    expect(second.recovered).toBe(0);
    expect(Number((await getUser(env, 'alice'))?.dpcoin)).toBe(120);
    expect(await ledger(env, 'alice')).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('ignores a healthy paid order that was already credited', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 120);
    await seedStrandedOrder(env);
    // The payments row proves the credit batch applied.
    await drizzleOf(env).insert(schema.payments).values({
      id: 'pay_stranded', userId: 'alice', amount: 120, coins: 120,
      amountPaise: 19900, source: 'razorpay', status: 'success', createdAt: Date.now(),
    } as any);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));

    const summary = await reconcilePaymentOrders(env as any);

    expect(summary.recovered).toBe(0);
    expect(Number((await getUser(env, 'alice'))?.dpcoin)).toBe(120);
    expect(await ledger(env, 'alice')).toHaveLength(0);

    vi.unstubAllGlobals();
  });

  it('leaves a freshly claimed order alone', async () => {
    // Recovering immediately would race the credit batch that is probably still
    // in flight, so anything younger than the minimum age is skipped.
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);
    await seedStrandedOrder(env, { createdAt: Date.now(), updatedAt: Date.now() });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));

    const summary = await reconcilePaymentOrders(env as any);

    expect(summary.recovered).toBe(0);
    expect(Number((await getUser(env, 'alice'))?.dpcoin)).toBe(0);

    vi.unstubAllGlobals();
  });

  it('does nothing at all without gateway credentials', async () => {
    const { env } = makeEnv({ RAZORPAY_KEY_ID: '', RAZORPAY_KEY_SECRET: '' });
    await seedUser(env, 'alice', 0);
    await seedStrandedOrder(env);

    const summary = await reconcilePaymentOrders(env as any);

    expect(summary.recovered).toBe(0);
    expect(Number((await getUser(env, 'alice'))?.dpcoin)).toBe(0);
  });
});

// ===========================================================================
describe('no unledgered coin printer remains', () => {
  it('does not export awardReward from the gamification module', async () => {
    // It credited `dpcoin` with no ledger row, no idempotency and no amount
    // validation. It had no callers, so it was removed rather than repaired; this
    // test exists so it cannot quietly come back.
    const gamification: Record<string, unknown> = await import('../src/lib/gamification');
    expect('awardReward' in gamification).toBe(false);
  });

  it('keeps admin wallet adjustments balanced and replay-safe', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0);

    const first = await admin(env, 'POST', '/users/alice/wallet', { amount: 50, type: 'add' });
    expect(first.status).toBe(200);
    expect(Number((await getUser(env, 'alice'))?.dpcoin)).toBe(50);
    expect(await ledgerSum(env, 'alice')).toBe(50);

    // Subtracting more than the balance must fail loudly rather than clamp,
    // which is what used to desynchronise the ledger from the balance.
    const overdraw = await admin(env, 'POST', '/users/alice/wallet', { amount: 500, type: 'subtract' });
    expect(overdraw.status).toBe(412);
    expect(Number((await getUser(env, 'alice'))?.dpcoin)).toBe(50);
    expect(await ledgerSum(env, 'alice')).toBe(50);
  });
});
