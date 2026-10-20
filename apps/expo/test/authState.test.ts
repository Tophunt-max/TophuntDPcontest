import { describe, expect, it } from 'vitest';
import { accountShellFlags, authFlags, cachedValueForUid, type AuthSnapshot } from '../src/lib/authState';

const snap = (status: AuthSnapshot['status'], user: any = null): AuthSnapshot => ({ status, user, error: null });

describe('auth startup state model', () => {
  it('never treats a restoring persisted session as guest', () => {
    expect(authFlags(snap('restoring'))).toEqual({
      loading: true,
      ready: false,
      signedIn: false,
      isGuest: false,
      failed: false,
    });
  });

  it('declares guest only after Firebase has confirmed no user', () => {
    expect(authFlags(snap('guest'))).toMatchObject({ loading: false, ready: true, signedIn: false, isGuest: true });
  });

  it('declares authenticated only with an authenticated snapshot and user', () => {
    expect(authFlags(snap('authenticated', { uid: 'u1' }))).toMatchObject({ ready: true, signedIn: true, isGuest: false });
    // Defensive malformed state: no user must never unlock authenticated actions.
    expect(authFlags(snap('authenticated'))).toMatchObject({ signedIn: false, isGuest: false });
  });

  it('does not downgrade a restoration error to guest', () => {
    expect(authFlags(snap('error'))).toEqual({
      loading: false,
      ready: false,
      signedIn: false,
      isGuest: false,
      failed: true,
    });
  });
});


describe('authenticated account shell transitions', () => {
  it('never exposes account A cached identity during an A → B or A → guest commit', () => {
    const a = { uid: 'a', name: 'Alice' };
    expect(cachedValueForUid('a', a)).toBe(a);
    expect(cachedValueForUid('b', a)).toBeNull();
    expect(cachedValueForUid(null, a)).toBeNull();
  });

  it('keeps wallet balance loading independent from cached public identity', () => {
    expect(accountShellFlags('authenticated', true, false)).toEqual({
      avatarLoading: false,
      balanceLoading: true,
      showGuestUi: false,
    });
    expect(accountShellFlags('authenticated', true, true)).toEqual({
      avatarLoading: false,
      balanceLoading: false,
      showGuestUi: false,
    });
  });

  it('never shows guest UI while restoring/error, only after confirmed guest', () => {
    expect(accountShellFlags('restoring', false, false).showGuestUi).toBe(false);
    expect(accountShellFlags('error', false, false).showGuestUi).toBe(false);
    expect(accountShellFlags('guest', false, false).showGuestUi).toBe(true);
  });
});