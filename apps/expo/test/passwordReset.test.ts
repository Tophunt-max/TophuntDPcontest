/**
 * Password-reset request handling.
 *
 * The bug these pin: the screen used to swallow `auth/user-not-found` and then
 * tell the user a link was on its way. Firebase had explicitly said the account
 * did not exist — the app threw that away and sent the user to an inbox that was
 * never going to receive anything. "Forgot password email nahi aa raha" was the
 * app declining to repeat what it had been told.
 *
 * The suppression was justified as anti-enumeration, but Email Enumeration
 * Protection is OFF on this project (verified against production:
 * `accounts:createAuthUri` returns `registered:false` and `sendOobCode` returns
 * `EMAIL_NOT_FOUND` for the API key shipped in the bundle), so the silence
 * protected nothing.
 *
 * The property that matters most below is the LAST block: this has to stay
 * correct if enumeration protection is later switched on in the console, because
 * nobody will remember to come back and change the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sendPasswordResetEmail = vi.fn(async () => {});
const fetchSignInMethodsForEmail = vi.fn(async () => [] as string[]);

vi.mock('firebase/auth', () => ({
  sendPasswordResetEmail: (...a: any[]) => (sendPasswordResetEmail as any)(...a),
  fetchSignInMethodsForEmail: (...a: any[]) => (fetchSignInMethodsForEmail as any)(...a),
}));
vi.mock('@/src/services/firebase/initFirebase', () => ({ auth: { __fake: true } }));

const authError = (code: string) => Object.assign(new Error(`firebase raw text for ${code}`), { code });

beforeEach(() => {
  sendPasswordResetEmail.mockReset().mockResolvedValue(undefined as any);
  fetchSignInMethodsForEmail.mockReset().mockResolvedValue([]);
});

describe('requestPasswordReset', () => {
  it('reports "sent" when Firebase accepts, echoing the normalised address', async () => {
    const { requestPasswordReset } = await import('@/src/services/auth/passwordReset');

    const out = await requestPasswordReset('  User@Example.COM ');

    expect(out).toEqual({ status: 'sent', email: 'user@example.com' });
    // The normalised address is what gets sent, so what the confirmation screen
    // displays is exactly what Firebase was given.
    expect(sendPasswordResetEmail).toHaveBeenCalledWith({ __fake: true }, 'user@example.com');
  });

  it('does NOT report "sent" when Firebase says the account does not exist', async () => {
    sendPasswordResetEmail.mockRejectedValueOnce(authError('auth/user-not-found'));
    const { requestPasswordReset } = await import('@/src/services/auth/passwordReset');

    const out = await requestPasswordReset('ghost@example.com');

    expect(out.status).toBe('no-password-account');
  });

  it('looks up which providers the address does have', async () => {
    sendPasswordResetEmail.mockRejectedValueOnce(authError('auth/user-not-found'));
    fetchSignInMethodsForEmail.mockResolvedValueOnce(['google.com']);
    const { requestPasswordReset } = await import('@/src/services/auth/passwordReset');

    const out = await requestPasswordReset('g@example.com');

    expect(out).toEqual({ status: 'no-password-account', email: 'g@example.com', providers: ['google.com'] });
  });

  it('still answers when the provider lookup itself fails', async () => {
    // A failed diagnostic must not downgrade a clear answer into an exception.
    sendPasswordResetEmail.mockRejectedValueOnce(authError('auth/user-not-found'));
    fetchSignInMethodsForEmail.mockRejectedValueOnce(new Error('offline'));
    const { requestPasswordReset } = await import('@/src/services/auth/passwordReset');

    const out = await requestPasswordReset('g@example.com');

    expect(out).toEqual({ status: 'no-password-account', email: 'g@example.com', providers: [] });
  });

  it('rejects an empty address without calling Firebase', async () => {
    const { requestPasswordReset } = await import('@/src/services/auth/passwordReset');
    await expect(requestPasswordReset('   ')).rejects.toThrow(/enter your email/i);
    expect(sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('replaces Firebase raw text for the causes a user must act on', async () => {
    const { requestPasswordReset } = await import('@/src/services/auth/passwordReset');

    for (const [code, expected] of [
      ['auth/too-many-requests', /too many attempts/i],
      ['auth/invalid-email', /does not look right/i],
      ['auth/network-request-failed', /could not reach the server/i],
      ['auth/operation-not-allowed', /disabled/i],
    ] as [string, RegExp][]) {
      sendPasswordResetEmail.mockRejectedValueOnce(authError(code));
      await expect(requestPasswordReset('a@b.com')).rejects.toThrow(expected);
    }
  });

  it('passes an unrecognised error through untouched rather than hiding it', async () => {
    sendPasswordResetEmail.mockRejectedValueOnce(authError('auth/internal-error'));
    const { requestPasswordReset } = await import('@/src/services/auth/passwordReset');
    await expect(requestPasswordReset('a@b.com')).rejects.toThrow(/firebase raw text/);
  });
});

describe('describeNoPasswordAccount', () => {
  it('names the provider the account actually uses', async () => {
    const { describeNoPasswordAccount } = await import('@/src/services/auth/passwordReset');
    const msg = describeNoPasswordAccount('a@b.com', ['google.com']);
    expect(msg).toContain('a@b.com');
    expect(msg).toContain('Google');
    expect(msg).toMatch(/no password to reset/i);
  });

  it('lists several providers readably', async () => {
    const { describeNoPasswordAccount } = await import('@/src/services/auth/passwordReset');
    const msg = describeNoPasswordAccount('a@b.com', ['google.com', 'apple.com', 'phone']);
    expect(msg).toContain('Google, Apple or your phone number');
  });

  it('ignores a stray "password" entry, which would make the advice nonsense', async () => {
    const { describeNoPasswordAccount } = await import('@/src/services/auth/passwordReset');
    // "signs in with email and password, so there is no password to reset" would
    // be self-contradicting.
    const msg = describeNoPasswordAccount('a@b.com', ['password']);
    expect(msg).toMatch(/could not find a password login/i);
  });

  it('stays truthful when no providers are known', async () => {
    const { describeNoPasswordAccount } = await import('@/src/services/auth/passwordReset');
    const msg = describeNoPasswordAccount('a@b.com', []);
    // Must not assert the account is absent — the list is also empty when
    // enumeration protection hides it.
    expect(msg).toMatch(/could not find a password login/i);
    expect(msg).not.toMatch(/does not exist/i);
  });
});

describe('with Email Enumeration Protection enabled in the console', () => {
  it('degrades to a plain "sent" without any code change', async () => {
    // That setting makes Firebase resolve for every address, so the
    // no-password-account branch simply stops being reachable and the flow
    // becomes the cautious one that protection is designed to produce.
    sendPasswordResetEmail.mockResolvedValueOnce(undefined as any);
    const { requestPasswordReset } = await import('@/src/services/auth/passwordReset');

    const out = await requestPasswordReset('anything@example.com');

    expect(out.status).toBe('sent');
    expect(fetchSignInMethodsForEmail).not.toHaveBeenCalled();
  });
});
