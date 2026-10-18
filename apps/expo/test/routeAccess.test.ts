/**
 * Guest-first route policy (src/lib/routeAccess.ts) — the root guard's brain.
 */
import { describe, it, expect } from 'vitest';
import { classifyRoute, guardDecision, type RouteAccess } from '@/src/lib/routeAccess';
import { loginHref } from '@/src/lib/authGate';
import { postAuthDestination } from '@/src/lib/postAuthRedirect';

const seg = (path: string) => path.split('/').filter(Boolean);

describe('classifyRoute', () => {
  it('public content is open to guests', () => {
    for (const s of [
      'home', 'explore', 'explore/leaderboard', 'battle/[id]', 'blog', 'blog/[slug]', '[slug]',
      'legal/terms', 'legal/privacy', 'legal/refund', 'legal/guidelines',
      'story/view/[userId]', 'story/highlight/[userId]', 'contest/photo', 'contest/photo/index',
      'contest/video', 'profile/connections', 'profile/wins', '+not-found',
    ]) {
      expect(classifyRoute(seg(s)), s).toBe('public');
    }
  });

  it('personal screens need an account', () => {
    for (const s of [
      'messages', 'messages/chat/[id]', 'notifications', 'wallet', 'wallet/deposit', 'wallet/store', 'wallet/withdraw',
      'setting', 'setting/security', 'setting/delete-account', 'profile/manage', 'profile/manage/edit',
      'profile/manage/verification', 'story/create', 'contest/photo/setup', 'contest/joined', 'prizes', 'prizes/[matchId]',
    ]) {
      expect(classifyRoute(seg(s)), s).toBe('private');
    }
  });

  it('/profile is public for someone else, private for "me"', () => {
    expect(classifyRoute(['profile'], { userId: 'u123' })).toBe('public');
    expect(classifyRoute(['profile'], { userId: ['u123'] })).toBe('public');
    expect(classifyRoute(['profile'])).toBe('private');
    expect(classifyRoute(['profile'], { userId: '  ' })).toBe('private');
  });

  it('matches exactly — no substring accidents, unknown routes fail closed', () => {
    expect(classifyRoute(['profile-tips'])).toBe('private');
    expect(classifyRoute(['storyx', 'view'])).toBe('private');
    expect(classifyRoute(['home', 'secret'])).toBe('private');
    expect(classifyRoute(['explore', 'admin'])).toBe('private');
  });

  it('auth screens: entry vs. flow', () => {
    for (const s of ['auth/login', 'auth/login/password', 'auth/login/phone', 'auth/signup', 'auth/forgot-password', 'auth/forgot-password/reset', 'onboarding']) {
      expect(classifyRoute(seg(s)), s).toBe('auth-entry');
    }
    for (const s of ['auth/action', 'auth/signup/fill-profile', 'auth/signup/follow-someone', 'auth/signup/congratulations']) {
      expect(classifyRoute(seg(s)), s).toBe('auth-flow');
    }
    for (const s of ['', 'splash', 'maintenance', 'force-update', 'account-scheduled-deletion']) {
      expect(classifyRoute(seg(s)), s).toBe('system');
    }
  });

  it('route groups are ignored', () => {
    expect(classifyRoute(['(tabs)', 'home'])).toBe('public');
  });
});

describe('guardDecision', () => {
  const base = {
    authLoading: false,
    currentPath: '/wallet',
    destination: '/home',
    loginHref,
  };

  it('never redirects while auth is still loading', () => {
    expect(guardDecision({ ...base, access: 'private', signedIn: false, authLoading: true })).toEqual({ type: 'none' });
  });

  it('first launch and returning guests stay on public Home', () => {
    expect(guardDecision({ ...base, access: 'public', signedIn: false, currentPath: '/home' })).toEqual({ type: 'none' });
  });

  it('a public dynamic link opens for a guest (no login first)', () => {
    for (const path of ['/battle/m1', '/@alice', '/story/view/u1', '/profile?userId=u1', '/blog/some-post']) {
      expect(guardDecision({ ...base, access: 'public', signedIn: false, currentPath: path })).toEqual({ type: 'none' });
    }
  });

  it('a guest on a private screen is sent to sign in with a safe return path', () => {
    expect(guardDecision({ ...base, access: 'private', signedIn: false, currentPath: '/wallet/withdraw' })).toEqual({
      type: 'redirect',
      to: '/auth/login?redirect=%2Fwallet%2Fwithdraw',
    });
  });

  it('signed-in user on a sign-in screen leaves it for their destination — unless they just signed in there', () => {
    expect(guardDecision({ ...base, access: 'auth-entry', signedIn: true, destination: '/battle/m1' })).toEqual({ type: 'leave-auth', to: '/battle/m1' });
    expect(guardDecision({ ...base, access: 'auth-entry', signedIn: true, justSignedIn: true })).toEqual({ type: 'none' });
  });

  it('signing out on a private screen lands on public Home (no login race)', () => {
    expect(guardDecision({ ...base, access: 'private', signedIn: false, justSignedOut: true, currentPath: '/setting' })).toEqual({ type: 'redirect', to: '/home' });
  });

  it('action links and post-signup steps are never bounced', () => {
    for (const signedIn of [true, false]) {
      expect(guardDecision({ ...base, access: 'auth-flow', signedIn })).toEqual({ type: 'none' });
      expect(guardDecision({ ...base, access: 'system', signedIn })).toEqual({ type: 'none' });
    }
  });

  it('never loops: every redirect lands where the guard is satisfied', () => {
    const routes: Array<[string, RouteAccess]> = [
      ['/home', 'public'], ['/wallet', 'private'], ['/messages', 'private'], ['/auth/login', 'auth-entry'],
      ['/auth/action', 'auth-flow'], ['/splash', 'system'], ['/@alice', 'public'],
    ];
    const accessOf = (path: string): RouteAccess => {
      const p = path.split('?')[0];
      if (p.startsWith('/auth/login')) return 'auth-entry';
      return routes.find(([r]) => r === p)?.[1] ?? 'public';
    };
    for (const signedIn of [true, false]) {
      for (const [path, access] of routes) {
        const redirect = new URLSearchParams(path.split('?')[1] || '').get('redirect');
        let decision = guardDecision({
          ...base, access, signedIn, currentPath: path, destination: postAuthDestination(redirect),
        });
        let hops = 0;
        let at = path;
        while (decision.type !== 'none') {
          at = decision.to;
          const r = new URLSearchParams(at.split('?')[1] || '').get('redirect');
          decision = guardDecision({ ...base, access: accessOf(at), signedIn, currentPath: at, destination: postAuthDestination(r) });
          hops++;
          expect(hops, `${signedIn ? 'user' : 'guest'} ${path} -> ${at}`).toBeLessThan(2);
        }
      }
    }
  });

  it('the post-auth destination can never be another auth screen or an external site', () => {
    for (const evil of ['https://evil.example', '//evil.example', '/auth/login', '/\\evil', 'javascript:alert(1)']) {
      expect(postAuthDestination(evil)).toBe('/home');
    }
  });
});
