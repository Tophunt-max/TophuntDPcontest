/**
 * The indexing contract for the blog, enforced against the real
 * `public/_worker.js`.
 *
 * ## The failure this suite exists to prevent
 *
 * Search Console reported **92 of 4,475 submitted urls indexed**. Nothing was
 * broken in any way a browser could show you: every post loaded, the sitemap was
 * valid XML with all 4,475 entries, robots.txt allowed everything. The problem was
 * that the pieces disagreed with each other.
 *
 * Measured against production before this change:
 *
 *  - The canonical tag matched the url in the sitemap on **0 of 40** sampled posts.
 *    35 differed only by a trailing slash; 5 pointed at urls that do not exist.
 *  - `/blog` contained **zero** `<a href>` to any article, so ~4,400 posts had no
 *    internal links at all.
 *  - Article bodies linked to `/blog/blog/<slug>/`, which answered **200 with
 *    `noindex, nofollow`** — every followed internal link hit a live dead end.
 *  - Every dead url answered 200: `/wp-login.php`, `/xmlrpc.php`, `/feed`,
 *    `/sitemap_index.xml`, and any typo'd permalink.
 *
 * Each of those is a one-line regression away from returning, and none of them
 * would fail a build, a typecheck, or a manual smoke test. So they are asserted
 * here instead.
 *
 * The single most important test in this file is the first one: the canonical tag
 * and the sitemap `<loc>` are derived from the same value and must never drift.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { get, stubApi, json, fakeEnv } from './helpers/edgeWorker';

const ORIGIN = 'https://tophunt.in';
const SLUG = 'amazon-quiz-answers-today';

const post = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  slug: SLUG,
  title: 'Amazon Quiz Answers Today',
  excerpt: 'Todays answers.',
  content: '<p>Body text</p>',
  coverImageUrl: 'https://media.tophunt.in/cover.jpg',
  category: 'Quiz',
  tags: ['amazon'],
  author: 'TopHunt',
  publishedAt: 1700000000000,
  ...overrides,
});

const archivePayload = (opts: { page?: number; total?: number; perPage?: number; count?: number } = {}) => {
  const perPage = opts.perPage ?? 100;
  const total = opts.total ?? 250;
  const count = opts.count ?? perPage;
  return {
    page: opts.page ?? 1,
    perPage,
    total,
    totalPages: Math.max(Math.ceil(total / perPage), 1),
    category: null,
    posts: Array.from({ length: count }, (_, i) => ({
      slug: `post-${i}`,
      title: `Post ${i}`,
      category: 'Quiz',
      publishedAt: 1700000000000 - i * 1000,
      lastmod: 1700000000000 - i * 1000,
    })),
  };
};

const API = {
  post: (body: unknown, status = 200) => ({ '/read/blog/*': () => json(body, status) }),
  archive: (payload: unknown) => ({ '/read/blog/archive': () => json(payload) }),
  categories: (cats: unknown[] = []) => ({ '/read/blog/categories': () => json(cats) }),
};

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const stub = (routes: Record<string, (url: URL) => Response>) => {
  restore = stubApi(routes);
};

const head = async (res: Response) => await res.text();
const canonicalOf = (html: string) => /<link rel="canonical" href="([^"]+)"/.exec(html)?.[1] ?? null;
const robotsOf = (html: string) => /<meta name="robots" content="([^"]+)"/.exec(html)?.[1] ?? null;
const hrefsOf = (html: string) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);

// ---------------------------------------------------------------------------
// 1. The canonical tag and the sitemap must name the same url
// ---------------------------------------------------------------------------
describe('canonical url', () => {
  it('is the root permalink, and is byte-identical to the sitemap <loc>', async () => {
    stub({
      ...API.post(post()),
      '/read/blog/sitemap': () => json({ posts: [{ slug: SLUG, lastmod: 1700000000000 }], nextCursor: null }),
      ...API.categories(),
    });

    const page = await head(await get(`${ORIGIN}/${SLUG}`));
    const canonical = canonicalOf(page);

    const sitemap = await (await get(`${ORIGIN}/sitemap.xml`)).text();
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);

    expect(canonical).toBe(`${ORIGIN}/${SLUG}`);
    // The assertion that was false for every post in production.
    expect(locs).toContain(canonical);
  });

  it.each([
    ['a trailing slash', `${ORIGIN}/${SLUG}/`],
    ['a doubled /blog/blog/ prefix', `${ORIGIN}/blog/blog/${SLUG}/`],
    ['a slug that no longer exists', `${ORIGIN}/tcl-is-a-global-top-____-tv-brand/`],
    ['another domain entirely', 'https://example.com/whatever'],
  ])('ignores a stored canonical_url with %s', async (_label, stored) => {
    stub(API.post(post({ canonicalUrl: stored })));
    const page = await head(await get(`${ORIGIN}/${SLUG}`));
    // Provenance data must never decide the canonical tag. The 5-in-40 posts whose
    // stored value pointed at a noindex 404 were not demoted, they were removed.
    expect(canonicalOf(page)).toBe(`${ORIGIN}/${SLUG}`);
  });

  it('marks a resolved post indexable', async () => {
    stub(API.post(post()));
    expect(robotsOf(await head(await get(`${ORIGIN}/${SLUG}`)))).toBe('index, follow');
  });
});

// ---------------------------------------------------------------------------
// 2. One url per page
// ---------------------------------------------------------------------------
describe('url normalisation', () => {
  it.each([
    ['a trailing slash', `${ORIGIN}/${SLUG}/`, `${ORIGIN}/${SLUG}`],
    ['the /blog/ prefix', `${ORIGIN}/blog/${SLUG}`, `${ORIGIN}/${SLUG}`],
    ['the /blog/ prefix and a slash', `${ORIGIN}/blog/${SLUG}/`, `${ORIGIN}/${SLUG}`],
    ['the doubled prefix from imported links', `${ORIGIN}/blog/blog/${SLUG}/`, `${ORIGIN}/${SLUG}`],
    ['a triple prefix', `${ORIGIN}/blog/blog/blog/${SLUG}`, `${ORIGIN}/${SLUG}`],
  ])('301s %s onto the permalink', async (_label, from, to) => {
    const res = await get(from);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(to);
  });

  it('preserves the query string through a normalising redirect', async () => {
    const res = await get(`${ORIGIN}/blog/${SLUG}/?utm_source=telegram`);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/${SLUG}?utm_source=telegram`);
  });

  it('leaves the home page and /blog alone', async () => {
    stub({ ...API.archive(archivePayload()) });
    expect((await get(`${ORIGIN}/`)).status).toBe(200);
    expect((await get(`${ORIGIN}/blog`)).status).toBe(200);
  });

  it('does not mistake an archive route for a post slug', async () => {
    stub({ ...API.archive(archivePayload({ page: 2 })), ...API.categories() });
    // Without the BLOG_SUBROUTES guard this 301s to /archive.
    expect((await get(`${ORIGIN}/blog/archive/page/2`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. Dead urls say they are dead
// ---------------------------------------------------------------------------
describe('status codes for urls that do not exist', () => {
  it('404s an unresolved permalink instead of serving a 200 shell', async () => {
    stub(API.post(null, 404));
    const res = await get(`${ORIGIN}/a-slug-that-never-existed`);
    expect(res.status).toBe(404);
    expect(robotsOf(await head(res))).toBe('noindex, follow');
  });

  it('503s — never 404s — when the API itself is unreachable', async () => {
    stub({ '/read/blog/*': () => json({ error: 'boom' }, 500) });
    const res = await get(`${ORIGIN}/${SLUG}`);
    // A 404 here would start Google's removal clock on a live, ranking article
    // because an upstream had a bad minute.
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('120');
  });

  it.each([
    '/wp-login.php',
    '/wp-admin',
    '/wp-content/uploads/2025/02/spin-and-win.jpg',
    '/wp-json/wp/v2/posts',
    '/xmlrpc.php',
    '/feed',
    '/author/bubun',
    '/category/quiz',
    '/tag/amazon',
    '/page/2',
    '/2023/07/some-post',
  ])('410s the retired WordPress url %s', async (path) => {
    expect((await get(`${ORIGIN}${path}`)).status).toBe(410);
  });

  it.each(['/sitemap_index.xml', '/post-sitemap.xml', '/wp-sitemap.xml', '/sitemap.xml.gz'])(
    '404s the non-existent sitemap %s instead of returning HTML',
    async (path) => {
      // Search Console reports "Couldn't fetch" for a sitemap url that answers with
      // an HTML document, which is what the SPA fallback used to do here.
      const res = await get(`${ORIGIN}${path}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).not.toContain('text/html');
    },
  );

  it('404s an unknown multi-segment path but keeps live app screens at 200', async () => {
    expect((await get(`${ORIGIN}/nope/nope`)).status).toBe(404);
    // Private screens are noindex, but they exist — a signed-in user is looking at
    // one, so answering 404 would be a lie in the other direction.
    for (const path of ['/wallet/withdraw', '/auth/login', '/messages/chat/abc', '/setting']) {
      const res = await get(`${ORIGIN}${path}`);
      expect(res.status, path).toBe(200);
      expect(robotsOf(await head(res)), path).toBe('noindex, nofollow');
    }
  });

  it('301s /index.html onto / rather than serving a duplicate of the home page', async () => {
    // It is a real file in the build, so it answered 200 with the app — the same
    // page on a second url, with no canonical of its own.
    const res = await get(`${ORIGIN}/index.html`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/`);
  });

  it('404s a missing static asset rather than serving index.html under a .js url', async () => {
    const spaFallback = {
      ASSETS: {
        fetch: async () => new Response('<!doctype html><html></html>', { headers: { 'content-type': 'text/html' } }),
      },
    };
    const res = await get(`${ORIGIN}/_expo/static/js/web/entry-stale.js`, {
      accept: '*/*',
      env: spaFallback as any,
    });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 4. Crawlers that do not ask for text/html still get the SEO head
// ---------------------------------------------------------------------------
describe('content negotiation', () => {
  it('serves full post meta to a client sending a wildcard Accept', async () => {
    stub(API.post(post()));
    const html = await head(await get(`${ORIGIN}/${SLUG}`, { accept: '*/*' }));
    // This used to fall through to the raw shell: <title>TopHunt</title>, no
    // description, no canonical, no content — a page that is invisible while
    // looking completely fine in a browser.
    expect(canonicalOf(html)).toBe(`${ORIGIN}/${SLUG}`);
    expect(html).toContain('Amazon Quiz Answers Today');
  });

  it('still treats an extensioned path as an asset even when html is requested', async () => {
    const res = await get(`${ORIGIN}/whatever.xml`, { accept: 'text/html' });
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 5. Internal links
// ---------------------------------------------------------------------------
describe('internal linking', () => {
  it('rewrites doubled /blog/blog/ links inside article content', async () => {
    stub(
      API.post(
        post({
          content:
            '<p><a href="https://tophunt.in/blog/blog/other-post/">Other</a>' +
            '<a href="https://tophunt.in/blog/second-post/">Second</a>' +
            '<a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Ftophunt.in%2Fblog%2Fblog%2Fmine%2F">Share</a>' +
            '<a href="https://tophunt.in/">Home</a></p>',
        }),
      ),
    );
    const html = await head(await get(`${ORIGIN}/${SLUG}`));

    expect(html).toContain('href="https://tophunt.in/other-post"');
    expect(html).toContain('href="https://tophunt.in/second-post"');
    expect(html).not.toContain('/blog/blog/');
    expect(html).not.toContain('%2Fblog%2Fblog%2F');
    // The home page url is a single slash and must survive the slash stripping.
    expect(html).toContain('href="https://tophunt.in/"');
  });

  it('gives every post a route back into the catalogue', async () => {
    stub(API.post(post()));
    const html = await head(await get(`${ORIGIN}/${SLUG}`));
    expect(html).toContain(`href="${ORIGIN}/blog/archive"`);
  });

  it('gives /blog crawlable links, which it had none of', async () => {
    stub({ ...API.archive(archivePayload({ count: 12 })) });
    const html = await head(await get(`${ORIGIN}/blog`));
    const postLinks = hrefsOf(html).filter((h) => /^https:\/\/tophunt\.in\/post-\d+$/.test(h));
    expect(postLinks.length).toBe(12);
    expect(html).toContain(`href="${ORIGIN}/blog/archive"`);
  });
});

// ---------------------------------------------------------------------------
// 6. The archive pages
// ---------------------------------------------------------------------------
describe('/blog/archive', () => {
  it('is an indexable page of real anchors to permalinks', async () => {
    stub({ ...API.archive(archivePayload({ total: 250 })), ...API.categories([{ category: 'Quiz', count: 120 }]) });
    const res = await get(`${ORIGIN}/blog/archive`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(robotsOf(html)).toBe('index, follow');
    expect(canonicalOf(html)).toBe(`${ORIGIN}/blog/archive`);
    expect(hrefsOf(html).filter((h) => /^https:\/\/tophunt\.in\/post-\d+$/.test(h)).length).toBe(100);
    // No `rel=prev` on the first page, and a `rel=next` because there are 3.
    expect(html).not.toContain('rel="prev"');
    expect(html).toContain(`<link rel="next" href="${ORIGIN}/blog/archive/page/2"`);
  });

  it('chains pages with prev/next so a crawler can walk the whole catalogue', async () => {
    stub({ ...API.archive(archivePayload({ page: 2, total: 250 })), ...API.categories() });
    const html = await (await get(`${ORIGIN}/blog/archive/page/2`)).text();
    expect(canonicalOf(html)).toBe(`${ORIGIN}/blog/archive/page/2`);
    expect(html).toContain(`<link rel="prev" href="${ORIGIN}/blog/archive"`);
    expect(html).toContain(`<link rel="next" href="${ORIGIN}/blog/archive/page/3"`);
  });

  it('301s /page/1 onto the unsuffixed url', async () => {
    const res = await get(`${ORIGIN}/blog/archive/page/1`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/blog/archive`);
  });

  it('404s a page past the end instead of an empty indexable page', async () => {
    stub({ ...API.archive({ ...archivePayload({ total: 250 }), page: 99, posts: [] }), ...API.categories() });
    expect((await get(`${ORIGIN}/blog/archive/page/99`)).status).toBe(404);
  });

  it('503s when the archive feed is unreachable', async () => {
    stub({ '/read/blog/archive': () => json({}, 500), ...API.categories() });
    const res = await get(`${ORIGIN}/blog/archive`);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('120');
  });

  it('serves a category archive with its own canonical', async () => {
    stub({ ...API.archive(archivePayload({ total: 120 })), ...API.categories([{ category: 'Quiz', count: 120 }]) });
    const html = await (await get(`${ORIGIN}/blog/archive/category/Quiz`)).text();
    expect(canonicalOf(html)).toBe(`${ORIGIN}/blog/archive/category/Quiz`);
  });

  it('renders without the category list when that call fails', async () => {
    stub({ ...API.archive(archivePayload()), '/read/blog/categories': () => json({}, 500) });
    // Categories are decoration; the links are the point.
    expect((await get(`${ORIGIN}/blog/archive`)).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 7. The sitemap advertises the archive too
// ---------------------------------------------------------------------------
describe('/sitemap.xml', () => {
  const sitemapOf = async (postCount: number, categories: unknown[] = []) => {
    stub({
      '/read/blog/sitemap': () =>
        json({
          posts: Array.from({ length: postCount }, (_, i) => ({ slug: `post-${i}`, lastmod: 1700000000000 })),
          nextCursor: null,
        }),
      ...API.categories(categories),
    });
    return await (await get(`${ORIGIN}/sitemap.xml`)).text();
  };

  it('lists every archive page, not just the first', async () => {
    const xml = await sitemapOf(250);
    // 250 posts at 100 per page.
    for (const loc of [
      `${ORIGIN}/blog/archive`,
      `${ORIGIN}/blog/archive/page/2`,
      `${ORIGIN}/blog/archive/page/3`,
    ]) {
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
    expect(xml).not.toContain(`${ORIGIN}/blog/archive/page/4`);
  });

  it('lists category archives', async () => {
    const xml = await sitemapOf(250, [{ category: 'Quiz', count: 150 }]);
    expect(xml).toContain(`<loc>${ORIGIN}/blog/archive/category/Quiz</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/blog/archive/category/Quiz/page/2</loc>`);
  });

  it('emits post urls with no trailing slash and no /blog/ prefix', async () => {
    const xml = await sitemapOf(3);
    expect(xml).toContain(`<loc>${ORIGIN}/post-0</loc>`);
    expect(xml).not.toMatch(/<loc>https:\/\/tophunt\.in\/blog\/post-/);
    expect(xml).not.toMatch(/<loc>https:\/\/tophunt\.in\/post-\d+\/<\/loc>/);
  });

  it('still serves valid XML when the categories call fails', async () => {
    stub({
      '/read/blog/sitemap': () => json({ posts: [{ slug: 'a', lastmod: 1 }], nextCursor: null }),
      '/read/blog/categories': () => json({}, 500),
    });
    const res = await get(`${ORIGIN}/sitemap.xml`);
    expect(res.headers.get('content-type')).toContain('xml');
    expect(await res.text()).toContain('<loc>https://tophunt.in/a</loc>');
  });
});

// ---------------------------------------------------------------------------
// 8. robots.txt still points at the one sitemap that exists
// ---------------------------------------------------------------------------
describe('/robots.txt', () => {
  it('declares the sitemap and blocks only the private prefixes', async () => {
    const body = await (await get(`${ORIGIN}/robots.txt`)).text();
    expect(body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    expect(body).toContain('Disallow: /wallet/');
    // The blog and the archive must stay crawlable.
    expect(body).not.toContain('Disallow: /blog');
  });
});
