/**
 * Explore backend: people + universal search, suggestions, "ending soon",
 * "your rank", and the admin-managed Explore config (banners + sections).
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { likePrefix, normaliseSearchTerm } from '../src/routes/read';
import { isSafeExploreLink, normaliseSections, publicExploreConfig, validateExplorePatch, EXPLORE_SECTIONS } from '../src/lib/exploreConfig';

const app = makeApp();

async function get(env: TestEnv, path: string, uid?: string) {
  const res = await app.request(`/read${path}`, { headers: uid ? { Authorization: `Bearer ${uid}` } : {} }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}

async function user(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: 1, updatedAt: 1, ...extra } as any);
}

async function match(env: TestEnv, id: string, extra: Record<string, any> = {}) {
  await drizzleOf(env)
    .insert(schema.contestMatches)
    .values({
      id,
      status: 'active',
      type: 'photo',
      title: `Battle ${id}`,
      userA: { uid: 'pa', username: 'pa', mediaUrl: 'https://media.example.com/a.jpg' },
      userB: { uid: 'pb', username: 'pb', mediaUrl: 'https://media.example.com/b.jpg' },
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      ...extra,
    } as any);
}

// ===========================================================================
describe('search term handling', () => {
  it('drops a leading @, trims and lowercases', () => {
    expect(normaliseSearchTerm('  @@Rahul_K ')).toBe('rahul_k');
    expect(normaliseSearchTerm('A   b')).toBe('a b');
  });
  it('escapes LIKE wildcards so they match literally', () => {
    expect(likePrefix('a%b_c')).toBe('a\\%b\\_c%');
  });
});

describe('/read/users/search', () => {
  it('finds by @handle, by name and by a later word of the name, ranked exact → handle → name', async () => {
    const { env } = makeEnv();
    await user(env, 'u1', { username: 'rahul', fullName: 'Rahul Verma' });
    await user(env, 'u2', { username: 'rahul_k', fullName: 'Rahul Kumar' });
    await user(env, 'u3', { username: 'priya', fullName: 'Priya Rahul' });
    await user(env, 'u4', { username: 'amit', fullName: 'Amit Sharma' });

    const at = await get(env, '/users/search?q=@rahul');
    expect(at.body.map((r: any) => r.id)).toEqual(['u1', 'u2', 'u3']);
    expect(at.body[0].fullName).toBe('Rahul Verma');

    expect((await get(env, '/users/search?q=sharma')).body.map((r: any) => r.id)).toEqual(['u4']);
  });

  it('treats % and _ literally', async () => {
    const { env } = makeEnv();
    await user(env, 'u1', { username: 'a_b' });
    await user(env, 'u2', { username: 'axb' });
    expect((await get(env, '/users/search?q=a_')).body.map((r: any) => r.id)).toEqual(['u1']);
    expect((await get(env, '/users/search?q=%25%25')).body).toEqual([]);
  });

  it('hides blocked and unfinished accounts', async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    await user(env, 'zed1');
    await user(env, 'zed2', { signupCompleted: false });
    await drizzleOf(env).insert(schema.userBlocks).values({ blockerId: 'me', blockedId: 'zed1', createdAt: 1 } as any);
    expect((await get(env, '/users/search?q=zed', 'me')).body).toEqual([]);
    expect((await get(env, '/users/search?q=zed')).body.map((r: any) => r.id)).toEqual(['zed1']);
  });
});

// ===========================================================================
describe('/read/search (universal)', () => {
  it('returns people, contests, battles and blog for one query', async () => {
    const { env } = makeEnv();
    await user(env, 'dance_king', { fullName: 'Dance King' });
    await drizzleOf(env).insert(schema.contests).values({ id: 'c1', title: 'Dance Off', status: 'live', createdAt: 1 } as any);
    await drizzleOf(env).insert(schema.contests).values({ id: 'c2', title: 'Old Dance', status: 'ended', createdAt: 1 } as any);
    await match(env, 'm1', { title: 'Street dance battle', totalVotes: 5 });
    await match(env, 'm2', { title: 'Secret dance', isPrivate: true });
    await match(env, 'm3', { title: 'Held dance', moderationHoldAt: 1 });
    await match(env, 'm4', { title: 'Finished dance', status: 'completed' });
    await drizzleOf(env)
      .insert(schema.blogPosts)
      .values({ id: 'b1', slug: 'dance-tips', title: 'Dance tips', status: 'published', publishedAt: 1, createdAt: 1, updatedAt: 1 } as any);
    await drizzleOf(env)
      .insert(schema.blogPosts)
      .values({ id: 'b2', slug: 'dance-draft', title: 'Dance draft', status: 'draft', createdAt: 1, updatedAt: 1 } as any);

    const r = await get(env, '/search?q=dance');
    expect(r.status).toBe(200);
    expect(r.body.people.map((p: any) => p.id)).toEqual(['dance_king']);
    expect(r.body.contests.map((c: any) => c.id)).toEqual(['c1']);
    expect(r.body.battles.map((m: any) => m.id)).toEqual(['m1']);
    expect(r.body.blog.map((b: any) => b.slug)).toEqual(['dance-tips']);
  });

  it('answers empty for a 1-character query', async () => {
    const { env } = makeEnv();
    expect((await get(env, '/search?q=a')).body).toMatchObject({ people: [], contests: [], battles: [], blog: [] });
  });

  it('hides battles with a blocked participant from a signed-in viewer', async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    await match(env, 'm1', { title: 'Cook off' });
    await drizzleOf(env).insert(schema.userBlocks).values({ blockerId: 'me', blockedId: 'pa', createdAt: 1 } as any);
    expect((await get(env, '/search?q=cook', 'me')).body.battles).toEqual([]);
  });
});

// ===========================================================================
describe('/read/users/suggested', () => {
  it('never suggests yourself or someone you already follow', async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    await user(env, 'friend');
    await user(env, 'stranger');
    await drizzleOf(env).insert(schema.follows).values({ followerId: 'me', followingId: 'friend', createdAt: 1 } as any);
    const r = await get(env, '/users/suggested', 'me');
    expect(r.body.map((u: any) => u.id)).toEqual(['stranger']);
    expect(r.headers.get('Cache-Control')).toContain('no-store');
    // A guest still sees everyone.
    expect((await get(env, '/users/suggested')).body).toHaveLength(3);
  });

  it('puts verified, then most-followed creators first', async () => {
    const { env } = makeEnv();
    await user(env, 'small', { followersCount: 1 });
    await user(env, 'big', { followersCount: 900 });
    await user(env, 'blue', { verified: true, followersCount: 5 });
    expect((await get(env, '/users/suggested')).body.map((u: any) => u.id)).toEqual(['blue', 'big', 'small']);
  });
});

// ===========================================================================
describe('/read/matches?sort=ending', () => {
  it('lists live battles closing soonest first, skipping lapsed ones', async () => {
    const { env } = makeEnv();
    const now = Date.now();
    await match(env, 'later', { expiresAt: now + 5 * 3_600_000 });
    await match(env, 'soon', { expiresAt: now + 600_000 });
    await match(env, 'lapsed', { expiresAt: now - 1000 });
    await match(env, 'waiting', { status: 'waiting_for_opponent', expiresAt: now + 60_000 });
    const r = await get(env, '/matches?status=active&sort=ending&limit=10');
    expect(r.body.map((m: any) => m.id)).toEqual(['soon', 'later']);
  });
});

// ===========================================================================
describe('/read/leaderboard/me', () => {
  it('reports the viewer\'s rank, with ties sharing a rank', async () => {
    const { env } = makeEnv();
    await user(env, 'a', { wins: 10 });
    await user(env, 'b', { wins: 7 });
    await user(env, 'c', { wins: 7 });
    await user(env, 'me', { wins: 3, xp: 1000 });
    expect((await get(env, '/leaderboard/me?by=wins', 'me')).body).toMatchObject({ by: 'wins', rank: 4, score: 3 });
    expect((await get(env, '/leaderboard/me?by=wins', 'c')).body.rank).toBe(2);
    expect((await get(env, '/leaderboard/me?by=xp', 'me')).body.rank).toBe(1);
    expect((await get(env, '/leaderboard/me')).status).toBe(401);
  });
});

// ===========================================================================
describe('Explore config', () => {
  const banner = (over: Record<string, any> = {}) => ({ imageUrl: 'https://cdn.example.com/b.jpg', title: 'Hi', link: '/referral', ...over });

  it('links: app paths and https only', () => {
    expect(isSafeExploreLink('/referral')).toBe(true);
    expect(isSafeExploreLink('https://tophunt.in/blog')).toBe(true);
    expect(isSafeExploreLink('')).toBe(true);
    for (const bad of ['//evil.com', 'javascript:alert(1)', 'http://x.com', '/a b', 'tophunt://x']) expect(isSafeExploreLink(bad)).toBe(false);
  });

  it('validates banners and sections', () => {
    for (const bad of [
      { banners: [banner({ imageUrl: 'http://x/y.jpg' })] },
      { banners: [banner({ link: 'javascript:alert(1)' })] },
      { banners: [banner({ startsAt: 10, endsAt: 5 })] },
      { banners: [banner({ title: 'x'.repeat(81) })] },
      { banners: Array.from({ length: 11 }, () => banner()) },
      { sections: [{ key: 'nope' }] },
      { other: 1 },
    ]) {
      expect(() => validateExplorePatch(JSON.parse(JSON.stringify(bad))), JSON.stringify(bad).slice(0, 80)).toThrow();
    }
    const ok: any = { banners: [banner({ id: 'x' }), banner({ id: 'x' })], sections: [{ key: 'grid', enabled: false }, { key: 'trending' }] };
    validateExplorePatch(ok);
    expect(ok.banners.map((b: any) => b.id)).toEqual(['x', 'x-2']);
    expect(ok.sections[0]).toEqual({ key: 'grid', enabled: false });
    expect(ok.sections.map((s: any) => s.key).sort()).toEqual([...EXPLORE_SECTIONS].sort());
  });

  it('public projection: only enabled banners inside their window; every section present once', () => {
    const now = 1_000_000;
    const cfg = {
      explore: {
        banners: [
          banner({ id: 'live' }),
          banner({ id: 'off', enabled: false }),
          banner({ id: 'future', startsAt: now + 1 }),
          banner({ id: 'past', endsAt: now }),
          banner({ id: 'bad', link: '//evil' }),
        ],
        sections: [{ key: 'people', enabled: false }, { key: 'people' }],
      },
    };
    const pub = publicExploreConfig(cfg, now);
    expect(pub.banners.map((b: any) => b.id)).toEqual(['live']);
    expect(pub.banners[0]).not.toHaveProperty('enabled');
    expect(pub.sections[0]).toEqual({ key: 'people', enabled: false });
    expect(pub.sections).toHaveLength(EXPLORE_SECTIONS.length);
    expect(normaliseSections(undefined).every((s) => s.enabled)).toBe(true);
  });

  it('is saved by an admin (audited) and shown in the public app config', async () => {
    const { env } = makeEnv();
    const save = (body: any) =>
      app.request(
        '/admin/app-settings',
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' }, body: JSON.stringify(body) },
        env,
        fakeCtx(),
      );
    expect((await save({ explore: { banners: [banner({ link: 'javascript:x' })] } })).status).toBe(400);
    expect((await save({ explore: { banners: [banner({ id: 'promo' })], sections: [{ key: 'grid', enabled: false }] } })).status).toBe(200);
    await env.CACHE_KV.delete('settings:appConfig');
    const cfg = await get(env, '/app-config');
    expect(cfg.body.explore.banners.map((b: any) => b.id)).toEqual(['promo']);
    expect(cfg.body.explore.sections.find((s: any) => s.key === 'grid').enabled).toBe(false);
    const audit = await drizzleOf(env).select().from(schema.adminAuditLog).all();
    expect(audit.some((a: any) => String(a.action).includes('explore'))).toBe(true);
  });
});
