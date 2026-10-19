/**
 * Sign-in plumbing that decides what the login/signup screens offer and say:
 * the admin switches (src/lib/authMethods.ts), human error messages
 * (src/lib/authErrors.ts), in-app browser detection (src/lib/inAppBrowser.ts)
 * and the first-party auth domain (src/lib/authDomain.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  FALLBACK_AUTH_METHODS,
  resolveClientAuthMethods,
  signupBlockedReason,
  signupKeyForProvider,
} from '@/src/lib/authMethods';
import { friendlyAuthError, isAuthCancellation } from '@/src/lib/authErrors';
import { detectInAppBrowser, externalBrowserUrl } from '@/src/lib/inAppBrowser';
import { isSameSiteAuth, webAuthDomain } from '@/src/lib/authDomain';

const sw = (enabled: boolean, extra: Record<string, boolean> = {}) => ({ enabled, web: true, android: true, ios: true, ...extra });

describe('resolveClientAuthMethods', () => {
  const cfg = {
    authMethods: {
      signupsEnabled: true,
      signupsClosedMessage: '',
      google: sw(true, { ios: false }),
      facebook: sw(false),
      apple: sw(true),
      phone: sw(true),
      password: sw(true),
      emailSignup: sw(false),
    },
  };

  it('applies the global AND the per-platform switch', () => {
    expect(resolveClientAuthMethods(cfg, 'web').google).toBe(true);
    expect(resolveClientAuthMethods(cfg, 'ios').google).toBe(false);
    expect(resolveClientAuthMethods(cfg, 'android').facebook).toBe(false);
    expect(resolveClientAuthMethods(cfg, 'web').emailSignup).toBe(false);
  });

  it('closed signups carry the admin message (or the default one)', () => {
    const closed = resolveClientAuthMethods({ authMethods: { ...cfg.authMethods, signupsEnabled: false, signupsClosedMessage: 'Kal aana' } }, 'web');
    expect(closed.signupsOpen).toBe(false);
    expect(closed.signupsClosedMessage).toBe('Kal aana');
    expect(resolveClientAuthMethods({ authMethods: { signupsEnabled: false } }, 'web').signupsClosedMessage).toMatch(/band/);
  });

  it('reads the legacy shape from an older Worker, and falls back when there is no config', () => {
    const legacy = resolveClientAuthMethods({ authSettings: { googleLogin: false, phoneLogin: false } }, 'web');
    expect(legacy.google).toBe(false);
    expect(legacy.phone).toBe(false);
    expect(legacy.password).toBe(true);
    expect(resolveClientAuthMethods(null, 'web')).toEqual(FALLBACK_AUTH_METHODS);
    // Opt-in providers stay hidden until an admin turns them on.
    expect(FALLBACK_AUTH_METHODS.apple).toBe(false);
    expect(FALLBACK_AUTH_METHODS.facebook).toBe(false);
  });

  it('says why a new account is refused, before the profile form', () => {
    const m = resolveClientAuthMethods(cfg, 'ios');
    expect(signupKeyForProvider('google.com')).toBe('google');
    expect(signupBlockedReason(m, 'google')).toMatch(/band/);
    expect(signupBlockedReason(m, 'apple')).toBeNull();
    expect(signupBlockedReason({ ...m, signupsOpen: false, signupsClosedMessage: 'X' }, 'apple')).toBe('X');
  });
});

describe('friendlyAuthError', () => {
  it('never shows a raw Firebase string', () => {
    const raw = Object.assign(new Error('Firebase: Error (auth/internal-error).'), { code: 'auth/internal-error' });
    expect(friendlyAuthError(raw)).not.toMatch(/Firebase|auth\//);
    expect(friendlyAuthError(new Error('Firebase: Error (auth/popup-blocked).'))).toMatch(/popup/i);
    expect(friendlyAuthError(new Error('Firebase: Error (auth/something-new).'), 'fallback')).toBe('fallback');
  });

  it('explains the cases users actually hit', () => {
    expect(friendlyAuthError({ code: 'auth/account-exists-with-different-credential' })).toMatch(/pehle se/);
    expect(friendlyAuthError({ code: 'auth/operation-not-allowed' })).toMatch(/available nahi/);
    expect(friendlyAuthError({ code: 'auth/invalid-credential' })).toMatch(/galat/);
  });

  it('passes our own server messages through', () => {
    expect(friendlyAuthError({ code: 'functions/failed-precondition', message: 'Naye account abhi band hain.' })).toBe('Naye account abhi band hain.');
  });

  it('treats a closed popup as a cancellation, not an error', () => {
    expect(isAuthCancellation({ code: 'auth/popup-closed-by-user' })).toBe(true);
    expect(isAuthCancellation({ code: 'auth/cancelled-popup-request' })).toBe(true);
    expect(isAuthCancellation({ code: 'auth/internal-error' })).toBe(false);
  });
});

describe('detectInAppBrowser', () => {
  const IG_ANDROID = 'Mozilla/5.0 (Linux; Android 14; SM-S911B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 Instagram 350.0.0.0.80 Android';
  const FB_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0]';
  const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36';
  const BRAVE = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
  const SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

  it('spots Instagram and Facebook webviews', () => {
    expect(detectInAppBrowser(IG_ANDROID)).toEqual({ inApp: true, name: 'Instagram', os: 'android' });
    expect(detectInAppBrowser(FB_IOS)).toEqual({ inApp: true, name: 'Facebook', os: 'ios' });
  });

  it('leaves real browsers alone', () => {
    for (const ua of [CHROME, BRAVE, SAFARI]) expect(detectInAppBrowser(ua).inApp).toBe(false);
  });

  it('builds an Android hand-off to the real browser; none on iOS', () => {
    const url = externalBrowserUrl('https://tophunt.in/auth/login?redirect=%2Fhome', detectInAppBrowser(IG_ANDROID));
    expect(url).toMatch(/^intent:\/\/tophunt\.in\/auth\/login\?redirect=%2Fhome#Intent;scheme=https;/);
    expect(url).toContain('S.browser_fallback_url=');
    expect(externalBrowserUrl('https://tophunt.in/auth/login', detectInAppBrowser(FB_IOS))).toBeNull();
  });
});

describe('webAuthDomain', () => {
  const DEF = 'tophuntdpcontest.firebaseapp.com';
  it('runs sign-in first-party only on allow-listed hosts', () => {
    expect(webAuthDomain('tophunt.in', DEF)).toBe('tophunt.in');
    expect(webAuthDomain('tophuntdpcontest.pages.dev', DEF)).toBe(DEF);
    expect(webAuthDomain('localhost', DEF)).toBe(DEF);
    expect(webAuthDomain(null, DEF)).toBe(DEF);
  });
  it('has a kill switch and an explicit override', () => {
    expect(webAuthDomain('tophunt.in', DEF, 'default')).toBe(DEF);
    expect(webAuthDomain('x.test', DEF, 'auth.example.com')).toBe('auth.example.com');
  });
  it('allows the redirect fallback only when sign-in is first-party', () => {
    expect(isSameSiteAuth('tophunt.in', 'tophunt.in')).toBe(true);
    expect(isSameSiteAuth(DEF, 'tophunt.in')).toBe(false);
  });
});
