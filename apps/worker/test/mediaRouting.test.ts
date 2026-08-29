/**
 * The image/video split, and the registry the bucket's layout is declared in.
 *
 * Two things here are load-bearing enough to pin.
 *
 * First, `mediaRouting`'s three-way answer. Two of its states put video on R2 and
 * they mean opposite things — an operator who chose R2, and an operator who chose
 * Bunny and did not finish wiring it. `/health/deep` fails only the second, and
 * that distinction is invisible from behaviour, so nothing but a test protects it.
 *
 * Second, `categoryForKey` across BOTH key layouts. Cache policy and the
 * proxy-only decision are resolved through it, so a prefix that stops resolving
 * silently downgrades a `no-store` banner to a year of immutable caching. The
 * failure is a deleted banner staying public, not an error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const integrations = vi.hoisted(() => ({ value: { video: { provider: 'r2', libraryId: '', cdnHostname: '' } } }));
const bunny = vi.hoisted(() => ({ config: null as null | { apiKey: string; libraryId: string; cdnHostname: string } }));

vi.mock('../src/lib/integrations', () => ({
  getIntegrations: async () => integrations.value,
  resolveSecret: async () => null,
}));
vi.mock('../src/lib/bunny', () => ({
  bunnyConfig: async () => bunny.config,
}));

import { mediaRouting, allowedMimesForUpload, assertR2AcceptsKind } from '../src/lib/mediaRouting';
import {
  categoryForKey,
  cachePolicyForKey,
  isProxyOnlyKey,
  isSafeRelativeKey,
  buildMediaKey,
  isUserWritablePrefix,
  USER_UPLOAD_PREFIXES,
  MEDIA_CATEGORIES,
} from '../src/lib/mediaCategories';

const env = {} as any;

const asLegacyR2 = () => {
  integrations.value = { video: { provider: 'r2', libraryId: '', cdnHostname: '' } };
  bunny.config = null;
};
const asBunnyLive = () => {
  integrations.value = { video: { provider: 'bunny', libraryId: '42', cdnHostname: 'vz-x.b-cdn.net' } };
  bunny.config = { apiKey: 'k', libraryId: '42', cdnHostname: 'vz-x.b-cdn.net' };
};
const asBunnyHalfWired = () => {
  integrations.value = { video: { provider: 'bunny', libraryId: '', cdnHostname: '' } };
  bunny.config = null;
};

beforeEach(asLegacyR2);

describe('mediaRouting', () => {
  it('routes video to R2 when an operator selected R2', async () => {
    const routing = await mediaRouting(env);
    expect(routing).toMatchObject({ videoProvider: 'r2', r2AcceptsVideo: true, reason: 'provider-setting' });
  });

  it('routes video to Bunny and CLOSES R2 once Bunny is configured', async () => {
    asBunnyLive();
    const routing = await mediaRouting(env);
    expect(routing).toMatchObject({ videoProvider: 'bunny', r2AcceptsVideo: false, reason: 'bunny-live' });
  });

  it('reports a half-wired Bunny separately from a deliberate R2 choice', async () => {
    // Same runtime behaviour as `provider-setting` — video still goes to R2 — but a
    // different cause, and the only one `/health/deep` fails. Without the distinct
    // reason a half-finished cutover is indistinguishable from a working setup
    // while the Bunny library the operator thinks they are filling stays empty.
    asBunnyHalfWired();
    const routing = await mediaRouting(env);
    expect(routing).toMatchObject({ videoProvider: 'r2', r2AcceptsVideo: true, reason: 'not-configured' });
  });
});

describe('assertR2AcceptsKind', () => {
  it('never blocks an image, in any state', async () => {
    for (const state of [asLegacyR2, asBunnyLive, asBunnyHalfWired]) {
      state();
      await expect(assertR2AcceptsKind(env, 'image', 'avatars')).resolves.toBeUndefined();
    }
  });

  it('rejects video once Bunny is live, naming the action to use instead', async () => {
    asBunnyLive();
    // This is the actual defence against a stale build POSTing a video to /upload,
    // so the message has to be actionable: a client author cannot be told to read
    // the source, and "upload failed" sends them to check their connection.
    await expect(assertR2AcceptsKind(env, 'video', 'stories')).rejects.toThrow(/createVideoUpload/);
  });

  it('allows video on the legacy path, but only where the app ever offered it', async () => {
    await expect(assertR2AcceptsKind(env, 'video', 'stories')).resolves.toBeUndefined();
    // An avatar was never allowed to be a video and must not become one just
    // because the cutover is unfinished.
    await expect(assertR2AcceptsKind(env, 'video', 'avatars')).rejects.toThrow(/images only/i);
    await expect(assertR2AcceptsKind(env, 'video', 'deposits')).rejects.toThrow(/images only/i);
  });
});

describe('allowedMimesForUpload', () => {
  it('is images-only when Bunny is live', async () => {
    asBunnyLive();
    expect(await allowedMimesForUpload(env, 'stories')).not.toContain('video/mp4');
  });

  it('re-admits video on the legacy path', async () => {
    expect(await allowedMimesForUpload(env, 'stories')).toContain('video/mp4');
    expect(await allowedMimesForUpload(env, 'avatars')).not.toContain('video/mp4');
  });
});

describe('categoryForKey', () => {
  it('resolves both key layouts to the same category', () => {
    for (const key of ['contest-banners/images/a.jpg', 'contest-banners/2026/08/a.jpg']) {
      expect(categoryForKey(key)?.prefix).toBe('contest-banners');
      expect(cachePolicyForKey(key)).toBe('no-store');
      expect(isProxyOnlyKey(key)).toBe(true);
    }
  });

  it('does not confuse the three contest-ish prefixes', () => {
    // `contest-entries` and `contest-banners` are the same length and both sort
    // ahead of `contests`; longest-prefix matching is what keeps an entry from
    // inheriting the banner cache policy.
    expect(categoryForKey('contests/2026/08/a.jpg')?.prefix).toBe('contests');
    expect(categoryForKey('contest-entries/2026/08/a.jpg')?.prefix).toBe('contest-entries');
    expect(categoryForKey('contest-banners/2026/08/a.jpg')?.prefix).toBe('contest-banners');
    expect(cachePolicyForKey('contest-entries/2026/08/a.jpg')).toBe('immutable');
  });

  it('does not match a prefix that is merely a string prefix', () => {
    expect(categoryForKey('posts-archive/a.jpg')).toBeNull();
    expect(categoryForKey('storiesx/a.jpg')).toBeNull();
  });

  it('treats an unknown key as immutable and not proxy-only', () => {
    // Fail-open for cache policy, argued on cost in the registry: forcing every
    // unrecognised legacy key through a Worker invocation would be a real bill for
    // no correctness gain. Pinned so the trade stays a decision.
    expect(categoryForKey('who-knows/a.jpg')).toBeNull();
    expect(cachePolicyForKey('who-knows/a.jpg')).toBe('immutable');
    expect(isProxyOnlyKey('who-knows/a.jpg')).toBe(false);
  });
});

describe('isSafeRelativeKey', () => {
  it('accepts the shapes this deployment mints', () => {
    expect(isSafeRelativeKey('2026/08/abc-123.jpg')).toBe(true);
    expect(isSafeRelativeKey('images/abc.jpg')).toBe(true);
    expect(isSafeRelativeKey('abc.jpg')).toBe(true);
  });

  it('refuses traversal, encoded traversal, empty segments and excess depth', () => {
    for (const bad of [
      '',
      '/',
      'a//b.jpg',
      '2026/08/',
      '../avatars/a.jpg',
      '..',
      '%2e%2e/a.jpg',
      'a/b/c/d.jpg',
      'a\\b.jpg',
      'a?b.jpg',
    ]) {
      expect(isSafeRelativeKey(bad)).toBe(false);
    }
  });

  it('accepts every key buildMediaKey produces, for every category', () => {
    // The two halves of one contract: if the builder can emit a shape the mapper
    // refuses, deletion breaks silently for that category.
    for (const category of MEDIA_CATEGORIES) {
      const key = buildMediaKey(category.prefix, '.jpg');
      expect(key.startsWith(`${category.prefix}/`)).toBe(true);
      expect(isSafeRelativeKey(key.slice(category.prefix.length + 1))).toBe(true);
    }
  });
});

describe('the upload allow-list is derived, not maintained by hand', () => {
  it('contains exactly the user-written categories', () => {
    const expected = MEDIA_CATEGORIES.filter((c) => c.writer === 'user').map((c) => c.prefix);
    expect([...USER_UPLOAD_PREFIXES]).toEqual(expected);
  });

  it('excludes every prefix a client must not name', () => {
    for (const prefix of ['contest-banners', 'payment-qr', 'blog/imported']) {
      expect(isUserWritablePrefix(prefix)).toBe(false);
    }
  });
});
