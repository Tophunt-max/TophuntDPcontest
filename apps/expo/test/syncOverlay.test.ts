import { describe, it, expect } from 'vitest';

import { overlayFlag, overlayLike } from '@/src/sync/overlay';

describe('pending intent overlay', () => {
  it('no pending intent: the server wins', () => {
    expect(overlayLike(true, 10, undefined)).toEqual({ liked: true, count: 10 });
    expect(overlayFlag(false, undefined)).toBe(false);
  });
  it('a pending like the server has not seen adds exactly one', () => {
    expect(overlayLike(false, 10, { liked: true })).toEqual({ liked: true, count: 11 });
  });
  it('a pending unlike removes exactly one, never below zero', () => {
    expect(overlayLike(true, 10, { liked: false })).toEqual({ liked: false, count: 9 });
    expect(overlayLike(true, 0, { liked: false })).toEqual({ liked: false, count: 0 });
  });
  it('once the server reflects the intent, nothing is applied twice', () => {
    expect(overlayLike(true, 11, { liked: true })).toEqual({ liked: true, count: 11 });
  });
  it('a pending bookmark wins over the server value', () => {
    expect(overlayFlag(false, true)).toBe(true);
    expect(overlayFlag(true, false)).toBe(false);
  });
});
