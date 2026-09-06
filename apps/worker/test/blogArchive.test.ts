/**
 * `/read/blog/archive` — the page-numbered feed behind the crawlable archive pages,
 * and the 404 that `/read/blog/:slug` now returns for a missing post.
 *
 * ## Why this endpoint exists
 *
 * The blog list screen is a React Native `FlatList`, so it renders
 * `TouchableOpacity`, not `<a href>`. A live fetch of `https://tophunt.in/blog`
 * found ZERO links to any article. With ~4,400 posts and no internal links, the
 * sitemap was the only way Google could learn a url existed and there was no path
 * for authority to reach an article — which is what a catalogue sitting in
 * "Crawled – currently not indexed" looks like from the inside.
 *
 * The SEO Worker renders `/blog/archive/page/<n>` from this feed, so each post
 * gains a real inbound link from an indexable page.
 *
 * ## The properties worth pinning
 *
 *  1. OFFSET PAGINATION MUST BE A TOTAL ORDER. `published_at` is nullable (the
 *     importer writes NULL when the archived date is unknown) and duplicate values
 *     are common, so without the `id` tiebreak SQLite may order ties differently
 *     between two queries — which for OFFSET pagination means a post appearing on
 *     two pages, or on none. That is silent: every page looks fine on its own.
 *  2. ROUTE ORDER. Registered above `/blog/:slug`; move it below and "archive" is
 *     captured as a post slug, the feed 404s, and every archive page turns into a
 *     503 with nothing in the logs to say why.
 *  3. DRAFTS MUST NOT LEAK, for the same reason as the sitemap: these pages are
 *     public and indexable.
 *  4. A MISSING POST MUST BE A 404. It used to be `200 null`, which the edge Worker
 *     turned into a 200 HTML "Not found" page — a soft 404 on an unbounded url
 *     space, since the SPA claims every one-segment path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import { schema } from '../src/db';

const app = makeApp();

let env: TestEnv;

async function get(path: string) {
  const res = await app.fetch(new Request(`https://api.test${path}`), env, fakeCtx());
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedPost(over: Record<string, any>) {
  const now = Date.now();
  await drizzleOf(env)
    .insert(schema.blogPosts)
    .values({
      id: over.id,
      slug: over.slug,
      title: over.title ?? over.slug,
      category: over.category ?? null,
      status: over.status ?? 'published',
      publishedAt: over.publishedAt === undefined ? now : over.publishedAt,
      createdAt: over.createdAt ?? now,
      updatedAt: over.updatedAt ?? now,
    } as any)
    .run();
}

beforeEach(() => {
  ({ env } = makeEnv());
});

describe('GET /read/blog/archive', () => {
  it('returns a page of slug + title with the totals the pager needs', async () => {
    await seedPost({ id: 'p1', slug: 'first-post', title: 'First Post', publishedAt: 3000 });

    const { status, body } = await get('/read/blog/archive');
    expect(status).toBe(200);
    expect(body.page).toBe(1);
    expect(body.total).toBe(1);
    expect(body.totalPages).toBe(1);
    expect(body.posts[0]).toMatchObject({ slug: 'first-post', title: 'First Post' });
  });

  it('reports totalPages so the sitemap and rel=next know where the set ends', async () => {
    for (let i = 1; i <= 5; i++) await seedPost({ id: `p${i}`, slug: `post-${i}`, publishedAt: i * 1000 });

    const { body } = await get('/read/blog/archive?per=2');
    expect(body.total).toBe(5);
    expect(body.totalPages).toBe(3);
    expect(body.posts).toHaveLength(2);
  });

  it('walks every post exactly once across pages', async () => {
    for (let i = 1; i <= 7; i++) await seedPost({ id: `p${i}`, slug: `post-${i}`, publishedAt: i * 1000 });

    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const { body } = await get(`/read/blog/archive?per=3&page=${page}`);
      seen.push(...body.posts.map((p: any) => p.slug));
    }

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it('stays stable across pages when published_at ties or is NULL', async () => {
    // The exact shape the importer produces: identical timestamps, and NULLs where
    // the archived date could not be determined. Without ORDER BY … , id this is
    // where a post silently lands on two pages or on none.
    await seedPost({ id: 'a', slug: 'tie-a', publishedAt: 5000 });
    await seedPost({ id: 'b', slug: 'tie-b', publishedAt: 5000 });
    await seedPost({ id: 'c', slug: 'tie-c', publishedAt: 5000 });
    await seedPost({ id: 'd', slug: 'no-date', publishedAt: null });

    const seen: string[] = [];
    for (let page = 1; page <= 4; page++) {
      const { body } = await get(`/read/blog/archive?per=1&page=${page}`);
      seen.push(...body.posts.map((p: any) => p.slug));
    }

    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(seen.sort()).toEqual(['no-date', 'tie-a', 'tie-b', 'tie-c']);
  });

  it('orders newest first', async () => {
    await seedPost({ id: 'p1', slug: 'older', publishedAt: 1000 });
    await seedPost({ id: 'p2', slug: 'newer', publishedAt: 2000 });
    const { body } = await get('/read/blog/archive');
    expect(body.posts.map((p: any) => p.slug)).toEqual(['newer', 'older']);
  });

  it('excludes drafts, because these pages are public and indexable', async () => {
    await seedPost({ id: 'p1', slug: 'live-post' });
    await seedPost({ id: 'p2', slug: 'secret-draft', status: 'draft' });

    const { body } = await get('/read/blog/archive');
    expect(body.total).toBe(1);
    expect(body.posts.map((p: any) => p.slug)).toEqual(['live-post']);
  });

  it('filters by category, and counts only that category', async () => {
    await seedPost({ id: 'p1', slug: 'quiz-one', category: 'Quiz', publishedAt: 2000 });
    await seedPost({ id: 'p2', slug: 'offer-one', category: 'Offers', publishedAt: 1000 });

    const { body } = await get('/read/blog/archive?category=Quiz');
    expect(body.category).toBe('Quiz');
    expect(body.total).toBe(1);
    expect(body.posts.map((p: any) => p.slug)).toEqual(['quiz-one']);
  });

  it('returns an empty page — not an error — past the end, so the Worker can 404 it', async () => {
    await seedPost({ id: 'p1', slug: 'only' });
    const { status, body } = await get('/read/blog/archive?page=99');
    expect(status).toBe(200);
    expect(body.posts).toEqual([]);
    expect(body.totalPages).toBe(1);
  });

  it('clamps a hostile per-page value', async () => {
    for (let i = 1; i <= 3; i++) await seedPost({ id: `p${i}`, slug: `post-${i}`, publishedAt: i * 1000 });
    // An unbounded `per` is a way to make the Worker serialise the whole catalogue
    // into one document on demand.
    const { body } = await get('/read/blog/archive?per=100000');
    expect(body.perPage).toBe(500);
  });

  it('treats a junk page or per value as page 1 at the default size', async () => {
    await seedPost({ id: 'p1', slug: 'only' });
    const { status, body } = await get('/read/blog/archive?page=nonsense&per=nonsense');
    expect(status).toBe(200);
    expect(body.page).toBe(1);
    expect(body.perPage).toBe(100);
  });

  it('is not shadowed by /read/blog/:slug', async () => {
    await seedPost({ id: 'p1', slug: 'a-post' });
    const { status, body } = await get('/read/blog/archive');
    expect(status).toBe(200);
    expect(Array.isArray(body.posts)).toBe(true);
  });
});

describe('GET /read/blog/:slug — not found is a 404', () => {
  it('404s an unknown slug', async () => {
    // Was `200 null`, which the edge Worker rendered as a 200 HTML "Not found"
    // page. Every typo'd or retired permalink was therefore a soft 404 that Google
    // re-crawls indefinitely.
    const { status, body } = await get('/read/blog/no-such-post');
    expect(status).toBe(404);
    expect(body).toBeNull();
  });

  it('404s a draft rather than admitting it exists', async () => {
    await seedPost({ id: 'p1', slug: 'secret-draft', status: 'draft' });
    expect((await get('/read/blog/secret-draft')).status).toBe(404);
  });

  it('still serves a published post with a 200', async () => {
    await seedPost({ id: 'p1', slug: 'live-post', title: 'Live Post' });
    const { status, body } = await get('/read/blog/live-post');
    expect(status).toBe(200);
    expect(body.slug).toBe('live-post');
  });
});
