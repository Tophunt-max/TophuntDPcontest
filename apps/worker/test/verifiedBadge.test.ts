/**
 * The admin-granted "verified" blue check, from the panel to the app's API.
 *
 * An admin could mark a user verified and the PANEL rendered a tick, but the flag
 * never reached the app: the profile response was served from a shared KV cache
 * that the admin write did not invalidate, and the list endpoints (search,
 * suggested, followers/following, leaderboard) did not select the column at all.
 * So the one place a blue check exists for showed nothing.
 *
 * These tests pin the whole path, because "the badge is missing" is invisible from
 * the server side — every endpoint returned 200 the entire time.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

vi.mock('../src/lib/firebaseAdmin', () => ({
  updateAuthUser: async () => undefined,
  createAuthUser: async () => 'uid',
  createCustomToken: async () => 't',
  getUserByEmail: async () => null,
  deleteAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

async function read(env: TestEnv, uid: string | null, path: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** Verify a user the way the admin panel does. */
async function adminVerify(env: TestEnv, uid: string, verified = true) {
  const res = await app.request(
    `/admin/users/${uid}/profile`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
      body: JSON.stringify({ verified }),
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
    .values({
      uid,
      username: uid,
      fullName: uid,
      status: 'active',
      dpcoin: 0,
      createdAt: ts,
      updatedAt: ts,
      ...extra,
    } as any);
}

const userRow = (env: TestEnv, uid: string) =>
  drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();

describe('admin verification reaches the app', () => {
  it('persists the flag and serves it on the profile', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    expect((await read(env, 'bob', '/users/alice')).body.verified).toBe(false);

    const res = await adminVerify(env, 'alice');
    expect(res.status).toBe(200);
    expect((await userRow(env, 'alice'))?.verified).toBe(true);
    expect((await read(env, 'bob', '/users/alice')).body.verified).toBe(true);
  });

  /**
   * The bug that made this invisible. The public profile comes from a shared KV
   * entry, so writing the row was not enough — the app kept serving the pre-edit
   * copy until the TTL lapsed, and "I verified them and nothing happened" is
   * exactly how that presents.
   */
  it('invalidates the cached profile so the badge appears immediately', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    // Warm the shared cache with the unverified copy.
    const before = await read(env, 'bob', '/users/alice');
    expect(before.body.verified).toBe(false);

    await adminVerify(env, 'alice');

    // No waiting for a TTL.
    expect((await read(env, 'bob', '/users/alice')).body.verified).toBe(true);
  });

  it('un-verifies just as immediately', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { verified: true });
    await seedUser(env, 'bob');
    await read(env, 'bob', '/users/alice'); // warm

    await adminVerify(env, 'alice', false);

    expect((await read(env, 'bob', '/users/alice')).body.verified).toBe(false);
  });
});

describe('the flag is present wherever a name is rendered', () => {
  /**
   * A badge that only exists on the profile screen is a badge most people never
   * see. These endpoints feed the lists, and none of them selected the column.
   */
  it('is returned by search', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alicecooper', { verified: true });
    await seedUser(env, 'bob');

    const res = await read(env, 'bob', '/users/search?q=alice');
    const hit = res.body.find((u: any) => u.id === 'alicecooper');
    expect(hit?.verified).toBe(true);
  });

  it('is returned by suggested users', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { verified: true });
    await seedUser(env, 'bob');

    const res = await read(env, 'bob', '/users/suggested');
    expect(res.body.find((u: any) => u.id === 'alice')?.verified).toBe(true);
  });

  it('is returned by the leaderboard', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { verified: true, wins: 10 });
    await seedUser(env, 'bob');

    const res = await read(env, 'bob', '/leaderboard');
    expect(res.body.find((u: any) => u.uid === 'alice')?.verified).toBe(true);
  });

  it('is returned by the followers and following lists', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { verified: true });
    await seedUser(env, 'bob');
    await drizzleOf(env)
      .insert(schema.follows)
      .values({ followerId: 'alice', followingId: 'bob', createdAt: Date.now() } as any);

    const followers = await read(env, 'bob', '/users/bob/followers');
    expect(followers.body.find((u: any) => u.id === 'alice')?.verified).toBe(true);

    const following = await read(env, 'alice', '/users/alice/following');
    expect(following.body.find((u: any) => u.id === 'bob')?.verified).toBe(false);
  });

  /**
   * The blue check is editorial and admin-only. It must never be confused with
   * `emailVerified` / `phoneVerified`, which record that a contact detail was
   * proven and are set by the user's own OTP flow.
   */
  it('is independent of email and phone verification', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { emailVerified: true, phoneVerified: true });
    await seedUser(env, 'bob');

    const res = await read(env, 'bob', '/users/alice');
    expect(res.body.emailVerified).toBe(true);
    expect(res.body.verified).toBe(false);
  });
});
