/**
 * Gamification: the XP engine, levels, achievements, quests, cosmetics,
 * milestone rewards, seasons, leaderboards and the admin surface.
 *
 * The properties pinned here are the ones whose failure would be invisible in
 * normal use and expensive later: XP awarded twice, a cap overrun by a race, a
 * balance moving without its ledger event, a cosmetic equipped without being
 * owned, a reward paid without a budget, a season paid twice.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

vi.mock('../src/lib/firebaseAdmin', () => ({
  lookupAuthUser: async () => ({ email: null, emailVerified: false, phoneNumber: null }),
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
  DEFAULT_PROGRESSION,
  getProgression,
  levelFor,
  levelInfo,
  rankFor,
  sanitizeProgression,
  validateProgression,
  xpForLevel,
} from '../src/lib/progression';
import { awardXp, reconcileXp, reverseXp, xpAwardStatements } from '../src/lib/xpService';
import { syncProgression, tierFor } from '../src/lib/achievements';
import { settleRefund, settleWinner } from '../src/lib/contestSettlement';
import { finalizeSeason, leaderboardPage, myRank, rangeFor } from '../src/lib/seasons';
import { monthPeriod, weekPeriod } from '../src/lib/quests';
import { rewardDayNumber } from '../src/lib/gamification';

const app = makeApp();
const DAY = 86_400_000;
const CURVE = { xpThreshold: 500, xpIncrement: 500, maxLevel: 100 };

const fakeVoteCounter = () => ({ idFromName: (n: string) => n, get: () => ({ engagement: async () => ({ share: 1 }) }) });
const env0 = () => makeEnv({ VOTE_COUNTER: fakeVoteCounter() } as any).env;

async function call(env: TestEnv, uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` }, body: JSON.stringify({ action, ...data }) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function admin(env: TestEnv, method: string, path: string, body?: any, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers['X-Admin-Secret'] = 'test-admin-secret';
  const res = await app.request(`/admin${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function read(env: TestEnv, path: string, uid?: string) {
  const res = await app.request(`/read${path}`, uid ? { headers: { Authorization: `Bearer ${uid}` } } : {}, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now() - 1000;
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, status: 'active', uid, username: uid, fullName: uid, dpcoin: 0, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function setProgression(env: TestEnv, progression: Record<string, any>, extra: Record<string, any> = {}) {
  const db = drizzleOf(env);
  await db.delete(schema.settings).where(eq(schema.settings.id, 'gamification'));
  await db.insert(schema.settings).values({ id: 'gamification', data: { progression, ...extra } as any, updatedAt: Date.now() } as any);
  await env.CACHE_KV.delete('settings:gamification');
}

const on = (env: TestEnv, extra: Record<string, any> = {}) => setProgression(env, { enabled: true, ...extra });

const userXp = async (env: TestEnv, uid: string) =>
  Number((await env.DB.prepare('SELECT xp FROM users WHERE uid = ?').bind(uid).first<{ xp: number }>())?.xp ?? 0);
const ledgerSum = async (env: TestEnv, uid: string) =>
  Number((await env.DB.prepare('SELECT COALESCE(SUM(delta),0) AS s FROM user_xp_events WHERE uid = ?').bind(uid).first<{ s: number }>())?.s ?? 0);

async function seedBudget(env: TestEnv, id: string, total: number, perUser: number | null = null) {
  const ts = Date.now();
  await env.DB.prepare(
    `INSERT INTO promo_budgets (id, name, kind, total_coins, spent_coins, status, per_user_limit, created_at, updated_at)
     VALUES (?, ?, 'free_rewards', ?, 0, 'active', ?, ?, ?)`,
  ).bind(id, id, total, perUser, ts, ts).run();
}

// ===========================================================================
describe('level engine', () => {
  it('keeps the existing formula: cumulative XP to reach level L', () => {
    expect(xpForLevel(1, CURVE)).toBe(0);
    expect(xpForLevel(2, CURVE)).toBe(500);
    expect(xpForLevel(3, CURVE)).toBe(1500);
    expect(xpForLevel(4, CURVE)).toBe(3000);
    expect(levelFor(1499, CURVE)).toBe(2);
    expect(levelFor(1500, CURVE)).toBe(3);
  });

  it('computes progress inside the level', () => {
    const info = levelInfo(1000, CURVE, DEFAULT_PROGRESSION);
    expect(info).toMatchObject({ level: 2, levelStartXp: 500, nextLevelXp: 1500, xpIntoLevel: 500, xpForNextLevel: 1000, xpToNextLevel: 500, isMaxLevel: false });
    expect(info.progress).toBeCloseTo(0.5);
    expect(info.nextMilestone?.level).toBe(5);
  });

  it('returns an explicit max-level state and keeps counting XP', () => {
    const top = xpForLevel(100, CURVE);
    const info = levelInfo(top + 12345, CURVE, DEFAULT_PROGRESSION);
    expect(info).toMatchObject({ level: 100, isMaxLevel: true, nextLevelXp: null, xpForNextLevel: null, xpToNextLevel: null, progress: 1, xpIntoLevel: 12345 });
    expect(info.rank.name).toBe('Legend');
  });

  it('treats negative and garbage XP as zero', () => {
    expect(levelInfo(-50, CURVE, DEFAULT_PROGRESSION).level).toBe(1);
    expect(levelInfo(Number.NaN, CURVE, DEFAULT_PROGRESSION).xp).toBe(0);
  });

  it('maps levels to ranks by level, not XP bands', () => {
    expect(rankFor(1, DEFAULT_PROGRESSION.ranks).name).toBe('Newcomer');
    expect(rankFor(6, DEFAULT_PROGRESSION.ranks).name).toBe('Creator');
    expect(rankFor(30, DEFAULT_PROGRESSION.ranks).name).toBe('Challenger');
    expect(rankFor(31, DEFAULT_PROGRESSION.ranks).name).toBe('Champion');
    expect(rankFor(51, DEFAULT_PROGRESSION.ranks).name).toBe('Legend');
  });

  it('rejects configuration that would overflow or misorder', () => {
    expect(() => validateProgression({ maxLevel: 1000 }, { xpThreshold: 1_000_000, xpIncrement: 1_000_000 })).toThrow(/would need more than/);
    expect(() => validateProgression({ ranks: [{ id: 'aa', name: 'A', minLevel: 5, icon: 'x', color: '#000000' }] }, CURVE)).toThrow(/first rank/);
    expect(() => validateProgression({ ranks: [
      { id: 'aa', name: 'A', minLevel: 1, icon: 'x', color: '#000000' },
      { id: 'bb', name: 'B', minLevel: 1, icon: 'x', color: '#000000' },
    ] }, CURVE)).toThrow(/increasing/);
    expect(() => validateProgression({ rules: { vote: { xp: -1 } } }, CURVE)).toThrow(/rules.vote.xp/);
    expect(() => validateProgression({ rules: { hack: { xp: 1 } } }, CURVE)).toThrow(/not a known XP action/);
    expect(() => validateProgression({ milestones: [{ level: 5, title: 'x', description: '', items: [], coins: 0 }, { level: 5, title: 'y', description: '', items: [], coins: 0 }] }, CURVE)).toThrow(/Two milestones/);
    expect(() => validateProgression(DEFAULT_PROGRESSION, CURVE)).not.toThrow();
  });

  it('sanitises stored garbage back to safe defaults', () => {
    const s = sanitizeProgression({ maxLevel: 'x', rules: { vote: { xp: 1e9, dailyCap: -4 } } });
    expect(s.maxLevel).toBe(100);
    expect(s.rules.vote).toEqual(DEFAULT_PROGRESSION.rules.vote);
  });

  it('caps the level everywhere at maxLevel, including the profile', async () => {
    const env = env0();
    await setProgression(env, { maxLevel: 5 });
    await seedUser(env, 'alice', { xp: 9_999_999 });
    const own = await read(env, '/users/alice', 'alice');
    expect(own.body.level).toBe(5);
    expect(own.body.levelInfo.isMaxLevel).toBe(true);
  });

  it('achievement tiers are bounded', () => {
    expect(tierFor({ threshold: 10, repeatable: false, maxTiers: 1 }, 35)).toBe(1);
    expect(tierFor({ threshold: 10, repeatable: true, maxTiers: 3 }, 35)).toBe(3);
    expect(tierFor({ threshold: 10, repeatable: true, maxTiers: 5 }, 9)).toBe(0);
  });
});

// ===========================================================================
describe('XP engine', () => {
  it('applies an award exactly once per event id, with a matching ledger row', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    const input = { uid: 'alice', action: 'match_win' as const, eventId: 'match_win:m1', ts: Date.now() };
    const [a, b] = await Promise.all([awardXp(env, input), awardXp(env, input)]);
    expect([a.applied, b.applied].filter(Boolean)).toHaveLength(1);
    expect(await userXp(env, 'alice')).toBe(100);
    expect(await ledgerSum(env, 'alice')).toBe(100);
  });

  it('enforces the daily cap exactly under concurrency', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    const ts = Date.now();
    // Default vote rule: 5 XP, 100 XP/day.
    await Promise.all(Array.from({ length: 40 }, (_, i) => awardXp(env, { uid: 'alice', action: 'vote', eventId: `vote:m${i}:alice`, ts })));
    expect(await userXp(env, 'alice')).toBe(100);
    const daily = await env.DB.prepare(`SELECT xp, events FROM user_xp_daily WHERE uid = 'alice' AND action = 'vote'`).first<any>();
    expect(daily).toEqual({ xp: 100, events: 40 });
    // The next reward day has a fresh cap.
    await awardXp(env, { uid: 'alice', action: 'vote', eventId: 'vote:next:alice', ts: ts + DAY });
    expect(await userXp(env, 'alice')).toBe(105);
  });

  it('never takes an XP amount from a fixed rule caller', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    await awardXp(env, { uid: 'alice', action: 'vote', eventId: 'vote:x:alice', amount: 1_000_000, ts: Date.now() });
    expect(await userXp(env, 'alice')).toBe(5);
  });

  it('a disabled rule awards nothing', async () => {
    const env = env0();
    await setProgression(env, { rules: { vote: { xp: 5, enabled: false, dailyCap: null } } });
    await seedUser(env, 'alice');
    const r = await awardXp(env, { uid: 'alice', action: 'vote', eventId: 'vote:x:alice', ts: Date.now() });
    expect(r.applied).toBe(false);
    expect(await userXp(env, 'alice')).toBe(0);
  });

  it('clamps lifetime XP below the overflow ceiling', async () => {
    const env = env0();
    await seedUser(env, 'alice', { xp: 1_999_999_990 });
    await awardXp(env, { uid: 'alice', action: 'match_win', eventId: 'match_win:big', ts: Date.now() });
    expect(await userXp(env, 'alice')).toBe(2_000_000_000);
  });

  it('reverses append-only, once, and never below zero', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    await awardXp(env, { uid: 'alice', action: 'match_win', eventId: 'match_win:r', ts: Date.now() });
    await env.DB.prepare(`UPDATE users SET xp = 30 WHERE uid = 'alice'`).run(); // simulate other drift
    const d1 = await reverseXp(env, { originalId: 'match_win:r', reason: 'test', ts: Date.now() });
    const d2 = await reverseXp(env, { originalId: 'match_win:r', reason: 'test', ts: Date.now() + 1 });
    expect(d1).toBe(-30);
    expect(d2).toBeNull();
    expect(await userXp(env, 'alice')).toBe(0);
    const rows = await env.DB.prepare(`SELECT id FROM user_xp_events WHERE uid = 'alice'`).all();
    expect(rows.results).toHaveLength(2); // original kept, one reversal added
  });

  it('reconcile reports a balance that moved without a ledger event', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    await awardXp(env, { uid: 'alice', action: 'match_win', eventId: 'match_win:z', ts: Date.now() });
    expect(await reconcileXp(env, ['alice'])).toEqual([]);
    await env.DB.prepare(`UPDATE users SET xp = xp + 7 WHERE uid = 'alice'`).run();
    expect(await reconcileXp(env, ['alice'])).toEqual([{ uid: 'alice', xp: 107, ledger: 100 }]);
  });

  it('the migration opened a ledger balance for pre-existing XP', async () => {
    // Re-run the opening-balance statement against a seeded user, as the migration would.
    const env = env0();
    await seedUser(env, 'old', { xp: 1234 });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO user_xp_events (id, uid, action, delta, requested, day, rule_version, created_at)
       SELECT 'opening:' || uid, uid, 'opening_balance', xp, xp, 0, 0, 0 FROM users WHERE COALESCE(xp, 0) > 0`,
    ).run();
    expect(await reconcileXp(env, ['old'])).toEqual([]);
  });
});

// ===========================================================================
describe('existing XP paths now go through the engine', () => {
  it('daily check-in: same 50 XP, once per reward day, ledgered, forged fields ignored', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    const first = await call(env, 'alice', 'claimDailyReward', { xp: 99999, amount: 99999 });
    expect(first.status).toBe(200);
    expect(first.body.xpEarned).toBe(50);
    const again = await call(env, 'alice', 'claimDailyReward');
    expect(again.status).toBe(409);
    expect(await userXp(env, 'alice')).toBe(50);
    expect(await ledgerSum(env, 'alice')).toBe(50);
  });

  it('match settlement pays win/loss XP once even when two resolvers race', async () => {
    const env = env0();
    await seedUser(env, 'win');
    await seedUser(env, 'lose');
    const ts = Date.now();
    await drizzleOf(env).insert(schema.contestMatches).values({
      id: 'm1', status: 'active', type: 'photo', title: 't', entryFee: 0,
      userA: { uid: 'win' } as any, userB: { uid: 'lose' } as any, createdAt: ts,
    } as any);
    const input = { matchId: 'm1', expectedStatus: 'active' as const, winnerUid: 'win', loserUid: 'lose', rewardAmount: 0, description: 'x', completedAt: ts };
    const res = await Promise.all([settleWinner(env as any, input), settleWinner(env as any, input)]);
    expect(res.filter(Boolean)).toHaveLength(1);
    expect(await userXp(env, 'win')).toBe(100);
    expect(await userXp(env, 'lose')).toBe(20);
    expect(await reconcileXp(env, ['win', 'lose'])).toEqual([]);
  });

  it('a cancelled match reverses the entry XP; a tie keeps it', async () => {
    const env = env0();
    await seedUser(env, 'a');
    await seedUser(env, 'b');
    const ts = Date.now();
    for (const [id, status] of [['mc', 'waiting_for_opponent'], ['mt', 'active']] as const) {
      await drizzleOf(env).insert(schema.contestMatches).values({ id, status, type: 'photo', title: 't', entryFee: 0, userA: { uid: 'a' } as any, createdAt: ts } as any);
      await awardXp(env, { uid: 'a', action: 'contest_entry', eventId: `contest_entry:${id}:a`, ts });
    }
    expect(await userXp(env, 'a')).toBe(20);
    await settleRefund(env as any, { matchId: 'mc', expectedStatus: 'waiting_for_opponent', finalStatus: 'cancelled', participantUids: ['a'], refundPerUser: 0, description: 'no opponent', completedAt: ts });
    await settleRefund(env as any, { matchId: 'mt', expectedStatus: 'active', finalStatus: 'completed', participantUids: ['a'], refundPerUser: 0, description: 'tie', completedAt: ts });
    expect(await userXp(env, 'a')).toBe(10);
    expect(await reconcileXp(env, ['a'])).toEqual([]);
  });

  it('admin XP grant needs a reason and lands on the ledger', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    expect((await admin(env, 'POST', '/users/alice/grant', { xp: 100 })).status).toBe(400);
    expect((await admin(env, 'POST', '/users/alice/grant', { xp: 100, reason: 'event prize' })).status).toBe(200);
    expect(await userXp(env, 'alice')).toBe(100);
    expect(await ledgerSum(env, 'alice')).toBe(100);
  });

  it('daily quests (daily tasks) pay their configured XP once', async () => {
    const env = env0();
    await setProgression(env, {}, { dailyTasks: [{ id: 'c1', title: 'Enter', reward: 5, xp: 15, target: 1, type: 'contest' }] });
    await seedUser(env, 'alice');
    // One contest entry today (the task counts entry-fee ledger rows).
    await env.DB.prepare(`INSERT INTO coin_transactions (id, uid, amount, type, created_at) VALUES ('contest_entry:mx:alice', 'alice', 0, 'contest_entry_fee', ?)`).bind(Date.now()).run();
    const r = await call(env, 'alice', 'claimDailyTask', { taskId: 'c1' });
    expect(r.status).toBe(200);
    expect(r.body.xpEarned).toBe(15);
    expect((await call(env, 'alice', 'claimDailyTask', { taskId: 'c1' })).status).toBe(409);
    expect(await userXp(env, 'alice')).toBe(15);
  });
});

// ===========================================================================
describe('progression sync, achievements and level-ups', () => {
  it('the first sync is silent: no retroactive XP, no notifications', async () => {
    const env = env0();
    await on(env);
    await seedUser(env, 'alice', { xp: 3000, profileImageUrl: 'https://cdn.test/a.jpg', bio: 'hi', wins: 3 });
    const r = await syncProgression(env, 'alice');
    expect(r?.leveledUp).toBeNull();
    expect(await userXp(env, 'alice')).toBe(3000);
    const ach = await env.DB.prepare(`SELECT achievement_id, xp_awarded, source FROM user_achievements WHERE uid = 'alice'`).all<any>();
    expect(ach.results?.map((a) => a.achievement_id).sort()).toEqual(['first_win', 'profile_complete']);
    expect(ach.results?.every((a) => a.xp_awarded === 0 && a.source === 'backfill')).toBe(true);
    // Cosmetics for levels already reached are granted (level 4: none until 5).
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = 'alice'`).first<any>();
    expect(Number(n.n)).toBe(0);
  });

  it('a later unlock pays its XP exactly once, even when syncs race', async () => {
    const env = env0();
    await on(env);
    await seedUser(env, 'alice');
    await syncProgression(env, 'alice'); // baseline
    await env.DB.prepare(`UPDATE users SET wins = 1 WHERE uid = 'alice'`).run();
    await Promise.all([syncProgression(env, 'alice'), syncProgression(env, 'alice'), syncProgression(env, 'alice')]);
    expect(await userXp(env, 'alice')).toBe(50); // first_win
    const item = await env.DB.prepare(`SELECT item_id FROM user_inventory WHERE uid = 'alice'`).all<any>();
    expect(item.results?.map((r) => r.item_id)).toContain('sticker_first_win');
    expect(await reconcileXp(env, ['alice'])).toEqual([]);
  });

  it('announces a level-up once and grants milestone items', async () => {
    const env = env0();
    await on(env);
    await seedUser(env, 'alice');
    await syncProgression(env, 'alice');
    await env.DB.prepare(`UPDATE users SET xp = ? WHERE uid = 'alice'`).bind(xpForLevel(5, CURVE)).run();
    const results = await Promise.all([syncProgression(env, 'alice'), syncProgression(env, 'alice')]);
    expect(results.filter((r) => r?.leveledUp).length).toBe(1);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = 'alice' AND type = 'level_up'`).first<any>();
    expect(Number(n.n)).toBe(1);
    const inv = await env.DB.prepare(`SELECT item_id FROM user_inventory WHERE uid = 'alice'`).all<any>();
    expect(inv.results?.map((r) => r.item_id)).toContain('frame_bronze');
  });

  it('with the experience off, syncs stay silent', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    await syncProgression(env, 'alice');
    await env.DB.prepare(`UPDATE users SET xp = 9000, wins = 1 WHERE uid = 'alice'`).run();
    const r = await syncProgression(env, 'alice');
    expect(r?.leveledUp).toBeNull();
    expect(await userXp(env, 'alice')).toBe(9000);
  });

  it('getProgression returns server-computed progress and never takes a uid', async () => {
    const env = env0();
    await on(env);
    await seedUser(env, 'alice', { xp: 1000 });
    await seedUser(env, 'bob', { xp: 50_000 });
    const r = await call(env, 'alice', 'getProgression', { uid: 'bob' });
    expect(r.status).toBe(200);
    expect(r.body.levelInfo).toMatchObject({ xp: 1000, level: 2, xpIntoLevel: 500, xpForNextLevel: 1000 });
    expect(r.body.roadmap.find((m: any) => m.level === 5).unlocked).toBe(false);
  });
});

// ===========================================================================
describe('cosmetics', () => {
  it('only an owned, active item of the right type can be equipped', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    expect((await call(env, 'alice', 'equipCosmetic', { slot: 'frame', itemId: 'frame_bronze' })).status).toBe(403);
    await env.DB.prepare(`INSERT INTO user_inventory (uid, item_id, source, acquired_at) VALUES ('bob', 'frame_bronze', 'level', 1)`).run();
    // Bob's ownership does not help Alice.
    expect((await call(env, 'alice', 'equipCosmetic', { slot: 'frame', itemId: 'frame_bronze' })).status).toBe(403);
    // Right item, wrong slot.
    expect((await call(env, 'bob', 'equipCosmetic', { slot: 'title', itemId: 'frame_bronze' })).status).toBe(403);
    const ok = await call(env, 'bob', 'equipCosmetic', { slot: 'frame', itemId: 'frame_bronze' });
    expect(ok.status).toBe(200);
    expect(ok.body.cosmetics.frame.id).toBe('frame_bronze');
    // Public profile shows the resolved item.
    const pub = await read(env, '/users/bob', 'alice');
    expect(pub.body.cosmetics.frame.id).toBe('frame_bronze');
    expect(pub.body.levelSeen).toBeUndefined();
    expect((await call(env, 'bob', 'equipCosmetic', { slot: 'frame', itemId: null })).status).toBe(200);
  });

  it('a revoked item is unequipped and cannot be re-equipped', async () => {
    const env = env0();
    await seedUser(env, 'bob');
    await env.DB.prepare(`INSERT INTO user_inventory (uid, item_id, source, acquired_at) VALUES ('bob', 'frame_bronze', 'level', 1)`).run();
    await call(env, 'bob', 'equipCosmetic', { slot: 'frame', itemId: 'frame_bronze' });
    expect((await admin(env, 'POST', '/gamification/users/bob/inventory/frame_bronze/revoke', { reason: 'abuse review' })).status).toBe(200);
    const u = await env.DB.prepare(`SELECT json_extract(cosmetics, '$.frame') AS f FROM users WHERE uid = 'bob'`).first<any>();
    expect(u.f).toBeNull();
    expect((await call(env, 'bob', 'equipCosmetic', { slot: 'frame', itemId: 'frame_bronze' })).status).toBe(403);
  });

  it('pins only unlocked achievements, within the limit, after the showcase level', async () => {
    const env = env0();
    await seedUser(env, 'alice', { xp: 0 });
    expect((await call(env, 'alice', 'pinAchievements', { achievementIds: [] })).status).toBe(412);
    await env.DB.prepare(`UPDATE users SET xp = 500 WHERE uid = 'alice'`).run();
    expect((await call(env, 'alice', 'pinAchievements', { achievementIds: ['first_win'] })).status).toBe(403);
    await env.DB.prepare(`INSERT INTO user_achievements (uid, achievement_id, tier, unlocked_at) VALUES ('alice', 'first_win', 1, 1)`).run();
    expect((await call(env, 'alice', 'pinAchievements', { achievementIds: ['first_win'] })).status).toBe(200);
    expect((await call(env, 'alice', 'pinAchievements', { achievementIds: ['a1', 'a2', 'a3', 'a4'] })).status).toBe(400);
  });
});

// ===========================================================================
describe('quests', () => {
  it('weeks start on Monday and months follow the calendar, on the reward-day boundary', () => {
    const mon = Date.UTC(2026, 9, 26, 12); // Monday 26 Oct 2026
    const w = weekPeriod(mon, 0);
    expect(new Date(w.startMs).toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(w.endMs - w.startMs).toBe(7 * DAY);
    const m = monthPeriod(mon, 330);
    expect(m.key).toBe('m2026-10');
    expect(new Date(m.startMs).toISOString()).toBe('2026-09-30T18:30:00.000Z'); // midnight IST
  });

  it('claims once, only when the server counts the progress', async () => {
    const env = env0();
    await on(env, { quests: [{ id: 'wk_checkin', title: 'Check in', period: 'week', metric: 'checkins', target: 1, xp: 20, minLevel: 1, enabled: true }] });
    await seedUser(env, 'alice');
    expect((await call(env, 'alice', 'claimQuest', { questId: 'wk_checkin' })).status).toBe(412);
    await call(env, 'alice', 'claimDailyReward');
    const list = await call(env, 'alice', 'getQuests');
    expect(list.body.quests[0]).toMatchObject({ progress: 1, claimable: true });
    const [a, b] = await Promise.all([call(env, 'alice', 'claimQuest', { questId: 'wk_checkin' }), call(env, 'alice', 'claimQuest', { questId: 'wk_checkin' })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await userXp(env, 'alice')).toBe(70);
  });

  it('a level-gated quest is locked below its level', async () => {
    const env = env0();
    await on(env, { quests: [{ id: 'elite', title: 'Elite', period: 'week', metric: 'votes', target: 0 + 1, xp: 25, minLevel: 20, enabled: true }] });
    await seedUser(env, 'alice');
    const list = await call(env, 'alice', 'getQuests');
    expect(list.body.quests[0].locked).toBe(true);
    expect((await call(env, 'alice', 'claimQuest', { questId: 'elite' })).status).toBe(412);
  });
});

// ===========================================================================
describe('milestone coin rewards go through the budget and ledger', () => {
  async function withGrant(env: TestEnv, coins = 30) {
    await seedUser(env, 'alice');
    await env.DB.prepare(
      `INSERT INTO reward_grants (id, uid, source_type, source_id, coins, status, created_at, updated_at) VALUES ('level:5:alice', 'alice', 'level', '5', ?, 'claimable', 1, 1)`,
    ).bind(coins).run();
  }

  it('without a budget the reward stays saved and nothing is paid', async () => {
    const env = env0();
    await on(env);
    await withGrant(env);
    const r = await call(env, 'alice', 'claimRewardGrant', { grantId: 'level:5:alice' });
    expect(r.status).toBe(412);
    const u = await env.DB.prepare(`SELECT dpcoin FROM users WHERE uid = 'alice'`).first<any>();
    expect(u.dpcoin).toBe(0);
    const g = await env.DB.prepare(`SELECT status FROM reward_grants WHERE id = 'level:5:alice'`).first<any>();
    expect(g.status).toBe('claimable');
  });

  it('pays Diamonds once, with a ledger row and budget spend', async () => {
    const env = env0();
    await seedBudget(env, 'b1', 1000);
    await on(env, { rewardBudgetId: 'b1' });
    await withGrant(env);
    const [a, b] = await Promise.all([
      call(env, 'alice', 'claimRewardGrant', { grantId: 'level:5:alice' }),
      call(env, 'alice', 'claimRewardGrant', { grantId: 'level:5:alice' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const u = await env.DB.prepare(`SELECT dpcoin, locked_coins FROM users WHERE uid = 'alice'`).first<any>();
    expect(u).toEqual({ dpcoin: 30, locked_coins: 30 });
    const t = await env.DB.prepare(`SELECT amount, locked_delta, type FROM coin_transactions WHERE id = 'reward_grant:level:5:alice'`).first<any>();
    expect(t).toEqual({ amount: 30, locked_delta: 30, type: 'gamification_reward' });
    const bud = await env.DB.prepare(`SELECT spent_coins FROM promo_budgets WHERE id = 'b1'`).first<any>();
    expect(bud.spent_coins).toBe(30);
  });

  it('an exhausted budget keeps the reward claimable', async () => {
    const env = env0();
    await seedBudget(env, 'b1', 10);
    await on(env, { rewardBudgetId: 'b1' });
    await withGrant(env, 30);
    const r = await call(env, 'alice', 'claimRewardGrant', { grantId: 'level:5:alice' });
    expect(r.status).toBe(412);
    const g = await env.DB.prepare(`SELECT status FROM reward_grants WHERE id = 'level:5:alice'`).first<any>();
    expect(g.status).toBe('claimable');
  });

  it("someone else's grant looks like a missing one", async () => {
    const env = env0();
    await seedBudget(env, 'b1', 1000);
    await on(env, { rewardBudgetId: 'b1' });
    await withGrant(env);
    await seedUser(env, 'mallory');
    expect((await call(env, 'mallory', 'claimRewardGrant', { grantId: 'level:5:alice' })).status).toBe(404);
  });
});

// ===========================================================================
describe('leaderboards and seasons', () => {
  it('period XP is separate from lifetime XP and excludes admin adjustments', async () => {
    const env = env0();
    await seedUser(env, 'a', { xp: 10_000 });
    await seedUser(env, 'b');
    const ts = Date.now();
    await awardXp(env, { uid: 'b', action: 'match_win', eventId: 'match_win:w1', ts });
    await awardXp(env, { uid: 'a', action: 'admin_adjustment', eventId: 'admin:1', amount: 5000, reason: 'x', ts });
    const p = await getProgression(env);
    const week = await rangeFor(env, p, 'week');
    const page = await leaderboardPage(env, week, 0, 10);
    expect(page.map((r) => r.uid)).toEqual(['b']);
    const life = await leaderboardPage(env, null, 0, 10);
    expect(life.map((r) => r.uid)).toEqual(['a', 'b']);
    expect((await myRank(env, 'b', week)).rank).toBe(1);
    expect((await myRank(env, 'b', null)).rank).toBe(2);
  });

  it('breaks ties by lifetime XP, then account age', async () => {
    const env = env0();
    const ts = Date.now();
    await seedUser(env, 'young', { xp: 0, createdAt: ts - 10 });
    await seedUser(env, 'old', { xp: 0, createdAt: ts - 1000 });
    await awardXp(env, { uid: 'young', action: 'match_win', eventId: 'match_win:y', ts });
    await awardXp(env, { uid: 'old', action: 'match_win', eventId: 'match_win:o', ts });
    const p = await getProgression(env);
    const page = await leaderboardPage(env, await rangeFor(env, p, 'week'), 0, 10);
    expect(page.map((r) => r.uid)).toEqual(['old', 'young']);
    expect((await myRank(env, 'young', await rangeFor(env, p, 'week'))).rank).toBe(2);
  });

  it('the public XP leaderboard serves only public fields', async () => {
    const env = env0();
    await seedUser(env, 'a', { xp: 700, email: 'a@example.com', phone: '+911111111111' });
    const r = await read(env, '/leaderboard/xp?period=lifetime');
    expect(r.status).toBe(200);
    expect(r.body.rows[0]).toMatchObject({ uid: 'a', score: 700, level: 2 });
    expect(JSON.stringify(r.body)).not.toContain('example.com');
    expect(JSON.stringify(r.body)).not.toContain('+911');
    const s = await read(env, '/leaderboard/xp?period=season');
    expect(s.body.active).toBe(false);
  });

  it('finalizes a season once: snapshot, rewards, lifetime XP untouched', async () => {
    const env = env0();
    await seedBudget(env, 'b1', 1000);
    await on(env, { rewardBudgetId: 'b1' });
    await seedUser(env, 'a');
    await seedUser(env, 'b');
    const p = await getProgression(env);
    const ts = Date.now() - 10 * DAY;
    await awardXp(env, { uid: 'a', action: 'match_win', eventId: 'match_win:s1', ts });
    await awardXp(env, { uid: 'b', action: 'match_loss', eventId: 'match_loss:s1:b', ts });
    const day = rewardDayNumber(ts, p.settings.dayResetOffsetMinutes);
    await env.DB.prepare(
      `INSERT INTO seasons (id, name, starts_at, ends_at, start_day, end_day, status, top_n, rewards, created_at, updated_at)
       VALUES ('s1', 'Season 1', ?, ?, ?, ?, 'active', 10, ?, 1, 1)`,
    ).bind(ts - DAY, ts + DAY, day - 1, day + 1, JSON.stringify([{ fromRank: 1, toRank: 1, coins: 25, itemId: 'collectible_season_top' }])).run();
    const [x, y] = await Promise.all([finalizeSeason(env, 's1'), finalizeSeason(env, 's1')]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    expect(await finalizeSeason(env, 's1')).toBe(false);
    const res = await env.DB.prepare(`SELECT uid, rank, xp FROM season_results WHERE season_id = 's1' ORDER BY rank`).all<any>();
    expect(res.results).toEqual([{ uid: 'a', rank: 1, xp: 100 }, { uid: 'b', rank: 2, xp: 20 }]);
    const grants = await env.DB.prepare(`SELECT id, coins FROM reward_grants WHERE source_type = 'season'`).all<any>();
    expect(grants.results).toEqual([{ id: 's1'.replace(/^/, 'season:') + ':a', coins: 25 }]);
    expect(await userXp(env, 'a')).toBe(100);
    const inv = await env.DB.prepare(`SELECT uid FROM user_inventory WHERE item_id = 'collectible_season_top'`).all<any>();
    expect(inv.results).toEqual([{ uid: 'a' }]);
  });
});

// ===========================================================================
describe('admin surface', () => {
  it('moderators cannot move XP or change config; admins need a reason', async () => {
    const env = env0();
    await seedUser(env, 'mod', { role: 'moderator' });
    await seedUser(env, 'alice');
    expect((await admin(env, 'POST', '/gamification/users/alice/xp', { amount: 10, reason: 'nope' }, 'mod:moderator')).status).toBe(403);
    expect((await admin(env, 'POST', '/gamification/config', { progression: { enabled: true } }, 'mod:moderator')).status).toBe(403);
    // Moderators may inspect, without coin rewards.
    const insp = await admin(env, 'GET', '/gamification/users/alice', undefined, 'mod:moderator');
    expect(insp.status).toBe(200);
    expect(insp.body.rewardGrants).toBeUndefined();
    expect((await admin(env, 'POST', '/gamification/users/alice/xp', { amount: 10 })).status).toBe(400);
  });

  it('a negative adjustment never drives XP below zero, and is audited', async () => {
    const env = env0();
    await seedUser(env, 'alice', { xp: 0 });
    await awardXp(env, { uid: 'alice', action: 'match_win', eventId: 'match_win:q', ts: Date.now() });
    const r = await admin(env, 'POST', '/gamification/users/alice/xp', { amount: -500, reason: 'farming review' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ applied: -100, before: 100, after: 0 });
    const audit = await env.DB.prepare(`SELECT action FROM admin_audit_log WHERE action = 'gamification.xp.adjust'`).all();
    expect(audit.results).toHaveLength(1);
    expect(await reconcileXp(env, ['alice'])).toEqual([]);
  });

  it('reverses an event once', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    await awardXp(env, { uid: 'alice', action: 'match_win', eventId: 'match_win:rv', ts: Date.now() });
    expect((await admin(env, 'POST', '/gamification/events/match_win:rv/reverse', { reason: 'collusion' })).status).toBe(200);
    expect((await admin(env, 'POST', '/gamification/events/match_win:rv/reverse', { reason: 'collusion' })).status).toBe(409);
    expect(await userXp(env, 'alice')).toBe(0);
  });

  it('validates config on save and bumps the version', async () => {
    const env = env0();
    expect((await admin(env, 'POST', '/gamification/config', { progression: { maxLevel: 1 } })).status).toBe(400);
    const ok = await admin(env, 'POST', '/gamification/config', { progression: { enabled: true, rules: { vote: { xp: 2, dailyCap: 20 } } } });
    expect(ok.status).toBe(200);
    const p = await getProgression(env);
    expect(p.cfg.enabled).toBe(true);
    expect(p.cfg.rules.vote).toMatchObject({ xp: 2, dailyCap: 20 });
    expect(p.cfg.version).toBe(2);
  });

  it('no endpoint lets a user grant themselves XP', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    for (const action of ['grantXp', 'awardXp', 'addXp']) {
      expect((await call(env, 'alice', action, { amount: 1000 })).status).toBe(400);
    }
    expect((await admin(env, 'POST', '/gamification/users/alice/xp', { amount: 10, reason: 'x'.repeat(5) }, 'alice')).status).toBe(403);
    expect(await userXp(env, 'alice')).toBe(0);
  });
});

// ===========================================================================
describe('level-based tournament eligibility', () => {
  it('refuses entry below the contest minimum level, before any fee moves', async () => {
    const env = env0();
    await seedUser(env, 'alice', { xp: 0, lockedCoins: 100, dpcoin: 100 });
    const ts = Date.now();
    await drizzleOf(env).insert(schema.contests).values({
      id: 'c1', title: 'Advanced', type: 'photo', status: 'live', totalEntryFee: 10, rewardCoins: 0, minLevel: 10, createdAt: ts,
    } as any);
    const r = await call(env, 'alice', 'startMatch', { contestId: 'c1', mediaUrl: 'https://cdn.test/x.jpg', mediaType: 'photo' });
    expect(r.status).toBe(412);
    expect(r.body.error?.message ?? JSON.stringify(r.body)).toContain('level 10');
    const u = await env.DB.prepare(`SELECT dpcoin FROM users WHERE uid = 'alice'`).first<any>();
    expect(u.dpcoin).toBe(100);
  });
});

// Exercise xpAwardStatements directly so a refactor cannot silently drop the gate.
describe('gated awards', () => {
  it('a false gate writes nothing', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    const p = await getProgression(env);
    const s = xpAwardStatements(env, p, { uid: 'alice', action: 'match_win', eventId: 'g1', ts: Date.now(), gate: '1 = 0' });
    await env.DB.batch(s.statements);
    expect(await userXp(env, 'alice')).toBe(0);
    const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM user_xp_events`).first<any>();
    expect(Number(n.n)).toBe(0);
  });
});

// ===========================================================================
describe('visual layer contract', () => {
  it('roadmap reports each milestone coin reward state from the user grants', async () => {
    const env = env0();
    const milestones = [
      { level: 2, title: 'Two', description: '', items: [], feature: null, coins: 10 },
      { level: 3, title: 'Three', description: '', items: [], feature: null, coins: 10 },
      { level: 5, title: 'Five', description: '', items: [], feature: null, coins: 10 },
      { level: 6, title: 'Six', description: '', items: [], feature: null, coins: 0 },
    ];
    await on(env, { milestones });
    await seedUser(env, 'alice', { xp: xpForLevel(4, CURVE) });
    await env.DB.prepare(`INSERT INTO reward_grants (id, uid, source_type, source_id, coins, status, created_at, updated_at) VALUES ('level:2:alice','alice','level','2',10,'claimed',1,1), ('level:3:alice','alice','level','3',10,'claimable',1,1)`).run();
    const r = await call(env, 'alice', 'getProgression');
    const byLevel = Object.fromEntries(r.body.roadmap.map((m: any) => [m.level, m.rewardState]));
    expect(byLevel).toEqual({ 2: 'claimed', 3: 'claimable', 5: 'pending', 6: 'none' });
  });

  it('with the experience off, the roadmap shows no coin rewards', async () => {
    const env = env0();
    await setProgression(env, { milestones: [{ level: 2, title: 'Two', description: '', items: [], feature: null, coins: 10 }] });
    await seedUser(env, 'alice', { xp: 600 });
    const r = await call(env, 'alice', 'getProgression');
    expect(r.body.roadmap[0]).toMatchObject({ coins: 0, rewardState: 'none' });
  });

  it('seeds a real Champion frame and grants it at level 50, with asset keys on default frames', async () => {
    const env = env0();
    const item = await env.DB.prepare(`SELECT type, json_extract(asset, '$.key') AS k FROM reward_catalog WHERE id = 'frame_champion'`).first<any>();
    expect(item).toEqual({ type: 'frame', k: 'frame.champion' });
    const bronze = await env.DB.prepare(`SELECT json_extract(asset, '$.key') AS k FROM reward_catalog WHERE id = 'frame_bronze'`).first<any>();
    expect(bronze.k).toBe('frame.bronze');
    await on(env);
    await seedUser(env, 'alice');
    await syncProgression(env, 'alice');
    await env.DB.prepare(`UPDATE users SET xp = ? WHERE uid = 'alice'`).bind(xpForLevel(50, CURVE)).run();
    await syncProgression(env, 'alice');
    const inv = await env.DB.prepare(`SELECT item_id FROM user_inventory WHERE uid = 'alice'`).all<any>();
    expect(inv.results?.map((r) => r.item_id)).toEqual(expect.arrayContaining(['frame_champion', 'title_champion']));
  });

  it('leaderboard rows carry the rank id for the emblem', async () => {
    const env = env0();
    await seedUser(env, 'a', { xp: xpForLevel(31, CURVE) });
    const r = await read(env, '/leaderboard/xp?period=lifetime');
    expect(r.body.rows[0]).toMatchObject({ rankId: 'champion', rankTitle: 'Champion', level: 31 });
  });

  it('rejects a malformed asset key on a catalog item', async () => {
    const env = env0();
    const bad = await admin(env, 'PUT', '/gamification/catalog/frame_x', { type: 'frame', name: 'X', rarity: 'rare', asset: { key: '../../evil' } });
    expect(bad.status).toBe(400);
    const ok = await admin(env, 'PUT', '/gamification/catalog/frame_x', { type: 'frame', name: 'X', rarity: 'rare', asset: { key: 'frame.gold' } });
    expect(ok.status).toBe(200);
  });

  it('public profiles expose levelInfo and resolved cosmetics but no XP history', async () => {
    const env = env0();
    await seedUser(env, 'bob', { xp: 1000 });
    await awardXp(env, { uid: 'bob', action: 'match_win', eventId: 'match_win:pp', ts: Date.now() });
    const pub = await read(env, '/users/bob', 'alice');
    expect(pub.body.levelInfo.level).toBeGreaterThan(1);
    expect(pub.body.recentXp).toBeUndefined();
    expect(JSON.stringify(pub.body)).not.toContain('match_win:pp');
    // Someone else's progression is not readable through the API either.
    await seedUser(env, 'alice');
    const mine = await call(env, 'alice', 'getProgression', { uid: 'bob' });
    expect(mine.body.levelInfo.xp).toBe(0);
  });
});

// ===========================================================================
describe('review fixes', () => {
  it('a post-launch account (level_seen set at signup) is paid for its first achievements', async () => {
    const env = env0();
    await on(env);
    await seedUser(env, 'newbie', { levelSeen: 1, profileImageUrl: 'https://cdn.test/a.jpg', bio: 'hi' });
    await syncProgression(env, 'newbie');
    expect(await userXp(env, 'newbie')).toBe(100); // profile_complete
    const a = await env.DB.prepare(`SELECT source, xp_awarded FROM user_achievements WHERE uid = 'newbie' AND achievement_id = 'profile_complete'`).first<any>();
    expect(a).toEqual({ source: 'progress', xp_awarded: 100 });
  });

  it('milestone grants are written in the same batch as the level-up, and only for a level actually seen', async () => {
    const env = env0();
    await on(env, { milestones: [{ level: 2, title: 'Two', description: '', items: [], feature: null, coins: 25 }] });
    await seedUser(env, 'alice', { levelSeen: 1 });
    await env.DB.prepare(`UPDATE users SET xp = 600 WHERE uid = 'alice'`).run();
    await Promise.all([syncProgression(env, 'alice'), syncProgression(env, 'alice')]);
    const g = await env.DB.prepare(`SELECT id, coins, status FROM reward_grants WHERE uid = 'alice'`).all<any>();
    expect(g.results).toEqual([{ id: 'level:2:alice', coins: 25, status: 'claimable' }]);
  });

  it('POST /admin/rewards cannot rewrite progression or move the curve', async () => {
    const env = env0();
    await on(env, { rewardBudgetId: null });
    const before = (await getProgression(env)).cfg;
    const r = await admin(env, 'POST', '/rewards', { dailyLoginReward: 12, progression: { enabled: false, milestones: [{ level: 2, title: 'x', description: '', items: [], coins: 99999 }] } });
    expect(r.status).toBe(200);
    const after = (await getProgression(env)).cfg;
    expect(after.enabled).toBe(true);
    expect(after.milestones).toEqual(before.milestones);
    expect((await admin(env, 'POST', '/rewards', { xpThreshold: 10 })).status).toBe(400);
    expect((await admin(env, 'POST', '/rewards', { xpThreshold: 500 })).status).toBe(200); // unchanged value is fine
  });

  it("a private account's achievement list is locked for non-followers", async () => {
    const env = env0();
    await seedUser(env, 'priv', { isPrivate: true });
    await seedUser(env, 'stranger');
    await env.DB.prepare(`INSERT INTO user_achievements (uid, achievement_id, tier, unlocked_at) VALUES ('priv', 'first_win', 1, 1)`).run();
    const guest = await read(env, '/users/priv/achievements');
    expect(guest.body).toEqual({ achievements: [], locked: true });
    const stranger = await read(env, '/users/priv/achievements', 'stranger');
    expect(stranger.body.achievements).toEqual([]);
    const own = await read(env, '/users/priv/achievements', 'priv');
    expect(own.body.achievements.map((a: any) => a.id)).toEqual(['first_win']);
    await seedUser(env, 'half', { signupCompleted: false });
    expect((await read(env, '/users/half/achievements')).body.achievements).toEqual([]);
  });

  it('season PATCH refuses to create an overlap', async () => {
    const env = env0();
    const day = DAY;
    const t0 = Date.now() + 10 * day;
    const a = await admin(env, 'POST', '/gamification/seasons', { name: 'A', startsAt: t0, endsAt: t0 + 10 * day });
    const b = await admin(env, 'POST', '/gamification/seasons', { name: 'B', startsAt: t0 + 20 * day, endsAt: t0 + 30 * day });
    expect([a.status, b.status]).toEqual([200, 200]);
    const bad = await admin(env, 'PATCH', `/gamification/seasons/${b.body.id}`, { startsAt: t0 + 5 * day });
    expect(bad.status).toBe(412);
  });

  it('an admin XP retry with the same Idempotency-Key never awards twice', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    const call2 = () => app.request('/admin/gamification/users/alice/xp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret', 'Idempotency-Key': 'k-1' },
      body: JSON.stringify({ amount: 40, reason: 'event bonus' }),
    }, env, fakeCtx());
    await call2();
    await call2();
    expect(await userXp(env, 'alice')).toBe(40);
  });

  it('reverseXp reports success from its own attempt only', async () => {
    const env = env0();
    await seedUser(env, 'alice');
    await awardXp(env, { uid: 'alice', action: 'match_win', eventId: 'match_win:n', ts: Date.now() });
    const ts = Date.now();
    const [x, y] = await Promise.all([
      reverseXp(env, { originalId: 'match_win:n', reason: 'r', ts }),
      reverseXp(env, { originalId: 'match_win:n', reason: 'r', ts }),
    ]);
    expect([x, y].filter((d) => d !== null)).toEqual([-100]);
  });

  it('getProgression no longer ranks the season, and returns recent unlocks for the reveal', async () => {
    const env = env0();
    await on(env);
    await seedUser(env, 'alice', { levelSeen: 1 });
    await env.DB.prepare(`INSERT INTO user_achievements (uid, achievement_id, tier, unlocked_at, xp_awarded, source) VALUES ('alice', 'first_vote', 1, ?, 25, 'progress')`).bind(Date.now()).run();
    const r = await call(env, 'alice', 'getProgression');
    expect(r.body.newlyUnlocked.map((a: any) => a.id)).toContain('first_vote');
  });
});
