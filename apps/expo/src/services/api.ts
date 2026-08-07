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
export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_URL || 'https://tophunt-api.weadown-in.workers.dev';

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

/** GET a /read endpoint on the Worker, attaching the ID token if present. */
export const readApi = async (path: string, params?: Record<string, any>) => {
  const url = new URL(`${API_BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {};
  const currentUser = auth.currentUser;
  if (currentUser) {
    try {
      headers['Authorization'] = `Bearer ${await currentUser.getIdToken()}`;
    } catch {
      /* proceed without token */
    }
  }
  const res = await fetch(url.toString(), { headers });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const status = (json?.error?.status || 'INTERNAL').toLowerCase().replace(/_/g, '-');
    throw new ApiCallError(`functions/${status}`, json?.error?.message || 'Request failed');
  }
  return json;
};

/**
 * Realtime-by-polling. Replaces Firestore onSnapshot: repeatedly calls `fetcher`
 * and invokes `callback` with the result. Returns an unsubscribe function with
 * the same ergonomics as a Firestore listener.
 */
export const poll = <T>(
  fetcher: () => Promise<T>,
  callback: (data: T) => void,
  intervalMs = 5000,
): (() => void) => {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = async () => {
    if (!active) return;
    try {
      const data = await fetcher();
      if (active) callback(data);
    } catch (e) {
      console.warn('[poll] fetch failed', e);
    } finally {
      if (active) timer = setTimeout(tick, intervalMs);
    }
  };
  tick();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
};

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
