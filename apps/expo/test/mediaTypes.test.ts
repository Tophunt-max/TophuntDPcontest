/**
 * The client-side file check must not reject anything the server accepts.
 *
 * `uploadToR2` now identifies the picked file from its own bytes before sending
 * it, so the user learns immediately that they chose a PDF instead of waiting for
 * a 400 after a 40 MB upload. That makes it a gate in front of every photo and
 * video in the app, which means a bug here does not merely weaken a check — it
 * blocks uploads outright, exactly the class of failure this repo has already had
 * twice (the missing upload folders, and the missing `blob:` in the CSP).
 *
 * So the emphasis here is the false-REJECT direction. The security direction is
 * enforced and tested on the Worker (apps/worker/test/mediaTypes.test.ts); this
 * file is about not breaking the app.
 */
import { describe, it, expect } from 'vitest';
import {
  IMAGE_MIME_TYPES,
  VIDEO_MIME_TYPES,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  kindOf,
  sniffMediaMime,
} from '../src/lib/mediaTypes';

const ascii = (prefix: number[], text: string, pad = 0) =>
  new Uint8Array([...prefix, ...[...text].map((c) => c.charCodeAt(0)), ...new Array(pad).fill(0)]);

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const WEBP = ascii([], 'RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
const GIF = ascii([], 'GIF89a', 6);
const MP4 = ascii([0, 0, 0, 0x18], 'ftypisom', 4);
const MOV = ascii([0, 0, 0, 0x14], 'ftypqt  ', 4);

describe('client sniffer accepts everything the app can legitimately pick', () => {
  it.each([
    ['a camera JPEG', JPEG, 'image/jpeg'],
    ['a screenshot PNG', PNG, 'image/png'],
    ['a WebP', WEBP, 'image/webp'],
    ['a GIF', GIF, 'image/gif'],
    ['an Android MP4', MP4, 'video/mp4'],
    ['an iOS MOV', MOV, 'video/quicktime'],
  ])('accepts %s', (_label, input, expected) => {
    expect(sniffMediaMime(input)).toBe(expected);
  });

  it('identifies an iOS .mov as quicktime, not mp4', () => {
    // The live bug this fixes: contest and story uploads hard-coded 'video/mp4'
    // for every picked video, so an iPhone entry was stored mislabelled. The
    // detected type is what gets sent now.
    expect(sniffMediaMime(MOV)).toBe('video/quicktime');
    expect(kindOf('video/quicktime')).toBe('video');
  });

  it('only needs the first 16 bytes, which is all uploadToR2 reads', () => {
    // uploadToR2 slices blob(0, SNIFF_BYTES). If the sniffer ever needed more,
    // every upload would fail — so this pins the contract.
    expect(sniffMediaMime(MP4.slice(0, 16))).toBe('video/mp4');
    expect(sniffMediaMime(WEBP.slice(0, 16))).toBe('image/webp');
    expect(sniffMediaMime(JPEG.slice(0, 16))).toBe('image/jpeg');
  });
});

describe('client sniffer still refuses non-media', () => {
  it.each([
    ['an SVG', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an HTML file', '<!DOCTYPE html><html>'],
    ['a PDF', '%PDF-1.7'],
    ['a ZIP/APK', 'PK\u0003\u0004'],
    ['an empty file', ''],
  ])('refuses %s', (_label, text) => {
    expect(sniffMediaMime(new TextEncoder().encode(text))).toBeNull();
  });
});

describe('mirrors the Worker policy', () => {
  // Drift between these lists and apps/worker/src/lib/mediaTypes.ts shows up as a
  // file the app accepts and the server rejects, which reads to a user as a
  // broken upload. Hard-coded on purpose so a change here is deliberate.
  it('lists the same accepted types', () => {
    expect([...IMAGE_MIME_TYPES]).toEqual(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
    expect([...VIDEO_MIME_TYPES]).toEqual(['video/mp4', 'video/quicktime']);
  });

  it('uses the same caps', () => {
    expect(MAX_IMAGE_BYTES).toBe(12 * 1024 * 1024);
    expect(MAX_VIDEO_BYTES).toBe(80 * 1024 * 1024);
  });

  it('never classifies SVG as an image', () => {
    expect(kindOf('image/svg+xml')).toBeNull();
    expect(IMAGE_MIME_TYPES as readonly string[]).not.toContain('image/svg+xml');
  });
});
