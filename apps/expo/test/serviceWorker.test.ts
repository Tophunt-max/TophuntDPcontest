/**
 * public/sw.js (offline shell + hashed-file cache), run as the real file in a
 * sandbox with fake `caches`/`fetch`, plus the edge worker's cache headers and the
 * registration switch.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { swMode } from '@/src/lib/serviceWorker.web';
import { get, fakeEnv } from './helpers/edgeWorker';

const ORIGIN = 'https://tophunt.in';
const SRC = readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const key = (r: any) => (typeof r === 'string' ? new URL(r, ORIGIN).href : r.url);
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name)!;
    return {
      match: async (r: any) => m.get(key(r))?.clone(),
      put: async (r: any, res: Response) => void m.set(key(r), res),
      keys: async () => [...m.keys()].map((u) => new Request(u)),
      delete: async (r: any) => m.delete(key(r)),
    };
  };
  return { stores, api: { open, keys: async () => [...stores.keys()], delete: async (n: string) => stores.delete(n), match: async () => undefined } };
}

function loadSw(fetchImpl: (r: any) => Promise<Response>) {
  const listeners: Record<string, (e: any) => void> = {};
  const c = fakeCaches();
  const self: any = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, fn: any) => (listeners[t] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(SRC, { self, caches: c.api, fetch: fetchImpl, Response, Request, Headers, URL, console, Promise });
  return { sw: self.__tophuntSw, listeners, caches: c };
}

const req = (path: string, init: Omit<RequestInit, 'mode'> & { mode?: string } = {}) => {
  const { mode, ...rest } = init;
  const r = new Request(path.startsWith('http') ? path : ORIGIN + path, rest);
  if (mode) Object.defineProperty(r, 'mode', { value: mode });
  return r;
};

describe('sw.js routing', () => {
  const { sw } = loadSw(async () => new Response(''));
  it('caches only same-origin hashed build files and handles navigations', () => {
    expect(sw.route(req('/_expo/static/js/web/entry-16d934f4b4adb2f7df8a7bc86ed00bc3.js'), ORIGIN)).toBe('static');
    expect(sw.route(req('/assets/assets/images/x.c39a8875a9a75ad7f95ce3b80f53bac5@2x.png'), ORIGIN)).toBe('static');
    expect(sw.route(req('/wallet', { mode: 'navigate' }), ORIGIN)).toBe('navigate');
  });
  it('never touches the API, auth proxy, other origins, writes, credentials or unhashed files', () => {
    for (const r of [
      req('https://api.tophunt.in/read/matches'),
      req('https://media.tophunt.in/a.jpg'),
      req('/__/auth/handler', { mode: 'navigate' }),
      req('/api'),
      req('/read/blog'),
      req('/sw.js'),
      req('/firebase-messaging-sw.js'),
      req('/explore-banners/a.svg'),
      req('/_expo/static/js/web/entry-16d934f4b4adb2f7df8a7bc86ed00bc3.js?x=1'),
      req('/_expo/static/js/web/entry-16d934f4b4adb2f7df8a7bc86ed00bc3.js', { headers: { Range: 'bytes=0-1' } }),
      req('/_expo/static/js/web/entry-16d934f4b4adb2f7df8a7bc86ed00bc3.js', { headers: { Authorization: 'Bearer x' } }),
      req('/', { method: 'POST', body: 'x' }),
    ]) {
      expect(sw.route(r, ORIGIN), r.url).toBeNull();
    }
  });
  it('does not store no-store, private, errors or opaque responses', () => {
    expect(sw.storable(new Response('x'))).toBe(true);
    expect(sw.storable(new Response('x', { headers: { 'cache-control': 'private, no-store' } }))).toBe(false);
    expect(sw.storable(new Response('x', { status: 404 }))).toBe(false);
  });
});

describe('sw.js offline behaviour', () => {
  it('serves the last saved shell when the network fails, else a built-in offline page', async () => {
    let online = true;
    const { sw } = loadSw(async () => {
      if (!online) throw new TypeError('Failed to fetch');
      return new Response('<html>shell</html>', { headers: { 'content-type': 'text/html' } });
    });
    online = false;
    const first: Response = await sw.navigate(req('/', { mode: 'navigate' }));
    expect(first.status).toBe(503);
    expect(await first.text()).toContain("You're offline");
    online = true;
    await sw.navigate(req('/contest/abc', { mode: 'navigate' }));
    online = false;
    const later: Response = await sw.navigate(req('/wallet', { mode: 'navigate' }));
    expect(await later.text()).toBe('<html>shell</html>');
  });
  it('a hashed file is fetched once, then served from the cache', async () => {
    let calls = 0;
    const { sw } = loadSw(async () => {
      calls++;
      return new Response('js');
    });
    const r = req('/_expo/static/js/web/index-7d55f95999bfbeb1f2e9ffd15df0d29d.js');
    await sw.staticFirst(r);
    expect(await (await sw.staticFirst(r)).text()).toBe('js');
    expect(calls).toBe(1);
  });
  it('activate deletes caches from older builds but keeps the shell', async () => {
    const { listeners, caches, sw } = loadSw(async () => new Response(''));
    await caches.api.open('tophunt-static-old');
    await caches.api.open(sw.STATIC_CACHE);
    await caches.api.open(sw.SHELL_CACHE);
    let done: Promise<unknown> = Promise.resolve();
    listeners.activate({ waitUntil: (p: Promise<unknown>) => (done = p) });
    await done;
    expect([...caches.stores.keys()].sort()).toEqual([sw.SHELL_CACHE, sw.STATIC_CACHE].sort());
  });
});

describe('edge cache headers (public/_worker.js)', () => {
  const env = (body: string, type: string) => ({ ...fakeEnv, ASSETS: { fetch: async () => new Response(body, { headers: { 'content-type': type } }) } });
  it('hashed build files are immutable for a year', async () => {
    const res = await get(`${ORIGIN}/_expo/static/js/web/entry-16d934f4b4adb2f7df8a7bc86ed00bc3.js`, { accept: '*/*', env: env('x', 'application/javascript') });
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
  it('the service worker is always revalidated; the manifest has its type', async () => {
    const sw = await get(`${ORIGIN}/sw.js`, { accept: '*/*', env: env('x', 'application/javascript') });
    expect(sw.headers.get('cache-control')).toBe('no-cache');
    expect(sw.headers.get('service-worker-allowed')).toBe('/');
    const m = await get(`${ORIGIN}/manifest.json`, { accept: '*/*', env: env('{}', 'application/octet-stream') });
    expect(m.headers.get('content-type')).toBe('application/manifest+json');
  });
  it('unhashed files are left alone', async () => {
    const res = await get(`${ORIGIN}/explore-banners/a.svg`, { accept: '*/*', env: env('<svg/>', 'image/svg+xml') });
    expect(res.headers.get('cache-control')).toBeNull();
  });
});

describe('registration switch', () => {
  it('registers in production, skips in development, and EXPO_PUBLIC_SW=off unregisters', () => {
    expect(swMode({ dev: false, flag: undefined })).toBe('register');
    expect(swMode({ dev: true, flag: undefined })).toBe('skip');
    expect(swMode({ dev: false, flag: 'off' })).toBe('unregister');
  });
});
