/**
 * Reading the server-rendered VS card off a match. (The old client-side
 * "should this device capture and record a card" gate is gone: the server now
 * renders the card from the two accepted entries.)
 */
import { describe, it, expect } from 'vitest';
import { vsImageOf } from '@/src/lib/vsStory';

describe('vsImageOf', () => {
  it('reads the card off the MATCH', () => {
    expect(vsImageOf({ vsImageUrl: 'https://cdn.test/vs-cards/images/a.jpg' })).toBe(
      'https://cdn.test/vs-cards/images/a.jpg',
    );
  });

  it('treats every kind of absence as "no card"', () => {
    // Null is the normal case, not an error: battles that predate the feature,
    // video battles, installs without the native module, and every battle whose
    // stories have expired (the cron deletes the card and clears the column). An
    // empty string is what a careless write would leave, and pointing an Image at
    // it renders nothing.
    expect(vsImageOf(null)).toBeNull();
    expect(vsImageOf(undefined)).toBeNull();
    expect(vsImageOf({})).toBeNull();
    expect(vsImageOf({ vsImageUrl: null })).toBeNull();
    expect(vsImageOf({ vsImageUrl: '' })).toBeNull();
    expect(vsImageOf({ vsImageUrl: 123 })).toBeNull();
  });
});
