/**
 * `/read/blog/sitemap` — the slug-only feed the SEO Worker builds the sitemap from.
 *
 * This endpoint exists because the sitemap was silently incomplete. Walking
 * `/read/blog` at its 50-post cap needed ~87 sequential subrequests for the
 * current catalogue, a Worker has a subrequest ceiling, and the loop was simply
 * cut short: the live sitemap advertised 2,452 of 4,338 urls with no error
 * anywhere. Returning two columns per row instead of twenty makes the whole
 * catalogue one request.
 *
 * Three properties are worth pinning, because each fails silently:
 *
 *  1. DRAFTS MUST NOT APPEAR. A sitemap is a public statement that these urls
 *     exist and should be crawled. Leaking an unpublished post there is a content
 *     leak that no test on the read path would catch, since `/read/blog/:slug`
 *     refuses drafts separately.
 *  2. ROUTE ORDER. `/blog/:slug` is registered on the same prefix, so if this
 *     route is ever moved below it, "sitemap" is captured as a post slug and the
 *     endpoint starts 404ing — which would degrade the sitemap to nine static
 *     routes, again with no error.
 *  3. PAGINATION TERMINATES AND DOES NOT REPEAT. Past the limit the caller must
 *     be told to continue, and the last page must report the end — otherwise the
 *     Worker either loops or stops early.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import { schema } from '../src/db';

const app = makeApp();

let env: TestEnv;

async function get(path: string) {
  const res = await app.fetch(new Request(`https://api.test${path}`), env, fakeCtx());
  return { status: res.status, body: (await res.json()) as any };
}

async function seedPost(over: Record<string, any>) {
  const now = Date.now();
  await drizzleOf(env)
    .insert(schema.blogPosts)
    .values({
      id: over.id,
      slug: over.slug,
      title: over.title ?? over.slug,
      status: over.status ?? 'published',
      publishedAt: over.publishedAt ?? now,
      createdAt: over.createdAt ?? now,
      updatedAt: over.updatedAt ?? now,
    } as any)
    .run();
}

beforeEach(() => {
  ({ env } = makeEnv());
});

describe('GET /read/blog/sitemap', () => {
  it('returns every published post as slug + lastmod, and nothing else', async () => {
    await seedPost({ id: 'p1', slug: 'first-post', publishedAt: 3000, updatedAt: 9000 });

    const { status, body } = await get('/read/blog/sitemap');
    expect(status).toBe(200);
    expect(body.posts).toHaveLength(1);
    // Exactly two fields — the point of the endpoint is that it is small.
    expect(Object.keys(body.posts[0]).sort()).toEqual(['lastmod', 'slug']);
    expect(body.posts[0].slug).toBe('first-post');
  });

  it('excludes drafts', async () => {
    await seedPost({ id: 'p1', slug: 'live-post', status: 'published' });
    await seedPost({ id: 'p2', slug: 'secret-draft', status: 'draft' });

    const { body } = await get('/read/blog/sitemap');
    const slugs = body.posts.map((p: any) => p.slug);
    expect(slugs).toContain('live-post');
    expect(slugs).not.toContain('secret-draft');
  });

  it('prefers updated_at for lastmod, so an edited post gets re-crawled', async () => {
    await seedPost({ id: 'p1', slug: 'edited', publishedAt: 1000, updatedAt: 5000 });
    const { body } = await get('/read/blog/sitemap');
    expect(body.posts[0].lastmod).toBe(5000);
  });

  it('orders newest first', async () => {
    await seedPost({ id: 'p1', slug: 'older', publishedAt: 1000 });
    await seedPost({ id: 'p2', slug: 'newer', publishedAt: 2000 });
    const { body } = await get('/read/blog/sitemap');
    expect(body.posts.map((p: any) => p.slug)).toEqual(['newer', 'older']);
  });

  it('reports the end of the catalogue with a null cursor', async () => {
    await seedPost({ id: 'p1', slug: 'only', publishedAt: 1000 });
    const { body } = await get('/read/blog/sitemap');
    // The Worker stops looping on this. A stray cursor here would make it fetch
    // the same page forever until it hit its page cap.
    expect(body.nextCursor).toBeNull();
  });

  it('paginates without repeating or dropping a post', async () => {
    for (let i = 1; i <= 5; i++) {
      await seedPost({ id: `p${i}`, slug: `post-${i}`, publishedAt: i * 1000 });
    }

    const first = await get('/read/blog/sitemap?limit=2');
    expect(first.body.posts.map((p: any) => p.slug)).toEqual(['post-5', 'post-4']);
    expect(first.body.nextCursor).toBe(4000);

    const second = await get(`/read/blog/sitemap?limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.posts.map((p: any) => p.slug)).toEqual(['post-3', 'post-2']);

    const third = await get(`/read/blog/sitemap?limit=2&cursor=${second.body.nextCursor}`);
    expect(third.body.posts.map((p: any) => p.slug)).toEqual(['post-1']);
    expect(third.body.nextCursor).toBeNull();
  });

  it('is not shadowed by /read/blog/:slug', async () => {
    // If this route is ever registered below /blog/:slug, "sitemap" is read as a
    // post slug and this becomes a 404 — quietly reducing the sitemap to the
    // static routes only.
    await seedPost({ id: 'p1', slug: 'a-post' });
    const { status, body } = await get('/read/blog/sitemap');
    expect(status).toBe(200);
    expect(Array.isArray(body.posts)).toBe(true);
  });
});
