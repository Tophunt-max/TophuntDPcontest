import { describe, it, expect, vi } from 'vitest';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
// `authTime` is stamped "now" so the session-revocation gate behaves realistically.
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { authStateCacheKey } from '../src/lib/cache';

const app = makeApp();

/** GET an authenticated /read endpoint as `uid`. */
async function get(env: TestEnv, uid: string, path: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: { Authorization: `Bearer ${uid}` } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

/** Admin blocks / unblocks via the panel's PATCH route (X-Admin-Secret = superadmin). */
async function setBlocked(env: TestEnv, uid: string, isBlocked: boolean) {
  const res = await app.request(
    `/admin/users/${uid}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
      body: JSON.stringify({ isBlocked }),
    },
    env,
    fakeCtx(),
  );
  return res.status;
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 1000, createdAt: ts, updatedAt: ts, ...extra } as any);
}

const AUTHED_ROUTE = '/notifications/unread-count'; // requireAuth -> hits readAccountState

describe('SCALE_TIER — auth-state cache (the one free->paid lever)', () => {
  it('free tier (default): serves the request but NEVER writes the auth-state cache key', async () => {
    const { env } = makeEnv(); // SCALE_TIER unset => "free"
    await seedUser(env, 'alice');

    const r = await get(env, 'alice', AUTHED_ROUTE);
    expect(r.status).toBe(200);
    // The whole point on free: zero extra KV writes.
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(false);
  });

  it('unrecognised SCALE_TIER value is treated as free (typo can never incur paid writes)', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'PAID_PLAN_YES' as any });
    await seedUser(env, 'alice');

    const r = await get(env, 'alice', AUTHED_ROUTE);
    expect(r.status).toBe(200);
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(false);
  });

  it('paid tier: caches the auth-state after the first authenticated request', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'paid' });
    await seedUser(env, 'alice');

    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(false);
    const r = await get(env, 'alice', AUTHED_ROUTE);
    expect(r.status).toBe(200);
    // Now present — subsequent authed requests read it instead of hitting D1.
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(true);
  });

  it('paid tier: blocking invalidates the cache AND the next request is refused (403)', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'paid' });
    await seedUser(env, 'alice');

    // Prime the cache while alice is in good standing.
    expect((await get(env, 'alice', AUTHED_ROUTE)).status).toBe(200);
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(true);

    // Admin blocks alice.
    expect(await setBlocked(env, 'alice', true)).toBe(200);
    // The cached (stale, "not blocked") copy was dropped — this is what makes the
    // block take effect NOW rather than after the 60s TTL.
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(false);

    // The next request re-reads fresh D1 state and is refused. Moderation is
    // checked before revocation, so this is a 403 permission-denied, not a 401.
    expect((await get(env, 'alice', AUTHED_ROUTE)).status).toBe(403);
  });

  it('auto tier: caches the auth-state like paid (safe on any plan via fail-open writes)', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'auto' });
    await seedUser(env, 'alice');

    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(false);
    const r = await get(env, 'alice', AUTHED_ROUTE);
    expect(r.status).toBe(200);
    // "auto" attempts the cache (like paid); on paid it succeeds, on free the put
    // simply fails open — either way the request is served correctly.
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(true);
  });

  it('auto tier: blocking still invalidates immediately (revocation is a DELETE, not gated by tier)', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'auto' });
    await seedUser(env, 'alice');

    expect((await get(env, 'alice', AUTHED_ROUTE)).status).toBe(200);
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(true);

    expect(await setBlocked(env, 'alice', true)).toBe(200);
    // The invalidation delete drops the cached copy — this is what keeps a block
    // immediate even on a free plan whose write budget is exhausted.
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(false);
    expect((await get(env, 'alice', AUTHED_ROUTE)).status).toBe(403);
  });

  it('paid tier: unblocking invalidates the cache so access is restored immediately', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'paid' });
    await seedUser(env, 'alice', { isBlocked: true, status: 'blocked' });

    // A blocked account is refused, and that refusal gets cached.
    expect((await get(env, 'alice', AUTHED_ROUTE)).status).toBe(403);
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(true);

    // Admin unblocks. Unblock does NOT revoke sessions, so the explicit
    // invalidateAuthState in the PATCH handler is the only thing that clears the
    // cached "blocked" copy.
    expect(await setBlocked(env, 'alice', false)).toBe(200);
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(false);

    // Access restored on the very next request.
    expect((await get(env, 'alice', AUTHED_ROUTE)).status).toBe(200);
  });
});
