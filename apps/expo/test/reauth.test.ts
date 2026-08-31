/**
 * Client side of "confirm it's you".
 *
 * The interesting logic here is not the UI — it is the two decisions the client
 * makes on the user's behalf, and both have a failure mode that is invisible in
 * manual testing:
 *
 *  1. Recognising the server's refusal. It arrives as `failed-precondition`, NOT
 *     401, on purpose: a 401 is handled globally as an expired session and would
 *     sign the user out mid-flow. If the client mistook one for the other, "confirm
 *     it's you" would become a logout.
 *
 *  2. Choosing the proof. An account with a password re-enters it (stronger,
 *     instant, no SMS cost); an account without one gets a code. Showing a password
 *     field to a user who has only ever tapped "Continue with Google" is a dead
 *     end they cannot escape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { calls, authState } = vi.hoisted(() => ({
  calls: [] as { action: string; data: any }[],
  authState: { currentUser: null as any },
}));

vi.mock('@/src/services/api', () => ({
  callApi: async (action: string, data: any = {}) => {
    calls.push({ action, data });
    if (action === 'sendReauthOtp') {
      return { success: true, method: 'email', sentTo: 'al***@example.com', cooldownSeconds: 60 };
    }
    return { success: true };
  },
}));

vi.mock('@/src/services/firebase/initFirebase', () => ({
  get auth() {
    return authState;
  },
}));

const { reauthCalls } = vi.hoisted(() => ({ reauthCalls: [] as string[] }));

vi.mock('firebase/auth', () => ({
  EmailAuthProvider: { credential: (email: string, password: string) => ({ email, password }) },
  reauthenticateWithCredential: async (_user: any, cred: any) => {
    if (cred.password !== 'correct-horse') {
      const err: any = new Error('wrong');
      err.code = 'auth/wrong-password';
      throw err;
    }
    reauthCalls.push('reauthenticated');
  },
  updatePassword: async () => undefined,
}));

import {
  beginReauth,
  completeReauthWithOtp,
  completeReauthWithPassword,
  isReauthRequired,
} from '@/src/services/auth/reauth';

beforeEach(() => {
  calls.length = 0;
  reauthCalls.length = 0;
  authState.currentUser = null;
});

const passwordUser = () => ({
  email: 'alice@example.com',
  providerData: [{ providerId: 'password' }],
  getIdToken: async (force?: boolean) => {
    if (force) reauthCalls.push('token-refreshed');
    return 'token';
  },
});

const googleUser = () => ({
  email: 'alice@example.com',
  providerData: [{ providerId: 'google.com' }],
  getIdToken: async () => 'token',
});

describe('recognising the server refusal', () => {
  it('detects the re-auth marker', () => {
    expect(
      isReauthRequired({
        code: 'functions/failed-precondition',
        message: "reauth_required: For your security, please confirm it's you before continuing.",
      }),
    ).toBe(true);
  });

  /**
   * An expired session and a stale session are different problems with opposite
   * remedies — sign in again versus confirm and continue. Conflating them would
   * sign the user out of a flow they were halfway through.
   */
  it('does not mistake an expired session for a re-auth prompt', () => {
    expect(
      isReauthRequired({
        code: 'functions/unauthenticated',
        message: 'Your session expired. Please sign in again.',
      }),
    ).toBe(false);
  });

  it('does not fire on unrelated failures', () => {
    for (const e of [
      null,
      undefined,
      {},
      { code: 'functions/invalid-argument', message: 'Enter a valid email address.' },
      { code: 'functions/resource-exhausted', message: 'Too many requests. Please slow down.' },
      { code: 'functions/already-exists', message: 'Email is already in use.' },
    ]) {
      expect(isReauthRequired(e), JSON.stringify(e)).toBe(false);
    }
  });
});

describe('choosing how to re-verify', () => {
  /** Stronger factor, instant, and it costs us no SMS. */
  it('prefers the password when the account has one, and sends nothing', async () => {
    authState.currentUser = passwordUser();

    const plan = await beginReauth();

    expect(plan.kind).toBe('password');
    expect(calls).toEqual([]);
  });

  /**
   * Phone-only, Google-only and Apple-only accounts have no password. Without this
   * fallback the gate would be unsatisfiable for them — which for deletion means
   * the store-compliance dead end the whole deletion flow exists to avoid.
   */
  it('falls back to a code for an account with no password', async () => {
    authState.currentUser = googleUser();

    const plan = await beginReauth();

    expect(plan.kind).toBe('otp');
    expect(plan.method).toBe('email');
    expect(plan.sentTo).toBe('al***@example.com');
    expect(calls.map((c) => c.action)).toEqual(['sendReauthOtp']);
  });

  it('does not offer the password path to a password account with no email', async () => {
    authState.currentUser = { ...passwordUser(), email: null };
    const plan = await beginReauth();
    expect(plan.kind).toBe('otp');
  });

  it('refuses to start when nobody is signed in', async () => {
    await expect(beginReauth()).rejects.toThrow(/not signed in/i);
  });
});

describe('completing the password path', () => {
  /**
   * Reauthenticating moves `auth_time`, but the ID token has to be REFRESHED for
   * the next request to carry the new claim. Forgetting that refresh is the subtle
   * break: the local session is fresh, the server still sees the old token, and the
   * user is asked to confirm again forever.
   */
  it('reauthenticates and then force-refreshes the token', async () => {
    authState.currentUser = passwordUser();

    await completeReauthWithPassword('correct-horse');

    expect(reauthCalls).toEqual(['reauthenticated', 'token-refreshed']);
  });

  it('surfaces a readable message for a wrong password', async () => {
    authState.currentUser = passwordUser();

    await expect(completeReauthWithPassword('nope')).rejects.toThrow(
      /current password is not right/i,
    );
    // And no token refresh happened, so the server still sees a stale session.
    expect(reauthCalls).toEqual([]);
  });
});

describe('completing the OTP path', () => {
  it('sends the code to the server, which holds the grant', async () => {
    authState.currentUser = googleUser();

    await completeReauthWithOtp('123456');

    expect(calls).toEqual([{ action: 'verifyReauthOtp', data: { otp: '123456' } }]);
  });
});
