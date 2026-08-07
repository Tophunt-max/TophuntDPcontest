import { auth } from './firebase/initFirebase';

/**
 * Central API caller — now targets the Cloudflare Worker backend instead of
 * Firebase callable functions. Firebase Auth is still the source of truth: we
 * attach the current user's ID token as a Bearer token and the Worker verifies
 * it on the edge.
 *
 * Set EXPO_PUBLIC_API_URL to the deployed Worker URL
 * (e.g. https://tophunt-api.<subdomain>.workers.dev).
 */
const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://tophunt-api.workers.dev';

// Actions handled by the /auth route (was the `authHandler` callable).
const AUTH_ACTIONS = new Set([
  'check',
  'create',
  'createProfile',
  'getUserByIdentifier',
  'sendOtpToPhone',
  'verifyOtp',
  'updatePasswordWithPhone',
  'sendEmailOtp',
  'verifyEmailOtp',
  'sendPhoneOtp',
  'verifyPhoneOtp',
]);

/** Error shaped like a Firebase callable error so existing catch blocks work. */
class ApiCallError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const callApi = async (action: string, data: any = {}) => {
  const path = AUTH_ACTIONS.has(action) ? '/auth' : '/api';

  // Attach the Firebase ID token when the user is signed in. Auth actions like
  // `check`/`create` run pre-login and are allowed without a token.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const currentUser = auth.currentUser;
  if (currentUser) {
    try {
      headers['Authorization'] = `Bearer ${await currentUser.getIdToken()}`;
    } catch {
      /* proceed without token */
    }
  }

  try {
    const res = await fetch(`${API_BASE_URL}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, ...data }),
    });

    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      const status = (json?.error?.status || 'INTERNAL').toLowerCase().replace(/_/g, '-');
      throw new ApiCallError(`functions/${status}`, json?.error?.message || 'Request failed');
    }
    return json;
  } catch (error: any) {
    console.error(`[API Error] Path: ${path}, Action: ${action}`, error);
    throw error;
  }
};
