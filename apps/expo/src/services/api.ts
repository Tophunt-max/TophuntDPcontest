import { AppState } from 'react-native';
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
// The Worker base URL MUST be provided via EXPO_PUBLIC_API_URL (set per
// environment in eas.json / .env). We keep a last-resort fallback so the app
// never fetches an undefined URL, but warn loudly in development when the env
// var is missing so staging/dev builds don't silently hit production.
const FALLBACK_API_URL = 'https://tophunt-api.weadown-in.workers.dev';

if (!process.env.EXPO_PUBLIC_API_URL && __DEV__) {
  console.warn(
    '[api] EXPO_PUBLIC_API_URL is not set — falling back to the production Worker URL. ' +
      'Set EXPO_PUBLIC_API_URL in your .env / EAS env to target the right backend.',
  );
}

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || FALLBACK_API_URL;

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
 * Like `readApi` but also returns the `X-Next-Cursor` pagination header, so
 * callers can implement cursor-based infinite scroll. The Worker exposes this
 * header via CORS and sets it only when a further page exists (null = end).
 */
export const readApiWithCursor = async <T = any>(
  path: string,
  params?: Record<string, any>,
): Promise<{ data: T; nextCursor: string | null }> => {
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
  return { data: json as T, nextCursor: res.headers.get('X-Next-Cursor') };
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
    // Skip network while the app is backgrounded — saves Worker requests + D1
    // reads for idle users. We still reschedule so it resumes on foreground.
    if (AppState.currentState !== 'active') {
      timer = setTimeout(tick, intervalMs);
      return;
    }
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
