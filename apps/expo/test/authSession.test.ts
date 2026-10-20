import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  currentUser: null as any,
  next: null as null | ((user: any) => void),
  fail: null as null | ((error: Error) => void),
  subscriptions: 0,
  unsubscriptions: 0,
}));

vi.mock('../src/services/firebase/initFirebase', () => ({
  auth: {
    get currentUser() {
      return h.currentUser;
    },
  },
}));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: any, next: (user: any) => void, fail: (error: Error) => void) => {
    h.subscriptions += 1;
    h.next = next;
    h.fail = fail;
    return () => {
      h.unsubscriptions += 1;
    };
  },
}));

let current: any;
async function fresh() {
  current?.__disposeAuthSessionForTests?.();
  vi.resetModules();
  h.currentUser = null;
  h.next = null;
  h.fail = null;
  h.subscriptions = 0;
  h.unsubscriptions = 0;
  current = await import('../src/services/authSession');
  return current;
}

describe('one app-wide auth observer', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => {
    current?.__disposeAuthSessionForTests?.();
    current = null;
    vi.useRealTimers();
  });

  it('starts restoring, then publishes the persisted user to every subscriber', async () => {
    const s = await fresh();
    const seen: string[] = [];
    const offA = s.subscribeAuthSession(() => seen.push(`a:${s.getAuthSessionSnapshot().status}`));
    const offB = s.subscribeAuthSession(() => seen.push(`b:${s.getAuthSessionSnapshot().status}`));
    expect(h.subscriptions).toBe(1);
    expect(s.getAuthSessionSnapshot().status).toBe('restoring');

    h.next?.({ uid: 'saved-user' });
    expect(s.getAuthSessionSnapshot()).toMatchObject({ status: 'authenticated', user: { uid: 'saved-user' } });
    expect(seen).toEqual(['a:authenticated', 'b:authenticated']);
    offA();
    offB();
  });

  it('becomes guest only after the observer emits null', async () => {
    const s = await fresh();
    expect(s.getAuthSessionSnapshot().status).toBe('restoring');
    h.next?.(null);
    expect(s.getAuthSessionSnapshot()).toMatchObject({ status: 'guest', user: null });
  });

  it('an observer error is recoverable and never masquerades as guest', async () => {
    const s = await fresh();
    h.fail?.(new Error('indexeddb unavailable'));
    expect(s.getAuthSessionSnapshot()).toMatchObject({ status: 'error', user: null });
    s.retryAuthSession();
    expect(h.unsubscriptions).toBe(1);
    expect(h.subscriptions).toBe(2);
    expect(s.getAuthSessionSnapshot().status).toBe('restoring');
  });

  it('watchdog offers recovery without clearing or declaring the account guest', async () => {
    vi.useFakeTimers();
    const s = await fresh();
    await vi.advanceTimersByTimeAsync(s.__AUTH_RESTORE_WATCHDOG_MS);
    expect(s.getAuthSessionSnapshot().status).toBe('error');
    expect(s.getAuthSessionSnapshot().error?.message).toMatch(/not cleared/);
  });

  it('explicit Continue as guest keeps the observer alive for a later sign-in', async () => {
    const s = await fresh();
    s.continueAuthSessionAsGuest();
    expect(s.getAuthSessionSnapshot().status).toBe('guest');
    expect(h.unsubscriptions).toBe(0);
    h.next?.({ uid: 'new-login' });
    expect(s.getAuthSessionSnapshot()).toMatchObject({ status: 'authenticated', user: { uid: 'new-login' } });
  });
});
