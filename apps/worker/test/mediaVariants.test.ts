/**
 * Media DELIVERY: which url a client is handed, and what it costs.
 *
 * Two things are pinned here, both of which fail silently and expensively rather
 * than loudly:
 *
 *  1. `MEDIA_TRANSFORMATIONS` is a switch that can cause an OUTAGE if it is on
 *     when the zone is not ready — `/cdn-cgi/image/...` errors on a zone without
 *     Transformations instead of falling back to the original. So the off state
 *     must be a perfect passthrough, and the gate must stay closed for origins
 *     where the path cannot resolve at all (`*.workers.dev`, or a base with a
 *     path prefix like the staging `<worker>/media`).
 *
 *  2. Urls on a LEGACY base must still be optimised and CDN-served. Media urls
 *     are stored absolute, so before this every pre-cutover row was permanently
 *     excluded from both — a 66 KB avatar rendered into a 96px circle forever —
 *     while waiting on a manual D1 backfill. The regression this guards is subtle
 *     in exactly the wrong way: the images still load, so nothing looks broken;
 *     only the bill and the LCP move.
 *
 * The counterweight is `PROXY_ONLY_PREFIXES`. Deletion-lifecycle media must keep
 * ONE cache identity, because `deleteContestBannerByPublicUrl` purges the colo
 * entry for the stored url only. A canonicalised url, and a transformed variant,
 * are each a separate cache entry no delete path knows about — so moving those
 * prefixes would trade a Worker invocation for "deleted media is still served".
 */
import { describe, it, expect } from 'vitest';
import {
  avatarUrl as avatarUrlVariant,
  cdnUrl,
  canonicalizeMediaHtml,
  enrichMatchMedia,
  imgVariant,
  optimizedUrl,
  thumbUrl,
  transformationsAvailable,
} from '../src/lib/media';

const CURRENT = 'https://media.tophunt.in';
const LEGACY = 'https://tophunt-api.weadown-in.workers.dev/media';
const STAGING = 'https://tophunt-api-staging.weadown-in.workers.dev/media';

/** Production env with Transformations live. */
const env = (over: Record<string, unknown> = {}) =>
  ({
    R2_PUBLIC_BASE_URL: CURRENT,
    R2_LEGACY_BASE_URLS: LEGACY,
    R2_BUCKET: 'tophunt-media',
    MEDIA_TRANSFORMATIONS: 'true',
    ...over,
  }) as any;

/** Production env before the flag was flipped. */
const envOff = (over: Record<string, unknown> = {}) => env({ MEDIA_TRANSFORMATIONS: 'false', ...over });

describe('transformationsAvailable', () => {
  it('is true for the production media domain with the flag on', () => {
    expect(transformationsAvailable(env())).toBe(true);
  });

  it('is false unless the flag is exactly "true"', () => {
    for (const v of ['false', '', undefined, '1', 'yes', 'TRUE ']) {
      expect(transformationsAvailable(env({ MEDIA_TRANSFORMATIONS: v }))).toBe(v === 'TRUE ');
    }
  });

  it('is false on a *.workers.dev origin — not a zone, cannot be enabled', () => {
    const e = env({ R2_PUBLIC_BASE_URL: 'https://tophunt-api.weadown-in.workers.dev' });
    expect(transformationsAvailable(e)).toBe(false);
  });

  it('is false when the origin has a path prefix — /cdn-cgi/ only resolves at a zone root', () => {
    // The staging configuration, and the reason the original variant urls 404'd.
    expect(transformationsAvailable(env({ R2_PUBLIC_BASE_URL: STAGING }))).toBe(false);
  });

  it('is false for an unparseable origin rather than throwing', () => {
    expect(transformationsAvailable(env({ R2_PUBLIC_BASE_URL: 'not-a-url' }))).toBe(false);
  });
});

describe('imgVariant — off state is a perfect passthrough', () => {
  it('returns the original url untouched when the flag is off', () => {
    const url = `${CURRENT}/stories/images/abc.jpg`;
    expect(thumbUrl(envOff(), url)).toBe(url);
  });

  it('leaves a legacy-base url untouched when the flag is off', () => {
    const url = `${LEGACY}/stories/images/abc.jpg`;
    expect(thumbUrl(envOff(), url)).toBe(url);
  });

  it('passes null/undefined/empty through unchanged', () => {
    for (const v of [null, undefined, '']) {
      expect(thumbUrl(env(), v as any)).toBe(v);
      expect(cdnUrl(env(), v as any)).toBe(v);
    }
  });
});

describe('imgVariant — on state', () => {
  it('builds a variant for a url already on the current base', () => {
    expect(thumbUrl(env(), `${CURRENT}/stories/images/abc.jpg`)).toBe(
      `${CURRENT}/cdn-cgi/image/width=320,quality=70,fit=scale-down,format=auto/stories/images/abc.jpg`,
    );
  });

  it('builds the SAME variant for the pre-cutover url of the same object', () => {
    // The core regression: identical key, identical bucket, so a legacy-host row
    // must optimise identically instead of being excluded until a manual backfill.
    const fromCurrent = thumbUrl(env(), `${CURRENT}/stories/images/abc.jpg`);
    const fromLegacy = thumbUrl(env(), `${LEGACY}/stories/images/abc.jpg`);
    expect(fromLegacy).toBe(fromCurrent);
  });

  it('honours width/height/quality/fit/format', () => {
    const out = imgVariant(env(), `${CURRENT}/a/b.jpg`, {
      width: 100,
      height: 50,
      quality: 90,
      fit: 'contain',
      format: 'webp',
    });
    expect(out).toBe(`${CURRENT}/cdn-cgi/image/width=100,height=50,quality=90,fit=contain,format=webp/a/b.jpg`);
  });

  it('uses scale-down on every preset, so a variant is never upscaled', () => {
    // Width-only + `fit=cover` differs from `scale-down` in exactly one case:
    // a source NARROWER than the target, which cover upscales. Measured on a real
    // 645x1440 portrait entry, the 1080 preset was 84436 B with cover vs 50638 B
    // with scale-down — 67% larger and blurrier, on the most common shape in a DP
    // contest. Pinned because the default is invisible in the output otherwise.
    for (const out of [
      thumbUrl(env(), `${CURRENT}/a.jpg`),
      optimizedUrl(env(), `${CURRENT}/a.jpg`),
      avatarUrlVariant(env(), `${CURRENT}/a.jpg`),
    ]) {
      expect(out).toContain('fit=scale-down');
      expect(out).not.toContain('fit=cover');
    }
  });

  it('never transforms video, on either base', () => {
    for (const base of [CURRENT, LEGACY]) {
      for (const ext of ['mp4', 'mov', 'webm', 'm4v']) {
        const url = `${base}/stories/videos/clip.${ext}`;
        expect(thumbUrl(env(), url)).toBe(url);
      }
    }
  });

  it('does not double-transform an already-transformed url', () => {
    const once = thumbUrl(env(), `${CURRENT}/stories/images/abc.jpg`) as string;
    expect(thumbUrl(env(), once)).toBe(once);
  });

  it('leaves third-party urls alone — they are not in our bucket', () => {
    for (const url of [
      'https://lh3.googleusercontent.com/a/default-user=s96-c',
      'https://web.archive.org/web/2020/https://tophunt.in/wp-content/x.jpg',
      'https://i0.wp.com/tophunt.in/x.jpg',
    ]) {
      expect(thumbUrl(env(), url)).toBe(url);
    }
  });

  it('refuses a lookalike host that merely starts with our base', () => {
    const url = `${CURRENT}.evil.example/stories/images/abc.jpg`;
    expect(thumbUrl(env(), url)).toBe(url);
    expect(cdnUrl(env(), url)).toBe(url);
  });

  it('never transforms deletion-lifecycle prefixes', () => {
    // A variant is a cache entry no delete path purges; see PROXY_ONLY_PREFIXES.
    for (const prefix of ['contest-banners/images', 'vs-cards/images']) {
      for (const base of [CURRENT, LEGACY]) {
        const url = `${base}/${prefix}/abc.jpg`;
        expect(thumbUrl(env(), url)).toBe(url);
        expect(cdnUrl(env(), url)).toBe(url);
      }
    }
  });

  it('stays off for the staging origin even with the flag on', () => {
    const e = env({ R2_PUBLIC_BASE_URL: STAGING, R2_LEGACY_BASE_URLS: '' });
    const url = `${STAGING}/stories/images/abc.jpg`;
    expect(thumbUrl(e, url)).toBe(url);
  });
});

describe('cdnUrl', () => {
  it('moves a legacy-base url onto the current base', () => {
    expect(cdnUrl(env(), `${LEGACY}/stories/videos/clip.mp4`)).toBe(`${CURRENT}/stories/videos/clip.mp4`);
  });

  it('applies to VIDEO, which no variant helper ever covers', () => {
    // Video on the proxy path is the most expensive media in the system: ranged
    // requests bypass the edge cache, so every seek is an R2 GET + invocation.
    const out = cdnUrl(env(), `${LEGACY}/stories/videos/clip.mp4`);
    expect(out).toBe(`${CURRENT}/stories/videos/clip.mp4`);
  });

  it('works with the flag OFF — it needs the domain, not Transformations', () => {
    expect(cdnUrl(envOff(), `${LEGACY}/stories/images/abc.jpg`)).toBe(`${CURRENT}/stories/images/abc.jpg`);
  });

  it('is a no-op for a url already on the current base', () => {
    const url = `${CURRENT}/stories/images/abc.jpg`;
    expect(cdnUrl(env(), url)).toBe(url);
  });

  it('does not rewrite onto a legacy base when the current base is unusable', () => {
    // Guards the inversion: ownedMediaBases() drops malformed entries, so a blank
    // or broken R2_PUBLIC_BASE_URL would otherwise leave a LEGACY base first in
    // the list and move good urls onto the old host.
    const url = `${LEGACY}/stories/images/abc.jpg`;
    expect(cdnUrl(env({ R2_PUBLIC_BASE_URL: '' }), url)).toBe(url);
    expect(cdnUrl(env({ R2_PUBLIC_BASE_URL: 'not-a-url' }), url)).toBe(url);
  });
});

describe('canonicalizeMediaHtml', () => {
  it('rewrites our legacy host inside stored post HTML', () => {
    const html = `<p>x</p><img src="${LEGACY}/blog/imported/a.jpg" /><img src="${LEGACY}/blog/imported/b.png">`;
    expect(canonicalizeMediaHtml(env(), html)).toBe(
      `<p>x</p><img src="${CURRENT}/blog/imported/a.jpg" /><img src="${CURRENT}/blog/imported/b.png">`,
    );
  });

  it('leaves third-party image hosts exactly as stored', () => {
    // The importer is allowed to leave an image on its origin when fetch-to-R2
    // fails; those bytes are not ours and nothing here can serve them.
    const html = `<img src="https://web.archive.org/web/2020/x.jpg"><img src="https://i0.wp.com/y.jpg">`;
    expect(canonicalizeMediaHtml(env(), html)).toBe(html);
  });

  it('is a no-op when there is nothing legacy to rewrite', () => {
    const html = `<img src="${CURRENT}/blog/imported/a.jpg">`;
    expect(canonicalizeMediaHtml(env(), html)).toBe(html);
  });

  it('passes null/undefined/empty through', () => {
    for (const v of [null, undefined, '']) {
      expect(canonicalizeMediaHtml(env(), v as any)).toBe(v);
    }
  });
});

describe('enrichMatchMedia', () => {
  const participant = (base: string) => ({
    uid: 'u1',
    username: 'a',
    profilePic: `${base}/avatars/images/av.jpg`,
    mediaUrl: `${base}/contests/images/entry.jpg`,
    mediaType: 'photo',
  });

  it('canonicalises the fallback fields AND adds variants, for a legacy snapshot', () => {
    // contest_matches.user_a/user_b are permanent JSON snapshots — the feed's
    // media — so a pre-cutover match is exactly the case that has to work.
    const out: any = enrichMatchMedia(env(), { userA: participant(LEGACY), userB: participant(LEGACY) });
    for (const side of ['userA', 'userB'] as const) {
      expect(out[side].mediaUrl).toBe(`${CURRENT}/contests/images/entry.jpg`);
      expect(out[side].profilePic).toBe(`${CURRENT}/avatars/images/av.jpg`);
      expect(out[side].mediaUrlThumb).toBe(
        `${CURRENT}/cdn-cgi/image/width=320,quality=70,fit=scale-down,format=auto/contests/images/entry.jpg`,
      );
      expect(out[side].mediaUrlOptimized).toBe(
        `${CURRENT}/cdn-cgi/image/width=1080,quality=82,fit=scale-down,format=auto/contests/images/entry.jpg`,
      );
      expect(out[side].profilePicThumb).toBe(
        `${CURRENT}/cdn-cgi/image/width=128,quality=75,fit=scale-down,format=auto/avatars/images/av.jpg`,
      );
    }
  });

  it('leaves every media field byte-identical when the flag is off', () => {
    // The `|| mediaUrl` fallback the client relies on must hold, so that turning
    // the flag off is a complete rollback.
    const p = participant(CURRENT);
    const out: any = enrichMatchMedia(envOff(), { userA: p, userB: undefined });
    expect(out.userA.mediaUrl).toBe(p.mediaUrl);
    expect(out.userA.mediaUrlThumb).toBe(p.mediaUrl);
    expect(out.userA.mediaUrlOptimized).toBe(p.mediaUrl);
    expect(out.userA.profilePicThumb).toBe(p.profilePic);
  });

  it('tolerates a missing or malformed participant', () => {
    const out: any = enrichMatchMedia(env(), { userA: undefined, userB: null as any });
    expect(out.userA).toBeUndefined();
    expect(out.userB).toBeNull();
  });

  it('preserves non-media fields', () => {
    const out: any = enrichMatchMedia(env(), { userA: { ...participant(LEGACY), votes: 7 }, userB: undefined });
    expect(out.userA.votes).toBe(7);
    expect(out.userA.username).toBe('a');
  });
});
