/**
 * Referral program (lib/referralProgram.ts): apply → pending → qualify → rewarded,
 * two-sided, exactly once, with the fraud checks, caps, milestones, admin review,
 * expiry, and the user / admin / public read surfaces.
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

vi.mock('../src/lib/firebaseAdmin', () => ({
  lookupAuthUser: async (_env: unknown, uid: string) => ({ email: `${uid}@example.com`, emailVerified: false, phoneNumber: null }),
  revokeRefreshTokens: async () => undefined,
  deleteAuthUser: async () => undefined,
  updateAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  getUserByEmail: async () => null,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import {
  applyReferralCode,
  parseReferralConfig,
  qualifyReferral,
  reconcileReferrals,
  validateReferralPatch,
} from '../src/lib/referralProgram';

const app = makeApp();
const DAY = 24 * 60 * 60 * 1000;

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

async function read(env: TestEnv, uid: string | null, path: string) {
  const res = await app.request(`/read${path}`, { headers: uid ? { Authorization: `Bearer ${uid}` } : {} }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function seedProgram(env: TestEnv, referralProgram: Record<string, any>) {
  await drizzleOf(env).insert(schema.settings).values({ id: 'appConfig', data: { referralProgram } as any, updatedAt: Date.now() } as any);
  await env.CACHE_KV.delete('settings:appConfig');
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, dpcoin: 0, createdAt: ts, updatedAt: ts, ...extra } as any);
}

const coins = async (env: TestEnv, uid: string) =>
  Number((await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get())?.dpcoin);
const ledger = (env: TestEnv, uid: string) =>
  drizzleOf(env).select().from(schema.coinTransactions).where(eq(schema.coinTransactions.uid, uid)).all();
const referral = (env: TestEnv, referredUid: string) =>
  drizzleOf(env).select().from(schema.referrals).where(eq(schema.referrals.referredUid, referredUid)).get();

/** A referrer with code THREF1 and an invited user, under the given program. */
async function setup(program: Record<string, any> = {}) {
  const { env } = makeEnv();
  await seedProgram(env, { referrerReward: 30, refereeReward: 20, ...program });
  await seedUser(env, 'ref', { referralCode: 'THREF1', deviceId: 'dev-ref' });
  await seedUser(env, 'friend');
  return env;
}

// ===========================================================================
describe('applying a code', () => {
  it('creates a pending referral and pays nothing yet', async () => {
    const env = await setup();
    const res = await call(env, 'friend', 'applyReferralCode', { code: 'thref1', deviceId: 'dev-friend' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'applied', referralStatus: 'pending', qualifyAction: 'first_contest' });
    expect(await referral(env, 'friend')).toMatchObject({ status: 'pending', referrerUid: 'ref', code: 'THREF1', deviceId: 'dev-friend' });
    expect(await coins(env, 'friend')).toBe(0);
    expect(await coins(env, 'ref')).toBe(0);
    // A second code cannot replace the first.
    await seedUser(env, 'other', { referralCode: 'THOTHER' });
    expect((await call(env, 'friend', 'applyReferralCode', { code: 'THOTHER' })).body.status).toBe('already_referred');
    expect((await referral(env, 'friend'))?.referrerUid).toBe('ref');
  });

  it('refuses an unknown code, your own code, and a blocked referrer', async () => {
    const env = await setup();
    await seedUser(env, 'banned', { referralCode: 'THBAN', isBlocked: true });
    await drizzleOf(env).update(schema.users).set({ referralCode: 'THMINE' }).where(eq(schema.users.uid, 'friend'));
    expect((await call(env, 'friend', 'applyReferralCode', { code: 'NOPE99' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(env, 'friend', 'applyReferralCode', { code: 'THMINE' })).status).toBeGreaterThanOrEqual(400);
    expect((await call(env, 'friend', 'applyReferralCode', { code: 'THBAN' })).status).toBeGreaterThanOrEqual(400);
    expect(await drizzleOf(env).select().from(schema.referrals).all()).toHaveLength(0);
  });

  it('refuses an account older than the apply window', async () => {
    const env = await setup({ applyWindowDays: 3 });
    await seedUser(env, 'old', { createdAt: Date.now() - 4 * DAY });
    expect((await call(env, 'old', 'applyReferralCode', { code: 'THREF1' })).status).toBeGreaterThanOrEqual(400);
    expect(await referral(env, 'old')).toBeUndefined();
  });

  it('rejects the referrer\'s own device, and a device that already earned a referral', async () => {
    const env = await setup({ qualifyAction: 'signup' });
    const same = await call(env, 'friend', 'applyReferralCode', { code: 'THREF1', deviceId: 'dev-ref' });
    expect(same.status).toBeGreaterThanOrEqual(400);
    expect(await referral(env, 'friend')).toMatchObject({ status: 'rejected', rejectReason: 'same_device_as_referrer' });

    await seedUser(env, 'f2');
    await seedUser(env, 'f3');
    expect((await call(env, 'f2', 'applyReferralCode', { code: 'THREF1', deviceId: 'dev-x' })).status).toBe(200);
    expect((await call(env, 'f3', 'applyReferralCode', { code: 'THREF1', deviceId: 'dev-x' })).status).toBeGreaterThanOrEqual(400);
    expect(await referral(env, 'f3')).toMatchObject({ status: 'rejected', rejectReason: 'device_already_used' });
    // Only the genuine one was paid.
    expect(await coins(env, 'ref')).toBe(30);
    expect(await coins(env, 'friend')).toBe(0);
    expect(await coins(env, 'f3')).toBe(0);
  });

  it('is refused while the program is switched off', async () => {
    const env = await setup({ enabled: false });
    expect((await call(env, 'friend', 'applyReferralCode', { code: 'THREF1' })).status).toBeGreaterThanOrEqual(400);
  });
});

// ===========================================================================
describe('qualifying and paying', () => {
  it('first contest: pays both sides exactly once, ledgered, only on the right event', async () => {
    const env = await setup();
    await applyReferralCode(env as any, 'friend', 'THREF1');
    await qualifyReferral(env as any, 'friend', 'purchase');
    await qualifyReferral(env as any, 'friend', 'verified');
    expect((await referral(env, 'friend'))?.status).toBe('pending');

    await Promise.all([qualifyReferral(env as any, 'friend', 'contest'), qualifyReferral(env as any, 'friend', 'contest')]);
    await qualifyReferral(env as any, 'friend', 'contest');
    expect(await referral(env, 'friend')).toMatchObject({ status: 'rewarded', referrerReward: 30, refereeReward: 20 });
    expect(await coins(env, 'friend')).toBe(20);
    expect(await coins(env, 'ref')).toBe(30);
    expect((await ledger(env, 'friend')).map((r: any) => r.id)).toEqual(['referral_bonus:referred:friend']);
    expect((await ledger(env, 'ref')).map((r: any) => r.id)).toEqual(['referral_bonus:referrer:friend']);
  });

  it('first purchase', async () => {
    const env = await setup({ qualifyAction: 'first_purchase' });
    await applyReferralCode(env as any, 'friend', 'THREF1');
    await qualifyReferral(env as any, 'friend', 'contest');
    expect(await coins(env, 'friend')).toBe(0);
    await qualifyReferral(env as any, 'friend', 'purchase');
    expect(await coins(env, 'friend')).toBe(20);
  });

  it('verified needs BOTH email and mobile', async () => {
    const env = await setup({ qualifyAction: 'verified' });
    await applyReferralCode(env as any, 'friend', 'THREF1');
    await drizzleOf(env).update(schema.users).set({ emailVerified: true }).where(eq(schema.users.uid, 'friend'));
    await qualifyReferral(env as any, 'friend', 'verified');
    expect((await referral(env, 'friend'))?.status).toBe('pending');
    await drizzleOf(env).update(schema.users).set({ phoneVerified: true }).where(eq(schema.users.uid, 'friend'));
    await qualifyReferral(env as any, 'friend', 'verified');
    expect((await referral(env, 'friend'))?.status).toBe('rewarded');
    expect(await coins(env, 'ref')).toBe(30);
  });

  it('never pays an account the old instant referral already paid', async () => {
    const env = await setup({ qualifyAction: 'signup' });
    // A credit under the legacy claim keys already exists.
    await env.DB.prepare(
      `INSERT INTO coin_transactions (id, uid, type, amount, description, created_at) VALUES ('referral_bonus:referred:friend', 'friend', 'referral_bonus', 50, 'old', 1)`,
    ).run();
    await env.DB.prepare(`UPDATE users SET dpcoin = 50 WHERE uid = 'friend'`).run();
    await applyReferralCode(env as any, 'friend', 'THREF1');
    expect(await coins(env, 'friend')).toBe(50);
    expect(await ledger(env, 'friend')).toHaveLength(1);
  });

  it('a lifetime cap stops the referrer\'s share but still pays the friend', async () => {
    const env = await setup({ qualifyAction: 'signup', maxRewardedPerReferrer: 1 });
    await seedUser(env, 'f2');
    await applyReferralCode(env as any, 'friend', 'THREF1');
    await applyReferralCode(env as any, 'f2', 'THREF1');
    expect(await coins(env, 'ref')).toBe(30);
    expect(await coins(env, 'f2')).toBe(20);
    expect(await referral(env, 'f2')).toMatchObject({ status: 'rewarded', referrerReward: 0, rejectReason: 'referrer_lifetime_cap' });
  });

  it('a daily cap', async () => {
    const env = await setup({ qualifyAction: 'signup', maxRewardedPerReferrerPerDay: 1 });
    await seedUser(env, 'f2');
    await applyReferralCode(env as any, 'friend', 'THREF1');
    await applyReferralCode(env as any, 'f2', 'THREF1');
    expect(await coins(env, 'ref')).toBe(30);
    expect((await referral(env, 'f2'))?.rejectReason).toBe('referrer_daily_cap');
  });

  it('milestones pay the referrer once per tier', async () => {
    const env = await setup({ qualifyAction: 'signup', milestones: [{ count: 2, bonus: 100 }, { count: 5, bonus: 500 }] });
    await seedUser(env, 'f2');
    await seedUser(env, 'f3');
    await applyReferralCode(env as any, 'friend', 'THREF1');
    expect(await coins(env, 'ref')).toBe(30);
    await applyReferralCode(env as any, 'f2', 'THREF1');
    expect(await coins(env, 'ref')).toBe(30 + 30 + 100);
    await applyReferralCode(env as any, 'f3', 'THREF1');
    expect(await coins(env, 'ref')).toBe(30 * 3 + 100);
    expect((await ledger(env, 'ref')).filter((r: any) => String(r.id).startsWith('referral_milestone:'))).toHaveLength(1);
  });
});

// ===========================================================================
describe('admin review', () => {
  it('requireReview holds a qualified referral until an admin approves it', async () => {
    const env = await setup({ qualifyAction: 'signup', requireReview: true });
    await applyReferralCode(env as any, 'friend', 'THREF1');
    const row = await referral(env, 'friend');
    expect(row?.status).toBe('review');
    expect(await coins(env, 'friend')).toBe(0);

    const ok = await admin(env, 'PATCH', `/referrals/${row!.id}`, { action: 'approve' });
    expect(ok.status).toBe(200);
    expect(await referral(env, 'friend')).toMatchObject({ status: 'rewarded' });
    expect(await coins(env, 'friend')).toBe(20);
    expect(await coins(env, 'ref')).toBe(30);
    // Deciding again is refused and pays nothing more.
    expect((await admin(env, 'PATCH', `/referrals/${row!.id}`, { action: 'approve' })).status).toBeGreaterThanOrEqual(400);
    expect((await admin(env, 'PATCH', `/referrals/${row!.id}`, { action: 'reject' })).status).toBeGreaterThanOrEqual(400);
    expect(await coins(env, 'ref')).toBe(30);
    const audit = await drizzleOf(env).select().from(schema.adminAuditLog).all();
    expect(audit.some((a: any) => a.action === 'referral.approve')).toBe(true);
  });

  it('a rejected referral never pays, even if the friend qualifies later', async () => {
    const env = await setup();
    await applyReferralCode(env as any, 'friend', 'THREF1');
    const row = await referral(env, 'friend');
    expect((await admin(env, 'PATCH', `/referrals/${row!.id}`, { action: 'reject', reason: 'fake account' })).status).toBe(200);
    await qualifyReferral(env as any, 'friend', 'contest');
    expect(await referral(env, 'friend')).toMatchObject({ status: 'rejected', rejectReason: 'fake account' });
    expect(await coins(env, 'friend')).toBe(0);
    expect(await coins(env, 'ref')).toBe(0);
  });

  it('the admin list filters and reports stats', async () => {
    const env = await setup({ qualifyAction: 'signup' });
    await seedUser(env, 'f2');
    await applyReferralCode(env as any, 'friend', 'THREF1');
    // Switch to the default qualifying action, so the second referral stays pending.
    await env.DB.prepare(`UPDATE settings SET data = ? WHERE id = 'appConfig'`).bind(JSON.stringify({ referralProgram: { referrerReward: 30, refereeReward: 20 } })).run();
    await applyReferralCode(env as any, 'f2', 'THREF1');

    const all = await admin(env, 'GET', '/referrals');
    expect(all.status).toBe(200);
    expect(all.body.rows).toHaveLength(2);
    expect(all.body.stats.byStatus).toMatchObject({ rewarded: 1, pending: 1 });
    expect(all.body.stats.coinsPaid).toBe(50);
    expect(all.body.topReferrers[0]).toMatchObject({ uid: 'ref', rewarded: 1 });
    const pending = await admin(env, 'GET', '/referrals?status=pending');
    expect(pending.body.rows.map((r: any) => r.referredUid)).toEqual(['f2']);
    const q = await admin(env, 'GET', '/referrals?q=fri');
    expect(q.body.rows.map((r: any) => r.referredUid)).toEqual(['friend']);
  });
});

// ===========================================================================
describe('expiry', () => {
  it('an unqualified referral expires and can no longer pay', async () => {
    const env = await setup({ qualifyWindowDays: 1 });
    await applyReferralCode(env as any, 'friend', 'THREF1');
    expect((await reconcileReferrals(env as any)).expired).toBe(0);
    expect((await reconcileReferrals(env as any, Date.now() + 2 * DAY)).expired).toBe(1);
    await qualifyReferral(env as any, 'friend', 'contest');
    expect((await referral(env, 'friend'))?.status).toBe('expired');
    expect(await coins(env, 'friend')).toBe(0);
  });

  it('qualifying after the window (before the cron ran) expires instead of paying', async () => {
    const env = await setup({ qualifyWindowDays: 1 });
    await applyReferralCode(env as any, 'friend', 'THREF1');
    await qualifyReferral(env as any, 'friend', 'contest', { nowMs: Date.now() + 2 * DAY });
    expect((await referral(env, 'friend'))?.status).toBe('expired');
    expect(await coins(env, 'ref')).toBe(0);
  });

  it('the cron finishes a payout interrupted after the claim', async () => {
    const env = await setup();
    await applyReferralCode(env as any, 'friend', 'THREF1');
    // Simulate a crash between the claim and the credit.
    await env.DB.prepare(`UPDATE referrals SET qualified_at = ? WHERE referred_uid = 'friend'`).bind(Date.now() - 10 * 60 * 1000).run();
    expect((await reconcileReferrals(env as any)).paid).toBe(1);
    expect((await referral(env, 'friend'))?.status).toBe('rewarded');
    expect(await coins(env, 'friend')).toBe(20);
  });
});

// ===========================================================================
describe('read surfaces', () => {
  it('/read/me/referrals: code, link, stats, friends, and who referred me', async () => {
    const env = await setup({ qualifyAction: 'signup' });
    await applyReferralCode(env as any, 'friend', 'THREF1');

    const mine = await read(env, 'ref', '/me/referrals');
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      code: 'THREF1',
      link: 'https://tophunt.in/invite/THREF1',
      stats: { invited: 1, successful: 1, pending: 0, earned: 30 },
      program: { referrerReward: 30, refereeReward: 20, qualifyAction: 'signup' },
    });
    expect(mine.body.referrals[0]).toMatchObject({ username: 'friend', status: 'rewarded', reward: 30 });
    expect(mine.body.referrals[0].deviceId).toBeUndefined();

    const theirs = await read(env, 'friend', '/me/referrals');
    expect(theirs.body.referredBy).toMatchObject({ status: 'rewarded', reward: 20 });
    expect(theirs.body.canApply).toBe(false);
    expect(theirs.body.code).toMatch(/^TH[A-Z0-9]{6}$/);

    expect((await read(env, null, '/me/referrals')).status).toBe(401);
  });

  it('public app config carries the program, not its fraud settings', async () => {
    const env = await setup({ maxRewardedPerReferrerPerDay: 3, requireReview: true });
    const res = await read(env, null, '/app-config');
    expect(res.body.referral).toMatchObject({ enabled: true, referrerReward: 30, refereeReward: 20, qualifyAction: 'first_contest' });
    expect(res.body.referral.maxRewardedPerReferrerPerDay).toBeUndefined();
    expect(res.body.referral.requireReview).toBeUndefined();
  });
});

// ===========================================================================
describe('admin configuration', () => {
  it('validates the program patch', () => {
    for (const bad of [
      { referrerReward: -1 },
      { refereeReward: 1.5 },
      { qualifyAction: 'install' },
      { qualifyWindowDays: 0 },
      { applyWindowDays: 91 },
      { enabled: 'yes' },
      { milestones: [{ count: 0, bonus: 10 }] },
      { milestones: [{ count: 3, bonus: 10 }, { count: 3, bonus: 20 }] },
    ]) {
      expect(() => validateReferralPatch({ ...bad }), JSON.stringify(bad)).toThrow();
    }
    const ok: any = { referrerReward: '25', milestones: [{ count: 10, bonus: 200 }, { count: 3, bonus: 50 }] };
    validateReferralPatch(ok);
    expect(ok.referrerReward).toBe(25);
    expect(ok.milestones.map((m: any) => m.count)).toEqual([3, 10]);
  });

  it('is saved through app settings and audited; a bad patch stores nothing', async () => {
    const { env } = makeEnv();
    expect((await admin(env, 'POST', '/app-settings', { referralProgram: { qualifyAction: 'install' } })).status).toBe(400);
    expect(await drizzleOf(env).select().from(schema.settings).all()).toHaveLength(0);
    const ok = await admin(env, 'POST', '/app-settings', { referralProgram: { referrerReward: 75, refereeReward: 25, qualifyAction: 'verified' } });
    expect(ok.status).toBe(200);
    const row = await drizzleOf(env).select().from(schema.settings).where(eq(schema.settings.id, 'appConfig')).get();
    expect(parseReferralConfig(row?.data)).toMatchObject({ referrerReward: 75, refereeReward: 25, qualifyAction: 'verified' });
  });

  it('parsing: legacy referralBonus seeds the rewards until the program sets them', () => {
    expect(parseReferralConfig({})).toMatchObject({ referrerReward: 50, refereeReward: 50, qualifyAction: 'first_contest' });
    expect(parseReferralConfig({ rewardSettings: { referralBonus: 10 } })).toMatchObject({ referrerReward: 10, refereeReward: 10 });
    expect(parseReferralConfig({ rewardSettings: { referralBonus: 10 }, referralProgram: { refereeReward: 5 } })).toMatchObject({
      referrerReward: 10,
      refereeReward: 5,
    });
    expect(parseReferralConfig({ referralProgram: { referrerReward: -3, qualifyAction: 'x' } })).toMatchObject({
      referrerReward: 50,
      qualifyAction: 'first_contest',
    });
  });
});
