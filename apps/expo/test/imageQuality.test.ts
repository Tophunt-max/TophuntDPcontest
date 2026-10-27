import { afterEach, describe, expect, it } from 'vitest';
import { describeConnection, imagePolicyFor, isSlow, parseDataSaverMode } from '../src/lib/imageQuality';
import {
  previewImageUrl,
  responsiveImageUrl,
  setImageQualityPolicy,
} from '../src/lib/imageVariants';

const WIFI = { type: 'wifi' as const };
const LTE = { type: 'cellular' as const, generation: '4g' as const, expensive: true };
const EDGE = { type: 'cellular' as const, generation: '2g' as const, expensive: true };
const KEY = 'avatars/2026/08/a.jpg';
const ORIG = `https://media.tophunt.in/${KEY}`;
const v = (w: number, q: number) =>
  `https://media.tophunt.in/cdn-cgi/image/width=${w},quality=${q},fit=scale-down,format=auto,onerror=redirect/${KEY}`;

afterEach(() => setImageQualityPolicy(null));

describe('network-aware image policy', () => {
  it('full quality on Wi-Fi and 4G with Data saver off; preview only on Wi-Fi', () => {
    expect(imagePolicyFor(WIFI, 'off')).toEqual({ maxWidth: 1080, prefetch: true, preview: true, reason: 'normal' });
    expect(imagePolicyFor(LTE, 'off')).toEqual({ maxWidth: 1080, prefetch: true, preview: false, reason: 'normal' });
  });

  it('a slow connection gets the light size automatically', () => {
    expect(imagePolicyFor(EDGE, 'off')).toMatchObject({ maxWidth: 320, reason: 'slow_network' });
    expect(imagePolicyFor({ type: 'unknown', effectiveType: '3g' }, 'off').maxWidth).toBe(320);
    expect(imagePolicyFor({ type: 'unknown', downlinkMbps: 0.8 }, 'off').maxWidth).toBe(320);
    expect(isSlow({ type: 'unknown' })).toBe(false); // unknown is NOT assumed slow
  });

  it('Data saver "on mobile data" applies only to metered connections', () => {
    expect(imagePolicyFor(LTE, 'cellular')).toEqual({ maxWidth: 320, prefetch: false, preview: false, reason: 'data_saver' });
    expect(imagePolicyFor({ type: 'wifi', expensive: true }, 'cellular').maxWidth).toBe(320); // metered hotspot
    expect(imagePolicyFor(WIFI, 'cellular').maxWidth).toBe(1080);
  });

  it('Data saver "always" and the system Lite mode turn everything down', () => {
    expect(imagePolicyFor(WIFI, 'always')).toMatchObject({ maxWidth: 320, prefetch: false, preview: false });
    expect(imagePolicyFor({ type: 'wifi', saveData: true }, 'off')).toMatchObject({ maxWidth: 320, prefetch: false, reason: 'system_data_saver' });
  });

  it('describes the connection and parses the stored setting', () => {
    expect(describeConnection(LTE)).toBe('Mobile data (4G)');
    expect(describeConnection({ type: 'none' })).toBe('Offline');
    expect(parseDataSaverMode('always')).toBe('always');
    expect(parseDataSaverMode('garbage')).toBe('off');
  });
});

describe('the policy drives the variant', () => {
  it('caps a full-size image at 320 and never goes beyond the budgeted sizes', () => {
    expect(responsiveImageUrl(ORIG, 390, 3)).toBe(v(1080, 82));
    setImageQualityPolicy(imagePolicyFor(EDGE, 'off'));
    expect(responsiveImageUrl(ORIG, 390, 3)).toBe(v(320, 70));
    expect(responsiveImageUrl(ORIG, 28, 3)).toBe(v(128, 75)); // small images unchanged
  });

  it('offers the 128 preview only under a 1080 image on fast Wi-Fi', () => {
    setImageQualityPolicy(imagePolicyFor(WIFI, 'off'));
    expect(previewImageUrl(ORIG, v(1080, 82))).toBe(v(128, 75));
    expect(previewImageUrl(ORIG, v(320, 70))).toBeNull();
    setImageQualityPolicy(imagePolicyFor(LTE, 'off'));
    expect(previewImageUrl(ORIG, v(1080, 82))).toBeNull();
  });
});
