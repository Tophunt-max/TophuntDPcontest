/**
 * Daily check-in, daily tasks and Refer & Earn hardening:
 *  - the check-in track the app shows is the one the server pays, with an
 *    admin switch, fixed schedule and day-reset time;
 *  - daily tasks: enable / window, distinct-battle shares, contest entries;
 *  - referrals: caps and the monthly budget hold under concurrency, a banned
 *    friend is never paid, a missing device goes to review, minimum purchase,
 *    reversal (clawback), bulk decisions, linked accounts;
 *  - admin reads and the streak fix.
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
  dailyRewardFor,
  dailyRewardState,
  getSettings,
  rewardDayNumber,
  rewardDayStart,
  validateGamificationCoinLists,
} from '../src/lib/gamification';
import {
  applyReferralCode,
  publicReferralConfig,
  parseReferralConfig,
  qualifyReferral,
  reconcileReferrals,
} from '../src/lib/referralProgram';

const app = makeApp();
const DAY = 24 * 60 * 60 * 1000;

/** shareContest bumps the battle's share counter on the VOTE_COUNTER actor. */
const fakeVoteCounter = () => ({
  idFromName: (n: string) => n,
  get: () => ({ engagement: async () => ({ share: 1 }) }),
});
const env0 = () => makeEnv({ VOTE_COUNTER: fakeVoteCounter() } as any);

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

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, dpcoin: 0, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function seedGamification(env: TestEnv, data: Record<string, any>) {
  await drizzleOf(env).insert(schema.settings).values({ id: 'gamification', data: data as any, updatedAt: Date.now() } as any);
  await env.CACHE_KV.delete('settings:gamification');
}

async function seedProgram(env: TestEnv, referralProgram: Record<string, any>) {
  await drizzleOf(env).insert(schema.settings).values({ id: 'appConfig', data: { referralProgram } as any, updatedAt: Date.now() } as any);
  await env.CACHE_KV.delete('settings:appConfig');
}

async function seedMatch(env: TestEnv, id: string, uidA: string, uidB: string) {
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
      expiresAt: ts + DAY,
    } as any);
}

const userRow = (env: TestEnv, uid: string) => drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();
const coins = async (env: TestEnv, uid: string) => Number((await userRow(env, uid))?.dpcoin);
const referral = (env: TestEnv, referredUid: string) =>
  drizzleOf(env).select().from(schema.referrals).where(eq(schema.referrals.referredUid, referredUid)).get();

// ===========================================================================
describe('daily check-in', () => {
  it('the track shows exactly what the claim pays (formula)', async () => {
    const { env } = env0();
    await seedGamification(env, { dailyLoginReward: 10, dailyStreakBonus: 2 });
    await seedUser(env, 'u1');
    const before = await call(env, 'u1', 'getDailyReward');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ enabled: true, claimedToday: false, streak: 0, todayStreakDay: 1, todayReward: 12 });
    expect(before.body.track.map((d: any) => d.amount)).toEqual([12, 14, 16, 18, 20, 22, 24]);
    expect(before.body.track[0].status).toBe('ready');

    const claim = await call(env, 'u1', 'claimDailyReward');
    expect(claim.body.coinsEarned).toBe(before.body.todayReward);
    const after = await call(env, 'u1', 'getDailyReward');
    expect(after.body).toMatchObject({ claimedToday: true, streak: 1 });
    expect(after.body.track[0].status).toBe('claimed');
    expect(after.body.track[1].status).toBe('upcoming');
  });

  it('a fixed schedule replaces the formula and repeats', async () => {
    const { env } = env0();
    await seedGamification(env, { dailyRewardSchedule: [5, 10, 50] });
    const s = await getSettings(env as any);
    expect([1, 2, 3, 4, 5].map((d) => dailyRewardFor(s, d))).toEqual([5, 10, 50, 5, 10]);
    // Day 9 of a streak sits on the second week of the track.
    const st = dailyRewardState(s, { streak: 8, lastDailyClaim: Date.now() - DAY }, Date.now());
    expect(st.todayStreakDay).toBe(9);
    expect(st.track.map((d) => d.day)).toEqual([8, 9, 10, 11, 12, 13, 14]);
    expect(st.todayReward).toBe(50);
    await seedUser(env, 'u1', { streak: 8, lastDailyClaim: rewardDayStart(Date.now(), 0) - 1000 });
    expect((await call(env, 'u1', 'claimDailyReward')).body).toMatchObject({ coinsEarned: 50, streak: 9 });
  });

  it('a broken streak shows 0 and restarts at day 1', () => {
    const st = dailyRewardState(
      { dailyLoginReward: 10, dailyStreakBonus: 2, dailyRewardSchedule: [], dayResetOffsetMinutes: 0, dailyLoginEnabled: true } as any,
      { streak: 20, lastDailyClaim: Date.now() - 3 * DAY },
      Date.now(),
    );
    expect(st).toMatchObject({ streak: 0, todayStreakDay: 1, todayReward: 12 });
  });

  it('can be switched off', async () => {
    const { env } = env0();
    await seedGamification(env, { dailyLoginEnabled: false });
    await seedUser(env, 'u1');
    expect((await call(env, 'u1', 'getDailyReward')).body.enabled).toBe(false);
    expect((await call(env, 'u1', 'claimDailyReward')).status).toBeGreaterThanOrEqual(400);
    expect(await coins(env, 'u1')).toBe(0);
  });

  it('the day starts at the admin reset time (IST)', () => {
    // 2026-10-27 19:00 UTC is 00:30 IST on the 28th.
    const t = Date.UTC(2026, 9, 27, 19, 0);
    expect(rewardDayStart(t, 0)).toBe(Date.UTC(2026, 9, 27));
    expect(rewardDayStart(t, 330)).toBe(Date.UTC(2026, 9, 27, 18, 30));
    expect(rewardDayNumber(t, 330)).toBe(rewardDayNumber(t, 0) + 1);
    // An out-of-range offset falls back to UTC.
    expect(rewardDayStart(t, 99999)).toBe(Date.UTC(2026, 9, 27));
  });

  it('validates the new settings', () => {
    for (const bad of [
      { dailyLoginEnabled: 'yes' },
      { dailyRewardSchedule: [1, -2] },
      { dailyRewardSchedule: Array(31).fill(1) },
      { dayResetOffsetMinutes: 1000 },
      { dayResetOffsetMinutes: 1.5 },
      { dailyTasks: [{ id: 'aa', title: 'x', reward: 1, target: 1, type: 'contest', enabled: 'no' }] },
      { dailyTasks: [{ id: 'aa', title: 'x', reward: 1, target: 1, type: 'contest', startsAt: 2000, endsAt: 1000 }] },
    ]) {
      expect(() => validateGamificationCoinLists(bad), JSON.stringify(bad)).toThrow();
    }
    expect(() =>
      validateGamificationCoinLists({ dailyRewardSchedule: [], dayResetOffsetMinutes: 330, dailyTasks: [{ id: 'c1', title: 'Join', reward: 5, target: 1, type: 'contest', enabled: false, startsAt: null, endsAt: null }] }),
    ).not.toThrow();
  });
});

// ===========================================================================
describe('daily tasks', () => {
  it('a disabled task or one outside its window is hidden and cannot be claimed', async () => {
    const { env } = env0();
    const ts = Date.now();
    await seedGamification(env, {
      dailyTasks: [
        { id: 'on', title: 'On', reward: 5, target: 1, type: 'share' },
        { id: 'off', title: 'Off', reward: 5, target: 1, type: 'share', enabled: false },
        { id: 'later', title: 'Later', reward: 5, target: 1, type: 'share', startsAt: ts + DAY },
        { id: 'over', title: 'Over', reward: 5, target: 1, type: 'share', endsAt: ts - 1000 },
      ],
    });
    await seedUser(env, 'u1');
    await seedUser(env, 'a');
    await seedUser(env, 'b');
    await seedMatch(env, 'm1', 'a', 'b');
    const shared = await call(env, 'u1', 'shareContest', { matchId: 'm1' });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect((await call(env, 'u1', 'getDailyTasks')).body.tasks.map((t: any) => t.id)).toEqual(['on']);
    expect((await call(env, 'u1', 'claimDailyTask', { taskId: 'off' })).status).toBe(404);
    expect((await call(env, 'u1', 'claimDailyTask', { taskId: 'later' })).status).toBe(404);
    expect((await call(env, 'u1', 'claimDailyTask', { taskId: 'on' })).status).toBe(200);
    expect(await coins(env, 'u1')).toBe(5);
  });

  it('sharing the same battle again does not count, a different battle does', async () => {
    const { env } = env0();
    await seedGamification(env, { dailyTasks: [{ id: 'share2', title: 'Share 2 battles', reward: 10, target: 2, type: 'share' }] });
    await seedUser(env, 'u1');
    await seedUser(env, 'a');
    await seedUser(env, 'b');
    await seedMatch(env, 'm1', 'a', 'b');
    await seedMatch(env, 'm2', 'a', 'b');
    for (let i = 0; i < 5; i++) await call(env, 'u1', 'shareContest', { matchId: 'm1' });
    expect(await drizzleOf(env).select().from(schema.shares).all()).toHaveLength(1);
    let t = (await call(env, 'u1', 'getDailyTasks')).body.tasks[0];
    expect(t).toMatchObject({ progress: 1, claimable: false });
    expect((await call(env, 'u1', 'claimDailyTask', { taskId: 'share2' })).status).toBeGreaterThanOrEqual(400);
    await call(env, 'u1', 'shareContest', { matchId: 'm2' });
    t = (await call(env, 'u1', 'getDailyTasks')).body.tasks[0];
    expect(t).toMatchObject({ progress: 2, claimable: true });
  });

  it('a contest task counts today\'s contest entries', async () => {
    const { env } = env0();
    await seedGamification(env, { dailyTasks: [{ id: 'join1', title: 'Join a contest', reward: 8, target: 1, type: 'contest' }] });
    await seedUser(env, 'u1');
    expect((await call(env, 'u1', 'claimDailyTask', { taskId: 'join1' })).status).toBeGreaterThanOrEqual(400);
    await env.DB.prepare(
      `INSERT INTO coin_transactions (id, uid, amount, type, description, created_at, locked_delta) VALUES ('e1', 'u1', -20, 'contest_entry_fee', 'Entry', ?, -20)`,
    )
      .bind(Date.now())
      .run();
    expect((await call(env, 'u1', 'getDailyTasks')).body.tasks[0]).toMatchObject({ progress: 1, claimable: true });
    expect((await call(env, 'u1', 'claimDailyTask', { taskId: 'join1' })).body).toMatchObject({ success: true, reward: 8 });
  });
});

// ===========================================================================
/** An inviter with code THREF1 under the given program. */
async function referralSetup(program: Record<string, any> = {}) {
  const { env } = env0();
  await seedProgram(env, { referrerReward: 30, refereeReward: 20, ...program });
  await seedUser(env, 'ref', { referralCode: 'THREF1', deviceId: 'dev-ref' });
  return env;
}
async function invite(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  await seedUser(env, uid, extra);
  await applyReferralCode(env as any, uid, 'THREF1', { deviceId: `dev-${uid}` });
}

describe('referral caps and budget', () => {
  it('the daily cap holds when several friends qualify at the same moment', async () => {
    const env = await referralSetup({ maxRewardedPerReferrerPerDay: 1 });
    for (const f of ['f1', 'f2', 'f3', 'f4']) await invite(env, f);
    await Promise.all(['f1', 'f2', 'f3', 'f4'].map((f) => qualifyReferral(env as any, f, 'contest')));
    // The inviter is paid exactly once; every friend is paid.
    expect(await coins(env, 'ref')).toBe(30);
    for (const f of ['f1', 'f2', 'f3', 'f4']) expect(await coins(env, f)).toBe(20);
    const rows = await drizzleOf(env).select().from(schema.referrals).all();
    expect(rows.filter((r: any) => r.referrerReward > 0)).toHaveLength(1);
    expect(rows.filter((r: any) => r.rejectReason === 'referrer_daily_cap')).toHaveLength(3);
  });

  it('the lifetime cap holds under concurrency too', async () => {
    const env = await referralSetup({ maxRewardedPerReferrer: 2 });
    for (const f of ['f1', 'f2', 'f3', 'f4', 'f5']) await invite(env, f);
    await Promise.all(['f1', 'f2', 'f3', 'f4', 'f5'].map((f) => qualifyReferral(env as any, f, 'contest')));
    expect(await coins(env, 'ref')).toBe(60);
  });

  it('the monthly budget holds referrals in review; the cron pays them when there is room', async () => {
    const env = await referralSetup({ maxCoinsPerMonth: 50 });
    await invite(env, 'f1');
    await invite(env, 'f2');
    await Promise.all([qualifyReferral(env as any, 'f1', 'contest'), qualifyReferral(env as any, 'f2', 'contest')]);
    const rows = await drizzleOf(env).select().from(schema.referrals).all();
    expect(rows.filter((r: any) => r.status === 'rewarded')).toHaveLength(1);
    const held = rows.find((r: any) => r.status === 'review')!;
    expect(held).toMatchObject({ holdReason: 'monthly_budget' });
    expect(await coins(env, 'ref')).toBe(30);
    // An admin cannot pay past the budget.
    expect((await admin(env, 'PATCH', `/referrals/${held.id}`, { action: 'approve' })).status).toBeGreaterThanOrEqual(400);
    // Next month the cron pays it.
    const nextMonth = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 2);
    expect((await reconcileReferrals(env as any, nextMonth)).paid).toBe(1);
    expect(await coins(env, 'ref')).toBe(60);
    expect((await admin(env, 'GET', '/referrals')).body.stats.paidThisMonth).toBeGreaterThanOrEqual(50);
  });

  it('a credit lost after the flip is repaired by the cron', async () => {
    const env = await referralSetup();
    await invite(env, 'f1');
    await qualifyReferral(env as any, 'f1', 'contest');
    // Simulate a crash after the flip: the friend's credit never landed.
    await env.DB.prepare(`DELETE FROM coin_transactions WHERE id = 'referral_bonus:referred:f1'`).run();
    await env.DB.prepare(`DELETE FROM idempotency_keys WHERE key = 'referral_bonus:referred:f1'`).run();
    await env.DB.prepare(`UPDATE users SET dpcoin = 0, locked_coins = 0 WHERE uid = 'f1'`).run();
    await env.DB.prepare(`UPDATE referrals SET rewarded_at = ? WHERE referred_uid = 'f1'`).bind(Date.now() - 10 * 60 * 1000).run();
    expect((await reconcileReferrals(env as any)).repaired).toBe(1);
    expect(await coins(env, 'f1')).toBe(20);
    expect((await reconcileReferrals(env as any)).repaired).toBe(0);
    expect(await coins(env, 'f1')).toBe(20);
  });
});

describe('referral fraud checks', () => {
  it('a friend blocked before qualifying is rejected and nobody is paid', async () => {
    const env = await referralSetup();
    await invite(env, 'f1');
    await env.DB.prepare(`UPDATE users SET is_blocked = 1 WHERE uid = 'f1'`).run();
    await qualifyReferral(env as any, 'f1', 'contest');
    expect(await referral(env, 'f1')).toMatchObject({ status: 'rejected', rejectReason: 'referred_unavailable' });
    expect(await coins(env, 'f1')).toBe(0);
    expect(await coins(env, 'ref')).toBe(0);
  });

  it('a code applied without a device id waits for review', async () => {
    const env = await referralSetup();
    await seedUser(env, 'f1');
    await applyReferralCode(env as any, 'f1', 'THREF1');
    expect((await referral(env, 'f1'))?.holdReason).toBe('no_device');
    await qualifyReferral(env as any, 'f1', 'contest');
    expect((await referral(env, 'f1'))?.status).toBe('review');
    expect(await coins(env, 'ref')).toBe(0);
  });

  it('first purchase: a purchase below the minimum does not qualify, a later one does', async () => {
    const env = await referralSetup({ qualifyAction: 'first_purchase', minPurchaseInr: 100 });
    await invite(env, 'f1');
    await qualifyReferral(env as any, 'f1', 'purchase', { amountInr: 49 });
    await qualifyReferral(env as any, 'f1', 'purchase');
    expect((await referral(env, 'f1'))?.status).toBe('pending');
    await qualifyReferral(env as any, 'f1', 'purchase', { amountInr: 100 });
    expect((await referral(env, 'f1'))?.status).toBe('rewarded');
  });

  it('validates the new program fields', async () => {
    const env = await referralSetup();
    expect((await admin(env, 'POST', '/app-settings', { referralProgram: { maxCoinsPerMonth: -1 } })).status).toBe(400);
    expect((await admin(env, 'POST', '/app-settings', { referralProgram: { minPurchaseInr: 1.5 } })).status).toBe(400);
    expect((await admin(env, 'POST', '/app-settings', { referralProgram: { maxCoinsPerMonth: 5000, minPurchaseInr: 99 } })).status).toBe(200);
  });

  it('the app is told whether rewards are Diamond or DP coin', () => {
    const cfg = parseReferralConfig({});
    expect(publicReferralConfig(cfg, {}).rewardUnit).toBe('Diamond');
    expect(publicReferralConfig(cfg, { rewardLocking: { referral: false } }).rewardUnit).toBe('DP coin');
  });
});

describe('referral admin tools', () => {
  it('reverse takes back what is left, once, and is audited', async () => {
    const env = await referralSetup();
    await invite(env, 'f1');
    await qualifyReferral(env as any, 'f1', 'contest');
    // The friend already spent 15 of their 20 Diamonds.
    await env.DB.prepare(`UPDATE users SET dpcoin = 5, locked_coins = 5 WHERE uid = 'f1'`).run();
    const row = await referral(env, 'f1');
    expect((await admin(env, 'PATCH', `/referrals/${row!.id}`, { action: 'reverse' })).status).toBe(400); // reason required
    const res = await admin(env, 'PATCH', `/referrals/${row!.id}`, { action: 'reverse', reason: 'fake account' });
    expect(res.status).toBe(200);
    expect(res.body.sides).toEqual([
      { uid: 'f1', credited: 20, taken: 5, unit: 'Diamond' },
      { uid: 'ref', credited: 30, taken: 30, unit: 'Diamond' },
    ]);
    expect(await referral(env, 'f1')).toMatchObject({ status: 'reversed', rejectReason: 'fake account' });
    expect(await coins(env, 'f1')).toBe(0);
    expect(await coins(env, 'ref')).toBe(0);
    expect((await admin(env, 'PATCH', `/referrals/${row!.id}`, { action: 'reverse', reason: 'again' })).status).toBeGreaterThanOrEqual(400);
    const audit = await drizzleOf(env).select().from(schema.adminAuditLog).all();
    expect(audit.some((a: any) => a.action === 'referral.reverse')).toBe(true);
    // The device stays used: a new account on it cannot earn a referral.
    await seedUser(env, 'f2');
    await expect(applyReferralCode(env as any, 'f2', 'THREF1', { deviceId: 'dev-f1' })).rejects.toThrow();
  });

  it('bulk approve and reject', async () => {
    const env = await referralSetup({ requireReview: true, qualifyAction: 'signup' });
    for (const f of ['f1', 'f2', 'f3']) await invite(env, f);
    const ids = (await drizzleOf(env).select().from(schema.referrals).all()).map((r: any) => r.id);
    const res = await admin(env, 'POST', '/referrals/bulk', { ids: ids.slice(0, 2), action: 'approve' });
    expect(res.status).toBe(200);
    expect(res.body.results.every((r: any) => r.ok && r.status === 'rewarded')).toBe(true);
    const rej = await admin(env, 'POST', '/referrals/bulk', { ids: [ids[2], 'missing'], action: 'reject', reason: 'farm' });
    expect(rej.body.results).toMatchObject([{ ok: true, status: 'rejected' }, { ok: false }]);
    expect(await coins(env, 'ref')).toBe(60);
    expect((await admin(env, 'POST', '/referrals/bulk', { ids: [], action: 'approve' })).status).toBe(400);
  });

  it('linked accounts by device and IP', async () => {
    const env = await referralSetup();
    await seedUser(env, 'f1', { deviceId: 'shared-dev' });
    await seedUser(env, 'alt', { deviceId: 'shared-dev' });
    await applyReferralCode(env as any, 'f1', 'THREF1', { deviceId: 'shared-dev', ip: '1.2.3.4' });
    await seedUser(env, 'f2');
    await applyReferralCode(env as any, 'f2', 'THREF1', { deviceId: 'dev-f2', ip: '1.2.3.4' });
    const row = await referral(env, 'f1');
    const res = await admin(env, 'GET', `/referrals/${row!.id}/links`);
    expect(res.status).toBe(200);
    expect(res.body.sameDevice.map((u: any) => u.uid)).toEqual(['alt']);
    expect(res.body.sameIp.map((r: any) => r.uid)).toEqual(['f2']);
    expect(res.body.inviterIps[0]).toMatchObject({ ip: '1.2.3.4', n: 2 });
  });
});

// ===========================================================================
describe('admin: check-in and task reads, streak fix', () => {
  it('stats per day and a user\'s reward history', async () => {
    const { env } = env0();
    await seedGamification(env, { dailyTasks: [{ id: 'share1', title: 'Share', reward: 7, target: 1, type: 'share' }] });
    await seedUser(env, 'u1');
    await seedUser(env, 'a');
    await seedUser(env, 'b');
    await seedMatch(env, 'm1', 'a', 'b');
    await call(env, 'u1', 'claimDailyReward');
    await call(env, 'u1', 'shareContest', { matchId: 'm1' });
    await call(env, 'u1', 'claimDailyTask', { taskId: 'share1' });
    const stats = await admin(env, 'GET', '/rewards/stats?days=7');
    expect(stats.status).toBe(200);
    expect(stats.body.days).toHaveLength(7);
    expect(stats.body.days[0]).toMatchObject({ checkins: 1, checkinCoins: 12, taskClaims: 1, taskCoins: 7 });
    expect(stats.body.days[0].tasks.share1).toEqual({ claims: 1, coins: 7 });
    const mine = await admin(env, 'GET', '/users/u1/rewards');
    expect(mine.body).toMatchObject({ streak: 1, claimedToday: true, streakAlive: true });
    expect(mine.body.checkins).toHaveLength(1);
    expect(mine.body.taskClaims).toHaveLength(1);
  });

  it('streak fix: sets the streak, can continue it, never pays twice today', async () => {
    const { env } = env0();
    await seedUser(env, 'u1', { streak: 9, lastDailyClaim: Date.now() - 3 * DAY });
    expect((await admin(env, 'PATCH', '/users/u1/streak', { streak: 9 })).status).toBe(400); // reason required
    const res = await admin(env, 'PATCH', '/users/u1/streak', { streak: 9, continueStreak: true, reason: 'app was down' });
    expect(res.status).toBe(200);
    // Next claim continues at day 10 (10 + 10*2 = 30 with the defaults).
    expect((await call(env, 'u1', 'claimDailyReward')).body).toMatchObject({ streak: 10, coinsEarned: 30 });
    // Fixing it again after today's claim does not open a second claim today.
    await admin(env, 'PATCH', '/users/u1/streak', { streak: 10, continueStreak: true, reason: 'again' });
    expect((await call(env, 'u1', 'claimDailyReward')).status).toBe(409);
    expect(await coins(env, 'u1')).toBe(30);
    const audit = await drizzleOf(env).select().from(schema.adminAuditLog).all();
    expect(audit.filter((a: any) => a.action === 'user.streak.update')).toHaveLength(2);
  });
});
