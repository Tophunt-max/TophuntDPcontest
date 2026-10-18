/**
 * First-launch intro (src/lib/onboarding.ts): only a NEW guest who opened
 * TopHunt directly (app icon / bare tophunt.in) sees it, once — never from a
 * link, never when signed in, never when an admin switched it off.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  entryKindFromUrl,
  guestStartRoute,
  ONBOARDING_SEEN_KEY,
  sessionEntryKind,
  __resetSessionEntryForTests,
} from '@/src/lib/onboarding';
import { classifyRoute, guardDecision } from '@/src/lib/routeAccess';
import { loginHref } from '@/src/lib/authGate';

describe('how the session started', () => {
  it('direct: app icon, the bare site root, the splash/index targets', () => {
    for (const u of [null, '', 'https://tophunt.in', 'https://tophunt.in/', 'https://tophunt.in/splash', 'tophunt://', 'exp://192.168.1.5:8081', 'exp://192.168.1.5:8081/--/']) {
      expect(entryKindFromUrl(u as any), String(u)).toBe('direct');
    }
  });

  it('link: shared battles, profiles, blog, Stories, notifications, or the root with parameters', () => {
    for (const u of [
      'https://tophunt.in/battle/m1',
      'https://tophunt.in/@alice',
      'https://tophunt.in/profile?userId=u1',
      'https://tophunt.in/some-blog-post',
      'https://tophunt.in/story/view/u1',
      'https://tophunt.in/home',
      'https://tophunt.in/?utm_source=whatsapp',
      'https://tophunt.in/?ref=ABC123',
      'tophunt://battle/m1',
      'exp://192.168.1.5:8081/--/battle/m1',
      'not a url',
    ]) {
      expect(entryKindFromUrl(u), u).toBe('link');
    }
  });

  it('is decided once per session (a later in-app trip through splash keeps the first answer)', async () => {
    __resetSessionEntryForTests(null);
    expect(await sessionEntryKind(async () => 'https://tophunt.in/battle/m1')).toBe('link');
    expect(await sessionEntryKind(async () => null)).toBe('link');
    __resetSessionEntryForTests(null);
    expect(await sessionEntryKind(async () => { throw new Error('no linking'); })).toBe('direct');
  });
});

describe('where splash sends a guest', () => {
  beforeEach(() => __resetSessionEntryForTests(null));

  it('a brand-new guest who opened TopHunt directly gets the intro', () => {
    expect(guestStartRoute(null, { entry: 'direct', enabled: true })).toBe('/onboarding');
    expect(guestStartRoute(undefined)).toBe('/onboarding');
  });

  it('everyone else goes to Home', () => {
    expect(guestStartRoute('true', { entry: 'direct' })).toBe('/home');
    expect(guestStartRoute(null, { entry: 'link' })).toBe('/home');
    expect(guestStartRoute(null, { entry: 'direct', enabled: false })).toBe('/home');
  });

  it('keeps the storage key existing installs already have', () => {
    expect(ONBOARDING_SEEN_KEY).toBe('hasSeenOnboarding');
  });

  it('the intro screen is open to guests and moves a signed-in user on', () => {
    const access = classifyRoute(['onboarding']);
    const base = { access, authLoading: false, currentPath: '/onboarding', destination: '/home', loginHref };
    expect(guardDecision({ ...base, signedIn: false })).toEqual({ type: 'none' });
    expect(guardDecision({ ...base, signedIn: true })).toEqual({ type: 'leave-auth', to: '/home' });
  });
});
