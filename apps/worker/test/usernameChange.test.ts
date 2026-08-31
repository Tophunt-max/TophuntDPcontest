/**
 * Changing your username via profile edit (updateProfile action).
 *
 * The in-app rename must be held to the SAME rules signup is — global
 * uniqueness, length, character set, reserved names — or the edit path is a way
 * around them (two accounts sharing a handle, or grabbing "support" to phish in
 * DMs). These pin that contract at the API layer.
 *
 * The vote counter lives in a Durable Object that can't start here, so it's
 * mocked like the other /api tests; updateProfile never touches it.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 0, votesB: 0, total: 0, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

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

async function seedUser(env: TestEnv, uid: string, username: string) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username, fullName: uid, status: 'active', dpcoin: 0, createdAt: ts, updatedAt: ts } as any);
}

const usernameOf = async (env: TestEnv, uid: string) =>
  (await drizzleOf(env).select({ u: schema.users.username }).from(schema.users).where(eq(schema.users.uid, uid)).get())?.u;

describe('username change via updateProfile', () => {
  it('changes to an available username, stored lowercase', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 'alice');
    const r = await call(env, 'alice', 'updateProfile', { fullName: 'Alice', username: 'Alice_New' });
    expect(r.status).toBe(200);
    expect(await usernameOf(env, 'alice')).toBe('alice_new');
  });

  it('rejects taking a username already used by someone else', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 'alice');
    await seedUser(env, 'bob', 'bob');
    const r = await call(env, 'alice', 'updateProfile', { fullName: 'Alice', username: 'bob' });
    expect(r.status).toBe(409);
    // unchanged
    expect(await usernameOf(env, 'alice')).toBe('alice');
  });

  it('lets a user keep their own username (case-insensitive, not a self-collision)', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 'alice');
    const r = await call(env, 'alice', 'updateProfile', { fullName: 'Alice', username: 'ALICE' });
    expect(r.status).toBe(200);
    expect(await usernameOf(env, 'alice')).toBe('alice');
  });

  it('rejects a reserved username', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 'alice');
    const r = await call(env, 'alice', 'updateProfile', { fullName: 'Alice', username: 'support' });
    expect(r.status).toBe(400);
    expect(await usernameOf(env, 'alice')).toBe('alice');
  });

  it('rejects a too-short username', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 'alice');
    const r = await call(env, 'alice', 'updateProfile', { fullName: 'Alice', username: 'ab' });
    expect(r.status).toBe(400);
  });

  it('rejects an invalid character set', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', 'alice');
    const r = await call(env, 'alice', 'updateProfile', { fullName: 'Alice', username: 'bad name!' });
    expect(r.status).toBe(400);
  });
});
