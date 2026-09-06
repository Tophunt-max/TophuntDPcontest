/**
 * The two-tier read cache: Cloudflare Cache API in front of Workers KV.
 *
 * The harness's default `caches` stub is always-miss / never-store, which keeps
 * every other suite deterministic but means the edge tier is exercised by nothing.
 * This file installs a cache that really stores, because the property that matters
 * cannot be checked any other way:
 *
 *   AN EDGE HIT MUST NOT SKIP PER-VIEWER AUTHORIZATION.
 *
 * That is the whole reason `edgeCachedJson` returns DATA rather than a Response.
 * The older `edgeCached` returns the cached response and so returns from the handler
 * early — correct for a fully public endpoint, and a data leak on any endpoint that
 * gates or filters per viewer. If someone "simplifies" a call site back to a
 * response-level cache, the tests below are what fails.
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

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { READ_CACHE_TTLS } from '../src/routes/read';

const app = makeApp();

/** A Cache API stand-in that actually stores, keyed by the request url. */
function installEdgeCache() {
  const store = new Map<string, { body: string; cacheControl: string | null }>();
  const previous = (globalThis as any).caches;
  (globalThis as any).caches = {
    default: {
      async match(req: Request) {
        const hit = store.get(req.url);
        if (!hit) return undefined;
        return new Response(hit.body, { headers: { 'Content-Type': 'application/json' } });
      },
      async put(req: Request, res: Response) {
        store.set(req.url, {
          body: await res.text(),
          cacheControl: res.headers.get('Cache-Control'),
        });
      },
      async delete(req: Request) {
        return store.delete(req.url);
      },
    },
  };
  return {
    store,
    keys: () => [...store.keys()],
    restore: () => {
      (globalThis as any).caches = previous;
    },
  };
}

let edge: ReturnType<typeof installEdgeCache>;
beforeEach(() => {
  edge = installEdgeCache();
});
afterEach(() => {
  edge.restore();
});

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

describe('ttl pairs', () => {
  it('never lets the edge tier outlive the KV tier, and keeps every total inside its ceiling', () => {
    // The two tiers COMPOSE: a colo that misses the edge cache when the KV entry is
    // nearly expired promotes that already-old value for a further `edge` seconds, so
    // worst-case staleness is `edge + kv`. That is easy to get wrong by editing one
    // number, and no behavioural test can see it because neither the cache stub nor
    // `fakeKV` honours expiry. Asserting the arithmetic is the only guard.
    for (const [name, t] of Object.entries(READ_CACHE_TTLS)) {
      expect(t.edge, `${name}: edge must be shorter than kv`).toBeLessThan(t.kv);
      expect(t.edge + t.kv, `${name}: edge + kv exceeds its ceiling`).toBeLessThanOrEqual(t.ceiling);
    }
  });

  it('keeps the tail short on the keys an editor can invalidate', () => {
    // For an invalidated key the KV delete is global, so the post-invalidation tail
    // is just `edge` — but the Cache API cannot be purged, so that tail covers DELETE
    // and UNPUBLISH too. A takedown that keeps serving for a minute is the case that
    // matters, not an edit.
    for (const [name, t] of Object.entries(READ_CACHE_TTLS)) {
      if (!t.invalidated) continue;
      expect(t.edge, `${name}: post-invalidation tail is too long`).toBeLessThanOrEqual(30);
    }
  });
});

describe('the edge tier serves the shared payload', () => {
  it('is consulted BEFORE the KV tier', async () => {
    const { env } = makeEnv();
    await seedBattle(env);

    // Warm both tiers, then plant a different value in the edge tier only. Deleting
    // the D1 row and asserting the response is unchanged would pass even with the
    // edge tier completely broken, because KV also holds the value — so the tiers
    // have to disagree for this to prove anything.
    await listMatches(env, null);
    const [edgeKey] = edge.keys();
    edge.store.set(edgeKey, {
      body: JSON.stringify({ matches: [{ id: 'from-edge' }], nextCursor: null }),
      cacheControl: 'public, max-age=10',
    });

    const served = await listMatches(env, null);
    expect(served.body).toHaveLength(1);
    expect(served.body[0].id).toBe('from-edge');
  });

  it('falls through to KV when the edge tier misses', async () => {
    const { env } = makeEnv();
    await seedBattle(env);
    await listMatches(env, null);

    // Drop the edge entry only, and remove the D1 row so a KV hit is the only way to
    // still get the battle back.
    edge.store.clear();
    await drizzleOf(env).delete(schema.contestMatches);

    const served = await listMatches(env, null);
    expect(served.body).toHaveLength(1);
    expect(served.body[0].id).toBe('m1');
    // ...and the KV value is promoted back into the edge tier.
    expect(edge.keys()).toHaveLength(1);
  });

  it('keys the edge entry on the CACHE key, not the request url', async () => {
    const { env } = makeEnv();
    await seedBattle(env);
    await listMatches(env, null);

    const [key] = edge.keys();
    // A reserved path plus the KV key, so the two tiers cannot disagree about what
    // they hold, and an irrelevant query parameter cannot mint a duplicate entry.
    expect(key).toContain('/__edge');
    expect(decodeURIComponent(key)).toContain('cache:matches:active:all:recent:');
  });

  it('stores with a Cache-Control max-age, which is what sets the edge ttl', async () => {
    const { env } = makeEnv();
    await seedBattle(env);
    await listMatches(env, null);
    const [entry] = [...edge.store.values()];
    expect(entry.cacheControl).toMatch(/^public, max-age=\d+$/);
  });
});

describe('an edge hit still runs per-viewer authorization', () => {
  it('filters a blocked participant out of a cached list', async () => {
    const { env } = makeEnv();
    await seedBattle(env);

    // Warm both tiers from an unauthenticated request, so the stored entry is
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
    const bobView = await listMatches(env, 'bob');
    expect(bobView.body).toHaveLength(1);
    const anon = await listMatches(env, null);
    expect(anon.body).toHaveLength(1);
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

describe('the KV tier remains the fallback', () => {
  it('works with no Cache API at all', async () => {
    // The Cache API only does real work for Workers on a custom domain, so on the
    // *.workers.dev host that older app builds still call it is a no-op. The KV tier
    // is what keeps those clients cached.
    const { env } = makeEnv();
    await seedBattle(env);
    (globalThis as any).caches = undefined;

    const first = await listMatches(env, null);
    expect(first.body).toHaveLength(1);
    // Written to KV even though the edge tier was unavailable.
    const kvKeys = [...env.CACHE_KV._map.keys()].filter((k) => k.startsWith('cache:matches:'));
    expect(kvKeys).toHaveLength(1);

    await drizzleOf(env).delete(schema.contestMatches);
    const second = await listMatches(env, null);
    expect(second.body).toHaveLength(1); // served from KV
  });

  it('populates the edge tier from a KV hit', async () => {
    const { env } = makeEnv();
    await seedBattle(env);

    // Warm KV only.
    (globalThis as any).caches = undefined;
    await listMatches(env, null);
    expect(env.CACHE_KV._map.size).toBeGreaterThan(0);

    // Re-enable the edge tier: the next request should promote the KV value into it,
    // otherwise a colo would go to KV on every single request forever.
    edge.restore();
    edge = installEdgeCache();
    await listMatches(env, null);
    expect(edge.keys()).toHaveLength(1);
  });
});

describe('blog post cache shape migration', () => {
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

  it('reads an entry written in the previous, unwrapped shape', async () => {
    const { env } = makeEnv();
    await seedPost(env);
    // What the old code stored: the value WAS the payload. These have a 600s ttl, so
    // they keep arriving for ten minutes after deploy — reading one as "no `post`
    // field, therefore not found" would 404 every hot article in the blog.
    await env.CACHE_KV.put(
      'cache:blog:post:hello-world',
      JSON.stringify({ id: 'p1', slug: 'hello-world', title: 'Legacy shape' }),
    );
    const post = await getPost(env);
    expect(post?.title).toBe('Legacy shape');
  });

  it('does NOT cache a not-found, in either tier', async () => {
    const { env } = makeEnv();
    const res = await app.request('/read/blog/no-such-slug', {}, env, fakeCtx());
    expect(await res.json()).toBeNull();

    // The slug comes straight off the url on an unauthenticated, unthrottled
    // endpoint. Caching misses would mint one KV write per novel slug against a
    // 1,000/day budget for the whole Worker — a script walking made-up slugs would
    // stop every cache in the app from writing for the rest of the day. And such an
    // entry could not be cleared: `invalidateBlogReadCache` only knows the exact
    // slug and id of the post being edited, and the edge tier cannot be purged.
    expect(env.CACHE_KV._map.has('cache:blog:post:no-such-slug')).toBe(false);
    expect(edge.keys()).toHaveLength(0);

    const again = await app.request('/read/blog/no-such-slug', {}, env, fakeCtx());
    expect(await again.json()).toBeNull();
  });

  it('counts a view on every request, including cache hits', async () => {
    const { env } = makeEnv();
    await seedPost(env);
    await getPost(env); // populates both tiers
    await getPost(env); // edge hit
    await getPost(env); // edge hit
    const row = await drizzleOf(env)
      .select({ viewCount: schema.blogPosts.viewCount })
      .from(schema.blogPosts)
      .get();
    // The payload is cached; the analytics deliberately are not. Note what this does
    // and does not prove: the harness's sqlite resolves synchronously and
    // `fakeCtx().waitUntil` swallows, so this pins that the increment is ISSUED on a
    // cache hit — not that it is durable. Durability is what `waitUntil` is for in
    // the handler, and it is not observable from here.
    expect(Number(row?.viewCount)).toBe(3);
  });
});

describe('the kill switch covers both tiers', () => {
  it('caches nothing when KV_WRITES_DISABLED is set', async () => {
    // The flag's contract is "every cache read simply misses and the value is
    // recomputed from D1". Before `edgeStore` checked it, the KV write was skipped
    // and the edge write went through anyway — so a test deployment on a custom
    // domain kept serving cached data from six endpoints.
    const { env } = makeEnv({ KV_WRITES_DISABLED: 'true' });
    await seedBattle(env);

    expect((await listMatches(env, null)).body).toHaveLength(1);
    expect(edge.keys()).toHaveLength(0);
    expect([...env.CACHE_KV._map.keys()].filter((k) => k.startsWith('cache:matches:'))).toHaveLength(0);

    // Still correct, just uncached: the row is gone, so is the response.
    await drizzleOf(env).delete(schema.contestMatches);
    expect((await listMatches(env, null)).body).toHaveLength(0);
  });
});
