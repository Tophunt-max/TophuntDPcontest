/**
 * Admin vote-fraud analysis — GET /admin/matches/:id/vote-audit.
 *
 * This is the DETECTION half of the anti-cheat story: the vote path can't safely
 * block multi-account/cross-device stuffing (per-IP dedup would reject legit
 * carrier-NAT voters), so the outcome is surfaced for a human to judge. These
 * tests pin the aggregation an admin relies on: same-IP clusters (with the side
 * each backed), reused devices, and freshly-created accounts.
 *
 * Pure D1 (no Durable Object), so it runs in this harness by seeding `votes`
 * rows directly — which is exactly what the DO would have flushed.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();
const HOUR = 60 * 60 * 1000;

async function audit(env: TestEnv, id: string) {
  const res = await app.request(
    `/admin/matches/${id}/vote-audit`,
    { headers: { 'X-Admin-Secret': 'test-admin-secret' } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedUser(env: TestEnv, uid: string, createdAt: number) {
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, status: 'active', dpcoin: 0, createdAt, updatedAt: createdAt } as any);
}

async function seedMatch(env: TestEnv, id: string, createdAt: number) {
  await drizzleOf(env)
    .insert(schema.contestMatches)
    .values({
      id,
      status: 'active',
      title: `Battle ${id}`,
      userA: { uid: 'alice', username: 'alice', votes: 0 },
      userB: { uid: 'bob', username: 'bob', votes: 0 },
      totalVotes: 0,
      entryFee: 20,
      createdAt,
      expiresAt: createdAt + 86_400_000,
    } as any);
}

async function seedVote(
  env: TestEnv,
  matchId: string,
  voterUid: string,
  votedForUid: string,
  opts: { ip?: string | null; deviceId?: string | null; at?: number } = {},
) {
  const at = opts.at ?? Date.now();
  await drizzleOf(env)
    .insert(schema.votes)
    .values({
      id: `${matchId}_${voterUid}`,
      matchId,
      voterUid,
      votedForUid,
      deviceId: opts.deviceId ?? null,
      ip: opts.ip ?? null,
      createdAt: at,
    } as any);
}

describe('vote-audit fraud analysis', () => {
  it('flags an IP shared by several voters and which side it backed', async () => {
    const { env } = makeEnv();
    const t0 = Date.now();
    await seedMatch(env, 'm1', t0);
    await seedUser(env, 'alice', t0 - 30 * 86_400_000);
    await seedUser(env, 'bob', t0 - 30 * 86_400_000);
    // Three voters from ONE IP all backing alice (classic stuffing), one clean
    // voter from a different IP backing bob.
    await seedUser(env, 'v1', t0 - 10 * 86_400_000);
    await seedUser(env, 'v2', t0 - 10 * 86_400_000);
    await seedUser(env, 'v3', t0 - 10 * 86_400_000);
    await seedUser(env, 'v4', t0 - 10 * 86_400_000);
    await seedVote(env, 'm1', 'v1', 'alice', { ip: '1.1.1.1', deviceId: 'd1' });
    await seedVote(env, 'm1', 'v2', 'alice', { ip: '1.1.1.1', deviceId: 'd2' });
    await seedVote(env, 'm1', 'v3', 'alice', { ip: '1.1.1.1', deviceId: 'd3' });
    await seedVote(env, 'm1', 'v4', 'bob', { ip: '2.2.2.2', deviceId: 'd4' });

    const { status, body } = await audit(env, 'm1');
    expect(status).toBe(200);
    expect(body.totalVotes).toBe(4);
    expect(body.distinctIps).toBe(2);
    expect(body.ipClusters).toHaveLength(1);
    expect(body.ipClusters[0]).toMatchObject({ ip: '1.1.1.1', count: 3, forA: 3, forB: 0 });
    expect(body.clusteredIpVotes).toBe(3);
  });

  it('reports no signal for a clean battle (all distinct IPs, established accounts)', async () => {
    const { env } = makeEnv();
    const t0 = Date.now();
    await seedMatch(env, 'm2', t0);
    await seedUser(env, 'alice', t0 - 30 * 86_400_000);
    await seedUser(env, 'bob', t0 - 30 * 86_400_000);
    await seedUser(env, 'a', t0 - 40 * 86_400_000);
    await seedUser(env, 'b', t0 - 40 * 86_400_000);
    await seedVote(env, 'm2', 'a', 'alice', { ip: '10.0.0.1', deviceId: 'da' });
    await seedVote(env, 'm2', 'b', 'bob', { ip: '10.0.0.2', deviceId: 'db' });

    const { body } = await audit(env, 'm2');
    expect(body.ipClusters).toHaveLength(0);
    expect(body.deviceReuse).toHaveLength(0);
    expect(body.freshAccounts.forA).toBe(0);
    expect(body.freshAccounts.forB).toBe(0);
  });

  it('flags freshly-created accounts voting (minted around the match start)', async () => {
    const { env } = makeEnv();
    const t0 = Date.now();
    await seedMatch(env, 'm3', t0);
    await seedUser(env, 'alice', t0 - 30 * 86_400_000);
    await seedUser(env, 'bob', t0 - 30 * 86_400_000);
    // Two brand-new accounts (created 1h before the match) both back alice.
    await seedUser(env, 'sock1', t0 - HOUR);
    await seedUser(env, 'sock2', t0 - HOUR);
    // An old, organic account backs bob.
    await seedUser(env, 'real', t0 - 100 * 86_400_000);
    await seedVote(env, 'm3', 'sock1', 'alice', { ip: '3.3.3.1', deviceId: 's1' });
    await seedVote(env, 'm3', 'sock2', 'alice', { ip: '3.3.3.2', deviceId: 's2' });
    await seedVote(env, 'm3', 'real', 'bob', { ip: '3.3.3.3', deviceId: 's3' });

    const { body } = await audit(env, 'm3');
    expect(body.freshAccounts.forA).toBe(2);
    expect(body.freshAccounts.forB).toBe(0);
    expect(body.freshAccounts.voters.length).toBe(2);
  });

  it('requires full-admin auth', async () => {
    const { env } = makeEnv();
    await seedMatch(env, 'm4', Date.now());
    const res = await app.request(`/admin/matches/m4/vote-audit`, {}, env, fakeCtx());
    expect(res.status).toBeGreaterThanOrEqual(401);
  });
});
