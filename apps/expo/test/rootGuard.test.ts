/**
 * The root route guard (src/lib/rootGuard.ts) driven through the SEQUENCES of
 * snapshots `app/_layout.tsx` produces — the part of the guard the pure
 * `guardDecision` table cannot cover, because it depends on what the previous
 * render saw (cold start vs. just signed in vs. just signed out).
 */
import { describe, it, expect } from 'vitest';
import { createRootGuard, type GuardSnapshot } from '@/src/lib/rootGuard';
import { classifyRoute } from '@/src/lib/routeAccess';

function fakeRouter(history = 0) {
  const calls: string[] = [];
  let depth = history;
  return {
    calls,
    router: {
      replace: (to: string) => calls.push(`replace ${to}`),
      back: () => {
        depth -= 1;
        calls.push('back');
      },
      canGoBack: () => depth > 0,
    },
  };
}

const snap = (path: string, signedIn: boolean, extra: Partial<GuardSnapshot> = {}): GuardSnapshot => {
  const [p, q = ''] = path.split('?');
  const params = Object.fromEntries(new URLSearchParams(q));
  return { signedIn, loading: false, segments: p.split('/').filter(Boolean), params, pathname: p, ...extra };
};

describe('root guard sequences', () => {
  it('never redirects while auth is resolving, then sends a guest on a private screen to sign in', () => {
    const g = createRootGuard();
    const { router, calls } = fakeRouter();
    g.run(snap('/wallet', false, { loading: true }), router);
    expect(calls).toEqual([]);
    g.run(snap('/wallet', false), router);
    expect(calls).toEqual(['replace /auth/login?redirect=%2Fwallet']);
  });

  it('lets a guest browse public screens with no navigation at all', () => {
    const g = createRootGuard();
    const { router, calls } = fakeRouter();
    for (const p of ['/home', '/explore', '/profile?userId=u1']) g.run(snap(p, false), router);
    // Dynamic routes arrive as their file segments, with the value in params.
    g.run(snap('/battle/m1', false, { segments: ['battle', '[id]'], params: { id: 'm1' } }), router);
    g.run(snap('/story/view/u1', false, { segments: ['story', 'view', '[userId]'], params: { userId: 'u1' } }), router);
    expect(calls).toEqual([]);
  });

  it('signing in ON the login screen does not bounce (the screen routes itself)', () => {
    const g = createRootGuard();
    const { router, calls } = fakeRouter(1);
    g.run(snap('/auth/login?redirect=%2Fwallet', false), router);
    g.run(snap('/auth/login?redirect=%2Fwallet', true), router);
    expect(calls).toEqual([]);
  });

  it('a signed-in user arriving at login later (Back) leaves it', () => {
    const g = createRootGuard();
    const withHistory = fakeRouter(1);
    g.run(snap('/home', true), withHistory.router);
    g.run(snap('/auth/login?redirect=%2Fwallet', true), withHistory.router);
    expect(withHistory.calls).toEqual(['back']);

    const g2 = createRootGuard();
    const cold = fakeRouter(0);
    g2.run(snap('/auth/login?redirect=%2Fwallet', true), cold.router);
    expect(cold.calls).toEqual(['replace /wallet']);
  });

  it('signing out on a private screen lands on the public Home, not on login', () => {
    const g = createRootGuard();
    const { router, calls } = fakeRouter();
    g.run(snap('/setting', true), router);
    g.run(snap('/setting', false), router);
    expect(calls).toEqual(['replace /home']);
  });

  it('a session that ends while browsing a public screen changes nothing', () => {
    const g = createRootGuard();
    const { router, calls } = fakeRouter();
    const battle = { segments: ['battle', '[id]'], params: { id: 'm1' } };
    g.run(snap('/battle/m1', true, battle), router);
    g.run(snap('/battle/m1', false, battle), router);
    expect(calls).toEqual([]);
  });

  it('the new Follow requests screen is private and fails closed', () => {
    expect(classifyRoute(['notifications', 'requests'])).toBe('private');
    const g = createRootGuard();
    const { router, calls } = fakeRouter();
    g.run(snap('/notifications/requests', false), router);
    expect(calls).toEqual(['replace /auth/login?redirect=%2Fnotifications%2Frequests']);
  });
});
