/**
 * SCALE_TIER="auto" adapts to an exhausted KV daily write quota (lib/kvQuota.ts).
 *
 * On a free account the auth-state cache used to spend the 1,000/day KV write
 * budget every day, starving settings / blocks / feed-seen caches. After the first
 * daily-limit failure, `auto` now reads the account state from D1 directly for a
 * week and the isolate stops attempting doomed KV puts until UTC midnight.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { memoReset } from '../src/lib/memo';
import {
  AUTO_BACKOFF_MS,
  __resetKvQuotaForTests,
  autoAuthCacheAllowed,
  isKvDailyLimitError,
  kvPutsSuspended,
  noteKvPutFailure,
} from '../src/lib/kvQuota';

const app = makeApp();
const DAILY = new Error('KV put() limit exceeded for the day.');

beforeEach(() => {
  __resetKvQuotaForTests();
  memoReset();
});

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.users).values({ uid, username: uid, fullName: uid, createdAt: ts, updatedAt: ts, ...extra } as any);
}
async function get(env: TestEnv, uid: string) {
  const res = await app.request('/read/notifications/unread-count', { headers: { Authorization: `Bearer ${uid}` } }, env, fakeCtx());
  return res.status;
}
function countPuts(env: TestEnv, fail = false) {
  const keys: string[] = [];
  const orig = env.CACHE_KV.put.bind(env.CACHE_KV);
  env.CACHE_KV.put = (async (k: string, v: string, o?: any) => {
    keys.push(k);
    if (fail) throw DAILY;
    return orig(k, v, o);
  }) as any;
  const fn = () => keys.length;
  fn.keys = keys;
  return fn;
}

describe('KV daily-limit detection', () => {
  it('recognises the daily limit and nothing else', () => {
    expect(isKvDailyLimitError(DAILY)).toBe(true);
    expect(isKvDailyLimitError(new Error('KV PUT failed: 429 Too Many Requests'))).toBe(false);
    expect(isKvDailyLimitError(new Error('network connection lost'))).toBe(false);
  });

  it('suspends puts until the next UTC midnight', async () => {
    const { env } = makeEnv();
    const t = Date.UTC(2026, 9, 18, 15, 0, 0);
    expect(await noteKvPutFailure(env as any, DAILY, t)).toBe(true);
    expect(kvPutsSuspended(t + 60_000)).toBe(true);
    expect(kvPutsSuspended(Date.UTC(2026, 9, 19, 0, 0, 1))).toBe(false);
  });

  it('a per-key 429 does not suspend anything', async () => {
    const { env } = makeEnv();
    expect(await noteKvPutFailure(env as any, new Error('429 Too Many Requests'))).toBe(false);
    expect(kvPutsSuspended()).toBe(false);
  });
});

describe('SCALE_TIER=auto after the quota trips', () => {
  it('keeps serving, persists the event once, and stops attempting KV puts', async () => {
    const { env, db } = makeEnv({ SCALE_TIER: 'auto' });
    await seedUser(env, 'alice');
    const puts = countPuts(env, true);

    expect(await get(env, 'alice')).toBe(200); // the failing put is fail-open
    expect(puts()).toBe(1);
    const row = db.prepare("SELECT data FROM settings WHERE id = 'kvQuota'").get() as any;
    expect(JSON.parse(row.data).lastExhaustedAt).toBeGreaterThan(0);

    for (let i = 0; i < 5; i++) expect(await get(env, 'alice')).toBe(200);
    expect(puts()).toBe(1); // no further doomed puts this isolate
  });

  it('a fresh isolate (memo + local flag reset) still skips the auth cache for the backoff', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'auto' });
    await seedUser(env, 'alice');
    countPuts(env, true);
    await get(env, 'alice');
    __resetKvQuotaForTests(); // new isolate: only the D1 row survives
    memoReset();
    const puts = countPuts(env, false);
    expect(await get(env, 'alice')).toBe(200);
    // No auth-state write — the budget goes to the other caches (here the block list).
    expect(puts.keys).not.toContain(authStateCacheKey('alice'));
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(false);
  });

  it('a block is enforced immediately while backed off (D1 is read directly)', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'auto' });
    await seedUser(env, 'alice');
    countPuts(env, true);
    await get(env, 'alice');
    await drizzleOf(env).update(schema.users).set({ isBlocked: true } as any);
    expect(await get(env, 'alice')).toBe(403);
  });

  it('re-enables the auth cache once the backoff has passed', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'auto' });
    const old = Date.now() - AUTO_BACKOFF_MS - 1000;
    await noteKvPutFailure(env as any, DAILY, old);
    __resetKvQuotaForTests();
    memoReset();
    expect(await autoAuthCacheAllowed(env as any)).toBe(true);
  });

  it('paid is not backed off (paid KV writes bill instead of failing)', async () => {
    const { env } = makeEnv({ SCALE_TIER: 'paid' });
    await seedUser(env, 'alice');
    await noteKvPutFailure(env as any, DAILY, Date.now() - 2 * 86_400_000); // an old free-plan event
    __resetKvQuotaForTests();
    memoReset();
    expect(await get(env, 'alice')).toBe(200);
    expect(env.CACHE_KV._map.has(authStateCacheKey('alice'))).toBe(true);
  });
});
