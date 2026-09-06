/**
 * Test harness for the real `public/_worker.js` — the file Cloudflare Pages serves.
 *
 * Every test here drives the ACTUAL worker module rather than a re-implementation
 * of its rules. That matters more than usual for this file: it is the entire SEO
 * layer for the site, it has no type checking (plain JS, no bundler), and its
 * failures are silent by construction — a wrong canonical tag or a 200 on a dead
 * url produces a page that looks perfect in a browser and quietly stops the
 * catalogue being indexed. A test that copied the rule would keep passing after
 * the worker changed, which is exactly the regression it exists to catch.
 *
 * Two workerd globals have no Node equivalent and are stubbed:
 *
 *  - `caches.default`, as a no-op, so `/sitemap.xml` always rebuilds instead of
 *    returning whatever a previous test cached.
 *  - `HTMLRewriter`. The stub below is a deliberate, minimal DOUBLE, not an
 *    emulation: it supports the three operations `injectSeo` actually performs
 *    (`title` setInnerContent, `head`/`body` append) and ignores the `remove()`
 *    calls, which only matter against the real Expo shell. It is enough to assert
 *    what the head ends up containing, which is the property under test.
 */

export interface FakeEnv {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  SEO_API_BASE?: string;
  SEO_SITE_ORIGIN?: string;
}

const SHELL = '<!doctype html><html><head><title>TopHunt</title></head><body><div id="root"></div></body></html>';

class FakeElement {
  constructor(
    private readonly apply: (fn: (html: string) => string) => void,
    private readonly tag: string,
  ) {}
  setInnerContent(text: string) {
    this.apply((html) =>
      html.replace(new RegExp(`<${this.tag}>[\\s\\S]*?</${this.tag}>`), `<${this.tag}>${text}</${this.tag}>`),
    );
  }
  append(fragment: string) {
    this.apply((html) => html.replace(`</${this.tag}>`, `${fragment}</${this.tag}>`));
  }
  remove() {
    /* the shell used in tests carries none of the tags injectSeo removes */
  }
}

class FakeHTMLRewriter {
  private handlers: Array<[string, any]> = [];
  on(selector: string, handler: any) {
    this.handlers.push([selector, handler]);
    return this;
  }
  transform(res: Response) {
    const { readable, writable } = new TransformStream();
    const handlers = this.handlers;
    void (async () => {
      let html = await res.text();
      const apply = (fn: (h: string) => string) => {
        html = fn(html);
      };
      for (const [selector, handler] of handlers) {
        if (!handler || typeof handler.element !== 'function') continue;
        // Only the element selectors this worker relies on are honoured.
        if (selector === 'title' || selector === 'head' || selector === 'body') {
          handler.element(new FakeElement(apply, selector));
        }
      }
      const writer = writable.getWriter();
      await writer.write(new TextEncoder().encode(html));
      await writer.close();
    })();
    return new Response(readable, { status: res.status, headers: res.headers });
  }
}

/** Install the workerd globals the worker expects, then import it. */
export async function loadWorker() {
  (globalThis as any).HTMLRewriter ??= FakeHTMLRewriter;
  (globalThis as any).caches ??= {
    default: {
      async match() {
        return undefined;
      },
      async put() {},
      async delete() {
        return false;
      },
    },
  };
  return (await import('../../public/_worker.js' as any)).default;
}

export const fakeEnv: FakeEnv = {
  ASSETS: {
    fetch: async () => new Response(SHELL, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
  },
};

export const fakeCtx = { waitUntil() {}, passThroughOnException() {} };

/**
 * Route the worker's outbound API calls to an in-memory table.
 *
 * Keys are exact pathnames, or a `/prefix/*` wildcard (used for
 * `/read/blog/<slug>`, where the slug is part of the path). Returns a restore
 * function. Any un-stubbed path throws, so a test cannot pass because the worker
 * quietly took a different branch than the one being exercised.
 */
export function stubApi(routes: Record<string, (url: URL) => Response>) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    let handler = routes[url.pathname];
    if (!handler) {
      const wildcard = Object.keys(routes)
        .filter((k) => k.endsWith('/*'))
        // Longest prefix wins, so `/read/blog/sitemap` beats `/read/blog/*`.
        .sort((a, b) => b.length - a.length)
        .find((k) => url.pathname.startsWith(k.slice(0, -1)));
      if (wildcard) handler = routes[wildcard];
    }
    if (!handler) throw new Error(`unstubbed API call: ${url.pathname}`);
    return handler(url);
  }) as any;
  return () => {
    globalThis.fetch = original;
  };
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** GET a url through the worker. `accept` defaults to a browser navigation. */
export async function get(url: string, init: { accept?: string; env?: FakeEnv } = {}) {
  const worker = await loadWorker();
  const headers: Record<string, string> = {};
  if (init.accept !== '') headers.accept = init.accept ?? 'text/html';
  return worker.fetch(new Request(url, { headers }), init.env ?? fakeEnv, fakeCtx);
}
