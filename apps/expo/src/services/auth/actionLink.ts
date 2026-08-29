import {
  verifyPasswordResetCode,
  confirmPasswordReset,
  applyActionCode,
  checkActionCode,
} from 'firebase/auth';
import { auth } from '@/src/services/firebase/initFirebase';

/**
 * Firebase email action links (password reset, email verification, email change).
 *
 * WHY THIS EXISTS
 *
 * The reset email's link was landing on the app's LOGIN screen with no way to set
 * a password. The cause: Firebase's email template action URL points at
 * `tophunt.in`, and when the action URL is customised Firebase stops handling the
 * link itself — it just forwards the browser to that URL with `mode` and
 * `oobCode` in the query and expects the app to complete the flow. The app had no
 * handler for it anywhere (`oobCode` appeared nowhere in the codebase), so
 * expo-router matched nothing and fell through to the welcome/login screen. The
 * mail arrived, the link "worked", and the reset was simply impossible.
 *
 * Nothing in the URL is trusted here beyond being passed back to Firebase: the
 * `oobCode` is verified server-side by `verifyPasswordResetCode` BEFORE any form
 * is shown, so an expired or already-used link says so immediately instead of
 * after the user has typed a new password twice.
 */

export type ActionMode = 'resetPassword' | 'verifyEmail' | 'recoverEmail' | 'unknown';

/**
 * Decide whether the params currently on screen are a Firebase action link that
 * must be taken over by the handler route.
 *
 * MATCHED ON THE PAYLOAD, NOT THE PATH — the same correction the Cloudflare
 * worker needed. The first attempt keyed on `/__/auth/action`, Firebase's default
 * path, and the link still landed on the login screen: the console's action URL
 * can be ANY url on the domain (`https://tophunt.in/`, `/auth/login`, anything),
 * and Firebase just appends its query to whatever is configured. The path belongs
 * to whoever edits the console; `oobCode` plus a known `mode` is the actual
 * contract, and nothing else in this app uses either parameter.
 *
 * This is the net for the cases the worker never sees: a native deep link, and
 * any in-app navigation that carries the params without a server round trip.
 *
 * Returns null when there is nothing to do — including when the handler is
 * already showing, which is what stops this from fighting the worker's redirect.
 */
export function actionLinkRedirect(
  params: { mode?: unknown; oobCode?: unknown },
  alreadyOnHandler: boolean,
): { mode: ActionMode; oobCode: string } | null {
  if (alreadyOnHandler) return null;
  const oobCode = typeof params?.oobCode === 'string' ? params.oobCode : '';
  if (!oobCode) return null;
  const mode = parseMode(typeof params?.mode === 'string' ? params.mode : undefined);
  // An unknown mode with a code is still forwarded: the handler can say the link
  // is unusable, which is strictly better than silently showing the login screen.
  return { mode, oobCode };
}

/** Firebase's own mode strings, normalised. */
export function parseMode(raw?: string | null): ActionMode {
  switch (raw) {
    case 'resetPassword':
      return 'resetPassword';
    case 'verifyEmail':
      return 'verifyEmail';
    case 'recoverEmail':
      return 'recoverEmail';
    default:
      return 'unknown';
  }
}

/**
 * Readable text for the codes an action link can fail with.
 *
 * Every one of these is a dead end that the user can only escape by starting
 * over, so each message says that explicitly. Firebase's raw messages for
 * expired and invalid codes are near-identical and mention neither.
 */
export function messageForActionError(code?: string): string {
  switch (code) {
    case 'auth/expired-action-code':
      return 'This link has expired. Request a new password reset email and use the newest link.';
    case 'auth/invalid-action-code':
      return 'This link is not valid any more. It may already have been used, or a newer email may have replaced it — request a new one.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Please contact support.';
    case 'auth/user-not-found':
      return 'That account no longer exists.';
    case 'auth/weak-password':
      return 'Please choose a stronger password.';
    case 'auth/network-request-failed':
      return 'Could not reach the server. Check your connection and try again.';
    default:
      return 'This link could not be used. Request a new password reset email.';
  }
}

/**
 * Validate a reset code and return the address it belongs to.
 *
 * Showing the email matters: a user with several accounts needs to know which
 * one they are about to change the password for, and it is the only confirmation
 * available that the link belongs to them.
 */
export async function verifyResetCode(oobCode: string): Promise<{ email: string }> {
  const email = await verifyPasswordResetCode(auth, oobCode);
  return { email };
}

/** Set the new password. The code is single-use, so this can only succeed once. */
export async function completePasswordReset(oobCode: string, newPassword: string): Promise<void> {
  await confirmPasswordReset(auth, oobCode, newPassword);
}

/** Apply a verify-email or recover-email code. Returns the affected address. */
export async function applyEmailActionCode(oobCode: string): Promise<{ email: string | null }> {
  // checkActionCode first so we can name the address in the confirmation; it is
  // read-only, unlike applyActionCode which consumes the code.
  let email: string | null = null;
  try {
    const info = await checkActionCode(auth, oobCode);
    email = info?.data?.email ?? null;
  } catch {
    // Non-fatal: applyActionCode below is the operation that matters and will
    // surface a real failure.
  }
  await applyActionCode(auth, oobCode);
  return { email };
}
