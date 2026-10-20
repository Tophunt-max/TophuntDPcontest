import { describe, expect, it } from 'vitest';
import { authFlags, type AuthSnapshot } from '../src/lib/authState';

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
