/**
 * The SEO audit engine.
 *
 * The engine's whole value is that its numbers are trustworthy, so the things
 * pinned here are the ones that would make it lie:
 *
 *  1. A category with no data source must score `null`, never a number. An
 *     invented "Off-Page: 62/100" is worse than an empty panel, because someone
 *     will act on it.
 *  2. `overall` must average only the measurable categories. Counting an
 *     unmeasurable one as 0 would permanently cap the score; counting it as 100
 *     would inflate it.
 *  3. A passing check must be recorded as passed, not merely absent — otherwise
 *     "healthy" and "never ran" look identical.
 *  4. Severity must drive the score, so a critical finding cannot leave a
 *     category looking fine.
 *  5. The content checks must actually detect the defects they claim to (missing
 *     ALT, thin content, duplicate titles, a broken canonical), because every one
 *     of them is a silent failure in production.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { makeEnv, drizzleOf, type TestEnv } from './helpers/harness';
import { schema } from '../src/db';
import { runSeoAudit } from '../src/lib/seoAudit';

let env: TestEnv;

/** A minimal, fully-healthy rendered document for the probe stub. */
function goodHtml(opts: { canonical: string; robots?: string; jsonLd?: string[]; noscript?: boolean } = { canonical: 'https://tophunt.in/' }) {
  const types = opts.jsonLd ?? ['Organization', 'WebSite', 'SoftwareApplication'];
  return (
    `<!doctype html><html lang="en-IN"><head>` +
    `<title>TopHunt — Contests</title>` +
    `<meta name="robots" content="${opts.robots ?? 'index, follow'}">` +
    `<meta name="description" content="A description long enough to be useful in a search result snippet here.">` +
    `<link rel="canonical" href="${opts.canonical}">` +
    `<meta property="og:title" content="TopHunt">` +
    `<meta name="twitter:card" content="summary">` +
    types.map((t) => `<script type="application/ld+json">{"@type":"${t}"}</script>`).join('') +
    `</head><body>support@tophunt.in${opts.noscript === false ? '' : '<noscript><article>body</article></noscript>'}</body></html>`
  );
}

/**
 * Stub every probe the engine makes. Returning a healthy document for everything
 * means any failure a test sees comes from the D1 content it seeded, not the site.
 */
function stubSite(over: Record<string, { body?: string; status?: number; contentType?: string }> = {}, postCount = 1) {
  vi.stubGlobal('fetch', async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const path = url.pathname;
    const o = over[path];
    if (o) {
      return new Response(o.body ?? '', {
        status: o.status ?? 200,
        headers: { 'content-type': o.contentType ?? 'text/html' },
      });
    }
    if (path === '/robots.txt') {
      return new Response('User-agent: *\nAllow: /\n\nSitemap: https://tophunt.in/sitemap.xml\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (path === '/sitemap.xml') {
      const urls = Array.from({ length: postCount + 9 }, () => '<url><loc>x</loc></url>').join('');
      return new Response(`<?xml version="1.0"?><urlset>${urls}</urlset>`, {
        status: 200,
        headers: { 'content-type': 'application/xml' },
      });
    }
    if (path.startsWith('/wallet') || path.startsWith('/auth') || path.startsWith('/setting')) {
      return new Response(goodHtml({ canonical: `https://tophunt.in${path}`, robots: 'noindex, nofollow' }), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    if (path.includes('should-not-exist')) {
      return new Response(goodHtml({ canonical: 'https://tophunt.in/', robots: 'noindex, follow' }), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    return new Response(goodHtml({ canonical: `https://tophunt.in${path}`, jsonLd: ['Organization', 'WebSite', 'SoftwareApplication', 'Article'] }), {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  });
}

const LONG_BODY = `<h1>Title</h1>${'<p>word '.repeat(400)}</p><a href="/blog/other">related</a><img src="/a.jpg" alt="a chart">`;

async function seedPost(over: Record<string, any> = {}) {
  const now = Date.now();
  await drizzleOf(env)
    .insert(schema.blogPosts)
    .values({
      id: over.id ?? `p-${Math.random()}`,
      slug: over.slug ?? 'a-good-post',
      title: over.title ?? 'A perfectly reasonable post title',
      excerpt: over.excerpt ?? 'An excerpt that is comfortably long enough to serve as a meta description here.',
      content: over.content ?? LONG_BODY,
      coverImageUrl: over.coverImageUrl ?? 'https://media.tophunt.in/blog/imported/a.webp',
      author: over.author ?? 'TopHunt',
      category: over.category ?? 'Quiz',
      status: over.status ?? 'published',
      publishedAt: over.publishedAt ?? now,
      createdAt: now,
      updatedAt: over.updatedAt ?? now,
      ...over.extra,
    } as any)
    .run();
}

const cat = (a: Awaited<ReturnType<typeof runSeoAudit>>, id: string) => a.categories.find((c) => c.id === id)!;
const issue = (a: Awaited<ReturnType<typeof runSeoAudit>>, id: string) => a.issues.find((i) => i.id === id);

beforeEach(() => {
  ({ env } = makeEnv({ SEO_SITE_ORIGIN: 'https://tophunt.in' } as any));
});
afterEach(() => vi.unstubAllGlobals());

describe('scoring honesty', () => {
  it('scores an unmeasurable category as null, not a number', async () => {
    stubSite();
    await seedPost();
    const audit = await runSeoAudit(env);

    const offPage = cat(audit, 'offPage');
    expect(offPage.score).toBeNull();
    expect(offPage.status).toBe('not_configured');
    // The note must say what is needed, so the empty panel is self-explanatory.
    expect(offPage.note).toMatch(/Search Console|Ahrefs|Moz|Semrush/i);
  });

  it('averages only the measurable categories into the overall score', async () => {
    stubSite();
    await seedPost();
    const audit = await runSeoAudit(env);

    const measurable = audit.categories.filter((c) => c.score !== null).map((c) => c.score as number);
    expect(measurable.length).toBeGreaterThan(0);
    expect(audit.categories.some((c) => c.score === null)).toBe(true);
    const expected = Math.round(measurable.reduce((a, b) => a + b, 0) / measurable.length);
    expect(audit.overall).toBe(expected);
  });

  it('records passing checks, so healthy is distinguishable from never-ran', async () => {
    stubSite();
    await seedPost();
    const audit = await runSeoAudit(env);

    expect(audit.passed.length).toBeGreaterThan(10);
    expect(audit.passed.some((p) => p.id === 'tech.https')).toBe(true);
    const technical = cat(audit, 'technical');
    expect(technical.checksRun).toBeGreaterThan(0);
    expect(technical.checksPassed).toBeGreaterThan(0);
  });

  it('lets a critical finding fail its category outright', async () => {
    // Private screens indexable — the single worst technical outcome here.
    stubSite({
      '/wallet/withdraw': { body: goodHtml({ canonical: 'https://tophunt.in/wallet/withdraw', robots: 'index, follow' }) },
    });
    await seedPost();
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'tech.noindex.private');
    expect(found?.severity).toBe('critical');
    expect(cat(audit, 'technical').status).toBe('fail');
    expect(audit.totals.critical).toBeGreaterThan(0);
  });

  it('sorts issues by severity so the dashboard leads with what matters', async () => {
    stubSite({
      '/wallet/withdraw': { body: goodHtml({ canonical: 'https://tophunt.in/wallet/withdraw', robots: 'index, follow' }) },
    });
    await seedPost({ slug: 'thin', content: '<p>tiny</p>' });
    const audit = await runSeoAudit(env);

    const order = ['critical', 'high', 'medium', 'low'];
    const indices = audit.issues.map((i) => order.indexOf(i.severity));
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
  });
});

describe('content checks detect real defects', () => {
  it('flags images with no ALT text', async () => {
    stubSite();
    await seedPost({ content: `${LONG_BODY}<img src="/b.jpg"><img src="/c.jpg" alt="">` });
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'image.alt.missing');
    expect(found).toBeDefined();
    expect(found!.severity).toBe('high');
    // Both the bare img and the empty-alt img count.
    expect(found!.detail).toMatch(/2 images/);
  });

  it('does not flag images that have ALT text', async () => {
    stubSite();
    await seedPost();
    const audit = await runSeoAudit(env);
    expect(issue(audit, 'image.alt.missing')).toBeUndefined();
  });

  it('flags thin content', async () => {
    stubSite();
    await seedPost({ slug: 'thin-one', content: '<h1>Hi</h1><p>Only a few words here.</p>' });
    const audit = await runSeoAudit(env);

    expect(issue(audit, 'prog.thin_content')).toBeDefined();
    expect(issue(audit, 'content.very_thin')).toBeDefined();
  });

  it('flags duplicate titles across posts', async () => {
    stubSite({}, 2);
    await seedPost({ id: 'a', slug: 'one', title: 'Amazon Quiz Answers Today' });
    await seedPost({ id: 'b', slug: 'two', title: 'Amazon Quiz Answers Today' });
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'onpage.duplicate.title');
    expect(found).toBeDefined();
    expect(found!.affected[0]).toMatch(/×2/);
  });

  it('flags a post with no internal links', async () => {
    stubSite();
    await seedPost({ content: `<h1>T</h1>${'<p>word </p>'.repeat(400)}` });
    const audit = await runSeoAudit(env);
    expect(issue(audit, 'onpage.internal_links')).toBeDefined();
  });

  it('flags media still on the legacy Worker host', async () => {
    stubSite();
    await seedPost({ coverImageUrl: 'https://tophunt-api.weadown-in.workers.dev/media/blog/imported/x.jpg' });
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'image.legacy_host');
    expect(found).toBeDefined();
    expect(found!.suggestion).toMatch(/media-domain-backfill/);
  });

  it('flags a doubled /blog/blog/ canonical as critical', async () => {
    await seedPost({ slug: 'dbl' });
    stubSite({
      '/blog/dbl': { body: goodHtml({ canonical: 'https://tophunt.in/blog/blog/dbl/' }) },
    });
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'onpage.post.canonical_shape');
    expect(found?.severity).toBe('critical');
  });

  it('excludes drafts from every content check', async () => {
    stubSite();
    await seedPost({ id: 'live', slug: 'live-post' });
    await seedPost({ id: 'draft', slug: 'draft-post', status: 'draft', content: '<p>thin</p>', title: 'x' });
    const audit = await runSeoAudit(env);

    expect(audit.scope.posts).toBe(1);
    const affected = audit.issues.flatMap((i) => i.affected).join(' ');
    expect(affected).not.toMatch(/draft-post/);
  });
});

describe('technical checks', () => {
  it("detects a robots.txt that is not ours (managed robots override)", async () => {
    stubSite({
      '/robots.txt': {
        body: '# As a condition of accessing this website, you agree to abide by the following\n',
        contentType: 'text/plain',
      },
    });
    await seedPost();
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'tech.robots.sitemap');
    expect(found).toBeDefined();
    expect(found!.suggestion).toMatch(/managed|AI-crawl/i);
  });

  it('detects a sitemap served as HTML (edge Worker not running)', async () => {
    stubSite({ '/sitemap.xml': { body: '<!doctype html><html></html>', contentType: 'text/html' } });
    await seedPost();
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'tech.sitemap.xml');
    expect(found?.severity).toBe('critical');
  });

  it('detects a truncated sitemap', async () => {
    stubSite({
      '/sitemap.xml': {
        body: '<?xml version="1.0"?><urlset><url><loc>a</loc></url></urlset>',
        contentType: 'application/xml',
      },
    });
    for (let i = 0; i < 30; i++) await seedPost({ id: `p${i}`, slug: `post-${i}` });
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'tech.sitemap.complete');
    expect(found).toBeDefined();
    expect(found!.affectedCount).toBeGreaterThan(30);
  });

  it('tolerates a sitemap that is complete within rounding', async () => {
    stubSite({}, 30);
    for (let i = 0; i < 30; i++) await seedPost({ id: `p${i}`, slug: `post-${i}` });
    const audit = await runSeoAudit(env);
    expect(issue(audit, 'tech.sitemap.complete')).toBeUndefined();
  });

  it('passes when private routes are noindex', async () => {
    stubSite();
    await seedPost();
    const audit = await runSeoAudit(env);
    expect(issue(audit, 'tech.noindex.private')).toBeUndefined();
    expect(audit.passed.some((p) => p.id === 'tech.noindex.private')).toBe(true);
  });
});

describe('local SEO scope', () => {
  it('explains why city pages are deliberately absent instead of recommending them', async () => {
    stubSite();
    await seedPost();
    const audit = await runSeoAudit(env);

    const local = cat(audit, 'local');
    expect(local.note).toMatch(/doorway/i);
    // No check should ever ask for per-city landing pages.
    const ids = [...audit.issues, ...audit.passed].map((i) => i.id).join(' ');
    expect(ids).not.toMatch(/city/i);
  });
});

describe('AI search / GEO', () => {
  it('flags a missing SoftwareApplication schema with a no-fake-ratings warning', async () => {
    stubSite({ '/': { body: goodHtml({ canonical: 'https://tophunt.in/', jsonLd: ['Organization', 'WebSite'] }) } });
    await seedPost();
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'geo.softwareapplication_schema');
    expect(found).toBeDefined();
    expect(found!.suggestion).toMatch(/aggregateRating/);
  });

  it('flags content that is invisible without JavaScript', async () => {
    await seedPost({ slug: 'nojs' });
    stubSite({ '/blog/nojs': { body: goodHtml({ canonical: 'https://tophunt.in/blog/nojs/', noscript: false }) } });
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'geo.crawlable_without_js');
    expect(found?.severity).toBe('high');
  });

  it('counts FAQ-eligible posts rather than demanding schema everywhere', async () => {
    stubSite();
    await seedPost({
      content: `<h1>T</h1><h2>What is this?</h2><p>${'word '.repeat(200)}</p><h2>How does it work?</h2><p>answer</p><a href="/blog/x">x</a>`,
    });
    const audit = await runSeoAudit(env);

    const found = issue(audit, 'geo.faq_schema');
    expect(found).toBeDefined();
    expect(found!.suggestion).toMatch(/genuinely visible|misleading/i);
  });
});
