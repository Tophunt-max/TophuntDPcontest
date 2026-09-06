/**
 * KV WRITE VOLUME — a cost regression suite.
 *
 * The Workers free plan allows 100,000 KV reads but only 1,000 KV **writes** per
 * day, and when the write budget is gone every `put` in the Worker returns 429
 * until 00:00 UTC. That is not hypothetical: with no real users at all, one
 * person exercising the app exhausted it in about three hours, and Cloudflare
 * emailed to say KV was blocked. Reads at the time were under 1% used.
 *
 * The cause was `bumpSeen`, which wrote the viewer's impression-fatigue map on
 * every single feed request with no ttl gating whatsoever — measured at 12 writes
 * for 12 feed loads. Nothing about the RESPONSE changes when that regresses, so
 * no ordinary assertion catches it; only counting the writes does.
 *
 * These tests therefore assert on `CACHE_KV.put` call counts, in the same spirit
 * as `fakeR2._deleted` in the harness: a cost regression produces a byte-identical
 * response body and so goes unnoticed for months.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// The vote/engagement counters live in a Durable Object, which cannot start in
// this harness.
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({ like: 1, comment: 1, share: 1 }),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { feedSeenKey } from '../src/lib/cache';
import { memoGet } from '../src/lib/memo';

const app = makeApp();

/** Record every key written to CACHE_KV from this point on. */
function recordPuts(env: TestEnv): string[] {
  const puts: string[] = [];
  const orig = env.CACHE_KV.put.bind(env.CACHE_KV);
  env.CACHE_KV.put = async (key: string, value: string, opts?: any) => {
    puts.push(key);
    return orig(key, value, opts);
  };
  return puts;
}

async function seedFeed(env: TestEnv) {
  const ts = Date.now();
  const db = drizzleOf(env);
  for (const uid of ['alice', 'bob']) {
    await db
      .insert(schema.users)
      .values({ uid, username: uid, fullName: uid, dpcoin: 1000, createdAt: ts, updatedAt: ts } as any);
  }
  for (const [id, a, b] of [
    ['m1', 'alice', 'bob'],
    ['m2', 'bob', 'alice'],
  ] as const) {
    await db.insert(schema.contestMatches).values({
      id,
      status: 'active',
      type: 'photo',
      title: `Battle ${id}`,
      entryFee: 20,
      joinIdA: `${id}-a`,
      userA: { uid: a, username: a, mediaUrl: `${a}.jpg`, votes: 0 },
      userB: { uid: b, username: b, mediaUrl: `${b}.jpg`, votes: 0 },
      totalVotes: 0,
      likeCount: 0,
      commentCount: 0,
      shareCount: 0,
      minVotesRequired: 0,
      prizeCoins: 20,
      createdAt: ts,
      activatedAt: ts,
      expiresAt: ts + 86_400_000,
    } as any);
  }
}

/** The personalised feed — the path that used to write on every request. */
async function loadFeed(env: TestEnv, uid: string) {
  const res = await app.request(
    '/read/matches?status=active&sort=foryou',
    { headers: { Authorization: `Bearer ${uid}` } },
    env,
    fakeCtx(),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { items: any[]; nextCursor: number | null };
}

describe('feed reads do not scale KV writes with request count', () => {
  it('writes the fatigue map ONCE across many feed loads', async () => {
    const { env } = makeEnv();
    await seedFeed(env);

    const puts = recordPuts(env);
    for (let i = 0; i < 12; i++) {
      expect((await loadFeed(env, 'alice')).items.length).toBeGreaterThan(0);
    }

    // Before the write-behind was throttled this was 12 — one per request.
    expect(puts.filter((k) => k === feedSeenKey('alice'))).toHaveLength(1);
    // The rest of the feed's caches are each written once and then re-served, so
    // the whole page stays a fixed cost no matter how often it is refreshed.
    expect(puts).toHaveLength(5);
  });

  it('keeps counting impressions in memory while the durable copy stays throttled', async () => {
    const { env } = makeEnv();
    await seedFeed(env);

    for (let i = 0; i < 5; i++) await loadFeed(env, 'alice');

    // KV holds the first flush only...
    const durable = JSON.parse(env.CACHE_KV._map.get(feedSeenKey('alice'))!);
    expect(durable.v).toBe(2);
    expect(durable.map.m1).toBe(1);
    // ...while the isolate has the true count, which is what the ranker reads.
    // Throttling the FLUSH rather than the counting is what makes the saving free.
    expect(memoGet<any>(feedSeenKey('alice'))!.map.m1).toBe(5);
  });

  it('carries over a legacy bare-map fatigue value instead of resetting it', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    // The shape written before the throttle landed: the value IS the map. These
    // entries have a 3-day ttl, so they keep arriving after a deploy and must not
    // be read as "no impressions yet".
    await env.CACHE_KV.put(feedSeenKey('alice'), JSON.stringify({ m1: 7, retired: 3 }));

    await loadFeed(env, 'alice');

    const live = memoGet<any>(feedSeenKey('alice'))!;
    expect(live.map.m1).toBe(8); // 7 carried over, +1 for this load
    expect(live.map.retired).toBe(3); // an entry this load did not touch survives
  });
});

describe('settings reads are not one KV write per ttl lapse', () => {
  it('writes once for many reads, and an admin edit is still immediate', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await db
      .insert(schema.settings)
      .values({ id: 'appConfig', data: { feedWeights: { follow: 9 } }, updatedAt: Date.now() } as any);

    const { getAppConfig, invalidateSetting } = await import('../src/lib/settings');
    const puts = recordPuts(env);
    for (let i = 0; i < 10; i++) await getAppConfig(env as any);
    expect(puts).toHaveLength(1);

    // The memo must not outlive an invalidation, or a saved setting would appear
    // not to have saved.
    await db
      .update(schema.settings)
      .set({ data: { feedWeights: { follow: 1 } } } as any)
      .where(eq(schema.settings.id, 'appConfig'));
    await invalidateSetting(env as any, 'appConfig');
    expect((await getAppConfig(env as any)).feedWeights.follow).toBe(1);
  });
});

describe('KV_WRITES_DISABLED', () => {
  it('serves the feed while spending zero KV writes', async () => {
    const { env } = makeEnv({ KV_WRITES_DISABLED: 'true' });
    await seedFeed(env);

    const puts = recordPuts(env);
    for (let i = 0; i < 8; i++) {
      // Still a correct response — the caches fail open to D1, which is the same
      // path they take when KV is unavailable.
      expect((await loadFeed(env, 'alice')).items.length).toBeGreaterThan(0);
    }
    expect(puts).toHaveLength(0);
  });

  it('does NOT switch off a fail-closed rate limit', async () => {
    const { env } = makeEnv({ KV_WRITES_DISABLED: 'true' });
    const { consumeRateLimit } = await import('../src/lib/rateLimit');

    // Fail-open engagement throttle: skipped, because it is the high-volume
    // writer and a deployment with no users has nothing to throttle.
    for (let i = 0; i < 5; i++) {
      expect(await consumeRateLimit(env as any, 'like:alice', 2, 60)).toBe(true);
    }

    // Money / credential guard: keeps counting regardless of the switch. A config
    // flag is not allowed to hand an unlimited burst to a payout endpoint.
    const opts = { failClosed: true };
    expect(await consumeRateLimit(env as any, 'withdraw:alice', 2, 3600, opts)).toBe(true);
    expect(await consumeRateLimit(env as any, 'withdraw:alice', 2, 3600, opts)).toBe(true);
    expect(await consumeRateLimit(env as any, 'withdraw:alice', 2, 3600, opts)).toBe(false);
  });
});
