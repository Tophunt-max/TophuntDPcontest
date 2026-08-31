import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  type User,
} from 'firebase/auth';
import { auth } from '@/src/services/firebase/initFirebase';
import { callApi } from '@/src/services/api';
import { hasPasswordProvider, messageForChangePasswordError } from './changePassword';

/**
 * "Confirm it's you" before an irreversible or credential-level action.
 *
 * Deleting the account, and changing the email or phone number it signs in with,
 * are now gated server-side on a RECENT sign-in. Before that gate, the practical
 * requirement for taking over an account was a session of any age — a stolen ID
 * token, a phone left unlocked, an account left signed in on a shared device.
 *
 * The server accepts either of two proofs, and this module exists to pick the
 * better one:
 *
 *  1. A FRESH FIREBASE SESSION. Firebase's own `reauthenticateWithCredential`
 *     re-checks the password locally and moves the token's `auth_time`, which the
 *     server reads. This is the stronger factor — an attacker holding the phone
 *     still does not know the password — and it costs us no SMS. Only possible
 *     when the account HAS a password.
 *
 *  2. A SERVER OTP CHALLENGE, sent to the email or phone already on the account.
 *     The fallback for phone-only, Google-only and Apple-only accounts, which are
 *     a large share of the user base. Without it the gate would be unsatisfiable
 *     for them, which would mean either locking them out of deleting their own
 *     account — the store-compliance hole the deletion work closed — or exempting
 *     them, which is a gate with a hole in it.
 *
 * Callers do not choose. They call `beginReauth()`, and get told which of the two
 * to collect from the user.
 */

/** The server marks a refusal with this token in the message. */
const REAUTH_REQUIRED_CODE = 'reauth_required';

/** Does this error mean "prove it's you and try again"? */
export function isReauthRequired(error: unknown): boolean {
  const e = error as { message?: string; code?: string } | null;
  if (!e) return false;
  return (
    typeof e.message === 'string' &&
    e.message.includes(REAUTH_REQUIRED_CODE) &&
    // `failed-precondition` is deliberately not 401: a 401 is handled globally as
    // an expired session and would sign the user out mid-flow.
    (e.code === undefined || e.code.includes('failed-precondition'))
  );
}

export type ReauthKind = 'password' | 'otp';

export interface ReauthPlan {
  kind: ReauthKind;
  /** For `otp`: where the code went, masked. */
  sentTo?: string;
  /** For `otp`: which identifier was used. */
  method?: 'email' | 'phone';
  /** For `otp`: seconds before another code may be requested. */
  cooldownSeconds?: number;
}

function currentUser(): User {
  const user = auth.currentUser;
  if (!user) throw new Error('You are not signed in. Please sign in and try again.');
  return user;
}

/**
 * Work out how this user should re-verify, and start it.
 *
 * For the OTP path this SENDS the code, so the caller can go straight to
 * collecting it. For the password path nothing is sent — there is nothing to send.
 */
export async function beginReauth(): Promise<ReauthPlan> {
  const user = currentUser();

  // Prefer the password: stronger, instant, and free.
  if (hasPasswordProvider(user) && user.email) {
    return { kind: 'password' };
  }

  const res: any = await callApi('sendReauthOtp');
  return {
    kind: 'otp',
    sentTo: res?.sentTo,
    method: res?.method,
    cooldownSeconds: Number(res?.cooldownSeconds) || 60,
  };
}

/** Re-send an OTP challenge (the password path has nothing to resend). */
export async function resendReauthOtp(): Promise<ReauthPlan> {
  const res: any = await callApi('sendReauthOtp');
  return {
    kind: 'otp',
    sentTo: res?.sentTo,
    method: res?.method,
    cooldownSeconds: Number(res?.cooldownSeconds) || 60,
  };
}

/**
 * Complete the password path.
 *
 * Reauthenticating through the Firebase SDK is what moves `auth_time`; the ID
 * token then has to be refreshed so the NEXT request actually carries the new
 * claim. Skipping that refresh is the subtle way this breaks — the local session
 * is fresh, the server still sees the old token, and the user is asked to confirm
 * again in a loop.
 */
export async function completeReauthWithPassword(password: string): Promise<void> {
  const user = currentUser();
  if (!user.email) {
    throw new Error('This account has no email address, so it cannot be verified this way.');
  }
  try {
    const credential = EmailAuthProvider.credential(user.email, password);
    await reauthenticateWithCredential(user, credential);
    await user.getIdToken(true);
  } catch (e: any) {
    throw new Error(
      messageForChangePasswordError(e?.code) || e?.message || 'Could not verify your password.',
    );
  }
}

/** Complete the OTP path. The server holds the resulting grant. */
export async function completeReauthWithOtp(otp: string): Promise<void> {
  await callApi('verifyReauthOtp', { otp });
}
