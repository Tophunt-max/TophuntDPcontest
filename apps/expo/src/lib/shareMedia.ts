/**
 * Reading media BYTES on web (for share files, downloads and card captures).
 *
 * Displaying an image is easy; reading its pixels or bytes from script is not.
 * `fetch()`, a canvas `drawImage` + `toBlob`, and `html-to-image` all need the
 * response to carry `Access-Control-Allow-Origin` — and on `media.tophunt.in`
 * that was not reliable:
 *
 *  - The R2 custom domain only adds CORS headers when the request carries an
 *    `Origin`, and then without `Vary: Origin` on the plain response. A normal
 *    `<img>` (no `crossorigin`) loads the photo first and the browser caches that
 *    header-less response; a later `fetch(url, { mode: 'cors' })` can be answered
 *    from that cache entry and fail the CORS check. That is how the winner-card
 *    screenshot failed on phones and sharing silently fell back to a text link.
 *  - `/cdn-cgi/image/...` variants are served with no CORS headers at all.
 *
 * The fix is to stop depending on CORS for reads: the web app's edge Worker
 * (`public/_worker.js`) serves the same objects SAME-ORIGIN under
 * `/share-media/<key>`, so a read from tophunt.in never asks for CORS at all.
 * The direct url is still tried as a fallback (local dev has no edge Worker),
 * with `cache: 'no-store'` so a poisoned cache entry cannot be reused.
 *
 * Kept free of react-native imports so it runs in plain Node tests.
 */

/** Media hosts the edge proxy will serve (must match `_worker.js#SHARE_MEDIA_HOSTS`). */
const MEDIA_BASES = ['https://media.tophunt.in/', 'https://tophunt-api.weadown-in.workers.dev/media/'];

/** Bunny Stream pull zones carry video posters. */
const BUNNY_HOST = /^[a-z0-9-]+\.b-cdn\.net$/i;

/** Same-origin proxy path prefix (served by `public/_worker.js`). */
export const SHARE_MEDIA_PATH = '/share-media/';

/** Default bound on one image read. A share must never hang on a stalled fetch. */
export const MEDIA_READ_TIMEOUT_MS = 12_000;

function pageOrigin(): string | null {
  try {
    const loc = typeof window !== 'undefined' ? window.location : null;
    if (!loc || loc.protocol !== 'https:' || !loc.origin) return null;
    // Local dev / LAN hosts have no edge Worker in front of them.
    if (/^(localhost|127\.|10\.|192\.168\.)/.test(loc.hostname)) return null;
    return loc.origin.replace(/\/$/, '');
  } catch {
    return null;
  }
}

/**
 * The same-origin proxy url for a media url, or null when it is not proxyable
 * (third-party host, `/cdn-cgi/` variant, not on web, or no edge Worker).
 */
export function sameOriginMediaUrl(url: string | null | undefined, origin: string | null = pageOrigin()): string | null {
  if (!url || !origin || typeof url !== 'string') return null;
  // A variant has no CORS and no stable key; callers pass the original instead.
  for (const base of MEDIA_BASES) {
    if (url.startsWith(base)) {
      const key = url.slice(base.length).split(/[?#]/)[0];
      if (!key || key.startsWith('cdn-cgi/') || key.includes('..')) return null;
      return `${origin}${SHARE_MEDIA_PATH}${key}`;
    }
  }
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && BUNNY_HOST.test(u.hostname) && !u.pathname.includes('..')) {
      return `${origin}${SHARE_MEDIA_PATH}bunny/${u.hostname}${u.pathname}`;
    }
  } catch {
    /* not a url */
  }
  return null;
}

/** Reject after `ms`, aborting the underlying work when a controller is given. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string, controller?: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        try {
          controller?.abort();
        } catch {
          /* ignore */
        }
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function readOnce(url: string, init: RequestInit, timeoutMs: number): Promise<Blob> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  const res = await withTimeout(fetch(url, { ...init, signal: controller?.signal }), timeoutMs, 'image read', controller);
  if (!res.ok) throw new Error(`image read failed (${res.status})`);
  const blob = await res.blob();
  // An SPA fallback (index.html) or an error page must never become a "photo".
  if (blob.type && !blob.type.startsWith('image/')) throw new Error(`not an image (${blob.type})`);
  if (!blob.size) throw new Error('empty image');
  return blob;
}

/**
 * Read an image's bytes so script can use them. `blob:`/`data:` are read as-is;
 * owned media goes through the same-origin proxy first, then directly.
 * Throws when every route fails.
 */
export async function readImageBlob(url: string, opts: { timeoutMs?: number } = {}): Promise<Blob> {
  const timeoutMs = opts.timeoutMs ?? MEDIA_READ_TIMEOUT_MS;
  if (url.startsWith('blob:') || url.startsWith('data:')) return readOnce(url, {}, timeoutMs);
  const proxied = sameOriginMediaUrl(url);
  let firstError: unknown = null;
  if (proxied) {
    try {
      return await readOnce(proxied, { credentials: 'omit' }, timeoutMs);
    } catch (e) {
      firstError = e;
    }
  }
  try {
    return await readOnce(url, { mode: 'cors', credentials: 'omit', cache: 'no-store' }, timeoutMs);
  } catch (e) {
    throw firstError ?? e;
  }
}
