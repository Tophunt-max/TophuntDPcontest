/**
 * Level is DERIVED from XP on read, never served from the stored `users.level`
 * column.
 *
 * Nothing updates `users.level` any more — XP is incremented atomically inline
 * wherever it is earned, and the old `awardXp` that wrote the level column was
 * removed. So the stored column is frozen at its seeded value, and the profile /
 * leaderboard must compute the level from the authoritative `xp` instead. These
 * tests pin that: a deliberately WRONG stored level is ignored.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
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

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

/** Seed a user with an explicit xp and a deliberately wrong stored level. */
async function seedUser(env: TestEnv, uid: string, xp: number, storedLevel: number) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({
      uid,
      username: uid,
      fullName: uid,
      status: 'active',
      dpcoin: 0,
      xp,
      level: storedLevel,
      createdAt: ts,
      updatedAt: ts,
    } as any);
}

/** Owner read is uncached, so it is the clean way to assert the derived value. */
const ownProfile = async (env: TestEnv, uid: string) => {
  const res = await app.request(
    `/read/users/${uid}`,
    { headers: { Authorization: `Bearer ${uid}` } },
    env,
    fakeCtx(),
  );
  return (await res.json()) as any;
};

const seedGamification = async (env: TestEnv, data: Record<string, unknown>) => {
  await drizzleOf(env).insert(schema.settings).values({
    id: 'gamification', data: data as any, updatedAt: Date.now(),
  } as any);
  await env.CACHE_KV.delete('settings:gamification');
};

describe('level is derived from xp, not the stored column', () => {
  // Defaults: xpThreshold = xpIncrement = 500 → L2 @500, L3 @1500, L4 @3000.
  it('computes the profile level from xp and ignores a stale stored level', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 1600, 1); // 1600 xp → level 3; stored 1 is wrong

    const body = await ownProfile(env, 'alice');
    expect(body.xp).toBe(1600);
    expect(body.level).toBe(3);
  });

  it('never trusts an inflated stored level', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 0, 99); // no xp → level 1, no matter the stored 99

    const body = await ownProfile(env, 'alice');
    expect(body.level).toBe(1);
  });

  it('derives the leaderboard level from each row xp', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 3000, 1); // level 4
    await seedUser(env, 'bob', 500, 1);    // level 2

    const res = await app.request('/read/leaderboard?by=xp', {}, env, fakeCtx());
    const rows = (await res.json()) as any[];
    const byUid = Object.fromEntries(rows.map((r) => [r.uid, r.level]));
    expect(byUid.alice).toBe(4);
    expect(byUid.bob).toBe(2);
  });

  it('respects the admin xpThreshold/xpIncrement when computing the level', async () => {
    const { env } = makeEnv();
    // A smaller threshold makes the same xp worth a higher level.
    await seedGamification(env, { xpThreshold: 100, xpIncrement: 100 });
    await seedUser(env, 'alice', 300, 1); // @100/100: L2@100, L3@300 → level 3

    const body = await ownProfile(env, 'alice');
    expect(body.level).toBe(3);
  });
});
