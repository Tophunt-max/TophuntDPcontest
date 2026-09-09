/**
 * Where a user lands after signing in from a link.
 *
 * ---------------------------------------------------------------------------
 * Why this became load-bearing
 * ---------------------------------------------------------------------------
 * Public profiles moved to `/@handle`, and that screen still requires a session. So
 * every shared profile link now routes anonymous visitors through
 * `/auth/login?redirect=/@handle`, and `redirect` went from a detail on one screen to
 * the thing that decides whether shared links work at all.
 *
 * It was honoured on exactly one branch (email + password). Phone sign-in and all three
 * social providers hard-coded `/home`, so for most of this audience — phone is the
 * dominant method — opening a shared profile link ended at the home feed.
 *
 * ---------------------------------------------------------------------------
 * And why it is sanitised
 * ---------------------------------------------------------------------------
 * The value is a query parameter on an unauthenticated page and is handed to
 * `router.replace`, which on web is a navigation. The password branch previously used it
 * verbatim (`router.replace(decodeURIComponent(redirect))`), so
 * `tophunt.in/auth/login?redirect=https://evil.example` would have carried users
 * off-site from a genuine TopHunt login page — the domain the victim checked is real,
 * which is exactly what makes that hop credible.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeRedirect, postAuthDestination } from '@/src/lib/postAuthRedirect';

describe('sanitizeRedirect accepts in-app paths', () => {
  it('accepts a profile handle path, which is the whole point', () => {
    expect(sanitizeRedirect('/@alice')).toBe('/@alice');
    expect(sanitizeRedirect('/@john.doe')).toBe('/@john.doe');
  });

  it('accepts a path with a query string and a fragment', () => {
    expect(sanitizeRedirect('/profile?userId=abc')).toBe('/profile?userId=abc');
    expect(sanitizeRedirect('/blog/post#comments')).toBe('/blog/post#comments');
  });

  it('decodes a value that was encoded on the way through the login screens', () => {
    // `/auth/login` forwards `redirect` to `/auth/login/password`, re-encoding it — so a
    // value can arrive encoded more than once.
    expect(sanitizeRedirect(encodeURIComponent('/@alice'))).toBe('/@alice');
    expect(sanitizeRedirect(encodeURIComponent(encodeURIComponent('/@alice')))).toBe('/@alice');
  });

  it('takes the first value when the parameter is repeated', () => {
    // expo-router hands back an array for `?redirect=a&redirect=b`.
    expect(sanitizeRedirect(['/@alice', '/@bob'])).toBe('/@alice');
  });
});

describe('sanitizeRedirect refuses anything that could leave the app', () => {
  it('refuses an absolute url', () => {
    for (const evil of [
      'https://evil.example',
      'http://evil.example/path',
      'HTTPS://evil.example',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      expect(sanitizeRedirect(evil), evil).toBeNull();
    }
  });

  it('refuses a PROTOCOL-RELATIVE url, which looks like a path but is not', () => {
    // `//evil.example` starts with a slash and navigates off-site. This is the case a
    // naive `startsWith('/')` check lets through.
    expect(sanitizeRedirect('//evil.example')).toBeNull();
    expect(sanitizeRedirect('//evil.example/@alice')).toBeNull();
  });

  it('refuses a backslash-rooted value, which some url parsers read as a slash', () => {
    expect(sanitizeRedirect('/\\evil.example')).toBeNull();
  });

  it('refuses a scheme hidden behind leading slashes', () => {
    expect(sanitizeRedirect('/https://evil.example')).toBeNull();
    expect(sanitizeRedirect('///javascript:alert(1)')).toBeNull();
  });

  it('refuses an absolute url smuggled through encoding', () => {
    // The reason decoding happens BEFORE validation rather than after.
    expect(sanitizeRedirect(encodeURIComponent('https://evil.example'))).toBeNull();
    expect(sanitizeRedirect(encodeURIComponent('//evil.example'))).toBeNull();
  });

  it('refuses EMBEDDED control characters that could split the value', () => {
    expect(sanitizeRedirect('/@alice\nLocation: https://evil.example')).toBeNull();
    expect(sanitizeRedirect('/@ali\u0000ce')).toBeNull();
    // Trailing whitespace is just trimmed — that is not a smuggled value.
    expect(sanitizeRedirect('/@alice\r\n')).toBe('/@alice');
  });

  it('refuses a malformed escape rather than guessing', () => {
    expect(sanitizeRedirect('%2')).toBeNull();
    expect(sanitizeRedirect('%zz/@alice')).toBeNull();
  });

  it('refuses a bare relative path', () => {
    expect(sanitizeRedirect('@alice')).toBeNull();
    expect(sanitizeRedirect('home')).toBeNull();
  });

  it('refuses empty and non-string input', () => {
    for (const empty of [null, undefined, '', '   ', [] as string[]]) {
      expect(sanitizeRedirect(empty as any), String(empty)).toBeNull();
    }
  });
});

describe('sanitizeRedirect refuses destinations that would strand the user', () => {
  it('refuses a bounce back into the auth flow', () => {
    // Signing in and being returned to the login screen is a loop.
    for (const loop of ['/auth', '/auth/login', '/auth/login/phone', '/auth/signup']) {
      expect(sanitizeRedirect(loop), loop).toBeNull();
    }
  });

  it('refuses the transient screens', () => {
    // `/splash` and `/onboarding` throw the destination away on their own.
    expect(sanitizeRedirect('/splash')).toBeNull();
    expect(sanitizeRedirect('/onboarding')).toBeNull();
  });

  it('does not refuse a real path that merely starts with those letters', () => {
    // `/authentic-review-of-the-app` is a blog permalink, not the auth flow — the same
    // prefix-boundary mistake the robots.txt rules had to avoid.
    expect(sanitizeRedirect('/authentic-review-of-the-app')).toBe('/authentic-review-of-the-app');
  });
});

describe('postAuthDestination', () => {
  it('falls back to the home feed for anything refused', () => {
    expect(postAuthDestination('https://evil.example')).toBe('/home');
    expect(postAuthDestination(undefined)).toBe('/home');
    expect(postAuthDestination('/auth/login')).toBe('/home');
  });

  it('returns the link for anything accepted', () => {
    expect(postAuthDestination('/@alice')).toBe('/@alice');
  });
});
