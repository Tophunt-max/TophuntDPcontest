import { sendPasswordResetEmail, fetchSignInMethodsForEmail } from 'firebase/auth';
import { auth } from '@/src/services/firebase/initFirebase';

/**
 * Password-reset requests.
 *
 * WHY THIS EXISTS AS ITS OWN MODULE
 *
 * The screen used to swallow `auth/user-not-found` and then tell the user
 * "if that address has a password account, a reset link is on its way",
 * on the stated grounds that account enumeration must not be leaked and that
 * "with email-enumeration protection on, the call succeeds either way and we
 * genuinely do not know".
 *
 * That premise is FALSE for this project. Firebase Email Enumeration Protection
 * is OFF here, which is directly observable against the production project using
 * the API key that ships inside the web bundle:
 *
 *   POST identitytoolkit.googleapis.com/v1/accounts:createAuthUri
 *     -> {"registered": false}
 *   POST identitytoolkit.googleapis.com/v1/accounts:sendOobCode
 *     -> {"error":{"message":"EMAIL_NOT_FOUND"}}
 *
 * So anyone can already enumerate accounts directly, without the app. The UI's
 * silence protected nothing at all — and it cost the one thing that mattered:
 * a user who mistypes their address, or who signed up with Google or a phone
 * number, was sent to an inbox that was never going to receive anything, with no
 * way to find that out. "No email is arriving" was the app refusing to repeat
 * what Firebase had plainly told it.
 *
 * The real fix for the enumeration leak is to enable Email Enumeration
 * Protection in the Firebase console (Authentication -> Settings), which is not
 * something the client can do. This module is written to be CORRECT IN BOTH
 * CONFIGURATIONS:
 *
 *   protection OFF (today) -> Firebase throws user-not-found, we say precisely
 *                             what is wrong and what to do instead.
 *   protection ON          -> Firebase resolves for every address and
 *                             `fetchSignInMethodsForEmail` returns [], so we fall
 *                             back to the cautious wording on its own. Nothing
 *                             here needs changing when that switch is flipped.
 *
 * Sending stays on the CLIENT (Firebase's own mailer). It cannot move to the
 * Worker: the Admin API can only *generate* a reset link, not deliver one, and
 * `/health/deep` reports no email gateway configured. Routing it through the
 * Worker would produce a link nobody could send.
 */

/** Seconds before a resend is allowed, so the button cannot be used to spam. */
export const RESEND_COOLDOWN_SEC = 60;

export type ResetOutcome =
  /** Firebase accepted the request and is sending the mail. */
  | { status: 'sent'; email: string }
  /**
   * The address has no password credential. `providers` is what the account DOES
   * have (empty when unregistered — or when enumeration protection hides it).
   */
  | { status: 'no-password-account'; email: string; providers: string[] };

/**
 * Trim + lowercase. Firebase matches addresses case-insensitively but our own
 * comparisons and the text we echo back to the user should be stable, and a
 * leading space pasted from a password manager must not read as a different
 * address on the confirmation screen.
 */
export function normalizeEmail(raw: string): string {
  return (raw ?? '').trim().toLowerCase();
}

const PROVIDER_LABELS: Record<string, string> = {
  'google.com': 'Google',
  'apple.com': 'Apple',
  'facebook.com': 'Facebook',
  'github.com': 'GitHub',
  'twitter.com': 'X',
  phone: 'your phone number',
  password: 'email and password',
};

/** Human label for a Firebase provider id, falling back to the id itself. */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

/**
 * What to tell someone whose address has no password to reset.
 *
 * The distinction carried here is the whole point of the change: "this address
 * has no account" and "this account exists but signs in with Google" need
 * completely different actions from the user, and both used to render as the same
 * cheerful "check your email".
 */
export function describeNoPasswordAccount(email: string, providers: string[]): string {
  const usable = providers.filter((p) => p && p !== 'password');
  if (usable.length === 0) {
    // Either genuinely unregistered, or enumeration protection is hiding it.
    // Phrased so it is not a false statement in the second case.
    return `We could not find a password login for ${email}. If you signed up with Google, Apple or your phone number, use that method instead — or create a new account.`;
  }
  const labels = usable.map(providerLabel);
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}`;
  return `${email} signs in with ${list}, so there is no password to reset. Sign in with ${list} instead.`;
}

/**
 * Friendly text for the Firebase error codes this flow can realistically hit.
 * Returns null for anything unrecognised, so the caller can fall back to the
 * SDK's own message rather than hiding a cause we did not anticipate.
 *
 * `auth/too-many-requests` is listed first deliberately: it is what a user hits
 * after pressing a button that appeared to do nothing several times, and
 * Firebase's raw message for it is a wall of text ending in a support URL.
 */
export function messageForResetError(code?: string): string | null {
  switch (code) {
    case 'auth/too-many-requests':
      return 'Too many attempts from this device. Please wait a few minutes and try again.';
    case 'auth/invalid-email':
      return 'That email address does not look right. Please check it and try again.';
    case 'auth/network-request-failed':
      return 'Could not reach the server. Check your connection and try again.';
    case 'auth/operation-not-allowed':
      return 'Email sign-in is currently disabled for this app. Please contact support.';
    case 'auth/missing-email':
      return 'Please enter your email address.';
    default:
      return null;
  }
}

/**
 * Ask Firebase to send a reset link.
 *
 * Resolves with an outcome the UI can render truthfully; throws only for causes
 * the user has to act on differently (bad address, rate limit, offline), with
 * `message` already made readable.
 */
export async function requestPasswordReset(rawEmail: string): Promise<ResetOutcome> {
  const email = normalizeEmail(rawEmail);
  if (!email) {
    throw Object.assign(new Error('Please enter your email address.'), { code: 'auth/missing-email' });
  }
  try {
    await sendPasswordResetEmail(auth, email);
    return { status: 'sent', email };
  } catch (e: any) {
    const code = e?.code as string | undefined;
    if (code === 'auth/user-not-found') {
      // Best-effort: which providers DOES this address have? Never let this
      // lookup turn a clear answer into a crash — an empty list still produces a
      // usable message.
      let providers: string[] = [];
      try {
        providers = await fetchSignInMethodsForEmail(auth, email);
      } catch {
        providers = [];
      }
      return { status: 'no-password-account', email, providers };
    }
    const friendly = messageForResetError(code);
    if (friendly) throw Object.assign(new Error(friendly), { code });
    throw e;
  }
}
