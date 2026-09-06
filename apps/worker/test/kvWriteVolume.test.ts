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

    // The candidate pool and the per-viewer ranked order moved to isolate memory,
    // so they cost no KV write at all. Their TTLs (45s / 60s) made them ~1,920 and
    // ~1,440 writes a day, each on its own over the whole Worker's 1,000/day
    // budget, so this assertion is the one that keeps the quota fix honest.
    expect(puts.filter((k) => k.startsWith('cache:matches:cand:'))).toHaveLength(0);
    expect(puts.filter((k) => k.startsWith('cache:feedorder:'))).toHaveLength(0);

    // What is left for a whole feed page: the fatigue flush, the settings blob and
    // the viewer's block set. Fixed, and independent of how often the feed loads.
    expect(puts).toHaveLength(3);
  });

  it('does not re-flush until the interval has elapsed, then does', async () => {
    // `fakeKV` ignores `expirationTtl`, so nothing in this suite expires on its own
    // and elapsed time has to be simulated. The flush gate is `now - flushedAt`, so
    // ageing `flushedAt` in the isolate copy is exactly equivalent to waiting —
    // and it pins down the one behaviour a wall-clock test could never cover
    // cheaply: that the interval is actually consulted. Without this, a change
    // making FEED_SEEN_FLUSH_INTERVAL_MS effectively infinite would keep every
    // other test in this file green.
    const { env } = makeEnv();
    await seedFeed(env);

    await loadFeed(env, 'alice'); // first load flushes (flushedAt starts at 0)
    const puts = recordPuts(env);

    await loadFeed(env, 'alice');
    await loadFeed(env, 'alice');
    expect(puts.filter((k) => k === feedSeenKey('alice'))).toHaveLength(0);

    // Age the last flush past the 5-minute interval.
    const state = memoGet<any>(feedSeenKey('alice'))!;
    state.flushedAt = Date.now() - 6 * 60_000;

    await loadFeed(env, 'alice');
    expect(puts.filter((k) => k === feedSeenKey('alice'))).toHaveLength(1);
  });

  it('merges with the durable copy instead of overwriting another isolate’s counts', async () => {
    const { env } = makeEnv();
    await seedFeed(env);

    await loadFeed(env, 'alice');
    // Stand in for a second isolate that flushed a higher count for m2 and an id
    // this isolate has never served.
    await env.CACHE_KV.put(
      feedSeenKey('alice'),
      JSON.stringify({ v: 2, map: { m2: 9, elsewhere: 4 }, flushedAt: Date.now() }),
    );

    const state = memoGet<any>(feedSeenKey('alice'))!;
    state.flushedAt = Date.now() - 6 * 60_000; // due a flush
    await loadFeed(env, 'alice');

    const durable = JSON.parse(env.CACHE_KV._map.get(feedSeenKey('alice'))!);
    // Per-id max, so the other isolate's higher count survives...
    expect(durable.map.m2).toBe(9);
    // ...and an id only it had seen is not dropped.
    expect(durable.map.elsewhere).toBe(4);
    // This isolate's own counts are still there.
    expect(durable.map.m1).toBeGreaterThan(0);
  });

  it('does not erase fatigue when the KV read fails', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    await env.CACHE_KV.put(feedSeenKey('alice'), JSON.stringify({ v: 2, map: { m1: 40 }, flushedAt: 0 }));

    // A read ERROR must not be read as "this viewer has seen nothing", because the
    // empty map would be memoised and then flushed over the real history.
    const realGet = env.CACHE_KV.get.bind(env.CACHE_KV);
    env.CACHE_KV.get = async (key: string, type?: any) => {
      if (key === feedSeenKey('alice')) throw new Error('KV unavailable');
      return realGet(key, type);
    };

    const puts = recordPuts(env);
    await loadFeed(env, 'alice');
    expect(puts.filter((k) => k === feedSeenKey('alice'))).toHaveLength(0);
    expect(memoGet(feedSeenKey('alice'))).toBeUndefined();

    env.CACHE_KV.get = realGet;
    const durable = JSON.parse(env.CACHE_KV._map.get(feedSeenKey('alice'))!);
    expect(durable.map.m1).toBe(40);
  });

  it('does not try to read an envelope version it does not understand', async () => {
    const { env } = makeEnv();
    await seedFeed(env);
    // What a newer deploy might write. Cloudflare rollouts are not atomic across
    // colos, so this code will see it. Reading it as a count map would increment
    // `map.map` to NaN and flush `null` back, corrupting it for every reader.
    await env.CACHE_KV.put(
      feedSeenKey('alice'),
      JSON.stringify({ v: 99, map: { m1: 5 }, somethingNew: true }),
    );

    await loadFeed(env, 'alice');

    const live = memoGet<any>(feedSeenKey('alice'))!;
    expect(live.map.m1).toBe(1); // started over, rather than misreading
    expect(Number.isNaN(live.map.map)).toBe(false);
    expect(live.map.map).toBeUndefined();
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

  it('carries over a legacy bare-map fatigue value and upgrades it in place', async () => {
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

    // A legacy value parses with flushedAt 0, so it is due a flush immediately —
    // which is what migrates the stored shape forward. Asserted on the durable
    // copy, not just the isolate's, because the migration is the point.
    const durable = JSON.parse(env.CACHE_KV._map.get(feedSeenKey('alice'))!);
    expect(durable.v).toBe(2);
    expect(durable.map.m1).toBe(8);
    expect(durable.map.retired).toBe(3);
  });
});

describe('settings reads are not one KV write per ttl lapse', () => {
  // Settings are deliberately NOT memoised in isolate memory — `appConfig` carries
  // the `payoutsFrozen` fraud kill-switch, and an in-memory copy could not be
  // invalidated from the isolate that flipped it. The saving comes from the longer
  // KV ttl instead, which is safe precisely because the delete below is global.
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

    // An admin edit must be live on the very next read, not after the ttl —
    // otherwise a saved setting looks like it did not save, and the payout
    // kill-switch would not be a kill-switch.
    await db
      .update(schema.settings)
      .set({ data: { feedWeights: { follow: 1 } } } as any)
      .where(eq(schema.settings.id, 'appConfig'));
    await invalidateSetting(env as any, 'appConfig');
    expect((await getAppConfig(env as any)).feedWeights.follow).toBe(1);
  });
});

describe('KV_WRITES_DISABLED', () => {
  it('serves the feed while spending zero cache writes', async () => {
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

  it('does NOT switch off rate limiting — including fail-OPEN money guards', async () => {
    const { env } = makeEnv({ KV_WRITES_DISABLED: 'true' });
    const { consumeRateLimit } = await import('../src/lib/rateLimit');

    // This is the invariant the flag's documentation rests on, and the first
    // version of the flag broke it. Skipping every counter without
    // `failClosed: true` looked safe, but `failClosed` means "refuse if the
    // counter is unreadable", NOT "this guard protects money" — and `deposit`,
    // `ad` (mints withdrawable coins), `vidup` (Bunny spend), `create` (the only
    // per-IP signup limit) and `exportdata` (PII) are all fail-OPEN by omission.
    // So no rate limit may be affected by this flag, whatever its options.
    expect(await consumeRateLimit(env as any, 'deposit:alice', 2, 3600)).toBe(true);
    expect(await consumeRateLimit(env as any, 'deposit:alice', 2, 3600)).toBe(true);
    expect(await consumeRateLimit(env as any, 'deposit:alice', 2, 3600)).toBe(false);

    // A fail-open engagement throttle is equally unaffected.
    expect(await consumeRateLimit(env as any, 'like:alice', 1, 60)).toBe(true);
    expect(await consumeRateLimit(env as any, 'like:alice', 1, 60)).toBe(false);

    const opts = { failClosed: true };
    expect(await consumeRateLimit(env as any, 'withdraw:alice', 1, 3600, opts)).toBe(true);
    expect(await consumeRateLimit(env as any, 'withdraw:alice', 1, 3600, opts)).toBe(false);
  });
});
