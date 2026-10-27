/**
 * Coin economy (migration 0068): promo budgets, locked (play-only) coins, prize
 * and product subsidies, free-reward locking and caps, withdrawal risk, referral
 * holds, the approval password and its reset, and the coin alerts.
 *
 * Every scenario ends by checking the two ledger invariants:
 *   users.dpcoin       == SUM(coin_transactions.amount)
 *   users.locked_coins == SUM(coin_transactions.locked_delta)
 */
import { vi, describe, it, expect, afterEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000), email: `${uid}@t.test` };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// Reset codes and alerts are emailed; capture instead of sending.
const sentEmails: { to: string; subject: string; html: string }[] = [];
vi.mock('../src/lib/email', async (orig) => ({
  ...(await orig<typeof import('../src/lib/email')>()),
  sendEmail: vi.fn(async (_env: unknown, opts: any) => {
    sentEmails.push(opts);
    return true;
  }),
}));

import { eq } from 'drizzle-orm';
import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { settleRefund, settleWinner } from '../src/lib/contestSettlement';
import { computeMoneyHealth } from '../src/lib/moneyHealth';
import { coinEconomyOverview } from '../src/lib/coinEconomy';
import { listPublicCoinPackages } from '../src/lib/coinCatalog';
import { creditPaymentOrder, clawbackPaymentOrder } from '../src/lib/coinOrders';
import { adjustUserWallet } from '../src/lib/money';
import { monthlyHallOfFame } from '../src/cron';
import { runCoinAlerts, maybeSendCoinReport } from '../src/lib/coinAlerts';

const app = makeApp();
const PW = 'secret-123';
const BANNER = 'https://media.test/contest-banners/2026/01/x.jpg';
const PRODUCT_IMG = 'https://media.test/product-images/2026/01/x.jpg';

afterEach(() => {
  vi.unstubAllGlobals();
  sentEmails.length = 0;
});

async function call(env: TestEnv, uid: string, action: string, data: any = {}, headers: Record<string, string> = {}) {
  const res = await app.request('/api', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}`, ...headers }, body: JSON.stringify({ action, ...data }) }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function admin(env: TestEnv, method: string, path: string, body?: any, who = 'boss:admin') {
  const res = await app.request(`/admin${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${who}` }, body: body ? JSON.stringify(body) : undefined }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function seedUser(env: TestEnv, uid: string, dpcoin = 0, extra: Record<string, any> = {}) {
  const ts = extra.createdAt ?? Date.now() - 30 * 86_400_000;
  await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid, username: uid, fullName: uid, dpcoin, createdAt: ts, updatedAt: ts, ...extra } as any);
  if (dpcoin) await env.DB.prepare(`INSERT INTO coin_transactions (id, uid, amount, type, created_at) VALUES (?, ?, ?, 'opening', ?)`).bind(`open:${uid}`, uid, dpcoin, ts).run();
}
/** A player with `diamonds` play-only coins (ledgered), the only way to pay an entry fee. */
async function seedPlayer(env: TestEnv, uid: string, diamonds: number) {
  await seedUser(env, uid);
  await adjustUserWallet(env as any, { uid, amount: diamonds, direction: 'add', type: 'purchase', description: 'test diamonds', locked: true });
}
const user = (env: TestEnv, uid: string) => drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();
async function settings(env: TestEnv, data: any) {
  await drizzleOf(env).insert(schema.settings).values({ id: 'appConfig', data, updatedAt: Date.now() } as any).onConflictDoUpdate({ target: schema.settings.id, set: { data } });
  await env.CACHE_KV.delete('settings:appConfig');
}
async function expectBalanced(env: TestEnv) {
  const h = await computeMoneyHealth(env as any);
  expect(h.ledgerDrift.count).toBe(0);
  expect(h.lockedDrift).toMatchObject({ count: 0, overBalance: 0 });
  expect(h.staleReservations).toBe(0);
}
async function budget(env: TestEnv, kind: string, totalCoins: number, extra: Record<string, any> = {}) {
  const r = await admin(env, 'POST', '/promo-budgets', { name: `${kind} ${totalCoins}`, kind, totalCoins, reason: 'test budget', approvalPassword: PW, ...extra });
  expect(r.status).toBe(200);
  return r.body.id as string;
}

describe('approval password', () => {
  it('is required for promo actions, never stored, and can be reset by a superadmin with an email code', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'boss');
    await seedUser(env, 'root');
    let r = await admin(env, 'POST', '/promo-budgets', { name: 'Xx', kind: 'package_bonus', totalCoins: 30, reason: 'test budget' });
    expect(r.body.error.reason).toBe('approval_not_set');
    expect((await admin(env, 'POST', '/approval-password', { next: PW })).status).toBe(200);
    expect((await admin(env, 'POST', '/approval-password', { next: 'other-123' })).status).toBe(412);
    r = await admin(env, 'POST', '/promo-budgets', { name: 'Xx', kind: 'package_bonus', totalCoins: 30, reason: 'test budget' });
    expect(r.body.error.reason).toBe('approval_required');
    r = await admin(env, 'POST', '/promo-budgets', { name: 'Xx', kind: 'package_bonus', totalCoins: 30, reason: 'test budget', approvalPassword: 'wrong' });
    expect(r.body.error.reason).toBe('approval_invalid');
    r = await admin(env, 'POST', '/promo-budgets', { name: 'Xx', kind: 'package_bonus', totalCoins: 30, reason: 'x', approvalPassword: PW });
    expect(r.status).toBe(400); // reason too short

    // Reset: admin cannot, superadmin can with the emailed code.
    expect((await admin(env, 'POST', '/approval-password/reset/request', {})).status).toBe(403);
    r = await admin(env, 'POST', '/approval-password/reset/request', {}, 'root:superadmin');
    expect(r.status).toBe(200);
    const code = /(\d{6})/.exec(sentEmails.at(-1)!.subject)![1];
    expect((await admin(env, 'POST', '/approval-password/reset/confirm', { code: '000000', next: 'brand-new-1' }, 'root:superadmin')).status).toBe(400);
    expect((await admin(env, 'POST', '/approval-password/reset/confirm', { code, next: 'brand-new-1' }, 'root:superadmin')).status).toBe(200);
    r = await admin(env, 'POST', '/promo-budgets', { name: 'Yy', kind: 'package_bonus', totalCoins: 30, reason: 'after reset', approvalPassword: 'brand-new-1' });
    expect(r.status).toBe(200);

    const audit = await env.DB.prepare(`SELECT action, detail FROM admin_audit_log`).all<any>();
    expect(JSON.stringify(audit.results)).not.toMatch(/secret-123|brand-new-1/);
    expect(audit.results.map((a: any) => a.action)).toEqual(expect.arrayContaining(['approval-password.reset.request', 'approval-password.reset']));
  });
});

describe('package bonus budget + locked coins', () => {
  it('sells a package (with its loss-making bonus) as Diamonds, honours the per-user limit, and never pays Diamonds out', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'boss');
    await seedUser(env, 'alice');
    await seedUser(env, 'bob', 100);
    await settings(env, { coinPricing: { buyRate: 0.1 }, withdrawal: { enabled: true, minAmount: 10, conversionRate: 0.1 }, paymentGateway: { mode: 'manual' } });
    await admin(env, 'POST', '/approval-password', { next: PW });
    const b = await budget(env, 'package_bonus', 30, { perUserLimit: 20 });

    let r = await admin(env, 'POST', '/coin-packages', { name: 'Bb', coins: 100, bonusCoins: 20 });
    expect(r.body.error.message).toMatch(/Nuksaan/);
    r = await admin(env, 'POST', '/coin-packages', { name: 'Bb', coins: 100, bonusCoins: 20, budgetId: b, approvalPassword: PW });
    expect(r.status).toBe(200);
    const pkg = r.body.id;
    expect((await listPublicCoinPackages(env as any))[0]).toMatchObject({ totalCoins: 120, bonusLocked: true, priceInr: 10 });

    r = await call(env, 'alice', 'requestDeposit', { packageId: pkg, utr: 'UTR-0001' });
    expect((await admin(env, 'PATCH', `/deposits/${r.body.depositId}`, { action: 'approve' })).status).toBe(200);
    expect(await user(env, 'alice')).toMatchObject({ dpcoin: 120, lockedCoins: 120 });

    // Per-user limit reached → no bonus; room left (10) < bonus → catalog hides it.
    r = await call(env, 'alice', 'requestDeposit', { packageId: pkg, utr: 'UTR-0002' });
    expect(await drizzleOf(env).select().from(schema.deposits).where(eq(schema.deposits.id, r.body.depositId)).get()).toMatchObject({ bonusCoins: 0, amount: 100, budgetId: null });
    expect((await listPublicCoinPackages(env as any))[0]).toMatchObject({ bonusCoins: 0, bonusLocked: false });

    // Bought coins are Diamonds: none of them can be withdrawn.
    r = await call(env, 'alice', 'requestWithdrawal', { amount: 100, method: 'upi', accountDetails: 'alice@okhdfc' });
    expect(r.status).toBe(412);
    expect(r.body.error.message).toMatch(/Diamond withdraw nahi/);
    expect(await user(env, 'alice')).toMatchObject({ dpcoin: 120, lockedCoins: 120 });
    await expectBalanced(env);
  });

  it('razorpay: reserves at order, credits the whole package as Diamonds, a refund takes the Diamonds back', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'boss');
    await seedUser(env, 'carol');
    await settings(env, { coinPricing: { buyRate: 0.1 }, withdrawal: { enabled: true, minAmount: 10, conversionRate: 0.1 } });
    await admin(env, 'POST', '/approval-password', { next: PW });
    const b = await budget(env, 'package_bonus', 100);
    const pkg = (await admin(env, 'POST', '/coin-packages', { name: 'P', coins: 100, bonusCoins: 50, budgetId: b, approvalPassword: PW })).body.id;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'order_1' }), { status: 200 })));
    const r = await call(env, 'carol', 'createOrder', { packageId: pkg });
    expect(r.body).toMatchObject({ coins: 150, bonusCoins: 50, bonusLocked: true, amount: 1000 });
    expect((await admin(env, 'GET', `/promo-budgets/${b}`)).body.budget).toMatchObject({ heldCoins: 50, remainingCoins: 50 });
    expect((await creditPaymentOrder(env as any, drizzleOf(env) as any, { orderId: 'order_1', paymentId: 'pay_1', source: 'webhook', capturedAmountPaise: 1000 })).credited).toBe(true);
    expect(await user(env, 'carol')).toMatchObject({ dpcoin: 150, lockedCoins: 150 });
    expect((await call(env, 'carol', 'requestWithdrawal', { amount: 100, method: 'upi', accountDetails: 'carol@okhdfc' })).status).toBe(412);
    // carol then wins 30 DP coins and loses 20 to a debit (taken from DP coins):
    // 160 total, 150 Diamonds. The refund takes all 150 back from the Diamonds.
    await adjustUserWallet(env as any, { uid: 'carol', amount: 30, direction: 'add', type: 'contest_win_reward', description: 'won' });
    await adjustUserWallet(env as any, { uid: 'carol', amount: 20, direction: 'subtract', type: 'contest_entry_fee', description: 'spent' });
    await clawbackPaymentOrder(env as any, drizzleOf(env) as any, { paymentId: 'pay_1', kind: 'refund' });
    expect(await user(env, 'carol')).toMatchObject({ dpcoin: 10, lockedCoins: 0 });
    const h = await computeMoneyHealth(env as any);
    expect(h.ledgerDrift.count).toBe(0);
    expect(h.lockedDrift.count).toBe(0);
  });
});

describe('contest prize subsidy', () => {
  it('reserves per match, falls back to the pot when out, pays from the budget, releases on refund, re-locks coins', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'boss');
    await seedUser(env, 'alice');
    await seedPlayer(env, 'bob', 100);
    await admin(env, 'POST', '/approval-password', { next: PW });
    // alice: 20 locked coins.
    await adjustUserWallet(env as any, { uid: 'alice', amount: 20, direction: 'add', type: 'referral_bonus', description: 'x', locked: true });
    const pb = await budget(env, 'contest_prize', 60);
    const body = { title: 'Mega', type: 'photo', status: 'live', totalEntryFee: 20, rewardCoins: 50, bannerUrl: BANNER };
    expect((await admin(env, 'POST', '/contests', body)).body.error.message).toMatch(/cannot exceed the entry-fee pot/);
    const cid = (await admin(env, 'POST', '/contests', { ...body, subsidyBudgetId: pb, approvalPassword: PW })).body.id;
    const extra = (await drizzleOf(env).select().from(schema.contests).where(eq(schema.contests.id, cid)).get())?.extra as any;
    expect(extra?.approvalPassword).toBeUndefined();

    const start = (who: string, url: string) => call(env, who, 'startMatch', { contestId: cid, mediaUrl: url, mediaType: 'photo', deviceId: `d-${url}` });
    const m1 = (await start('alice', 'https://m.test/a1.jpg')).body.matchId;
    expect(await user(env, 'alice')).toMatchObject({ dpcoin: 10, lockedCoins: 10 });
    expect(await drizzleOf(env).select().from(schema.contestMatches).where(eq(schema.contestMatches.id, m1)).get()).toMatchObject({ prizeCoins: 50, subsidyCoins: 30 });
    expect((await call(env, 'bob', 'joinMatch', { matchId: m1, mediaUrl: 'https://m.test/b1.jpg', mediaType: 'photo', deviceId: 'd-b1' })).status).toBe(200);
    const m2 = (await start('bob', 'https://m.test/b2.jpg')).body.matchId;
    const m3 = (await start('bob', 'https://m.test/b3.jpg')).body.matchId;
    expect(await drizzleOf(env).select().from(schema.contestMatches).where(eq(schema.contestMatches.id, m3)).get()).toMatchObject({ prizeCoins: 20, subsidyCoins: 0 });
    const list: any = await (await app.request('/read/contests', {}, env, fakeCtx())).json();
    expect(list.find((x: any) => x.id === cid)).toMatchObject({ rewardCoins: 20, promoPrize: false });

    expect(await settleWinner(env as any, { matchId: m1, contestId: cid, expectedStatus: 'active', winnerUid: 'bob', loserUid: 'alice', rewardAmount: 50, description: 'win', completedAt: Date.now() })).toBe(true);
    await settleRefund(env as any, { matchId: m2, contestId: cid, expectedStatus: 'waiting_for_opponent', finalStatus: 'cancelled', participantUids: ['bob'], refundPerUser: 10, description: 'r', completedAt: Date.now() });
    await settleRefund(env as any, { matchId: m3, contestId: cid, expectedStatus: 'waiting_for_opponent', finalStatus: 'cancelled', participantUids: ['bob'], refundPerUser: 10, description: 'r', completedAt: Date.now() });
    expect((await admin(env, 'GET', `/promo-budgets/${cid ? pb : ''}`)).body.budget).toMatchObject({ spentCoins: 30, heldCoins: 0, remainingCoins: 30 });
    const listed: any = await (await app.request(`/read/contests/${cid}`, {}, env, fakeCtx())).json();
    expect(listed).toMatchObject({ promoPrize: true, rewardCoins: 50 });

    // Refund re-locks the locked coins an entry spent.
    const m4 = (await start('alice', 'https://m.test/a4.jpg')).body.matchId;
    expect(await user(env, 'alice')).toMatchObject({ dpcoin: 0, lockedCoins: 0 });
    await settleRefund(env as any, { matchId: m4, contestId: cid, expectedStatus: 'waiting_for_opponent', finalStatus: 'cancelled', participantUids: ['alice'], refundPerUser: 10, description: 'r', completedAt: Date.now() });
    expect(await user(env, 'alice')).toMatchObject({ dpcoin: 10, lockedCoins: 10 });

    const eco = await coinEconomyOverview(env as any);
    expect(eco.checks.filter((c: any) => !c.ok)).toEqual([]);
    expect((await admin(env, 'GET', '/coin-economy/contests')).body[0]).toMatchObject({ subsidy: 30, prizes: 50 });
    expect((await admin(env, 'GET', '/coin-economy/users/alice')).body.ledger.balanced).toBe(true);
    await expectBalanced(env);
  });
});

describe('product prize budget', () => {
  it('hides the coin value, reserves per match, stops when out, and returns coins on a cancelled claim', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'boss');
    await seedPlayer(env, 'al', 100);
    await seedPlayer(env, 'bo', 100);
    await admin(env, 'POST', '/approval-password', { next: PW });
    const pb = await budget(env, 'product_prize', 1500);
    const base = {
      title: 'Win earphones', type: 'photo', status: 'live', totalEntryFee: 20, rewardCoins: 0, bannerUrl: BANNER,
      prizeType: 'product', prizeProductTitle: 'Boat Airdopes', prizeProductImageUrl: PRODUCT_IMG, prizeProductValue: 1499, prizeCostCoins: 1000,
    };
    expect((await admin(env, 'POST', '/contests', base)).body.error.message).toMatch(/Product prize/);
    const cid = (await admin(env, 'POST', '/contests', { ...base, subsidyBudgetId: pb, approvalPassword: PW })).body.id;
    const listText = await (await app.request('/read/contests', {}, env, fakeCtx())).text();
    expect(listText).not.toMatch(/prizeCostCoins|subsidyBudgetId/);
    expect(listText).toMatch(/1499/);

    const m1 = (await call(env, 'al', 'startMatch', { contestId: cid, mediaUrl: 'https://m.test/a1.jpg', mediaType: 'photo', deviceId: 'a1' })).body.matchId;
    let r = await call(env, 'bo', 'startMatch', { contestId: cid, mediaUrl: 'https://m.test/b2.jpg', mediaType: 'photo', deviceId: 'b2' });
    expect(r.body.error.reason).toBe('prize_budget_exhausted');
    expect((await user(env, 'bo'))?.dpcoin).toBe(100);
    expect((await (await app.request(`/read/contests/${cid}`, {}, env, fakeCtx())).json() as any).prizesSoldOut).toBe(true);
    await admin(env, 'PATCH', `/promo-budgets/${pb}`, { totalCoins: 3000, reason: 'more stock', approvalPassword: PW });
    const m2 = (await call(env, 'bo', 'startMatch', { contestId: cid, mediaUrl: 'https://m.test/b2.jpg', mediaType: 'photo', deviceId: 'b2' })).body.matchId;

    await call(env, 'bo', 'joinMatch', { matchId: m1, mediaUrl: 'https://m.test/b1.jpg', mediaType: 'photo', deviceId: 'b1' });
    await settleWinner(env as any, { matchId: m1, contestId: cid, expectedStatus: 'active', winnerUid: 'bo', loserUid: 'al', rewardAmount: 0, description: 'w', completedAt: Date.now(), productPrize: { title: 'Boat Airdopes', imageUrl: PRODUCT_IMG, value: 1499 } as any });
    await settleRefund(env as any, { matchId: m2, contestId: cid, expectedStatus: 'waiting_for_opponent', finalStatus: 'cancelled', participantUids: ['bo'], refundPerUser: 10, description: 'r', completedAt: Date.now() });
    expect((await admin(env, 'GET', `/promo-budgets/${pb}`)).body.budget).toMatchObject({ spentCoins: 980, heldCoins: 0 });

    const claim = await drizzleOf(env).select().from(schema.prizeClaims).where(eq(schema.prizeClaims.matchId, m1)).get();
    expect((await admin(env, 'POST', `/prize-claims/${claim!.id}/status`, { status: 'cancelled', adminNote: 'out of stock' })).status).toBe(200);
    expect((await admin(env, 'GET', `/promo-budgets/${pb}`)).body.budget.spentCoins).toBe(0);
    await expectBalanced(env);
  });
});

describe('free rewards', () => {
  it('are locked by default, switchable per source, and capped by a free_rewards budget', async () => {
    const { env } = makeEnv({ ALLOW_UNVERIFIED_AD_REWARDS: 'true' } as any);
    await seedUser(env, 'boss');
    await seedUser(env, 'al');
    await seedUser(env, 'bo');
    await settings(env, { ads: { enabled: true, trustClient: true, provider: 't', reward: 5, dailyCap: 10 } });
    await admin(env, 'POST', '/approval-password', { next: PW });

    let r = await call(env, 'al', 'claimDailyReward');
    const daily = r.body.coinsEarned;
    expect(r.body.lockedCoins).toBe(daily);
    await call(env, 'al', 'claimAdReward');
    expect(await user(env, 'al')).toMatchObject({ dpcoin: daily + 5, lockedCoins: daily + 5 });
    expect((await admin(env, 'POST', '/app-settings', { rewardLocking: { bogus: true } })).status).toBe(400);
    expect((await admin(env, 'POST', '/app-settings', { rewardLocking: { ads: false } })).status).toBe(200);
    await call(env, 'al', 'claimAdReward');
    expect(await user(env, 'al')).toMatchObject({ dpcoin: daily + 10, lockedCoins: daily + 5 });

    // Cap: budget of 7 coins, per user max 5. Linking needs the approval password.
    const fb = await budget(env, 'free_rewards', 7, { perUserLimit: 5 });
    expect((await admin(env, 'POST', '/app-settings', { freeRewardsBudgetId: fb })).body.error.reason).toBe('approval_required');
    expect((await admin(env, 'POST', '/app-settings', { freeRewardsBudgetId: fb, approvalPassword: PW })).status).toBe(200);
    const cfg = await drizzleOf(env).select().from(schema.settings).where(eq(schema.settings.id, 'appConfig')).get();
    expect(JSON.stringify(cfg?.data)).not.toMatch(/secret-123/);
    r = await call(env, 'bo', 'claimAdReward');
    expect(r.status).toBe(200);
    r = await call(env, 'bo', 'claimAdReward'); // per-user limit 5 reached
    expect(r.body.error.reason).toBe('free_rewards_exhausted');
    r = await call(env, 'bo', 'claimDailyReward'); // daily > remaining room
    expect(r.body.error.reason).toBe('free_rewards_exhausted');
    expect((await user(env, 'bo'))?.dpcoin).toBe(5);
    const claims = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ad_reward_claims WHERE uid = 'bo'`).first<any>();
    expect(claims.n).toBe(1); // the refused claim does not eat the daily cap
    expect((await admin(env, 'GET', `/promo-budgets/${fb}`)).body.budget).toMatchObject({ spentCoins: 5 });
    const notes = await env.DB.prepare(`SELECT title FROM admin_notifications WHERE title LIKE 'Promo budget khatam%'`).all<any>();
    expect(notes.results.length).toBe(1);
    await expectBalanced(env);
  });

  it('daily tasks and Hall of Fame prizes are configurable and validated', async () => {
    const { env } = makeEnv();
    const ts = Date.now();
    for (const [uid, wins] of [['boss', 0], ['w1', 5], ['w2', 3], ['w3', 1]] as const) {
      await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid, username: uid, fullName: uid, dpcoin: 0, monthlyWins: wins, createdAt: ts, updatedAt: ts } as any);
    }
    expect((await admin(env, 'POST', '/rewards', { dailyTasks: [{ id: 'x', title: 'Bad', reward: -1, target: 1, type: 'vote' }] })).status).toBe(400);
    expect((await admin(env, 'POST', '/rewards', { hallOfFameRewards: [10, 5] })).status).toBe(400);
    expect((await admin(env, 'POST', '/rewards', { dailyTasks: [{ id: 'share1', title: 'Share once', reward: 7, target: 1, type: 'share' }], hallOfFameRewards: [300, 200, 100] })).status).toBe(200);
    expect((await call(env, 'w1', 'getDailyTasks')).body.tasks.map((t: any) => [t.id, t.reward])).toEqual([['share1', 7]]);
    expect((await monthlyHallOfFame(env as any, '2026-09')).paid).toBe(3);
    expect([(await user(env, 'w1'))?.dpcoin, (await user(env, 'w3'))?.dpcoin]).toEqual([300, 100]);
    // Hall of Fame pays Diamonds: play-only, never withdrawn.
    expect([(await user(env, 'w1'))?.lockedCoins, (await user(env, 'w3'))?.lockedCoins]).toEqual([300, 100]);
    await expectBalanced(env);
  });
});

describe('withdrawal risk', () => {
  it('flags new accounts on a shared device living on free coins', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'old', 0, { deviceId: 'dev-1' });
    await seedUser(env, 'fresh', 0, { deviceId: 'dev-1', createdAt: Date.now() - 86_400_000 });
    await seedUser(env, 'clean', 500);
    await settings(env, { withdrawal: { enabled: true, minAmount: 10, conversionRate: 0.1 }, rewardLocking: { referral: false } });
    await adjustUserWallet(env as any, { uid: 'fresh', amount: 200, direction: 'add', type: 'referral_bonus', description: 'ref' });
    let r = await call(env, 'fresh', 'requestWithdrawal', { amount: 100, method: 'upi', accountDetails: 'fresh@okhdfc' });
    expect(r.status).toBe(200);
    r = await call(env, 'clean', 'requestWithdrawal', { amount: 100, method: 'upi', accountDetails: 'clean@okhdfc' });
    const list = (await admin(env, 'GET', '/withdrawals')).body;
    const fresh = list.find((w: any) => w.userId === 'fresh');
    expect(fresh.riskLevel).toBe('high');
    expect(fresh.riskFlags).toEqual(expect.arrayContaining(['new_account', 'shared_device', 'mostly_free_coins', 'never_played']));
    expect(list.find((w: any) => w.userId === 'clean').riskFlags).not.toContain('shared_device');
    const note = await env.DB.prepare(`SELECT title FROM admin_notifications WHERE title LIKE '%HIGH RISK%'`).first<any>();
    expect(note).toBeTruthy();
  });
});

describe('referral fraud holds', () => {
  it('holds the third referral from one IP for the same referrer, and pays it only via review', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'ref', 0, { referralCode: 'REFCODE1' });
    await settings(env, { referralProgram: { enabled: true, referrerReward: 10, refereeReward: 10, qualifyAction: 'signup', applyWindowDays: 7 } });
    const ip = { 'CF-Connecting-IP': '203.0.113.9' };
    for (const [i, uid] of ['f1', 'f2', 'f3'].entries()) {
      await seedUser(env, uid, 0, { createdAt: Date.now() });
      const r = await call(env, uid, 'applyReferralCode', { code: 'REFCODE1', deviceId: `dev-${i}` }, ip);
      expect(r.status).toBe(200);
    }
    const rows = await env.DB.prepare(`SELECT referred_uid AS u, status, hold_reason AS hold, ip FROM referrals ORDER BY created_at`).all<any>();
    expect(rows.results.map((x: any) => [x.u, x.status, x.hold])).toEqual([
      ['f1', 'rewarded', null],
      ['f2', 'rewarded', null],
      ['f3', 'review', 'same_ip_burst'],
    ]);
    expect(rows.results[0].ip).toBe('203.0.113.9');
  });
});

describe('coin alerts and report', () => {
  it('alerts on an 80%-used budget and heavy free-coin earners, and emails the daily report once', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'boss');
    await seedUser(env, 'farm');
    await settings(env, { adminAlertEmail: 'ops@t.test', coinAlerts: { dailyFreeCoinsPerUser: 50 } });
    await admin(env, 'POST', '/approval-password', { next: PW });
    const b = await budget(env, 'contest_prize', 100);
    await env.DB.prepare(`UPDATE promo_budgets SET spent_coins = 85 WHERE id = ?`).bind(b).run();
    await adjustUserWallet(env as any, { uid: 'farm', amount: 80, direction: 'add', type: 'daily_task', description: 'x', locked: true });
    const out = await runCoinAlerts(env as any);
    expect(out).toMatchObject({ budgets: 1, heavyEarners: 1 });
    expect(sentEmails.map((e) => e.subject)).toEqual(expect.arrayContaining([expect.stringMatching(/Budget 80%/), expect.stringMatching(/free coin/)]));
    // Dedupe: a second run sends nothing new.
    sentEmails.length = 0;
    expect((await runCoinAlerts(env as any)).budgets).toBe(0);

    const at3 = Date.UTC(2026, 9, 26, 3, 5); // a Monday, 03:05 UTC
    expect(await maybeSendCoinReport(env as any, at3)).toEqual({ daily: true, weekly: true });
    expect(await maybeSendCoinReport(env as any, at3 + 60_000)).toEqual({ daily: false, weekly: false });
    expect(await maybeSendCoinReport(env as any, Date.UTC(2026, 9, 27, 9))).toEqual({ daily: false, weekly: false });
    expect(sentEmails.filter((e) => /coin report/.test(e.subject)).length).toBe(2);
  });
});

describe('admin wallet: DP coin or Diamond', () => {
  it('adds and subtracts Diamonds without touching DP coins, and refuses more than the Diamonds held', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'boss');
    await seedUser(env, 'eve', 50); // 50 DP coins
    const adjust = (body: any) => admin(env, 'POST', '/users/eve/wallet', { reason: 'support test', requestId: crypto.randomUUID(), ...body });
    expect((await adjust({ amount: 30, type: 'add', locked: true })).status).toBe(200);
    expect(await user(env, 'eve')).toMatchObject({ dpcoin: 80, lockedCoins: 30 });
    expect((await adjust({ amount: 20, type: 'subtract', locked: true })).status).toBe(200);
    expect(await user(env, 'eve')).toMatchObject({ dpcoin: 60, lockedCoins: 10 });
    const r = await adjust({ amount: 11, type: 'subtract', locked: true });
    expect(r.status).toBe(412);
    expect(r.body.error.message).toMatch(/Insufficient Diamonds/);
    expect(await user(env, 'eve')).toMatchObject({ dpcoin: 60, lockedCoins: 10 });
    // A DP coin subtraction still takes DP coins first.
    expect((await adjust({ amount: 50, type: 'subtract' })).status).toBe(200);
    expect(await user(env, 'eve')).toMatchObject({ dpcoin: 10, lockedCoins: 10 });
    await expectBalanced(env);
  });
});
