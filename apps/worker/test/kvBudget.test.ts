/**
 * KV BUDGET — the cost regression suite for the quota that actually ran out.
 *
 * ---------------------------------------------------------------------------
 * What this file is defending
 * ---------------------------------------------------------------------------
 * The Workers free plan allows 100,000 KV reads but only 1,000 KV WRITES per day,
 * and when the write budget is gone every `put` in the Worker returns 429 until
 * 00:00 UTC — silently disabling every cache in the app at once.
 *
 * The arithmetic that made this unavoidable, and that no ordinary test can see:
 *
 *   KV's MINIMUM expiration TTL is 60 seconds (`KV_MIN_TTL_SEC`), and a key that is
 *   read continuously is rewritten once per TTL lapse. So the FLOOR cost of any hot
 *   KV cache key is 86400 / 60 = 1,440 writes/day — 44% over the entire Worker's
 *   daily budget, for ONE key.
 *
 * There were roughly a dozen such keys (`cache:matches:*` with a combinatorial key
 * space, `cache:contest:list:*` x3, `cache:leaderboard:*`, `cache:user:{uid}` per hot
 * profile, `cache:comments:*` per active thread, …). Adding a Cache API tier in front
 * did NOT fix it, because an edge tier saves READS and leaves the write rate to the
 * KV TTL. The fix was to take KV out of those paths entirely.
 *
 * ---------------------------------------------------------------------------
 * Why it has to be asserted by counting
 * ---------------------------------------------------------------------------
 * A regression here produces a byte-identical response body. Someone "restoring the
 * durable tier" on a hot endpoint, or giving a new cache a 30-second KV TTL because
 * 30 seconds is the freshness they want, reintroduces the outage with a green test
 * suite and a plausible commit message. Only the write count shows it.
 *
 * Same spirit as `fakeR2._deleted` in the harness and as test/kvWriteVolume.test.ts,
 * which covers the feed's own write-behind path.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({ like: 1, comment: 1, share: 1 }),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));
vi.mock('../src/lib/publish', () => ({ publish: async () => {}, publishMany: async () => {} }));

import { makeEnv, makeApp, fakeCtx, drizzleOf, installEdgeCache, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { READ_CACHE_TTLS } from '../src/routes/read';
import { KV_MIN_TTL_SEC } from '../src/lib/cache';

const app = makeApp();

let edge: ReturnType<typeof installEdgeCache>;
beforeEach(() => {
  edge = installEdgeCache();
});
afterEach(() => {
  edge.restore();
});

/** Every key written to / read from CACHE_KV from this point on. */
function recordKv(env: TestEnv) {
  const puts: string[] = [];
  const gets: string[] = [];
  const origPut = env.CACHE_KV.put.bind(env.CACHE_KV);
  const origGet = env.CACHE_KV.get.bind(env.CACHE_KV);
  env.CACHE_KV.put = async (key: string, value: string, opts?: any) => {
    puts.push(key);
    return origPut(key, value, opts);
  };
  env.CACHE_KV.get = async (key: string, type?: any) => {
    gets.push(key);
    return origGet(key, type);
  };
  return { puts, gets };
}

async function seed(env: TestEnv) {
  const ts = Date.now();
  const db = drizzleOf(env);
  for (const uid of ['alice', 'bob']) {
    await db
      .insert(schema.users)
      .values({ uid, username: uid, fullName: uid, dpcoin: 1000, wins: 3, xp: 10, createdAt: ts, updatedAt: ts } as any);
  }
  await db.insert(schema.contests).values({
    id: 'c1',
    title: 'Contest one',
    type: 'photo',
    status: 'live',
    totalEntryFee: 40,
    rewardCoins: 60,
    createdBy: 'alice',
    createdAt: ts,
    updatedAt: ts,
  } as any);
  await db.insert(schema.contestMatches).values({
    id: 'm1',
    contestId: 'c1',
    status: 'active',
    type: 'photo',
    title: 'Battle m1',
    entryFee: 20,
    joinIdA: 'm1-a',
    userA: { uid: 'alice', username: 'alice', mediaUrl: 'a.jpg', votes: 0 },
    userB: { uid: 'bob', username: 'bob', mediaUrl: 'b.jpg', votes: 0 },
    totalVotes: 0,
    likeCount: 0,
    commentCount: 1,
    shareCount: 0,
    minVotesRequired: 0,
    prizeCoins: 20,
    createdAt: ts,
    activatedAt: ts,
    expiresAt: ts + 86_400_000,
  } as any);
  await db
    .insert(schema.matchComments)
    .values({ id: 'cm1', matchId: 'm1', userId: 'bob', text: 'nice', createdAt: ts } as any);
  await db
    .insert(schema.follows)
    .values({ followerId: 'bob', followingId: 'alice', createdAt: ts } as any);
  await db.insert(schema.blogPosts).values({
    id: 'p1',
    slug: 'hello',
    title: 'Hello',
    content: '<p>x</p>',
    status: 'published',
    publishedAt: ts,
    createdAt: ts,
    updatedAt: ts,
    viewCount: 0,
  } as any);
}

/**
 * The public read endpoints that were, together, the entire KV write problem.
 *
 * Each is requested repeatedly below: the point is that the write count does not grow
 * with the request count, and in fact is zero.
 */
const HOT_ENDPOINTS: Array<{ name: string; path: string }> = [
  { name: 'contest list', path: '/read/contests' },
  { name: 'contest list (filtered)', path: '/read/contests?type=photo' },
  { name: 'contest detail', path: '/read/contests/c1' },
  { name: 'match page', path: '/read/matches?status=active&sort=recent' },
  { name: 'match page (hot sort)', path: '/read/matches?status=active&sort=hot' },
  { name: 'leaderboard', path: '/read/leaderboard?by=wins' },
  { name: 'user profile', path: '/read/users/alice' },
  { name: 'followers', path: '/read/users/alice/followers' },
  { name: 'following', path: '/read/users/bob/following' },
  { name: 'comments', path: '/read/comments?targetType=matches&targetId=m1' },
  { name: 'blog list', path: '/read/blog' },
  { name: 'blog post', path: '/read/blog/hello' },
  { name: 'blog categories', path: '/read/blog/categories' },
  { name: 'app config', path: '/read/app-config' },
  { name: 'legal', path: '/read/legal' },
  { name: 'coin packages', path: '/read/coin-packages' },
];

describe('the hot public read endpoints spend ZERO KV writes', () => {
  for (const { name, path } of HOT_ENDPOINTS) {
    it(`${name}`, async () => {
      const { env } = makeEnv();
      await seed(env);
      const { puts } = recordKv(env);

      for (let i = 0; i < 6; i++) {
        const res = await app.request(path, {}, env, fakeCtx());
        expect(res.status, `${path} should serve 200`).toBe(200);
      }

      // `settings:*` is a deliberate exception — see the dedicated test below. It is a
      // fixed, tiny number of keys with a long backstop TTL, not a per-content or
      // per-user key, so it does not scale with traffic.
      const cacheWrites = puts.filter((k) => !k.startsWith('settings:'));
      expect(cacheWrites, `${path} wrote to KV: ${cacheWrites.join(', ')}`).toHaveLength(0);
    });
  }

  it('signed-in reads do not spend writes either, beyond the per-user block set', async () => {
    const { env } = makeEnv();
    await seed(env);
    const { puts } = recordKv(env);

    for (let i = 0; i < 6; i++) {
      for (const { path } of HOT_ENDPOINTS) {
        await app.request(path, { headers: { Authorization: 'Bearer bob' } }, env, fakeCtx());
      }
    }

    // `cache:blocks:{uid}` is the other deliberate KV survivor: it needs a globally
    // visible delete because it is a SAFETY filter, so it cannot move to a per-colo or
    // per-isolate tier. What matters is that it is written once per user per TTL
    // (3600s) rather than per request — so across 96 requests, exactly one write.
    const blockWrites = puts.filter((k) => k.startsWith('cache:blocks:'));
    expect(blockWrites).toHaveLength(1);

    const unexpected = puts.filter((k) => !k.startsWith('settings:') && !k.startsWith('cache:blocks:'));
    expect(unexpected, `unexpected KV writes: ${unexpected.join(', ')}`).toHaveLength(0);
  });
});

describe('the caches deliberately left on KV stay cheap', () => {
  it('writes each settings blob once across many reads', async () => {
    // `appConfig` carries `payoutsFrozen`, the fraud kill-switch, so this cache MUST
    // keep a globally-visible delete and therefore MUST stay on KV. Its cost is
    // controlled by the backstop TTL instead: at 1800s that is ~48 writes/day per id.
    const { env } = makeEnv();
    await drizzleOf(env)
      .insert(schema.settings)
      .values({ id: 'appConfig', data: { supportEmail: 'x@y.z' }, updatedAt: Date.now() } as any);

    const { getAppConfig, invalidateSetting } = await import('../src/lib/settings');
    const { puts } = recordKv(env);
    for (let i = 0; i < 12; i++) await getAppConfig(env as any);
    expect(puts.filter((k) => k === 'settings:appConfig')).toHaveLength(1);

    // ...and an admin edit is still live on the very next read, which is the property
    // that makes the long TTL safe.
    await invalidateSetting(env as any, 'appConfig');
    await getAppConfig(env as any);
    expect(puts.filter((k) => k === 'settings:appConfig')).toHaveLength(2);
  });

  it('writes a user block set once across many lookups', async () => {
    const { env } = makeEnv();
    const { hiddenUidsFor, invalidateBlockCache } = await import('../src/lib/blocks');
    const { puts } = recordKv(env);
    for (let i = 0; i < 12; i++) await hiddenUidsFor(env as any, 'alice');
    expect(puts.filter((k) => k === 'cache:blocks:alice')).toHaveLength(1);

    // A new block is visible immediately regardless of the TTL, because the delete is
    // global. That is the whole reason this one is allowed to remain on KV.
    await invalidateBlockCache(env as any, 'alice');
    await hiddenUidsFor(env as any, 'alice');
    expect(puts.filter((k) => k === 'cache:blocks:alice')).toHaveLength(2);
  });
});

describe('no KV TTL may sit under the platform floor', () => {
  it('holds for every declared read-cache lifetime', () => {
    // A sub-floor TTL is not a shorter cache: `cachePutJson` clamps it up to 60s. That
    // clamp silently added 20-40s to three documented ceilings, and doubled the wallet
    // balance staleness on `cache:user`, while the old test asserted the DECLARED
    // arithmetic and stayed green.
    for (const [name, t] of Object.entries(READ_CACHE_TTLS)) {
      if (t.kv === null) continue;
      expect(t.kv, `${name}: kv ttl below the ${KV_MIN_TTL_SEC}s floor`).toBeGreaterThanOrEqual(KV_MIN_TTL_SEC);
    }
  });

  it('holds for the caches that are still KV-backed', async () => {
    // Guards the three survivors by behaviour rather than by reading their constants:
    // whatever TTL they pass must be honourable as written.
    const { env } = makeEnv();
    const ttls: number[] = [];
    env.CACHE_KV.put = async (_k: string, _v: string, opts?: any) => {
      if (opts?.expirationTtl != null) ttls.push(Number(opts.expirationTtl));
    };
    await drizzleOf(env)
      .insert(schema.settings)
      .values({ id: 'appConfig', data: {}, updatedAt: Date.now() } as any);

    const { getAppConfig } = await import('../src/lib/settings');
    const { hiddenUidsFor } = await import('../src/lib/blocks');
    await getAppConfig(env as any);
    await hiddenUidsFor(env as any, 'alice');

    expect(ttls.length).toBeGreaterThan(0);
    for (const ttl of ttls) expect(ttl).toBeGreaterThanOrEqual(KV_MIN_TTL_SEC);
  });
});

describe('the Firebase credential caches are not an N+1', () => {
  it('reads the access token from KV once per isolate, not once per push', async () => {
    // THE BUG THIS EXISTS FOR. `notify.deliverToTokens` fans out over a user's devices
    // with `tokens.map(t => sendFcmToToken(...))`, and every `sendFcmToToken` called
    // `getAccessToken`, which read KV. So one notification to a three-device user cost
    // three KV reads (six with the retry), and `drainBroadcastJobs` repeats that for
    // 100 recipients per cron tick — several hundred reads to send one broadcast page,
    // all fetching the same string.
    const { env } = makeEnv();
    const { memoReset } = await import('../src/lib/memo');
    memoReset();

    await env.CACHE_KV.put(
      'firebase:access_token',
      JSON.stringify({ token: 'tok-123', expiresAt: Date.now() + 3_600_000 }),
    );
    const { gets } = recordKv(env);

    const { getAccessToken } = await import('../src/lib/firebaseAdmin');
    // CONCURRENT, because that is the real shape: `deliverToTokens` uses
    // `Promise.all(tokens.map(...))`. A plain value cache does not help here — every
    // call starts before any has populated it — so this specifically pins the
    // in-flight coalescing, which is the part that actually collapses the fan-out.
    const tokens = await Promise.all(Array.from({ length: 25 }, () => getAccessToken(env as any)));

    expect(tokens.every((t) => t === 'tok-123')).toBe(true);
    expect(gets.filter((k) => k === 'firebase:access_token')).toHaveLength(1);

    // And once warm, subsequent calls read nothing at all.
    await getAccessToken(env as any);
    expect(gets.filter((k) => k === 'firebase:access_token')).toHaveLength(1);
  });

  it('never memoises a token for longer than KV would have served it', async () => {
    // The safety property that makes memoising a credential acceptable at all: the
    // isolate copy is derived from the issuer's own expiry, so it cannot outlive the
    // durable one. Here the stored token expires within the skew window, so it must be
    // treated as spent rather than handed out.
    const { env } = makeEnv();
    const { memoReset, memoGet } = await import('../src/lib/memo');
    memoReset();
    await env.CACHE_KV.put(
      'firebase:access_token',
      JSON.stringify({ token: 'stale', expiresAt: Date.now() + 5_000 }),
    );
    const { getAccessToken } = await import('../src/lib/firebaseAdmin');
    // No service account configured, so minting a fresh token fails — which is the
    // proof that the stale one was NOT reused.
    await expect(getAccessToken(env as any)).rejects.toBeTruthy();
    expect(memoGet('firebase:access_token')).toBeUndefined();
  });

  it('reads the JWKS from KV once per isolate, not once per authenticated request', async () => {
    const { env } = makeEnv();
    const { memoReset } = await import('../src/lib/memo');
    memoReset();
    await env.CACHE_KV.put(
      'firebase:jwks',
      JSON.stringify({ keys: { keys: [] }, expiresAt: Date.now() + 3_600_000 }),
    );
    const { gets } = recordKv(env);

    // `importActual`, because this suite mocks `firebaseAuth` at the top so the route
    // tests can use a fake bearer token — and the thing under test here is the REAL
    // verifier's key-set fetch. Every token below is invalid, which is fine: the key
    // set is fetched BEFORE verification, so the KV reads are what this measures.
    const { verifyIdToken } = await vi.importActual<typeof import('../src/lib/firebaseAuth')>(
      '../src/lib/firebaseAuth',
    );
    await Promise.all(
      Array.from({ length: 20 }, () => verifyIdToken('not-a-real-token', env as any).catch(() => {})),
    );
    expect(gets.filter((k) => k === 'firebase:jwks')).toHaveLength(1);
  });
});

describe('the deep health check really re-probes', () => {
  it('reads KV on every call rather than answering from a cached result', async () => {
    // THE BUG THIS EXISTS FOR. Caching a healthy `/health/deep` was tried as a brake on
    // its amplification (one unauthenticated HTTP request -> five backend probes), and
    // it broke the deploy gate: `.github/workflows/deploy-worker.yml` gates every deploy
    // on this endpoint returning 200, Cache API entries SURVIVE a deploy, so a 200
    // written seconds before `wrangler deploy` would satisfy the gate with
    // `computeDeepHealth` never running against the new code. The endpoint exists to
    // exercise D1, KV and R2; a cache hit exercises none of them. The brake is a per-IP
    // rate limit instead.
    //
    // WHAT THIS DOES AND DOES NOT PROVE. `src/index.ts` cannot be imported in Node (it
    // registers Durable Objects, which need `cloudflare:workers`), so the harness app
    // does not mount the route and this asserts the probe function rather than the
    // handler. It pins the half that could regress silently — a memo or a short-circuit
    // creeping into `computeDeepHealth` — and NOT the handler's `no-store`, which is
    // currently the absence of caching code and would take a deliberate edit to undo.
    const { env } = makeEnv();
    const { gets } = recordKv(env);
    const { computeDeepHealth } = await import('../src/lib/health');

    for (let i = 0; i < 3; i++) await computeDeepHealth(env as any);

    // One probe read per call, not one in total.
    expect(gets.filter((k) => k === 'health:probe')).toHaveLength(3);
  });
});

describe('job state and payment intents are not in KV', () => {
  it('keeps blog import progress in D1, so an import cannot exhaust the write quota', async () => {
    // This was one KV write per import BATCH with a 24h ttl, so a single import of a
    // few thousand URLs produced hundreds of writes and could take the whole
    // application's caching offline for the rest of the day.
    const { env } = makeEnv();
    const { puts } = recordKv(env);
    const { writeImportProgress, readImportProgress } = await import('../src/lib/importerTask');

    for (let i = 0; i < 30; i++) {
      await writeImportProgress(env as any, { processed: i, total: 30 });
    }
    expect(puts).toHaveLength(0);
    expect(await readImportProgress(env as any)).toMatchObject({ processed: 29, total: 30 });
  });

  it('treats a stale progress document as absent, matching the old KV ttl', async () => {
    // A D1 row has no expiry. Without an age check, a finished run from last month
    // would keep being reported as the importer's current state, where the KV entry
    // simply vanished after 24h.
    const { env } = makeEnv();
    const { writeImportProgress, readImportProgress, IMPORT_PROGRESS_SETTING_ID } = await import(
      '../src/lib/importerTask'
    );
    const { eq } = await import('drizzle-orm');

    await writeImportProgress(env as any, { processed: 1 });
    await drizzleOf(env)
      .update(schema.settings)
      .set({ updatedAt: Date.now() - 2 * 86_400_000 } as any)
      .where(eq(schema.settings.id, IMPORT_PROGRESS_SETTING_ID));

    expect(await readImportProgress(env as any)).toBeNull();
  });
});
