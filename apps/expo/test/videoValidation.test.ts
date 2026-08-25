/**
 * Up-front video guardrails.
 *
 * The emphasis is the false-REJECT direction, because this runs before every
 * video upload: if it wrongly blocks a valid clip, or throws on the missing
 * metadata web pickers routinely omit, the feature is broken. The security limit
 * is the server's job; this is a fast, kind failure that must not overreach.
 */
import { describe, it, expect } from 'vitest';
import {
  validateVideo,
  STORY_MAX_VIDEO_SEC,
  CONTEST_MAX_VIDEO_SEC,
  MAX_VIDEO_BYTES,
} from '@/src/lib/videoValidation';

const storyLimits = { maxDurationSec: STORY_MAX_VIDEO_SEC };
const contestLimits = { maxDurationSec: CONTEST_MAX_VIDEO_SEC };

describe('validateVideo — duration', () => {
  it('accepts a clip within the limit', () => {
    expect(validateVideo({ durationMs: 25_000 }, contestLimits).ok).toBe(true);
    expect(validateVideo({ durationMs: 45_000 }, storyLimits).ok).toBe(true);
  });

  it('rejects a clip over the limit with a specific message', () => {
    const r = validateVideo({ durationMs: 42_000 }, contestLimits);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/42s.*up to 30s/i);
  });

  it('gives a half-second grace so an exactly-trimmed clip is not rejected', () => {
    expect(validateVideo({ durationMs: 30_000 }, contestLimits).ok).toBe(true);
    expect(validateVideo({ durationMs: 30_400 }, contestLimits).ok).toBe(true);
    expect(validateVideo({ durationMs: 31_000 }, contestLimits).ok).toBe(false);
  });
});

describe('validateVideo — size', () => {
  it('rejects a file over the byte cap', () => {
    const r = validateVideo({ fileSize: MAX_VIDEO_BYTES + 1 }, storyLimits);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/MB/);
  });

  it('accepts a file at the cap', () => {
    expect(validateVideo({ fileSize: MAX_VIDEO_BYTES }, storyLimits).ok).toBe(true);
  });

  it('honours a custom byte budget', () => {
    expect(validateVideo({ fileSize: 6 * 1024 * 1024 }, { maxDurationSec: 30, maxBytes: 5 * 1024 * 1024 }).ok).toBe(false);
  });
});

describe('validateVideo — unknown metadata (web / some Android providers)', () => {
  it('passes when duration and size are absent, leaving it to the server', () => {
    expect(validateVideo({}, storyLimits).ok).toBe(true);
    expect(validateVideo({ durationMs: null, fileSize: null }, storyLimits).ok).toBe(true);
    expect(validateVideo({ durationMs: undefined, fileSize: undefined }, contestLimits).ok).toBe(true);
  });

  it('ignores non-finite or zero values rather than misfiring', () => {
    expect(validateVideo({ durationMs: 0 }, contestLimits).ok).toBe(true);
    expect(validateVideo({ durationMs: NaN, fileSize: NaN }, contestLimits).ok).toBe(true);
    expect(validateVideo({ durationMs: -1 }, contestLimits).ok).toBe(true);
  });
});
