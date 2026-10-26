/**
 * Phase H: admin role boundaries and moderation that actually removes things.
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
const engagement = vi.hoisted(() => new Map<string, number>());
vi.mock('../src/lib/voteCounter', async (orig) => ({
  ...(await orig<any>()),
  bumpEngagement: async (_e: unknown, matchId: string, name: string, delta: number) => {
    if (name === 'comment') engagement.set(matchId, (engagement.get(matchId) ?? 0) + delta);
    return { comment: engagement.get(matchId) ?? 0 };
  },
  finalizeVotes: async () => ({ votesA: 0, votesB: 0, total: 0 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

async function user(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, dpcoin: 100, createdAt: ts - 3 * 86_400_000, updatedAt: ts, emailVerified: true, ...extra } as any);
}
async function api(env: TestEnv, uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` }, body: JSON.stringify({ action, ...data }) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
/** `as` is "secret" (full admin via X-Admin-Secret), or a bearer token like "mod:moderator". */
async function admin(env: TestEnv, as: string, method: string, path: string, body?: any) {
  const auth = as === 'secret' ? { 'X-Admin-Secret': 'test-admin-secret' } : { Authorization: `Bearer ${as}` };
  const res = await app.request(
    `/admin${path}`,
    { method, headers: { 'Content-Type': 'application/json', ...auth }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const MOD = 'mod:moderator';
async function world() {
  const { env } = makeEnv();
  for (const u of ['alice', 'bob', 'rep', 'mod']) await user(env, u);
  await drizzleOf(env).insert(schema.contestMatches).values({
    id: 'm1', status: 'active', type: 'photo', title: 'Battle', entryFee: 20, prizeCoins: 20,
    userA: { uid: 'alice', username: 'alice' }, userB: { uid: 'bob', username: 'bob' },
    createdAt: Date.now(), activatedAt: Date.now(), expiresAt: Date.now() + 3_600_000,
  } as any);
  return env;
}
const reportId = async (env: TestEnv) => ((await env.DB.prepare('SELECT id FROM reports LIMIT 1').first()) as any)?.id as string;

// ===========================================================================
describe('createReport', () => {
  it('needs a known type and an existing target that is not your own', async () => {
    const env = await world();
    expect((await api(env, 'rep', 'createReport', { targetType: 'banana', targetId: 'm1' })).status).toBe(400);
    expect((await api(env, 'rep', 'createReport', { targetType: 'match' })).status).toBe(400);
    expect((await api(env, 'rep', 'createReport', { targetType: 'match', targetId: 'nope' })).status).toBe(404);
    expect((await api(env, 'rep', 'createReport', { targetType: 'user', targetId: 'rep' })).status).toBe(400);
    expect((await api(env, 'alice', 'createReport', { targetType: 'match', targetId: 'm1' })).status).toBe(400);
  });

  it('aliases of one type are one report, not one each', async () => {
    const env = await world();
    for (const t of ['match', 'contestMatch', 'contestMatches']) {
      expect((await api(env, 'rep', 'createReport', { targetType: t, targetId: 'm1' })).status).toBe(200);
    }
    const n = await env.DB.prepare('SELECT COUNT(*) n FROM reports').first<any>();
    expect(n.n).toBe(1);
  });
});

// ===========================================================================
describe('resolving a report with "remove"', () => {
  it('a moderator cannot refund a live battle: it is held instead, and the report stays open', async () => {
    const env = await world();
    await api(env, 'rep', 'createReport', { targetType: 'match', targetId: 'm1' });
    const r = await admin(env, MOD, 'POST', `/reports/${await reportId(env)}/resolve`, { action: 'remove' });
    expect(r.status).toBe(202);
    expect(r.body.held).toBe(true);
    const m = await drizzleOf(env).select().from(schema.contestMatches).where(eq(schema.contestMatches.id, 'm1')).get();
    expect(m?.status).toBe('active');
    expect(m?.moderationHoldAt).toBeGreaterThan(0);
    expect(await reportId(env)).toBeTruthy();
  });

  it('a full admin removing it cancels and refunds, and closes every report on it', async () => {
    const env = await world();
    await user(env, 'rep2');
    await api(env, 'rep', 'createReport', { targetType: 'match', targetId: 'm1' });
    await api(env, 'rep2', 'createReport', { targetType: 'contestMatch', targetId: 'm1' });
    expect((await admin(env, 'secret', 'POST', `/reports/${await reportId(env)}/resolve`, { action: 'remove' })).status).toBe(200);
    const m = await drizzleOf(env).select().from(schema.contestMatches).where(eq(schema.contestMatches.id, 'm1')).get();
    expect(m?.status).toBe('cancelled');
    // Closed for every reporter (both aliases), kept as 'actioned' so each one
    // sees the outcome under My reports (migration 0067), and out of the queue.
    const rows = (await env.DB.prepare('SELECT status, resolved_at FROM reports').all<any>()).results;
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.status === 'actioned' && r.resolved_at > 0)).toBe(true);
    expect((await admin(env, 'secret', 'GET', '/reports')).body).toEqual([]);
    const notes = (await env.DB.prepare("SELECT recipient_id FROM notifications WHERE type = 'report_update' ORDER BY recipient_id").all<any>()).results;
    expect(notes.map((n: any) => n.recipient_id)).toEqual(['rep', 'rep2']);
  });

  it('removes a reported battle comment (it lives in match_comments) and notifies its author', async () => {
    const env = await world();
    engagement.set('m1', 1);
    await drizzleOf(env).insert(schema.matchComments).values({ id: 'mc1', matchId: 'm1', userId: 'bob', text: 'spam', createdAt: Date.now() } as any);
    await api(env, 'rep', 'createReport', { targetType: 'comment', targetId: 'mc1' });
    const r = await admin(env, MOD, 'POST', `/reports/${await reportId(env)}/resolve`, { action: 'remove' });
    expect(r.body).toMatchObject({ removed: true });
    expect(await drizzleOf(env).select().from(schema.matchComments).where(eq(schema.matchComments.id, 'mc1')).get()).toBeUndefined();
    expect(engagement.get('m1')).toBe(0);
    const note = await env.DB.prepare("SELECT title FROM notifications WHERE recipient_id = 'bob' AND type = 'moderation'").first<any>();
    expect(note?.title).toBe('Content removed');
  });

  it('refuses to "remove" an account (block it instead) and keeps the report', async () => {
    const env = await world();
    await api(env, 'rep', 'createReport', { targetType: 'user', targetId: 'bob' });
    const r = await admin(env, 'secret', 'POST', `/reports/${await reportId(env)}/resolve`, { action: 'remove' });
    expect(r.status).toBe(412);
    expect(await reportId(env)).toBeTruthy();
  });

  it('rejects an unknown action', async () => {
    const env = await world();
    await api(env, 'rep', 'createReport', { targetType: 'match', targetId: 'm1' });
    expect((await admin(env, 'secret', 'POST', `/reports/${await reportId(env)}/resolve`, { action: 'nuke' })).status).toBe(400);
  });
});

// ===========================================================================
describe('moderator boundaries', () => {
  it('cannot run the blog importer', async () => {
    const env = await world();
    expect((await admin(env, MOD, 'POST', '/blog/import', { posts: [] })).status).toBe(403);
    expect((await admin(env, MOD, 'POST', '/blog/import/discover', {})).status).toBe(403);
  });

  it('does not see voter device ids or the device fraud view', async () => {
    const env = await world();
    await env.DB.prepare("INSERT INTO votes (id, match_id, voter_uid, voted_for_uid, device_id, created_at) VALUES ('m1_rep','m1','rep','alice','dev-1',1)").run();
    const mod = await admin(env, MOD, 'GET', '/matches/m1/votes');
    expect(mod.status).toBe(200);
    expect(mod.body[0].deviceId).toBeUndefined();
    expect((await admin(env, 'secret', 'GET', '/matches/m1/votes')).body[0].deviceId).toBe('dev-1');
    expect((await admin(env, MOD, 'GET', '/fraud/votes')).status).toBe(403);
  });

  it('sees dashboard and analytics counts but no revenue', async () => {
    const env = await world();
    const ov = await admin(env, MOD, 'GET', '/overview');
    expect(ov.status).toBe(200);
    expect(ov.body.users).toBeDefined();
    expect(Object.keys(ov.body).some((k) => /^revenue/i.test(k))).toBe(false);
    const an = await admin(env, MOD, 'GET', '/analytics');
    expect(Object.keys(an.body).some((k) => /^revenue/i.test(k))).toBe(false);
    expect(Object.keys((await admin(env, 'secret', 'GET', '/analytics')).body)).toContain('revenue7dInr');
  });
});

// ===========================================================================
describe('audit trail', () => {
  it('records reward-settings changes and an error-log wipe', async () => {
    const env = await world();
    expect((await admin(env, 'secret', 'POST', '/rewards', { dailyLoginReward: 15 })).status).toBe(200);
    expect((await admin(env, 'secret', 'DELETE', '/logs')).status).toBe(200);
    const rows = (await env.DB.prepare('SELECT action FROM admin_audit_log').all<any>()).results.map((r: any) => r.action);
    expect(rows).toEqual(expect.arrayContaining(['settings.rewards.update', 'logs.clear']));
  });
});

describe('set-role', () => {
  it('rejects an unknown role instead of granting admin', async () => {
    const env = await world();
    const r = await admin(env, 'secret', 'POST', '/set-role', { userId: 'rep', role: 'superadmin' });
    expect(r.status).toBe(400);
    const u = await drizzleOf(env).select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.uid, 'rep')).get();
    expect(u?.role ?? 'user').not.toBe('admin');
  });
});
