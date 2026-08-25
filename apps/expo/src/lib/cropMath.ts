/**
 * The maths behind "adjust your photo": turn a pan/zoom gesture into the exact
 * rectangle of the ORIGINAL image that ends up inside the crop frame.
 *
 * This is the one part of the adjuster that can be quietly wrong — a sign flip or
 * a missing clamp produces a crop that is offset, zoomed, or reaches outside the
 * image (which `expo-image-manipulator` then rejects or fills with garbage). The
 * gesture wiring around it is thin; this is where the correctness lives, so it is
 * a pure function with tests rather than something buried in a component.
 *
 * Coordinate model, stated once so the signs are not a guess:
 *  - The frame is a fixed box of `frameW x frameH` display pixels, centred on
 *    screen. The image is drawn centred in it and "covers" it at a base scale,
 *    then the user applies an extra `scale` (>= 1) and drags it by
 *    `(translateX, translateY)` display pixels — positive X moves the image
 *    RIGHT, positive Y moves it DOWN, matching the gesture.
 *  - Moving the image right means the frame now sees content further LEFT in the
 *    image, so the crop's originX decreases as translateX grows. The formulas
 *    below encode exactly that.
 */

export interface CropInput {
  /** Natural pixel size of the source image. */
  imageW: number;
  imageH: number;
  /** Display size of the crop frame (the visible window). */
  frameW: number;
  frameH: number;
  /** User zoom on top of the cover base scale. 1 = fills the frame exactly. */
  scale: number;
  /** Image-centre offset from frame-centre, in display pixels. */
  translateX: number;
  translateY: number;
}

export interface CropRect {
  originX: number;
  originY: number;
  width: number;
  height: number;
}

/** The smallest scale at which the image still fully covers the frame ("cover"). */
export function coverBaseScale(imageW: number, imageH: number, frameW: number, frameH: number): number {
  if (imageW <= 0 || imageH <= 0) return 1;
  return Math.max(frameW / imageW, frameH / imageH);
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

/**
 * Compute the crop rectangle, in ORIGINAL image pixels, that the frame is
 * showing. Always returns a rect fully inside the image (clamped), with integer
 * values ready for `ImageManipulator.crop`.
 *
 * Degenerate inputs (a zero dimension, a non-finite transform) fall back to the
 * whole image rather than throwing — a bad probe should still produce a usable,
 * if un-adjusted, upload.
 */
export function computeCropRect(input: CropInput): CropRect {
  const { imageW, imageH, frameW, frameH } = input;

  if (
    !Number.isFinite(imageW) || !Number.isFinite(imageH) ||
    imageW <= 0 || imageH <= 0 || frameW <= 0 || frameH <= 0
  ) {
    return { originX: 0, originY: 0, width: Math.max(1, Math.round(imageW) || 1), height: Math.max(1, Math.round(imageH) || 1) };
  }

  const userScale = Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1;
  const tx = Number.isFinite(input.translateX) ? input.translateX : 0;
  const ty = Number.isFinite(input.translateY) ? input.translateY : 0;

  const displayScale = coverBaseScale(imageW, imageH, frameW, frameH) * userScale;
  const displayedW = imageW * displayScale;
  const displayedH = imageH * displayScale;

  // The frame window expressed in image pixels.
  let width = frameW / displayScale;
  let height = frameH / displayScale;
  // Cover guarantees the window is no larger than the image, but a user who
  // somehow zoomed below cover (or rounding) must not ask for more than exists.
  width = Math.min(width, imageW);
  height = Math.min(height, imageH);

  let originX = (displayedW / 2 - frameW / 2 - tx) / displayScale;
  let originY = (displayedH / 2 - frameH / 2 - ty) / displayScale;

  // Keep the window inside the image on both axes.
  originX = clamp(originX, 0, imageW - width);
  originY = clamp(originY, 0, imageH - height);

  // Round to whole pixels; guard against a rounded width/height spilling past the
  // edge by a pixel after the origin was also rounded.
  const rOriginX = Math.round(originX);
  const rOriginY = Math.round(originY);
  const rWidth = Math.min(Math.round(width), imageW - rOriginX);
  const rHeight = Math.min(Math.round(height), imageH - rOriginY);

  return {
    originX: rOriginX,
    originY: rOriginY,
    width: Math.max(1, rWidth),
    height: Math.max(1, rHeight),
  };
}

/**
 * How far the image may be dragged before a gap would appear at the frame edge,
 * i.e. the max |translate| on each axis for a given scale. The component uses
 * this to clamp panning so the frame is always fully covered.
 */
export function maxTranslate(input: Pick<CropInput, 'imageW' | 'imageH' | 'frameW' | 'frameH' | 'scale'>): { x: number; y: number } {
  const { imageW, imageH, frameW, frameH } = input;
  if (imageW <= 0 || imageH <= 0 || frameW <= 0 || frameH <= 0) return { x: 0, y: 0 };
  const userScale = Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1;
  const displayScale = coverBaseScale(imageW, imageH, frameW, frameH) * userScale;
  return {
    x: Math.max(0, (imageW * displayScale - frameW) / 2),
    y: Math.max(0, (imageH * displayScale - frameH) / 2),
  };
}
