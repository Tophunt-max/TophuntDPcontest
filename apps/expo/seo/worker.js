/**
 * Cloudflare Pages "advanced mode" Worker for tophunt.in (Expo web SPA).
 *
 * Why this exists
 * ---------------
 * The web app is a client-side rendered Expo (React Native Web) SPA
 * (`app.json` -> web.output = "single"). Crawlers that fetch a blog URL get a
 * near-empty HTML shell with a generic <title> and no per-page meta — which is
 * fatal for Google ranking. This Worker runs at the edge in front of the static
 * assets and, for blog/permalink URLs, rewrites the shell's <head> with the
 * post's real SEO tags (title, description, canonical, Open Graph, Twitter,
 * JSON-LD Article) plus a <noscript> content block for non-JS crawlers.
 *
 * It also serves:
 *   - /robots.txt   (points at the sitemap, allows crawling)
 *   - /sitemap.xml  (all published posts + key routes, built from the API)
 *
 * Deployment: this file is copied to `dist/_worker.js` after `expo export`
 * (see scripts/build-seo-worker.mjs). In advanced mode ALL requests hit this
 * Worker; static files and the SPA fallback are served via `env.ASSETS`.
 *
 * Config (optional Pages env vars, sensible defaults below):
 *   - SEO_API_BASE     Worker API base (default below is the live API)
 *   - SEO_SITE_ORIGIN  Public origin (default: https://tophunt.in)
 */

const DEFAULT_API_BASE = 'https://tophunt-api.weadown-in.workers.dev';
const DEFAULT_SITE_ORIGIN = 'https://tophunt.in';
const SITE_NAME = 'TopHunt';
const DEFAULT_DESCRIPTION =
  'TopHunt — contests, quizzes, giveaways and the latest offers, answers and updates.';

// Top-level app routes that must NEVER be treated as a blog permalink. Mirrors
// the folders/files under apps/expo/app/.
const RESERVED = new Set([
  '',
  'index',
  'home',
  'splash',
  'auth',
  'blog',
  'contest',
  'explore',
  'legal',
  'maintenance',
  'messages',
  'notifications',
  'onboarding',
  'profile',
  'setting',
  'story',
  'wallet',
  'force-update',
  'assets',
  '_expo',
  'sitemap.xml',
  'robots.txt',
  'favicon.png',
  'favicon.ico',
  'firebase-messaging-sw.js',
]);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    const apiBase = (env && env.SEO_API_BASE) || DEFAULT_API_BASE;
    const origin = (env && env.SEO_SITE_ORIGIN) || DEFAULT_SITE_ORIGIN;

    // --- robots.txt --------------------------------------------------------
    if (path === '/robots.txt') {
      return new Response(robotsTxt(origin), {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' },
      });
    }

    // --- sitemap.xml -------------------------------------------------------
    if (path === '/sitemap.xml') {
      return getSitemap(request, env, ctx, apiBase, origin);
    }

    // Only HTML navigations get SEO treatment. Everything else (JS/CSS/images/
    // API-less asset fetches) is served straight from static assets.
    const accept = request.headers.get('accept') || '';
    const isHtmlNav = request.method === 'GET' && accept.includes('text/html');
    if (!isHtmlNav) {
      return env.ASSETS.fetch(request);
    }

    const slug = blogSlugFromPath(path);
    if (slug) {
      try {
        const post = await fetchPost(apiBase, slug);
        if (post && post.title) {
          const shell = await fetchShell(env, origin);
          const canonicalPath = `/${post.slug || slug}`;
          return injectPostSeo(shell, post, origin, canonicalPath);
        }
      } catch (_err) {
        // fall through to plain SPA shell on any failure
      }
    }

    // /blog listing gets a static, sensible title/description.
    if (path === '/blog' || path === '/blog/') {
      try {
        const shell = await fetchShell(env, origin);
        return injectListSeo(shell, origin);
      } catch (_err) {
        /* fall through */
      }
    }

    // Default: SPA shell (client-side routing takes over).
    return fetchShell(env, origin);
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function blogSlugFromPath(path) {
  const clean = path.replace(/\/+$/, '');
  const segments = clean.split('/').filter(Boolean);
  if (segments.length === 2 && segments[0] === 'blog') return segments[1];
  if (segments.length === 1) {
    const s = segments[0];
    if (!RESERVED.has(s) && !s.includes('.')) return s;
  }
  return null;
}

async function fetchShell(env, origin) {
  // Always serve the SPA entry document for HTML navigations.
  const res = await env.ASSETS.fetch(new Request(`${origin}/index.html`));
  // Ensure HTML pages aren't cached too long so crawlers pick up fresh meta.
  const headers = new Headers(res.headers);
  headers.set('cache-control', 'public, max-age=0, must-revalidate');
  return new Response(res.body, { status: res.status, headers });
}

async function fetchPost(apiBase, slug) {
  const res = await fetch(`${apiBase}/read/blog/${encodeURIComponent(slug)}`, {
    headers: { accept: 'application/json' },
    cf: { cacheTtl: 300, cacheEverything: true },
  });
  if (!res.ok) return null;
  return res.json();
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(str, n) {
  const s = String(str || '').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).replace(/\s+\S*$/, '') + '\u2026';
}

function injectPostSeo(shellResp, post, origin, canonicalPath) {
  const title = post.metaTitle || post.title;
  const fullTitle = /tophunt/i.test(title) ? title : `${title} | ${SITE_NAME}`;
  const bodyText = stripHtml(post.content || post.excerpt || '');
  const description = truncate(post.metaDescription || post.excerpt || bodyText || DEFAULT_DESCRIPTION, 160);
  // Prefer the original permalink as canonical if it lives on this site;
  // otherwise self-canonical to the current site path.
  let canonical = `${origin}${canonicalPath}`;
  if (post.canonicalUrl && /^https?:\/\//i.test(post.canonicalUrl)) {
    try {
      const cu = new URL(post.canonicalUrl);
      const site = new URL(origin);
      if (cu.hostname.replace(/^www\./, '') === site.hostname.replace(/^www\./, '')) {
        canonical = cu.toString();
      }
    } catch (_e) {
      /* keep self-canonical */
    }
  }
  const image = post.coverImageUrl || '';
  const published = post.publishedAt || post.createdAt;
  const publishedIso = published ? new Date(Number(published)).toISOString() : undefined;
  const author = post.author || SITE_NAME;
  const tags = Array.isArray(post.tags) ? post.tags : [];

  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: truncate(post.title, 110),
    description,
    ...(image ? { image: [image] } : {}),
    ...(publishedIso ? { datePublished: publishedIso, dateModified: publishedIso } : {}),
    author: { '@type': 'Organization', name: author },
    publisher: {
      '@type': 'Organization',
      name: SITE_NAME,
      logo: { '@type': 'ImageObject', url: `${origin}/favicon.png` },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': canonical },
    ...(tags.length ? { keywords: tags.join(', ') } : {}),
  };

  const head =
    `\n<meta name="description" content="${esc(description)}">` +
    `\n<link rel="canonical" href="${esc(canonical)}">` +
    `\n<meta property="og:type" content="article">` +
    `\n<meta property="og:site_name" content="${esc(SITE_NAME)}">` +
    `\n<meta property="og:title" content="${esc(fullTitle)}">` +
    `\n<meta property="og:description" content="${esc(description)}">` +
    `\n<meta property="og:url" content="${esc(canonical)}">` +
    (image ? `\n<meta property="og:image" content="${esc(image)}">` : '') +
    (publishedIso ? `\n<meta property="article:published_time" content="${esc(publishedIso)}">` : '') +
    tags.map((t) => `\n<meta property="article:tag" content="${esc(t)}">`).join('') +
    `\n<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">` +
    `\n<meta name="twitter:title" content="${esc(fullTitle)}">` +
    `\n<meta name="twitter:description" content="${esc(description)}">` +
    (image ? `\n<meta name="twitter:image" content="${esc(image)}">` : '') +
    `\n<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`;

  // Content block for crawlers that don't execute JS (and as a semantic anchor).
  const noscript =
    `<noscript><article>` +
    `<h1>${esc(post.title)}</h1>` +
    (image ? `<img src="${esc(image)}" alt="${esc(post.title)}" width="1200" />` : '') +
    (post.excerpt ? `<p>${esc(post.excerpt)}</p>` : '') +
    (post.content || '') +
    `</article></noscript>`;

  return new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(fullTitle);
      },
    })
    .on('meta[name="description"]', { element(el) { el.remove(); } })
    .on('link[rel="canonical"]', { element(el) { el.remove(); } })
    .on('meta[property^="og:"]', { element(el) { el.remove(); } })
    .on('meta[name^="twitter:"]', { element(el) { el.remove(); } })
    .on('head', {
      element(el) {
        el.append(head, { html: true });
      },
    })
    .on('body', {
      element(el) {
        el.append(noscript, { html: true });
      },
    })
    .transform(shellResp);
}

function injectListSeo(shellResp, origin) {
  const title = `Blog | ${SITE_NAME}`;
  const description = truncate(
    'Read the latest TopHunt articles — contest answers, quiz solutions, giveaway guides and offer updates.',
    160,
  );
  const canonical = `${origin}/blog`;
  const head =
    `\n<meta name="description" content="${esc(description)}">` +
    `\n<link rel="canonical" href="${esc(canonical)}">` +
    `\n<meta property="og:type" content="website">` +
    `\n<meta property="og:site_name" content="${esc(SITE_NAME)}">` +
    `\n<meta property="og:title" content="${esc(title)}">` +
    `\n<meta property="og:description" content="${esc(description)}">` +
    `\n<meta property="og:url" content="${esc(canonical)}">` +
    `\n<meta name="twitter:card" content="summary">` +
    `\n<meta name="twitter:title" content="${esc(title)}">` +
    `\n<meta name="twitter:description" content="${esc(description)}">`;
  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(title); } })
    .on('meta[name="description"]', { element(el) { el.remove(); } })
    .on('link[rel="canonical"]', { element(el) { el.remove(); } })
    .on('meta[property^="og:"]', { element(el) { el.remove(); } })
    .on('meta[name^="twitter:"]', { element(el) { el.remove(); } })
    .on('head', { element(el) { el.append(head, { html: true }); } })
    .transform(shellResp);
}

function robotsTxt(origin) {
  return [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${origin}/sitemap.xml`,
    '',
  ].join('\n');
}

async function getSitemap(request, env, ctx, apiBase, origin) {
  const cache = caches.default;
  const cacheKey = new Request(`${origin}/sitemap.xml`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const urls = [];
  const push = (loc, lastmod, priority) =>
    urls.push({ loc: `${origin}${loc}`, lastmod, priority });

  push('/', undefined, '0.9');
  push('/blog', undefined, '0.8');

  // Paginate through published posts via the public API.
  let cursor = null;
  const MAX_PAGES = 200; // safety cap (~10k posts at 50/page)
  for (let i = 0; i < MAX_PAGES; i++) {
    const u = new URL(`${apiBase}/read/blog`);
    u.searchParams.set('limit', '50');
    if (cursor) u.searchParams.set('cursor', String(cursor));
    let data;
    try {
      const res = await fetch(u.toString(), {
        headers: { accept: 'application/json' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!res.ok) break;
      data = await res.json();
    } catch (_e) {
      break;
    }
    const posts = (data && data.posts) || [];
    for (const p of posts) {
      const lastmod = p.publishedAt || p.createdAt;
      push(
        `/${p.slug}`,
        lastmod ? new Date(Number(lastmod)).toISOString() : undefined,
        '0.7',
      );
    }
    cursor = data && data.nextCursor;
    if (!cursor || posts.length === 0) break;
  }

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls
      .map(
        (u) =>
          `  <url><loc>${esc(u.loc)}</loc>` +
          (u.lastmod ? `<lastmod>${esc(u.lastmod)}</lastmod>` : '') +
          (u.priority ? `<priority>${u.priority}</priority>` : '') +
          `</url>`,
      )
      .join('\n') +
    `\n</urlset>\n`;

  const response = new Response(body, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
