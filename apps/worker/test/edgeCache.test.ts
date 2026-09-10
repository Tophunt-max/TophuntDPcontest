/**
 * The read cache: Cloudflare Cache API, with KV deliberately no longer under it.
 *
 * The harness's default `caches` stub is always-miss / never-store, which keeps every
 * other suite deterministic but means the edge tier is exercised by nothing. This file
 * installs a cache that really stores, because two properties matter here and neither
 * can be checked any other way.
 *
 *   1. AN EDGE HIT MUST NOT SKIP PER-VIEWER AUTHORIZATION.
 *
 *      That is the whole reason `cachedJson` returns DATA rather than a Response.
 *      `cachedResponse` returns the cached response and so returns from the handler
 *      early — correct for a fully public endpoint, and a data leak on any endpoint
 *      that gates or filters per viewer. If someone "simplifies" a call site from one
 *      to the other, the tests below are what fails.
 *
 *   2. THE HOT READ PATHS MUST NOT WRITE TO KV.
 *
 *      Not a style rule. KV's minimum TTL is 60s, so a continuously-read KV cache key
 *      costs at least 1,440 writes/day against a free-plan budget of 1,000/day for the
 *      whole Worker — one hot key was over budget on its own. Nothing about a RESPONSE
 *      changes when a KV write creeps back in, so only counting the writes catches it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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
vi.mock('../src/lib/publish', () => ({
  publish: async () => {},
  publishMany: async () => {},
}));

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

async function seedBattle(env: TestEnv) {
  const ts = Date.now();
  const db = drizzleOf(env);
  for (const uid of ['alice', 'bob', 'carol']) {
    await db
      .insert(schema.users)
      .values({ uid, username: uid, fullName: uid, dpcoin: 1000, createdAt: ts, updatedAt: ts } as any);
  }
  await db.insert(schema.contestMatches).values({
    id: 'm1',
    status: 'active',
    type: 'photo',
    title: 'Battle m1',
    entryFee: 20,
    joinIdA: 'm1-a',
    userA: { uid: 'alice', username: 'alice', mediaUrl: 'alice.jpg', votes: 0 },
    userB: { uid: 'bob', username: 'bob', mediaUrl: 'bob.jpg', votes: 0 },
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

/** `sort=recent` is the page-cached list (not the personalised feed). */
async function listMatches(env: TestEnv, uid: string | null) {
  const res = await app.request(
    '/read/matches?status=active&sort=recent',
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  expect(res.status).toBe(200);
  return { body: (await res.json()) as any[], headers: res.headers };
}

describe('cache lifetimes', () => {
  it('never declares a KV ttl below the platform floor', () => {
    // THE BUG THIS EXISTS FOR. `cachePutJson` clamps sub-60s TTLs up to 60s, so a
    // table entry declaring `kv: 20` did not produce a 20-second cache — it produced a
    // 60-second one, and three ceilings here were quietly exceeded by 20-40s for
    // months. The old version of this suite asserted `edge + kv <= ceiling` on the
    // DECLARED numbers, which is exactly why it never noticed. A KV ttl must now
    // either be absent or be honourable as written.
    for (const [name, t] of Object.entries(READ_CACHE_TTLS)) {
      if (t.kv === null) continue;
      expect(t.kv, `${name}: a kv ttl below ${KV_MIN_TTL_SEC}s is silently clamped up`).toBeGreaterThanOrEqual(
        KV_MIN_TTL_SEC,
      );
    }
  });

  it('keeps every worst-case staleness inside its declared ceiling', () => {
    // The tiers COMPOSE when both are present: a colo that misses the edge cache while
    // the KV entry is nearly expired promotes that already-old value for a further
    // `edge` seconds, so the bound is `edge + kv`, not `kv`.
    for (const [name, t] of Object.entries(READ_CACHE_TTLS)) {
      expect(t.edge + (t.kv ?? 0), `${name}: worst-case staleness exceeds its ceiling`).toBeLessThanOrEqual(
        t.ceiling,
      );
    }
  });

  it('keeps the tail short on the keys a writer can purge', () => {
    // For an edge-only key the writer's own colo is purged immediately and every other
    // colo converges within `edge`, so `edge` IS the post-invalidation tail. It covers
    // DELETE and UNPUBLISH too, which is why the blog rows are the shortest in the
    // table — a post pulled for legal reasons is the case this bound is chosen for.
    for (const [name, t] of Object.entries(READ_CACHE_TTLS)) {
      if (!t.invalidated) continue;
      expect(t.edge, `${name}: post-invalidation tail is too long`).toBeLessThanOrEqual(60);
    }
  });
});

describe('the hot read paths spend no KV writes', () => {
  it('serves many identical list requests without touching KV', async () => {
    const { env } = makeEnv();
    await seedBattle(env);

    const puts = recordPuts(env);
    for (let i = 0; i < 10; i++) {
      expect((await listMatches(env, null)).body).toHaveLength(1);
    }
    // Previously: one KV write per 60s lapse per key variant, i.e. 1,440/day each.
    expect(puts.filter((k) => k.startsWith('cache:matches:'))).toHaveLength(0);
    expect(puts).toHaveLength(0);
  });

  it('caches the list at the edge and serves the second request from it', async () => {
    const { env } = makeEnv();
    await seedBattle(env);

    await listMatches(env, null);
    expect(edge.logicalKeys().some((k) => k.startsWith('cache:matches:active:all:recent:'))).toBe(true);

    // Delete the row: only a cache hit can still return the battle.
    await drizzleOf(env).delete(schema.contestMatches);
    expect((await listMatches(env, null)).body).toHaveLength(1);
  });

  it('recomputes from D1 when the Cache API is unavailable, and still writes nothing to KV', async () => {
    // The `*.workers.dev` host that older app builds still call gets no Cache API, so
    // this is the legacy-client path. It must be correct and it must stay off KV — the
    // point of the change is that the durable tier is gone, not that it is conditional.
    const { env } = makeEnv();
    await seedBattle(env);
    (globalThis as any).caches = undefined;

    const puts = recordPuts(env);
    expect((await listMatches(env, null)).body).toHaveLength(1);
    expect((await listMatches(env, null)).body).toHaveLength(1);
    expect(puts).toHaveLength(0);

    // ...and it is genuinely uncached, i.e. reading D1 every time.
    await drizzleOf(env).delete(schema.contestMatches);
    expect((await listMatches(env, null)).body).toHaveLength(0);
  });

  it('keys the edge entry on the CACHE key, not the request url', async () => {
    const { env } = makeEnv();
    await seedBattle(env);
    await listMatches(env, null);

    const [key] = edge.keys();
    // A reserved path plus the logical key, so a reader and a purging writer in another
    // file cannot disagree about what is stored, and an irrelevant query parameter
    // cannot mint a duplicate entry.
    expect(key).toContain('/__edge');
    expect(decodeURIComponent(key)).toContain('cache:matches:active:all:recent:');
  });

  it('stores with a Cache-Control max-age, which is what sets the edge ttl', async () => {
    const { env } = makeEnv();
    await seedBattle(env);
    await listMatches(env, null);
    const [entry] = [...edge.store.values()];
    expect(entry.cacheControl).toBe(`public, max-age=${READ_CACHE_TTLS.matchesPage.edge}`);
  });
});

describe('an edge hit still runs per-viewer authorization', () => {
  it('filters a blocked participant out of a cached list', async () => {
    const { env } = makeEnv();
    await seedBattle(env);

    // Warm the cache from an unauthenticated request, so the stored entry is
    // definitely the unfiltered, shared one.
    expect((await listMatches(env, null)).body).toHaveLength(1);

    // carol blocks alice, who is a participant in the cached battle.
    await drizzleOf(env)
      .insert(schema.userBlocks)
      .values({ blockerId: 'carol', blockedId: 'alice', createdAt: Date.now() } as any);

    // The cached entry is served, and the block filter is applied to it on the way
    // out. If the handler had returned the cached RESPONSE instead of the cached
    // DATA, carol would see the battle she is not allowed to see.
    const carol = await listMatches(env, 'carol');
    expect(carol.body).toHaveLength(0);
    expect(carol.headers.get('Cache-Control')).toBe('private, no-store');

    // ...and the shared entry is unharmed: another viewer still sees the battle, so
    // one viewer's exclusions were never written into it.
    expect((await listMatches(env, 'bob')).body).toHaveLength(1);
    expect((await listMatches(env, null)).body).toHaveLength(1);
  });

  it('never marks an authenticated response publicly cacheable', async () => {
    const { env } = makeEnv();
    await seedBattle(env);
    const signedIn = await listMatches(env, 'bob');
    // Per-viewer vote state is layered onto this response, so a shared cache must
    // not be allowed to keep it.
    expect(signedIn.headers.get('Cache-Control')).toBe('private, no-store');
    const anon = await listMatches(env, null);
    expect(anon.headers.get('Cache-Control')).toMatch(/^public, max-age=/);
  });
});

describe('the user profile cache', () => {
  async function seedProfile(env: TestEnv) {
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.users)
      .values({ uid: 'dave', username: 'dave', fullName: 'Dave', dpcoin: 500, createdAt: ts, updatedAt: ts } as any);
  }
  const getProfile = async (env: TestEnv, id = 'dave') =>
    (await (await app.request(`/read/users/${id}`, {}, env, fakeCtx())).json()) as any;

  it('costs no KV write, which is what makes its 30s bound real', async () => {
    // Its own comment justifies 30s by arguing a longer window "reads as a lost
    // payment" for a wallet balance — and on KV it was clamped to 60s, i.e. double the
    // bound it claimed. Edge-only honours 30s literally AND removes ~1,440 writes/day
    // per hot profile.
    const { env } = makeEnv();
    await seedProfile(env);
    const puts = recordPuts(env);
    for (let i = 0; i < 5; i++) expect((await getProfile(env)).uid).toBe('dave');
    expect(puts.filter((k) => k.startsWith('cache:user:'))).toHaveLength(0);
    expect(READ_CACHE_TTLS.userProfile.ceiling).toBe(30);
  });

  it('does NOT cache a missing user, in any tier', async () => {
    // `id` comes straight off the url, so caching negatives is an unbounded entry
    // supply keyed by invented uids.
    const { env } = makeEnv();
    expect(await getProfile(env, 'no-such-uid')).toBeNull();
    expect(edge.logicalKeys()).not.toContain('cache:user:no-such-uid');
    expect(env.CACHE_KV._map.has('cache:user:no-such-uid')).toBe(false);
    expect(await getProfile(env, 'no-such-uid')).toBeNull();
  });

  it('does NOT publish a hidden account, even when the owner is the one fetching it', async () => {
    // The entry is keyed only by uid, so without the write guard the OWNER's own
    // fetch — the one request entitled to see a pending-deletion profile — would
    // populate it for every other viewer.
    const { env } = makeEnv();
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.users)
      .values({ uid: 'gone', username: 'gone', status: 'pending_deletion', createdAt: ts, updatedAt: ts } as any);

    const owner = await app.request('/read/users/gone', { headers: { Authorization: 'Bearer gone' } }, env, fakeCtx());
    expect((await owner.json() as any)?.uid).toBe('gone');
    expect(owner.headers.get('Cache-Control')).toBe('private, no-store');
    expect(edge.logicalKeys()).not.toContain('cache:user:gone');

    // A stranger still gets "does not exist".
    const stranger = await app.request('/read/users/gone', { headers: { Authorization: 'Bearer bob' } }, env, fakeCtx());
    expect(await stranger.json()).toBeNull();
  });
});

/**
 * The invalidation side of an edge-only cache.
 *
 * THE BUG THESE EXIST FOR. When the read caches moved off KV, several writers were left
 * calling `delCache` — a KV-only delete — against keys nothing reads from KV any more.
 * That is worse than a colo-local purge: it invalidates NOTHING, in every colo, so the
 * pre-write payload keeps being served for the full TTL.
 *
 * On `/read/users/:id` that is not cosmetic. The payload spreads the whole `users` row,
 * including `email` and `phone`, so an account-deletion purge whose invalidation does
 * nothing means a stranger can still read a deleted account's real name, email and
 * phone. The read-side `status` guard cannot catch it either, because the CACHED copy
 * carries the pre-purge status — which is exactly why the write guard has always been
 * paired with an invalidation rather than relied on alone.
 *
 * A KV-only `delCache` on these keys is silent, so only asserting on the edge entry
 * catches a regression.
 */
describe('writers purge the edge tier, not just KV', () => {
  async function seedDave(env: TestEnv) {
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.users)
      .values({
        uid: 'dave',
        username: 'dave',
        fullName: 'Dave',
        email: 'dave@example.com',
        phone: '+919812345678',
        verified: false,
        createdAt: ts,
        updatedAt: ts,
      } as any);
  }
  const getProfile = async (env: TestEnv) =>
    (await (await app.request('/read/users/dave', {}, env, fakeCtx())).json()) as any;

  it('an admin profile edit is visible on the next read', async () => {
    const { env } = makeEnv();
    await seedDave(env);

    expect((await getProfile(env)).verified).toBe(false);
    expect(edge.logicalKeys()).toContain('cache:user:dave');

    const res = await app.request(
      '/read/../admin/users/dave/profile'.replace('/read/../', '/'),
      {
        method: 'PATCH',
        headers: { 'X-Admin-Secret': 'test-admin-secret', 'Content-Type': 'application/json' },
        body: JSON.stringify({ verified: true }),
      },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);

    // The entry must be GONE, not merely stale. "Granting a blue check and seeing
    // nothing change in the app" is precisely what a KV-only delete produces here.
    expect(edge.logicalKeys()).not.toContain('cache:user:dave');
    expect((await getProfile(env)).verified).toBe(true);
  });

  it('an account-deletion request stops the profile being served', async () => {
    const { env } = makeEnv();
    await seedDave(env);

    // Warm the shared entry. Note what it does NOT contain: the payload is projected
    // to an allow-list, so a stranger's copy carries no email or phone. The purge still
    // matters — the profile must stop being served at all — but the blast radius of a
    // missed purge is no longer a PII disclosure.
    const before = await getProfile(env);
    expect(before.username).toBe('dave');
    expect(before.email).toBeUndefined();
    expect(edge.logicalKeys()).toContain('cache:user:dave');

    // Deletion is gated on a recent sign-in or a passed re-auth challenge; the mocked
    // token carries no `auth_time`, so the grant stands in for having answered one.
    await env.OTP_KV.put('reauth:granted:dave', String(Date.now()));

    const res = await app.request(
      '/api',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer dave', 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'requestAccountDeletion', reason: 'done', confirm: true }),
      },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);

    expect(edge.logicalKeys()).not.toContain('cache:user:dave');
    // ...and a stranger now gets "does not exist" rather than the cached PII.
    expect(await getProfile(env)).toBeNull();
  });

  it('an identifier change purges the shared entry', async () => {
    const { env } = makeEnv();
    await seedDave(env);
    expect((await getProfile(env)).username).toBe('dave');
    expect(edge.logicalKeys()).toContain('cache:user:dave');

    // The `verifyOnly` branch, which needs no Firebase call — enough to exercise the
    // purge, which is the thing under test. The context origin must match the one the
    // reader used, because the edge key is same-origin by construction; in production
    // that is guaranteed, here it has to be stated.
    const { setOtp } = await import('../src/lib/otp');
    const { confirmEmailChange } = await import('../src/lib/identifierChange');
    await setOtp(env as any, 'email', 'dave', {
      otp: '123456',
      newEmail: 'dave@example.com',
      verifyOnly: true,
    });
    // Takes the whole caller now, not a uid: confirming a change ends the account's
    // OTHER sessions, and `auth_time` is how the surviving one is identified.
    await confirmEmailChange(
      env as any,
      { uid: 'dave', authTime: Math.floor(Date.now() / 1000) } as any,
      '123456',
      {
        req: { url: 'http://localhost/auth' },
        env,
      } as any,
    );

    expect(edge.logicalKeys()).not.toContain('cache:user:dave');

    // `emailVerified` is private, so the assertion that it changed has to be made from
    // the owner's own view. That read is uncached by design, which is the other half of
    // why an identifier change can never be served stale.
    const asOwner = await app.request(
      '/read/users/dave',
      { headers: { Authorization: 'Bearer dave' } },
      env,
      fakeCtx(),
    );
    expect(((await asOwner.json()) as any).emailVerified).toBe(true);
    expect(asOwner.headers.get('Cache-Control')).toBe('private, no-store');
  });
});

describe('blog reads', () => {
  async function seedPost(env: TestEnv) {
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.blogPosts)
      .values({
        id: 'p1',
        slug: 'hello-world',
        title: 'Hello world',
        content: '<p>Body</p>',
        status: 'published',
        publishedAt: ts,
        createdAt: ts,
        updatedAt: ts,
        viewCount: 0,
      } as any);
  }

  async function getPost(env: TestEnv) {
    const res = await app.request('/read/blog/hello-world', {}, env, fakeCtx());
    return (await res.json()) as any;
  }

  it('does NOT cache a not-found, in any tier', async () => {
    const { env } = makeEnv();
    const res = await app.request('/read/blog/no-such-slug', {}, env, fakeCtx());
    expect(await res.json()).toBeNull();

    // The slug comes straight off the url on an unauthenticated, unthrottled endpoint.
    // Caching misses would mint one entry per novel slug, and such an entry could not
    // be cleared: `invalidateBlogReadCache` only knows the exact slug and id of the
    // post being edited.
    expect(edge.logicalKeys()).not.toContain('cache:blog:post:no-such-slug');
    expect(env.CACHE_KV._map.has('cache:blog:post:no-such-slug')).toBe(false);

    const again = await app.request('/read/blog/no-such-slug', {}, env, fakeCtx());
    expect(await again.json()).toBeNull();
  });

  it('counts a view on every request, including cache hits', async () => {
    const { env } = makeEnv();
    await seedPost(env);
    await getPost(env); // populates the cache
    await getPost(env); // cache hit
    await getPost(env); // cache hit
    const row = await drizzleOf(env)
      .select({ viewCount: schema.blogPosts.viewCount })
      .from(schema.blogPosts)
      .get();
    // The payload is cached; the analytics deliberately are not. Note what this does
    // and does not prove: the harness's sqlite resolves synchronously and
    // `fakeCtx().waitUntil` swallows, so this pins that the increment is ISSUED on a
    // cache hit — not that it is durable.
    expect(Number(row?.viewCount)).toBe(3);
  });
});

describe('cache keys cannot be minted by irrelevant query parameters', () => {
  it('ignores unknown parameters on a parameterless endpoint', async () => {
    // `/read/app-config` takes no parameters, so `?x=1`, `?x=2`, … used to produce a
    // separate colo entry each for a byte-identical response — an unbounded,
    // attacker-controlled key supply on an unauthenticated endpoint.
    const { env } = makeEnv();
    for (const qs of ['', '?x=1', '?x=2', '?cache=bust']) {
      const res = await app.request(`/read/app-config${qs}`, {}, env, fakeCtx());
      expect(res.status).toBe(200);
    }
    expect(edge.keys()).toHaveLength(1);
    expect(edge.keys()[0]).toMatch(/\/read\/app-config$/);
  });

  it('normalises the parameters that DO matter', async () => {
    // Both spellings clamp to the same limit and therefore the same payload, so they
    // must share one entry rather than keying on the raw text.
    const { env } = makeEnv();
    await app.request('/read/blog/sitemap?limit=99999', {}, env, fakeCtx());
    await app.request('/read/blog/sitemap?limit=abc', {}, env, fakeCtx());
    expect(edge.keys()).toHaveLength(1);
  });
});

describe('the kill switch covers the edge tier', () => {
  it('caches nothing when KV_WRITES_DISABLED is set', async () => {
    // The flag's contract is "every cache read simply misses and the value is
    // recomputed from D1". It has to reach the edge tier too, now that the edge tier
    // IS the cache — otherwise a test deployment would serve cached data from every
    // endpoint in the module.
    const { env } = makeEnv({ KV_WRITES_DISABLED: 'true' });
    await seedBattle(env);

    expect((await listMatches(env, null)).body).toHaveLength(1);
    expect(edge.keys()).toHaveLength(0);

    // Still correct, just uncached: the row is gone, so is the response.
    await drizzleOf(env).delete(schema.contestMatches);
    expect((await listMatches(env, null)).body).toHaveLength(0);
  });
});
