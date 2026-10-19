/**
 * Human messages for sign-in failures.
 *
 * Firebase errors stringify as "Firebase: Error (auth/internal-error)." — which
 * is what users were shown, and which tells them nothing. Our own Worker errors
 * already carry a readable message, so those pass through unchanged.
 */

/** Errors that mean "the user closed the sheet" — never shown, never reported. */
export function isAuthCancellation(error: any): boolean {
  const code = String(error?.code || '');
  return (
    error?.message === 'cancelled' ||
    code === 'auth/popup-closed-by-user' ||
    code === 'auth/cancelled-popup-request' ||
    code === 'auth/user-cancelled' ||
    code === 'ERR_REQUEST_CANCELED' ||
    code === 'ERR_CANCELED'
  );
}

const MESSAGES: Record<string, string> = {
  'auth/popup-blocked': 'Browser ne login popup block kar diya. Popup allow karo aur dobara try karo.',
  'auth/network-request-failed': 'Internet connection check karo aur dobara try karo.',
  'auth/too-many-requests': 'Bahut zyada koshishein ho gayi. Thodi der baad try karo.',
  'auth/user-disabled': 'Ye account band kar diya gaya hai. Support se contact karo.',
  'auth/account-exists-with-different-credential':
    'Is email se account pehle se kisi aur tarike (jaise email/password ya Google) se bana hai. Usi tarike se login karo.',
  'auth/credential-already-in-use': 'Ye account pehle se kisi aur TopHunt account se juda hai.',
  'auth/email-already-in-use': 'Ye email pehle se registered hai. Sign in karo.',
  'auth/invalid-credential': 'Email ya password galat hai.',
  'auth/wrong-password': 'Email ya password galat hai.',
  'auth/invalid-login-credentials': 'Email ya password galat hai.',
  'auth/user-not-found': 'Is email se koi account nahi mila.',
  'auth/invalid-email': 'Email sahi nahi hai.',
  'auth/weak-password': 'Password kamzor hai — kam se kam 8 characters, ek capital letter, number aur symbol.',
  'auth/operation-not-allowed': 'Ye login tarika abhi available nahi hai. Koi aur tarika use karo.',
  'auth/unauthorized-domain': 'Is website se ye login abhi available nahi hai. tophunt.in par try karo.',
  'auth/web-storage-unsupported':
    'Browser ki cookies/storage band hai. Private mode band karo ya Chrome mein kholo.',
  'auth/internal-error':
    'Login abhi complete nahi ho paya. Page refresh karke dobara try karo, ya Chrome/Safari mein kholo.',
  'auth/timeout': 'Login mein bahut time lag gaya. Dobara try karo.',
};

/**
 * The message to show for a sign-in failure. `fallback` is used when nothing
 * more specific is known.
 */
export function friendlyAuthError(error: any, fallback = 'Login nahi ho paya. Dobara try karo.'): string {
  const code = String(error?.code || '');
  if (MESSAGES[code]) return MESSAGES[code];
  const msg = typeof error?.message === 'string' ? error.message.trim() : '';
  // A raw Firebase string is never shown as-is.
  if (!msg || /^Firebase:/i.test(msg) || /\(auth\/[a-z-]+\)/i.test(msg)) {
    const embedded = msg.match(/\((auth\/[a-z-]+)\)/i)?.[1];
    if (embedded && MESSAGES[embedded]) return MESSAGES[embedded];
    return fallback;
  }
  return msg;
}
