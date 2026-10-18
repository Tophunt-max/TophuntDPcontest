/**
 * First-launch intro (src/lib/onboarding.ts): a new guest sees it once, then
 * Home; it is never shown to a signed-in user (the guard bounces them off it).
 */
import { describe, it, expect } from 'vitest';
import { guestStartRoute, ONBOARDING_SEEN_KEY } from '@/src/lib/onboarding';
import { classifyRoute, guardDecision } from '@/src/lib/routeAccess';
import { loginHref } from '@/src/lib/authGate';

describe('first-launch intro', () => {
  it('a brand-new guest goes to the intro; anyone who has seen it goes to Home', () => {
    expect(guestStartRoute(null)).toBe('/onboarding');
    expect(guestStartRoute(undefined)).toBe('/onboarding');
    expect(guestStartRoute('false')).toBe('/onboarding');
    expect(guestStartRoute('true')).toBe('/home');
  });

  it('keeps the storage key the app has always used, so existing installs are not re-shown the intro', () => {
    expect(ONBOARDING_SEEN_KEY).toBe('hasSeenOnboarding');
  });

  it('is open to guests and moves a signed-in user on', () => {
    const access = classifyRoute(['onboarding']);
    const base = { access, authLoading: false, currentPath: '/onboarding', destination: '/home', loginHref };
    expect(guardDecision({ ...base, signedIn: false })).toEqual({ type: 'none' });
    expect(guardDecision({ ...base, signedIn: true })).toEqual({ type: 'leave-auth', to: '/home' });
  });
});
