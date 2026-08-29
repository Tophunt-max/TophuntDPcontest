/**
 * The url → R2-key mapping across a media DOMAIN CHANGE.
 *
 * Media urls are stored absolute in D1, so moving `R2_PUBLIC_BASE_URL` from the
 * Worker proxy (`<worker>/media`) to the bucket's own domain
 * (`https://media.tophunt.in`) leaves every existing row on the old host. Reads
 * survive — the Worker's `/media/*` route stays — but this mapping is the ONLY
 * thing that authorises a delete, and its failure mode is silence in both
 * directions:
 *
 *   • Too permissive, and a stored third-party url becomes a key in our bucket:
 *     `deleteByPublicUrl` on `https://evil.example/stories/images/x.jpg` used to
 *     delete OUR `stories/images/x.jpg`.
 *   • Too strict, and pre-cutover objects are never deleted at all. Nothing
 *     errors, no request fails; the bucket just keeps bytes that no record
 *     references, and a deleted contest banner stays publicly readable.
 *
 * Neither shows up in a request log, which is why they are pinned here.
 */
import { describe, it, expect } from 'vitest';
import {
  canonicalMediaUrl,
  contestBannerKeyFromPublicUrl,
  mediaKeyFromPublicUrl,
  ownedMediaBases,
  vsImageKeyFromPublicUrl,
} from '../src/lib/r2';

const CURRENT = 'https://media.tophunt.in';
const LEGACY = 'https://tophunt-api.weadown-in.workers.dev/media';

/** Production-shaped env: new media domain, old Worker-proxied base retained. */
const env = (over: Record<string, unknown> = {}) =>
  ({
    R2_PUBLIC_BASE_URL: CURRENT,
    R2_LEGACY_BASE_URLS: LEGACY,
    R2_BUCKET: 'tophunt-media',
    ...over,
  }) as any;

describe('ownedMediaBases', () => {
  it('lists the current base first, then the legacy ones', () => {
    expect(ownedMediaBases(env())).toEqual([CURRENT, LEGACY]);
  });

  it('normalises trailing slashes and de-duplicates', () => {
    const bases = ownedMediaBases(
      env({ R2_PUBLIC_BASE_URL: `${CURRENT}/`, R2_LEGACY_BASE_URLS: `${CURRENT},${LEGACY}/` }),
    );
    expect(bases).toEqual([CURRENT, LEGACY]);
  });

  it('ignores blank and malformed entries instead of dropping the valid ones', () => {
    const bases = ownedMediaBases(env({ R2_LEGACY_BASE_URLS: ` , not-a-url ,${LEGACY}` }));
    expect(bases).toEqual([CURRENT, LEGACY]);
  });

  it('tolerates the var being unset — the pre-cutover configuration', () => {
    expect(ownedMediaBases(env({ R2_LEGACY_BASE_URLS: undefined }))).toEqual([CURRENT]);
  });
});

describe('mediaKeyFromPublicUrl', () => {
  it('maps a url on the current media domain to its key', () => {
    expect(mediaKeyFromPublicUrl(env(), `${CURRENT}/stories/images/abc.jpg`)).toBe(
      'stories/images/abc.jpg',
    );
  });

  it('maps a pre-cutover Worker-proxied url to the SAME key', () => {
    // The bug this pins: the `/media` path prefix was previously left in the
    // key (`media/stories/images/abc.jpg`), so the delete hit nothing.
    expect(mediaKeyFromPublicUrl(env(), `${LEGACY}/stories/images/abc.jpg`)).toBe(
      'stories/images/abc.jpg',
    );
  });

  it('strips the bucket segment from an S3-style R2 endpoint url', () => {
    expect(
      mediaKeyFromPublicUrl(env(), 'https://acct.r2.cloudflarestorage.com/tophunt-media/posts/images/x.png'),
    ).toBe('posts/images/x.png');
  });

  it('accepts an r2.dev public-bucket url', () => {
    expect(mediaKeyFromPublicUrl(env(), 'https://pub-123.r2.dev/posts/images/x.png')).toBe(
      'posts/images/x.png',
    );
  });

  it('refuses a foreign host rather than turning its path into one of our keys', () => {
    expect(mediaKeyFromPublicUrl(env(), 'https://evil.example/stories/images/abc.jpg')).toBeNull();
    // A real third-party avatar, which account deletion legitimately encounters.
    expect(mediaKeyFromPublicUrl(env(), 'https://lh3.googleusercontent.com/a/xyz=s96-c')).toBeNull();
  });

  it('refuses a host that merely ends with our domain', () => {
    expect(mediaKeyFromPublicUrl(env(), 'https://media.tophunt.in.evil.example/a/b.jpg')).toBeNull();
  });

  it('refuses empty, non-url and base-only values', () => {
    expect(mediaKeyFromPublicUrl(env(), '')).toBeNull();
    expect(mediaKeyFromPublicUrl(env(), 'not a url')).toBeNull();
    expect(mediaKeyFromPublicUrl(env(), CURRENT)).toBeNull();
  });
});

describe('contestBannerKeyFromPublicUrl', () => {
  it('maps banners on both the current and the legacy base', () => {
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/images/b.jpg`)).toBe(
      'contest-banners/images/b.jpg',
    );
    // Previously null: the host comparison was against the single current base,
    // so banners uploaded before the cutover could never be deleted.
    expect(contestBannerKeyFromPublicUrl(env(), `${LEGACY}/contest-banners/images/b.jpg`)).toBe(
      'contest-banners/images/b.jpg',
    );
  });

  it('stays pinned to its own prefix on every base', () => {
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/stories/images/b.jpg`)).toBeNull();
    expect(contestBannerKeyFromPublicUrl(env(), `${LEGACY}/vs-cards/images/b.jpg`)).toBeNull();
  });

  /**
   * Date-sharded keys must map, or new banners silently stop being deletable.
   *
   * This is the case that made the gate worth revisiting. It used to require a
   * SINGLE path segment after the prefix, which was equivalent while keys were
   * flat — and would have rejected every `{prefix}/{YYYY}/{MM}/{uuid}` key the
   * moment the layout gained a month shard. Nothing would have thrown: the mapper
   * returns null, the delete hits nothing and reports success, and every new
   * banner leaks while deleted ones stay readable behind a live URL.
   */
  it('maps a date-sharded banner key', () => {
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/2026/08/b.jpg`)).toBe(
      'contest-banners/2026/08/b.jpg',
    );
    expect(contestBannerKeyFromPublicUrl(env(), `${LEGACY}/contest-banners/2026/08/b.jpg`)).toBe(
      'contest-banners/2026/08/b.jpg',
    );
  });

  it('rejects traversal, over-deep paths, empty segments and lookalike hosts', () => {
    // Deeper than `{YYYY}/{MM}/{file}` is not a shape this deployment mints.
    expect(
      contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/2026/08/a/b.jpg`),
    ).toBeNull();
    // Trailing slash leaves an empty final segment.
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/images/`)).toBeNull();
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/`)).toBeNull();
    // Traversal, raw and percent-encoded. `URL.pathname` is not decoded, so the
    // encoded form arrives literally and is refused by the segment charset rather
    // than needing a case of its own.
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/../avatars/b.jpg`)).toBeNull();
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/%2e%2e/b.jpg`)).toBeNull();
    expect(
      contestBannerKeyFromPublicUrl(env(), 'https://evil.example/contest-banners/images/b.jpg'),
    ).toBeNull();
  });

  it('rejects urls carrying credentials, a query or a fragment', () => {
    expect(
      contestBannerKeyFromPublicUrl(env(), 'https://u:p@media.tophunt.in/contest-banners/images/b.jpg'),
    ).toBeNull();
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/images/b.jpg?x=1`)).toBeNull();
    expect(contestBannerKeyFromPublicUrl(env(), `${CURRENT}/contest-banners/images/b.jpg#x`)).toBeNull();
  });
});

describe('vsImageKeyFromPublicUrl', () => {
  it('maps battle cards on both bases and nowhere else', () => {
    expect(vsImageKeyFromPublicUrl(env(), `${CURRENT}/vs-cards/images/c.jpg`)).toBe(
      'vs-cards/images/c.jpg',
    );
    expect(vsImageKeyFromPublicUrl(env(), `${LEGACY}/vs-cards/images/c.jpg`)).toBe(
      'vs-cards/images/c.jpg',
    );
    // The defacement guard: a participant-supplied url outside the prefix is not
    // one of our cards, whichever host it claims.
    expect(vsImageKeyFromPublicUrl(env(), `${CURRENT}/stories/images/c.jpg`)).toBeNull();
    expect(vsImageKeyFromPublicUrl(env(), 'https://evil.example/vs-cards/images/c.jpg')).toBeNull();
  });
});


/**
 * The READ-side counterpart to `ownedMediaBases`. Where that keeps DELETES
 * correct across a domain change, this keeps delivery correct: it maps a url on
 * any base we own onto the current one, so a pre-cutover row is served by the CDN
 * and can be transformed instead of being stuck on the Worker proxy until a
 * manual D1 backfill runs.
 */
describe('canonicalMediaUrl', () => {
  it('rewrites a legacy-base url onto the current base, key intact', () => {
    expect(canonicalMediaUrl(env(), `${LEGACY}/stories/images/abc.jpg`)).toBe(
      `${CURRENT}/stories/images/abc.jpg`,
    );
  });

  it('is a no-op for a url already on the current base', () => {
    const url = `${CURRENT}/stories/images/abc.jpg`;
    expect(canonicalMediaUrl(env(), url)).toBe(url);
  });

  it('preserves nested keys and percent-encoding verbatim', () => {
    // String surgery on the base only — the key is never decoded, so a key with
    // a `%` or `+` in it cannot be corrupted on the way through.
    expect(canonicalMediaUrl(env(), `${LEGACY}/blog/imported/a%2Bb%20c.jpg`)).toBe(
      `${CURRENT}/blog/imported/a%2Bb%20c.jpg`,
    );
  });

  it('leaves third-party urls untouched', () => {
    for (const url of [
      'https://lh3.googleusercontent.com/a/default-user=s96-c',
      'https://web.archive.org/web/2020id_/https://tophunt.in/x.jpg',
    ]) {
      expect(canonicalMediaUrl(env(), url)).toBe(url);
    }
  });

  it('refuses a lookalike host that merely prefix-matches a base', () => {
    const url = `${CURRENT}.evil.example/stories/images/abc.jpg`;
    expect(canonicalMediaUrl(env(), url)).toBe(url);
  });

  it('refuses the bare base with no key', () => {
    expect(canonicalMediaUrl(env(), LEGACY)).toBe(LEGACY);
    expect(canonicalMediaUrl(env(), `${LEGACY}/`)).toBe(`${LEGACY}/`);
  });

  it('never rewrites onto a LEGACY base when the current base is unusable', () => {
    // ownedMediaBases() drops malformed entries, so with a blank or broken
    // R2_PUBLIC_BASE_URL its first element is a legacy base. Taking [0] blindly
    // would move good urls onto the old host — the exact inversion of the intent.
    const good = `${CURRENT}/stories/images/abc.jpg`;
    expect(canonicalMediaUrl(env({ R2_PUBLIC_BASE_URL: '' }), good)).toBe(good);
    expect(canonicalMediaUrl(env({ R2_PUBLIC_BASE_URL: 'not-a-url' }), good)).toBe(good);
  });

  it('tolerates a trailing slash on the configured base', () => {
    expect(canonicalMediaUrl(env({ R2_PUBLIC_BASE_URL: `${CURRENT}/` }), `${LEGACY}/a/b.jpg`)).toBe(
      `${CURRENT}/a/b.jpg`,
    );
  });

  it('passes null/undefined/empty through unchanged', () => {
    for (const v of [null, undefined, '']) {
      expect(canonicalMediaUrl(env(), v as any)).toBe(v);
    }
  });
});
