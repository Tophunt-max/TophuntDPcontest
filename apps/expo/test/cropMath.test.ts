/**
 * The crop maths for the photo adjuster.
 *
 * These pin the behaviour that a component test cannot: that a given pan/zoom
 * maps to the right rectangle of the ORIGINAL image, and that the rectangle can
 * never fall outside the image (which is what makes expo-image-manipulator throw
 * or return a torn image). The gesture code is a thin shell over this.
 */
import { describe, it, expect } from 'vitest';
import { computeCropRect, coverBaseScale, maxTranslate } from '@/src/lib/cropMath';

describe('coverBaseScale', () => {
  it('scales up the limiting axis so the image covers the frame', () => {
    // A 1000x1000 image into a 100x200 frame must scale by height (0.2), not
    // width (0.1), or a gap would show top/bottom.
    expect(coverBaseScale(1000, 1000, 100, 200)).toBeCloseTo(0.2);
  });
});

describe('computeCropRect — no transform (centred cover)', () => {
  it('returns the whole image when frame and image share aspect', () => {
    const r = computeCropRect({ imageW: 900, imageH: 1600, frameW: 90, frameH: 160, scale: 1, translateX: 0, translateY: 0 });
    expect(r).toEqual({ originX: 0, originY: 0, width: 900, height: 1600 });
  });

  it('centre-crops a landscape image into a square frame', () => {
    // 1600x900 into 1:1 → cover by height, crop the sides symmetrically.
    const r = computeCropRect({ imageW: 1600, imageH: 900, frameW: 100, frameH: 100, scale: 1, translateX: 0, translateY: 0 });
    expect(r.width).toBe(900);
    expect(r.height).toBe(900);
    expect(r.originX).toBe(Math.round((1600 - 900) / 2)); // 350
    expect(r.originY).toBe(0);
  });

  it('centre-crops a tall image into a 9:16 frame', () => {
    // A phone screenshot 1080x2400 into 9:16 (frame 90x160): 9:16 is taller than
    // the image's own ratio, so it covers by width and trims top/bottom.
    const r = computeCropRect({ imageW: 1080, imageH: 2400, frameW: 90, frameH: 160, scale: 1, translateX: 0, translateY: 0 });
    expect(r.width).toBe(1080);
    // frame height in image px = (160/ (160/2400? )) ... assert via aspect: crop keeps 9:16.
    expect(r.height / r.width).toBeCloseTo(160 / 90, 2);
    expect(r.originX).toBe(0);
    expect(r.originY).toBe(Math.round((2400 - r.height) / 2));
  });
});

describe('computeCropRect — zoom', () => {
  it('zooming in halves the captured region and keeps it centred', () => {
    const base = computeCropRect({ imageW: 1000, imageH: 1000, frameW: 100, frameH: 100, scale: 1, translateX: 0, translateY: 0 });
    const zoomed = computeCropRect({ imageW: 1000, imageH: 1000, frameW: 100, frameH: 100, scale: 2, translateX: 0, translateY: 0 });
    expect(base.width).toBe(1000);
    expect(zoomed.width).toBe(500);
    expect(zoomed.height).toBe(500);
    // Still centred.
    expect(zoomed.originX).toBe(250);
    expect(zoomed.originY).toBe(250);
  });
});

describe('computeCropRect — pan', () => {
  it('dragging the image right reveals content further left (originX decreases)', () => {
    // Zoomed 2x so there is room to pan.
    const centred = computeCropRect({ imageW: 1000, imageH: 1000, frameW: 100, frameH: 100, scale: 2, translateX: 0, translateY: 0 });
    const dragged = computeCropRect({ imageW: 1000, imageH: 1000, frameW: 100, frameH: 100, scale: 2, translateX: 50, translateY: 0 });
    expect(dragged.originX).toBeLessThan(centred.originX);
  });

  it('never lets the crop leave the image, however hard you drag', () => {
    const r = computeCropRect({ imageW: 1000, imageH: 1000, frameW: 100, frameH: 100, scale: 2, translateX: 100000, translateY: -100000 });
    expect(r.originX).toBeGreaterThanOrEqual(0);
    expect(r.originY).toBeGreaterThanOrEqual(0);
    expect(r.originX + r.width).toBeLessThanOrEqual(1000);
    expect(r.originY + r.height).toBeLessThanOrEqual(1000);
  });
});

describe('computeCropRect — robustness', () => {
  it('falls back to the whole image for a zero dimension rather than throwing', () => {
    const r = computeCropRect({ imageW: 0, imageH: 0, frameW: 100, frameH: 100, scale: 1, translateX: 0, translateY: 0 });
    expect(r.width).toBeGreaterThan(0);
    expect(r.height).toBeGreaterThan(0);
  });

  it('treats a non-finite transform as no transform', () => {
    const r = computeCropRect({ imageW: 800, imageH: 800, frameW: 100, frameH: 100, scale: NaN, translateX: Infinity, translateY: 0 });
    expect(r).toEqual({ originX: 0, originY: 0, width: 800, height: 800 });
  });

  it('always returns integer pixels within bounds', () => {
    const r = computeCropRect({ imageW: 1333, imageH: 999, frameW: 90, frameH: 160, scale: 1.37, translateX: 12.5, translateY: -7.2 });
    expect(Number.isInteger(r.originX)).toBe(true);
    expect(Number.isInteger(r.originY)).toBe(true);
    expect(Number.isInteger(r.width)).toBe(true);
    expect(Number.isInteger(r.height)).toBe(true);
    expect(r.originX + r.width).toBeLessThanOrEqual(1333);
    expect(r.originY + r.height).toBeLessThanOrEqual(999);
  });
});

describe('maxTranslate', () => {
  it('is zero when the image exactly covers the frame (no room to pan)', () => {
    const t = maxTranslate({ imageW: 900, imageH: 1600, frameW: 90, frameH: 160, scale: 1 });
    expect(t.x).toBeCloseTo(0);
    expect(t.y).toBeCloseTo(0);
  });

  it('grows with zoom', () => {
    const t = maxTranslate({ imageW: 1000, imageH: 1000, frameW: 100, frameH: 100, scale: 2 });
    expect(t.x).toBeGreaterThan(0);
    expect(t.y).toBeGreaterThan(0);
  });
});
