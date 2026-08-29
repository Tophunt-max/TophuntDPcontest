import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  type User,
} from 'firebase/auth';
import { auth } from '@/src/services/firebase/initFirebase';
import { validatePassword } from '@/src/lib/passwordPolicy';
import { providerLabel } from './passwordReset';

/**
 * Changing the password of an ALREADY SIGNED-IN user.
 *
 * This is deliberately separate from `passwordReset.ts`, which handles the
 * signed-OUT case by emailing a link. The two are not interchangeable and the app
 * previously had only the second one, so a logged-in user who simply wanted a new
 * password had to log themselves out and pretend to have forgotten it.
 *
 * The other existing path, `updatePasswordWithPhone` (see
 * `app/auth/forgot-password/reset`), is a phone-OTP reset: it is keyed on a phone
 * number and never asks for the current password, so it cannot serve this flow
 * either.
 *
 * ## Why the current password is required
 *
 * Firebase treats a password change as a security-sensitive operation and will
 * reject it with `auth/requires-recent-login` when the session is old. Asking for
 * the current password lets us reauthenticate inline and succeed regardless of
 * session age — otherwise the feature would work only for the first few minutes
 * after signing in and throw an unexplainable error after that.
 *
 * It is also the check that makes the feature safe: without it, anyone holding an
 * unlocked phone could lock the real owner out of their own account, and this app
 * holds a coin balance.
 */

/** Firebase provider ids on the account, e.g. `['password', 'google.com']`. */
export function providerIdsFor(user: User | null | undefined): string[] {
  return (user?.providerData ?? []).map((p) => p?.providerId).filter(Boolean) as string[];
}

/**
 * Does this account have a password at all?
 *
 * Someone who only ever tapped "Continue with Google" has no password, so there
 * is nothing to change — offering the form anyway would fail at the
 * reauthenticate step with a confusing credential error. The Settings row is
 * hidden for these accounts and this screen explains why if reached directly.
 */
export function hasPasswordProvider(user: User | null | undefined): boolean {
  return providerIdsFor(user).includes('password');
}

/**
 * How this account actually signs in, for the copy shown to a user with no
 * password. Mirrors `describeNoPasswordAccount` but for the signed-in case, where
 * we know the providers for certain rather than having to hedge.
 */
export function describePasswordlessAccount(user: User | null | undefined): string {
  const labels = providerIdsFor(user)
    .filter((id) => id !== 'password')
    .map(providerLabel);

  if (labels.length === 0) {
    return 'This account does not sign in with a password, so there is nothing to change here.';
  }
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
  return `You sign in with ${list}, so this account has no password to change. Your password is managed by ${list}.`;
}

/**
 * Readable text for the codes this flow can actually produce.
 *
 * Kept separate from `messageForResetError` because the overlap is small and the
 * same code means something different here: `auth/too-many-requests` during a
 * reset means "you asked for too many emails", while during a change it means
 * "you got the current password wrong repeatedly".
 *
 * `auth/invalid-credential` is grouped with `auth/wrong-password` on purpose —
 * newer Identity Platform backends return the former where the older one returned
 * the latter, and to the user they are the same mistake.
 */
export function messageForChangePasswordError(code?: string): string | null {
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/invalid-login-credentials':
      return 'That current password is not right. Please try again.';
    case 'auth/too-many-requests':
      return 'Too many incorrect attempts. Please wait a few minutes and try again.';
    case 'auth/weak-password':
      return 'That new password is too weak. Please choose a stronger one.';
    case 'auth/requires-recent-login':
      // Reauthentication is part of this flow, so this should be unreachable —
      // if it happens the session is broken in a way a retry will not fix.
      return 'For your security, please log out and sign in again before changing your password.';
    case 'auth/network-request-failed':
      return 'Could not reach the server. Check your connection and try again.';
    case 'auth/user-mismatch':
    case 'auth/user-not-found':
      return 'This session no longer matches your account. Please sign in again.';
    default:
      return null;
  }
}

export class ChangePasswordError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'ChangePasswordError';
    this.code = code;
  }
}

/**
 * Reauthenticate, then set the new password.
 *
 * Throws `ChangePasswordError` with a message already fit to show the user.
 * Callers do not need to interpret Firebase codes.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = auth.currentUser;
  if (!user) {
    throw new ChangePasswordError('You are not signed in. Please sign in and try again.');
  }
  if (!user.email) {
    // Reauthentication below is via an email credential, so an account with no
    // email address cannot use this path even if it somehow has a password.
    throw new ChangePasswordError(
      'This account has no email address, so the password cannot be changed here.',
    );
  }
  if (!hasPasswordProvider(user)) {
    throw new ChangePasswordError(describePasswordlessAccount(user));
  }

  // Enforce our own policy before spending a network round trip, and because
  // Firebase's own rule is only 6 characters — looser than ours, so relying on it
  // would let this screen set a password our signup would have refused.
  const policyError = validatePassword(newPassword);
  if (policyError) throw new ChangePasswordError(policyError);

  if (currentPassword === newPassword) {
    throw new ChangePasswordError('That is already your password. Please choose a different one.');
  }

  try {
    const credential = EmailAuthProvider.credential(user.email, currentPassword);
    await reauthenticateWithCredential(user, credential);
  } catch (e: any) {
    throw new ChangePasswordError(
      messageForChangePasswordError(e?.code) || e?.message || 'Could not verify your current password.',
      e?.code,
    );
  }

  try {
    await updatePassword(user, newPassword);
  } catch (e: any) {
    throw new ChangePasswordError(
      messageForChangePasswordError(e?.code) || e?.message || 'Could not update your password.',
      e?.code,
    );
  }
}
