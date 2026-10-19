/**
 * An unfinished signup can never wander into the app.
 *
 * Regression: a new Google user pressed Back on "Fill your profile", landed on a
 * screen whose useProfile auto-created a default profile, and was a full user
 * from then on. The root guard now keeps an unfinished account on the signup
 * steps on every navigation, and the only completeness rule is the server flag.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createRootGuard, type GuardSnapshot } from '@/src/lib/rootGuard';
import {
  isProfileComplete,
  isProfileIncompleteError,
  markOnboardingComplete,
  markOnboardingIncomplete,
  onboardingDraftFor,
  onboardingRedirect,
  onboardingStatusFor,
  refreshOnboarding,
  resetOnboarding,
} from '@/src/lib/profileCompletion';

function router() {
  return { replace: vi.fn(), back: vi.fn(), canGoBack: () => true };
}
const snap = (over: Partial<GuardSnapshot>): GuardSnapshot => ({
  signedIn: true,
  loading: false,
  segments: ['home'],
  params: {},
  pathname: '/home',
  ...over,
});

beforeEach(() => resetOnboarding());

describe('completeness rule', () => {
  it('is the server flag only — a username alone does not count', () => {
    expect(isProfileComplete({ signupCompleted: true })).toBe(true);
    expect(isProfileComplete({ username: 'santalientertainment', signupCompleted: false })).toBe(false);
    expect(isProfileComplete(null)).toBe(false);
  });
  it('recognises the Worker error', () => {
    expect(isProfileIncompleteError(new Error('PROFILE_INCOMPLETE: Finish creating your profile'))).toBe(true);
    expect(isProfileIncompleteError(new Error('nope'))).toBe(false);
  });
});

describe('root guard', () => {
  it('sends an unfinished signed-in user back to the profile form from any app screen', () => {
    for (const segments of [['home'], ['profile'], ['wallet'], ['explore'], ['contest', 'photo']]) {
      const r = router();
      createRootGuard().run(snap({ segments, onboarding: 'incomplete' }), r);
      expect(r.replace).toHaveBeenCalledWith('/auth/signup/fill-profile');
    }
  });

  it('also catches the login screen reached with Back', () => {
    const r = router();
    createRootGuard().run(snap({ segments: ['auth', 'login'], onboarding: 'incomplete' }), r);
    expect(r.replace).toHaveBeenCalledWith('/auth/signup/fill-profile');
  });

  it('leaves the signup steps, legal pages and system screens alone', () => {
    for (const segments of [
      ['auth', 'signup', 'fill-profile'],
      ['auth', 'signup', 'follow-someone'],
      ['auth', 'signup', 'congratulations'],
      ['legal', 'terms'],
      ['splash'],
      ['maintenance'],
    ]) {
      const r = router();
      createRootGuard().run(snap({ segments, onboarding: 'incomplete' }), r);
      expect(r.replace, segments.join('/')).not.toHaveBeenCalled();
    }
  });

  it('never redirects on an unknown status (offline must not trap a real user)', () => {
    const r = router();
    createRootGuard().run(snap({ segments: ['home'], onboarding: 'unknown' }), r);
    expect(r.replace).not.toHaveBeenCalled();
  });

  it('a finished account is moved off the form steps', () => {
    expect(onboardingRedirect({ signedIn: true, status: 'complete', routeKey: 'auth/signup/fill-profile' })).toBe('/home');
    expect(onboardingRedirect({ signedIn: true, status: 'complete', routeKey: 'auth/signup/congratulations' })).toBeNull();
    expect(onboardingRedirect({ signedIn: false, status: 'incomplete', routeKey: 'home' })).toBeNull();
  });
});

describe('status store', () => {
  it('resolves from the own-profile read, and a network error stays unknown', async () => {
    expect(await refreshOnboarding('u1', async () => ({ signupCompleted: true }))).toBe('complete');
    resetOnboarding();
    expect(await refreshOnboarding('u2', async () => null)).toBe('incomplete');
    resetOnboarding();
    expect(await refreshOnboarding('u3', async () => {
      throw new Error('offline');
    })).toBe('unknown');
  });

  it('is per account, and server answers flip it', () => {
    markOnboardingComplete('a');
    expect(onboardingStatusFor('a')).toBe('complete');
    expect(onboardingStatusFor('b')).toBe('unknown');
    markOnboardingIncomplete('a');
    expect(onboardingStatusFor('a')).toBe('incomplete');
  });
});

describe('draft for a resumed onboarding', () => {
  it('pre-fills from the Firebase user and a half-created row', () => {
    const d = onboardingDraftFor(
      { displayName: 'Santali Entertainment', email: 's@example.com', photoURL: 'https://x/p.jpg', providerData: [{ providerId: 'google.com' }] },
      { username: 'santalientertainment', fullName: 'Santali Entertainment' },
    );
    expect(d).toMatchObject({ authProvider: 'google', email: 's@example.com', username: 'santalientertainment', avatarUrl: 'https://x/p.jpg' });
  });
});
