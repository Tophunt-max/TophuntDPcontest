/* TopHunt web service worker: offline start and faster repeat visits.
 *
 * What it caches, and nothing else:
 *  - content-hashed build files (`/_expo/static/...`, `/assets/...`), cache-first.
 *    A hash in the name means the bytes never change, so a cached copy is always
 *    right, and a new deploy simply asks for new names;
 *  - the HTML shell from the last successful page load, used ONLY when the network
 *    fails, so an offline open or reload still starts the app (which then shows
 *    its own offline banner and the saved feed from IndexedDB);
 *  - nothing for the offline page: it is built below (OFFLINE_HTML), because
 *    Pages redirects `*.html` to an extension-less url that this site answers
 *    with the app shell.
 *
 *  - images from the media host (MEDIA_ORIGINS), cache-first, at most
 *    MAX_MEDIA_ENTRIES (oldest dropped first), so feed cards, avatars and
 *    Story thumbnails the user already saw still show offline. Only
 *    `destination: image` GETs, fetched with CORS so the stored copy is a real
 *    (not opaque) response; video and Range requests are never cached. Media
 *    keys are unguessable public URLs, the same bytes the browser HTTP cache
 *    holds; the app deletes this cache on sign-out (lib/serviceWorker.web.ts).
 *
 * What it never touches (the request goes straight to the network as if this file
 * did not exist): anything not GET, anything else cross-origin (the API, Firebase,
 * Razorpay, media video), `/__/*` (Firebase auth proxy), `/api`, `/read`, `/auth/*`
 * API calls, requests carrying credentials headers, Range requests, and the two
 * service-worker scripts. Responses marked `no-store` or `private` are never kept.
 * Signed-in data is therefore never in Cache Storage; it lives where it did before
 * (memory and the WatermelonDB/IndexedDB store, cleared on sign-out).
 *
 * Versioning: BUILD_ID and PRECACHE are filled in by scripts/stamp-sw.mjs after
 * `expo export`. Each deploy gets a new cache; old ones are deleted on activate.
 * Unstamped (`dev`), the worker still works; it just has nothing to precache.
 *
 * Emergency off switch: build with EXPO_PUBLIC_SW=off (the app then unregisters
 * this worker), or replace this file with one that calls
 * `self.registration.unregister()`.
 */
const BUILD_ID = 'dev'; // @stamp:build-id
const PRECACHE = []; // @stamp:precache

const PREFIX = 'tophunt-';
const STATIC_CACHE = `${PREFIX}static-${BUILD_ID}`;
const SHELL_CACHE = `${PREFIX}shell`;
const SHELL_KEY = '/__sw_shell__';
/** Runtime-cached hashed files kept at most (oldest dropped first). */
const MAX_STATIC_ENTRIES = 150;
/** Offline images. Name shared with src/lib/serviceWorker.web.ts (sign-out clear). */
const MEDIA_CACHE = `${PREFIX}media`;
const MEDIA_ORIGINS = ['https://media.tophunt.in'];
const MAX_MEDIA_ENTRIES = 300;

/** Shown for a navigation when offline and no app shell has been saved yet. */
const OFFLINE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>TopHunt · Offline</title><style>
html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;text-align:center;
font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#fff;color:#212121;padding:24px;box-sizing:border-box}
@media (prefers-color-scheme:dark){body{background:#181A20;color:#fff}}
h1{font-size:22px;margin:16px 0 8px}p{font-size:15px;opacity:.75;margin:0 auto 24px;max-width:320px}
a{display:inline-block;background:#FF4D67;color:#fff;border-radius:999px;font-size:16px;font-weight:600;padding:12px 28px;text-decoration:none}
</style></head><body><main><h1>You're offline</h1>
<p>TopHunt needs a connection to load for the first time on this device. Check your internet and try again.</p>
<a href="">Try again</a></main></body></html>`;

const HASHED = /^\/(?:_expo\/static|assets)\/.+[.-][0-9a-f]{16,}(?:@\dx)?\.[a-z0-9]+$/i;
const NEVER = /^\/(?:__\/|api(?:\/|$)|read(?:\/|$)|upload(?:\/|$)|ws(?:\/|$)|telemetry(?:\/|$)|sw\.js$|firebase-messaging-sw\.js$)/;

/**
 * How a request is handled: 'static' (cache-first), 'navigate' (network, then the
 * saved shell), or null (not handled at all). Exposed for tests.
 */
function route(request, origin) {
  if (request.method !== 'GET') return null;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const h = request.headers;
  if (h.get('authorization') || h.get('range') || h.get('x-admin-secret')) return null;
  if (url.origin !== origin) {
    return MEDIA_ORIGINS.includes(url.origin) && request.destination === 'image' ? 'media' : null;
  }
  if (NEVER.test(url.pathname)) return null;
  if (request.mode === 'navigate') return 'navigate';
  if (HASHED.test(url.pathname) && !url.search) return 'static';
  return null;
}

function storable(res) {
  if (!res || res.status !== 200 || res.type === 'opaque') return false;
  const cc = (res.headers.get('cache-control') || '').toLowerCase();
  return !/\bno-store\b|\bprivate\b/.test(cc);
}

async function trim(cache, max = MAX_STATIC_ENTRIES) {
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]);
}

/**
 * Media image: the saved copy if there is one, else the network (with CORS, so
 * the copy is storable). If the CORS fetch fails (offline, or a host that does
 * not allow this origin) the browser's own request runs instead, unchanged.
 */
async function mediaFirst(request) {
  const cache = await caches.open(MEDIA_CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;
  let res;
  try {
    res = await fetch(new Request(request.url, { mode: 'cors', credentials: 'omit' }));
  } catch {
    return fetch(request);
  }
  if (storable(res)) {
    await cache.put(request.url, res.clone());
    await trim(cache, MAX_MEDIA_ENTRIES);
  }
  return res;
}

async function staticFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (storable(res)) {
    await cache.put(request, res.clone());
    await trim(cache);
  }
  return res;
}

async function navigate(request) {
  try {
    const res = await fetch(request);
    const type = res.headers.get('content-type') || '';
    if (storable(res) && type.includes('text/html')) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(SHELL_KEY, res.clone());
    }
    return res;
  } catch {
    const shell = await (await caches.open(SHELL_CACHE)).match(SHELL_KEY);
    if (shell) return shell;
    return new Response(OFFLINE_HTML, { status: 503, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(STATIC_CACHE);
      // One by one, so a single missing file does not abort the install.
      await Promise.all(
        PRECACHE.map(async (u) => {
          try {
            const res = await fetch(u, { cache: 'reload' });
            if (storable(res)) await cache.put(u, res);
          } catch {
            /* fetched again on first use */
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n.startsWith(`${PREFIX}static-`) && n !== STATIC_CACHE).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const kind = route(event.request, self.location.origin);
  if (kind === 'static') event.respondWith(staticFirst(event.request));
  else if (kind === 'navigate') event.respondWith(navigate(event.request));
  else if (kind === 'media') event.respondWith(mediaFirst(event.request));
});

self.__tophuntSw = { route, storable, navigate, staticFirst, mediaFirst, BUILD_ID, PRECACHE, STATIC_CACHE, SHELL_CACHE, SHELL_KEY, MEDIA_CACHE, MAX_MEDIA_ENTRIES };
