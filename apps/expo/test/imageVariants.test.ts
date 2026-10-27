import { afterEach, describe, expect, it } from 'vitest';
import {
  bucketFor,
  isTransformable,
  mediaKeyOf,
  originalImageUrl,
  responsiveImageUrl,
  setImageTransformsEnabled,
  WIDTH_BUCKETS,
} from '../src/lib/imageVariants';

const KEY = 'contest-entries/u1/1782889279766_76tsfwy1o9.jpg';
const ORIG = `https://media.tophunt.in/${KEY}`;
const v = (w: number, q: number, key = KEY) =>
  `https://media.tophunt.in/cdn-cgi/image/width=${w},quality=${q},fit=scale-down,format=auto,onerror=redirect/${key}`;

afterEach(() => setImageTransformsEnabled(true));

describe('responsive image variants', () => {
  it('rounds the drawn size × density up to a fixed bucket', () => {
    // Three sizes per image at most: the free plan counts image x size.
    expect(WIDTH_BUCKETS).toEqual([128, 320, 1080]);
    expect(bucketFor(28 * 3)).toBe(128);
    expect(bucketFor(100 * 3)).toBe(320);
    expect(bucketFor(170 * 3)).toBe(1080);
    expect(bucketFor(390 * 3)).toBe(1080); // capped
    expect(responsiveImageUrl(ORIG, 170, 2)).toBe(v(1080, 82));
    expect(responsiveImageUrl(ORIG, 150, 2)).toBe(v(320, 70));
    expect(responsiveImageUrl(ORIG, 390, 2)).toBe(v(1080, 82));
    expect(responsiveImageUrl(ORIG, 40, 10)).toBe(v(128, 75)); // dpr capped at 3
  });

  it('uses the exact parameter strings the Worker emits, so both share one cache entry', () => {
    // apps/worker/src/lib/media.ts: avatarUrl / thumbUrl / optimizedUrl.
    expect(responsiveImageUrl(ORIG, 128, 1)).toBe(v(128, 75));
    expect(responsiveImageUrl(ORIG, 320, 1)).toBe(v(320, 70));
    expect(responsiveImageUrl(ORIG, 1080, 1)).toBe(v(1080, 82));
  });

  it('re-sizes an existing variant from its key instead of nesting cdn-cgi', () => {
    expect(mediaKeyOf(v(128, 75))).toBe(KEY);
    expect(responsiveImageUrl(v(128, 75), 100, 3)).toBe(v(320, 70));
    expect(originalImageUrl(v(1080, 82))).toBe(ORIG);
  });

  it('moves a legacy-base url onto the media host', () => {
    const legacy = `https://tophunt-api.weadown-in.workers.dev/media/${KEY}`;
    expect(responsiveImageUrl(legacy, 100, 1)).toBe(v(128, 75));
    expect(originalImageUrl(legacy)).toBe(ORIG);
  });

  it.each([
    ['third-party avatar', 'https://lh3.googleusercontent.com/a/abc=s96-c'],
    ['bunny poster', 'https://vz-123.b-cdn.net/guid/thumbnail.jpg'],
    ['video', 'https://media.tophunt.in/stories/u1/clip.mp4'],
    ['VS card (proxy-only)', 'https://media.tophunt.in/vs-cards/m1.jpg'],
    ['contest banner (proxy-only)', 'https://media.tophunt.in/contest-banners/2026/10/b.jpg'],
    ['product image (proxy-only)', 'https://media.tophunt.in/product-images/p.png'],
    ['lookalike host', 'https://media.tophunt.in.evil.example/x.jpg'],
    ['path traversal', 'https://media.tophunt.in/avatars/../x.jpg'],
    ['local file', 'file:///data/user/0/x.jpg'],
  ])('leaves %s untouched', (_name, url) => {
    expect(responsiveImageUrl(url, 200, 3)).toBe(url);
  });

  it('is a no-op without a size, for empty input, and when the kill switch is off', () => {
    expect(responsiveImageUrl(ORIG, undefined, 3)).toBe(ORIG);
    expect(responsiveImageUrl(ORIG, 0, 3)).toBe(ORIG);
    expect(responsiveImageUrl(null, 100, 3)).toBeNull();
    setImageTransformsEnabled(false);
    expect(responsiveImageUrl(ORIG, 100, 3)).toBe(ORIG);
    expect(isTransformable(ORIG)).toBe(true);
    setImageTransformsEnabled(null); // unknown config keeps it on
    expect(responsiveImageUrl(ORIG, 100, 3)).toBe(v(320, 70));
  });

  it('caps the bucket when asked (list thumbnails stay on 320)', () => {
    expect(responsiveImageUrl(ORIG, 358, 3, 320)).toBe(v(320, 70));
    expect(responsiveImageUrl(ORIG, 20, 3, 320)).toBe(v(128, 75));
  });

  it('matches the Worker presets character for character', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.resolve(__dirname, '../../worker/src/lib/media.ts'), 'utf8');
    for (const [w, q] of [[128, 75], [320, 70], [1080, 82]]) {
      expect(src).toMatch(new RegExp(`width: ${w}, quality: ${q}, fit: "scale-down"`));
    }
    expect(src).toContain('"onerror=redirect"');
  });
});
