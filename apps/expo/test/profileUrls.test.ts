/**
 * `/@handle` at the EDGE — the public profile url, as Cloudflare Pages serves it.
 *
 * ---------------------------------------------------------------------------
 * What changed, and why it needs its own tests
 * ---------------------------------------------------------------------------
 * The shareable profile address was `/profile?userId=<firebase-uid>`. The uid is not
 * a secret and not a capability — the socket path checks it against a verified token,
 * and it was already readable off the leaderboard — but it is an INTERNAL identifier,
 * and internal identifiers do not belong in a url a person copies into a chat. It is
 * now `/@handle`, with the old form 301-ing forward so links already in circulation
 * keep working.
 *
 * Three properties here are invisible in a browser and can only be pinned by a test:
 *
 * 1. ROUTE PRECEDENCE. `blogSlugFromPath` claims EVERY one-segment path, and
 *    `app/[slug].tsx` does the same client-side. If the handle branch is ever moved
 *    below the blog branch, `/@alice` becomes "blog post not found" — a 404 on a real
 *    profile, served with a perfectly normal-looking page.
 *
 * 2. ONE URL PER PROFILE. Handles are case-insensitive, so without the lowercase
 *    redirect `/@Alice` and `/@alice` are two addresses for one page. Both would
 *    render correctly, and the duplication would only show up in Search Console.
 *
 * 3. AN UPSTREAM BLIP IS NOT A 404. Same reasoning as the blog branch: answering 404
 *    because the API had a bad minute is how an indexed page gets dropped. 503 asks
 *    for a redelivery instead.
 *
 * The worker module is imported once and shared, so `stubApi` is restored after every
 * test — an un-stubbed call throws, which is what stops a test passing because the
 * worker took a different branch than the one being exercised.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { get, stubApi, json, fakeEnv } from './helpers/edgeWorker';

const ORIGIN = 'https://tophunt.in';
const UID = 'ykQFaQ6urJV2t7sMqsIgEFu5vUE2';

const PROFILE = {
  uid: UID,
  username: 'alice',
  fullName: 'Alice Example',
  bio: 'Contest winner, three times over.',
  profileImageUrl: 'https://media.tophunt.in/avatars/alice.jpg',
};

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** Stub the two API endpoints the profile branches call. */
function stubProfiles(opts: {
  byHandle?: (handle: string) => Response;
  byUid?: (uid: string) => Response;
} = {}) {
  restore = stubApi({
    '/read/users/by-username/*': (url) => {
      const handle = decodeURIComponent(url.pathname.split('/').pop() || '');
      return opts.byHandle ? opts.byHandle(handle) : json(null);
    },
    '/read/users/*': (url) => {
      const uid = decodeURIComponent(url.pathname.split('/').pop() || '');
      return opts.byUid ? opts.byUid(uid) : json(null);
    },
  });
}

const head = async (res: Response) => await res.text();

// ---------------------------------------------------------------------------

describe('/@handle renders the profile', () => {
  it('answers 200 with the profile in the title', async () => {
    stubProfiles({ byHandle: (h) => (h === 'alice' ? json(PROFILE) : json(null)) });
    const res = await get(`${ORIGIN}/@alice`);
    expect(res.status).toBe(200);
    const html = await head(res);
    // `injectSeo` suffixes the site name, as it does for every other route.
    expect(html).toContain('<title>Alice Example (@alice) | TopHunt</title>');
  });

  it('sets the canonical to the lowercase handle url, never the uid one', async () => {
    // The whole point of the change. If the canonical still pointed at
    // `/profile?userId=…`, the uid would be back in the url Google reports and in
    // every "copy link" affordance that reads the canonical tag.
    stubProfiles({ byHandle: () => json(PROFILE) });
    const html = await head(await get(`${ORIGIN}/@alice`));
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/@alice"`);
    expect(html).not.toContain(UID);
  });

  it('emits og/twitter tags so a shared link previews as a card', async () => {
    // Social scrapers do not execute JS and do not get past the sign-in gate, so these
    // tags are the only thing that makes a pasted `/@alice` link render as anything.
    stubProfiles({ byHandle: () => json(PROFILE) });
    const html = await head(await get(`${ORIGIN}/@alice`));
    expect(html).toContain('property="og:title"');
    expect(html).toContain('content="https://media.tophunt.in/avatars/alice.jpg"');
    expect(html).toContain('property="og:type" content="profile"');
    expect(html).toContain('Contest winner, three times over.');
  });

  it('is NOINDEX, because the screen behind it still requires a sign-in', async () => {
    // Deliberate, and documented at `injectProfileSeo`: indexing a login-gated page is
    // the soft-404 pattern this Worker exists to remove. This single value is what
    // changes if profiles are ever made publicly viewable.
    stubProfiles({ byHandle: () => json(PROFILE) });
    const html = await head(await get(`${ORIGIN}/@alice`));
    expect(html).toContain('name="robots" content="noindex, follow"');
  });

  it('falls back to a generated description when the bio is empty', async () => {
    stubProfiles({ byHandle: () => json({ ...PROFILE, bio: '' }) });
    const html = await head(await get(`${ORIGIN}/@alice`));
    // Apostrophe entity-escaped on the way into the attribute, as it must be.
    expect(html).toContain('See @alice&#39;s battles, wins and photos on TopHunt.');
  });

  it('titles a nameless account by handle alone', async () => {
    stubProfiles({ byHandle: () => json({ ...PROFILE, fullName: '' }) });
    const html = await head(await get(`${ORIGIN}/@alice`));
    expect(html).toContain('<title>@alice | TopHunt</title>');
  });

  it('is NOT mistaken for a blog post', async () => {
    // Route precedence. `/read/blog/*` is deliberately left un-stubbed: if the handle
    // branch ever moves below the blog branch, the worker calls it and the harness
    // throws rather than quietly reporting a real profile as a missing article.
    stubProfiles({ byHandle: () => json(PROFILE) });
    expect((await get(`${ORIGIN}/@alice`)).status).toBe(200);
  });
});

describe('one url per profile', () => {
  it('301s a capitalised handle to the lowercase form', async () => {
    // No API call should be needed to decide this — the redirect is decided from the
    // path alone, so leaving both endpoints returning null proves the branch is taken
    // before any lookup.
    stubProfiles();
    const res = await get(`${ORIGIN}/@Alice`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/@alice`);
  });

  it('preserves the query string through the casing redirect', async () => {
    stubProfiles();
    const res = await get(`${ORIGIN}/@Alice?ref=whatsapp`);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/@alice?ref=whatsapp`);
  });

  it('301s a trailing slash away before resolving', async () => {
    // Handled by the existing single-hop normaliser, but worth pinning: `/@alice/` and
    // `/@alice` must not both render.
    stubProfiles({ byHandle: () => json(PROFILE) });
    const res = await get(`${ORIGIN}/@alice/`);
    expect(res.status).toBe(301);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/@alice`);
  });
});

describe('a handle that has moved', () => {
  it('redirects to the account`s current handle', async () => {
    // Instagram 404s a released handle. Following it instead is what keeps a link
    // that is already printed on a poster working.
    stubProfiles({ byHandle: (h) => (h === 'alice_old' ? json({ movedTo: 'alice_new' }) : json(PROFILE)) });
    const res = await get(`${ORIGIN}/@alice_old`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/@alice_new`);
  });

  it('is a 302 that is NEVER STORED, because the target can change', async () => {
    /**
     * The failure a 301 here would cause, which no server-side test can observe.
     *
     * Rename `alice` -> `bob`, let a browser cache `/@alice -> /@bob` permanently, then
     * rename BACK to `alice` — which the hold window deliberately permits, and which is
     * the most common reason to want a just-released handle. The server now answers
     * `/@bob` with `movedTo: alice`, while the client still rewrites `/@alice` to
     * `/@bob`. That is ERR_TOO_MANY_REDIRECTS on the account's own canonical url, and
     * it is unreachable from a fresh browser or a test double.
     */
    stubProfiles({ byHandle: () => json({ movedTo: 'alice_new' }) });
    const res = await get(`${ORIGIN}/@alice_old`);
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('lowercases the redirect target, so the hop lands on the canonical url', async () => {
    // Otherwise an old link costs TWO hops: `/@alice_old` -> `/@Alice_New` -> the
    // lowercase form. Every extra hop is another fetch out of the crawl budget.
    stubProfiles({ byHandle: () => json({ movedTo: 'Alice_New' }) });
    const res = await get(`${ORIGIN}/@alice_old`);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/@alice_new`);
  });
});

describe('a handle that resolves to nothing', () => {
  it('404s an unknown handle, with a real 404 status', async () => {
    // Not a soft 404. `app/[slug].tsx` would otherwise answer 200 for every invented
    // handle, and Google re-crawls those indefinitely.
    stubProfiles({ byHandle: () => json(null) });
    const res = await get(`${ORIGIN}/@nobody`);
    expect(res.status).toBe(404);
    expect(await head(res)).toContain('name="robots" content="noindex, follow"');
  });

  it('503s when the API is unreachable, rather than claiming the profile is gone', async () => {
    stubProfiles({
      byHandle: () => {
        throw new Error('upstream down');
      },
    });
    const res = await get(`${ORIGIN}/@alice`);
    expect(res.status).toBe(503);
  });

  it('503s on an API 5xx too', async () => {
    stubProfiles({ byHandle: () => json({ error: 'boom' }, 500) });
    expect((await get(`${ORIGIN}/@alice`)).status).toBe(503);
  });

  it('404s a profile payload with no username instead of rendering `@undefined`', async () => {
    stubProfiles({ byHandle: () => json({ uid: UID, fullName: 'Nameless' }) });
    expect((await get(`${ORIGIN}/@alice`)).status).toBe(404);
  });
});

describe('what is NOT a handle', () => {
  /**
   * `handleFromPath` re-validates the character set rather than trusting it, because
   * the segment is interpolated into an upstream url. These cases must fall through to
   * the ordinary routing, NOT reach the profile API — which is why the by-username
   * stub throws if it is called.
   */
  function stubHandleMustNotBeCalled(extra: Record<string, (url: URL) => Response> = {}) {
    restore = stubApi({
      '/read/users/by-username/*': () => {
        throw new Error('profile API called for something that is not a handle');
      },
      ...extra,
    });
  }

  it('does not treat a bare slug as a handle', async () => {
    stubHandleMustNotBeCalled({ '/read/blog/*': () => json(null) });
    // Falls through to the blog branch: a one-segment path with no `@`.
    expect((await get(`${ORIGIN}/some-article`)).status).toBe(404);
  });

  it('rejects a too-short handle', async () => {
    stubHandleMustNotBeCalled({ '/read/blog/*': () => json(null) });
    expect((await get(`${ORIGIN}/@ab`)).status).toBe(404);
  });

  it('rejects a handle with characters a username cannot contain', async () => {
    stubHandleMustNotBeCalled({ '/read/blog/*': () => json(null) });
    for (const bad of ['@alice-bob', '@alice%20bob', '@alice!']) {
      const res = await get(`${ORIGIN}/${bad}`);
      expect(res.status, bad).toBe(404);
    }
  });

  it('rejects a multi-segment path that merely starts with @', async () => {
    stubHandleMustNotBeCalled();
    // Two segments, so it is not a profile url — it reaches the fail-closed branch.
    const res = await get(`${ORIGIN}/@alice/posts`);
    expect(res.status).toBe(404);
    expect(await head(res)).toContain('noindex');
  });
});

describe('the legacy /profile?userId= address', () => {
  it('redirects to the holder`s handle', async () => {
    // What actually removes the uid from circulation: the links already shared keep
    // working, and everyone who follows one lands on the handle form.
    stubProfiles({ byUid: (uid) => (uid === UID ? json(PROFILE) : json(null)) });
    const res = await get(`${ORIGIN}/profile?userId=${UID}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/@alice`);
  });

  it('is a 302 that is NEVER STORED, because the handle can be reassigned', async () => {
    // `?userId=<uid>` -> `/@alice` is only true while that account holds `alice`. After
    // a rename and the 30-day hold, a legitimate new owner takes the handle — and a
    // client that cached a permanent hop would send the visitor to a DIFFERENT PERSON.
    // That is precisely the guarantee the hold window exists to provide, so it must not
    // be undone in the client.
    stubProfiles({ byUid: () => json(PROFILE) });
    const res = await get(`${ORIGIN}/profile?userId=${UID}`);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('lowercases the handle it redirects to', async () => {
    stubProfiles({ byUid: () => json({ ...PROFILE, username: 'Alice' }) });
    const res = await get(`${ORIGIN}/profile?userId=${UID}`);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/@alice`);
  });

  it('leaves a BARE /profile alone — that is the signed-in user`s own screen', async () => {
    // A redirect here would send every signed-in user to somebody else's profile, or
    // to a 404. The absence of a lookup is the point, so no stub is needed at all.
    restore = stubApi({});
    const res = await get(`${ORIGIN}/profile`);
    expect(res.status).toBe(200);
    expect(await head(res)).toContain('noindex');
  });

  it('leaves the url alone when the uid cannot be resolved', async () => {
    // An unresolvable uid is reported as not-found by the app. Redirecting to `/@null`
    // would replace that with a wrong-looking profile url.
    stubProfiles({ byUid: () => json(null) });
    const res = await get(`${ORIGIN}/profile?userId=deleted-uid`);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });

  it('leaves the url alone when the profile API is unreachable', async () => {
    stubProfiles({
      byUid: () => {
        throw new Error('upstream down');
      },
    });
    expect((await get(`${ORIGIN}/profile?userId=${UID}`)).status).toBe(200);
  });

  it('does not redirect a /profile SUBPATH such as the edit screen', async () => {
    restore = stubApi({});
    const res = await get(`${ORIGIN}/profile/edit?userId=${UID}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('a handle containing a dot', () => {
  /**
   * THE BUG THIS BLOCK EXISTS FOR, and it would have shipped.
   *
   * `validateUsername` allows dots, so `john.doe` is a perfectly legal handle. The
   * profile branch originally sat BELOW the asset/document split — and
   * `hasFileExtension` sees `.doe` as a file extension. So `/@john.doe` was classified
   * as an asset, fell through to the Pages SPA fallback, and was converted into a
   * plain-text 404 by the `servedHtml && hasFileExtension` guard.
   *
   * Every dotted handle would have been a dead link on the web: dead when shared, dead
   * on refresh, and — worst of all — dead as the TARGET of the legacy `?userId=`
   * redirect, which would have turned a url that previously worked into a broken one.
   *
   * The fix claims the whole `/@…` namespace above the split. Nothing else in the app
   * serves anything from it.
   */
  it('renders `/@john.doe` as a profile, not a missing file', async () => {
    stubProfiles({
      byHandle: (h) => (h === 'john.doe' ? json({ ...PROFILE, username: 'john.doe', fullName: 'John Doe' }) : json(null)),
    });
    const res = await get(`${ORIGIN}/@john.doe`, { env: fakeEnv });
    expect(res.status).toBe(200);
    const html = await head(res);
    expect(html).toContain('<title>John Doe (@john.doe) | TopHunt</title>');
    expect(html).toContain(`<link rel="canonical" href="${ORIGIN}/@john.doe"`);
  });

  it('404s an unknown dotted handle as a PAGE, not as a missing asset', async () => {
    // A real 404 document, so the app renders its not-found screen — rather than the
    // bare `text/plain` body `notFoundAsset` produces for a missing image.
    stubProfiles({ byHandle: () => json(null) });
    const res = await get(`${ORIGIN}/@nobody.here`, { env: fakeEnv });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('resolves `/@alice.png` as the HANDLE "alice.png"', async () => {
    // The deliberate consequence of claiming the namespace. `alice.png` is a legal
    // username, and no asset was ever served from `/@…`, so treating it as a handle is
    // the right answer — the alternative is the dotted-handle bug above.
    const seen: string[] = [];
    stubProfiles({
      byHandle: (h) => {
        seen.push(h);
        return json(null);
      },
    });
    const res = await get(`${ORIGIN}/@alice.png`, { env: fakeEnv });
    expect(seen).toEqual(['alice.png']);
    expect(res.status).toBe(404);
  });

  it('still 404s a genuinely missing ASSET outside the @ namespace', async () => {
    // The soft-404 rule the rest of the Worker enforces is untouched: an HTML shell
    // served under an image url is a page Google reports and re-crawls forever.
    // Not a `/wp-content/…` path — those are in LEGACY_GONE and answer 410.
    restore = stubApi({});
    const res = await get(`${ORIGIN}/_expo/static/js/web/stale-bundle.js`, { env: fakeEnv });
    expect(res.status).toBe(404);
  });
});
