import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { signOut } from 'firebase/auth';
import { auth } from './firebase/initFirebase';
import { emitToast } from '@/src/lib/toastBridge';

/**
 * Central API caller — targets the Cloudflare Worker backend. Firebase Auth is
 * still the source of truth: we attach the current user's ID token as a Bearer
 * token and the Worker verifies it on the edge.
 *
 * What this layer guarantees, and previously did not:
 *
 *  - TIMEOUTS. Every request is bounded. A bare `fetch` on a stalled mobile
 *    connection hangs forever, which surfaced as spinners that never resolved.
 *  - 401 RECOVERY. An expired ID token is refreshed once and the request is
 *    retried. If it still fails, the session is ended cleanly instead of leaving
 *    the user staring at "Request failed" on every screen.
 *  - RETRIES for reads. Idempotent GETs retry with backoff on transient network
 *    and 5xx failures. Writes are never retried automatically.
 *  - OFFLINE AWARENESS. Being offline produces a clear message instead of a raw
 *    `TypeError: Network request failed`.
 *  - One code path. Token attachment and error mapping were duplicated three
 *    times; they now live in a single `request()` core.
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

/** Request budget. Uploads set their own, longer, timeout. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Reads are safe to repeat; two retries covers a tunnel or a lift. */
const READ_RETRIES = 2;

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
  'phoneSignIn',
]);

/** Error shaped like a Firebase callable error so existing catch blocks work. */
export class ApiCallError extends Error {
  code: string;
  /** HTTP status, when the failure came from a response rather than the network. */
  status?: number;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** True for the errors where retrying is sensible rather than futile. */
function isRetryable(error: unknown): boolean {
  if (error instanceof ApiCallError) {
    // 5xx and 429 are transient; 4xx means the request itself is wrong.
    return error.status === 429 || (error.status !== undefined && error.status >= 500);
  }
  // AbortError (timeout) and TypeError (network) are both worth one more try.
  return true;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function isOffline(): Promise<boolean> {
  try {
    const state = await NetInfo.fetch();
    // `isInternetReachable` is null while unknown — only treat an explicit false
    // as offline so an inconclusive probe never blocks a request.
    return state.isConnected === false || state.isInternetReachable === false;
  } catch {
    return false;
  }
}

/**
 * End the session after the server has rejected a refreshed token.
 *
 * Signing out lets the root auth guard route back to login, which is far better
 * than every screen failing with a generic error while a dead token is retried
 * forever. Guarded so a burst of parallel 401s produces one sign-out, one toast.
 */
let endingSession = false;
async function endExpiredSession() {
  if (endingSession || !auth.currentUser) return;
  endingSession = true;
  try {
    emitToast('Your session expired. Please sign in again.', 'error');
    await signOut(auth);
  } catch (e) {
    console.error('[api] sign-out after 401 failed', e);
  } finally {
    // Allow a future expiry to be handled once the user is back in.
    setTimeout(() => {
      endingSession = false;
    }, 5_000);
  }
}

async function authHeader(forceRefresh = false): Promise<Record<string, string>> {
  const currentUser = auth.currentUser;
  if (!currentUser) return {};
  try {
    return { Authorization: `Bearer ${await currentUser.getIdToken(forceRefresh)}` };
  } catch (e) {
    // A refresh failure usually means the refresh token was revoked.
    if (forceRefresh) console.error('[api] token refresh failed', e);
    return {};
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  retries?: number;
  /** Suppress the automatic session-expiry sign-out (used by auth screens). */
  allowUnauthenticated?: boolean;
}

interface RawResponse<T> {
  data: T;
  headers: Headers;
}

/**
 * The single request path. Handles auth, timeout, retry, 401 refresh and error
 * mapping; everything public in this module is a thin wrapper over it.
 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<RawResponse<T>> {
  const {
    method = 'GET',
    body,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = method === 'GET' ? READ_RETRIES : 0,
    allowUnauthenticated = false,
  } = options;

  let lastError: unknown;

  // attempt 0..retries, plus one extra attempt reserved for a token refresh.
  for (let attempt = 0; attempt <= retries; attempt++) {
    let refreshedForThisAttempt = false;

    for (let authTry = 0; authTry < 2; authTry++) {
      const headers: Record<string, string> = {
        ...(await authHeader(authTry === 1)),
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      try {
        const res = await fetch(path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          // AbortSignal.timeout is available on Hermes/RN 0.74+ and every browser
          // the web build targets.
          signal: AbortSignal.timeout(timeoutMs),
        });

        const json: any = await res.json().catch(() => null);

        if (res.ok) return { data: json as T, headers: res.headers };

        // 401: the token may simply have expired. Force-refresh once and retry
        // the SAME attempt before treating it as a real failure.
        if (res.status === 401 && authTry === 0 && auth.currentUser) {
          refreshedForThisAttempt = true;
          continue;
        }
        if (res.status === 401 && !allowUnauthenticated && auth.currentUser) {
          await endExpiredSession();
        }

        const status = (json?.error?.status || 'INTERNAL').toLowerCase().replace(/_/g, '-');
        throw new ApiCallError(
          `functions/${status}`,
          json?.error?.message || `Request failed (${res.status})`,
          res.status,
        );
      } catch (e: any) {
        // A refresh retry is not a failure yet — let the inner loop continue.
        if (refreshedForThisAttempt && authTry === 0) {
          lastError = e;
          continue;
        }
        lastError = e;
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
          lastError = new ApiCallError(
            'functions/deadline-exceeded',
            'The server took too long to respond. Please try again.',
          );
        } else if (e instanceof TypeError) {
          // fetch throws TypeError for network-level failures.
          lastError = new ApiCallError(
            'functions/unavailable',
            (await isOffline())
              ? "You're offline. Check your connection and try again."
              : 'Could not reach the server. Please try again.',
          );
        }
        break; // out of the auth loop, into retry handling
      }
    }

    const canRetry = attempt < retries && isRetryable(lastError);
    if (!canRetry) break;
    // Exponential backoff with jitter, so a flaky network does not produce a
    // synchronised retry storm across every screen.
    await sleep(400 * 2 ** attempt + Math.random() * 200);
  }

  throw lastError instanceof Error
    ? lastError
    : new ApiCallError('functions/internal', 'Request failed');
}

function buildUrl(path: string, params?: Record<string, any>): string {
  const url = new URL(`${API_BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/** GET a /read endpoint on the Worker, attaching the ID token if present. */
export const readApi = async (path: string, params?: Record<string, any>) => {
  const { data } = await request<any>(buildUrl(path, params));
  return data;
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
  const { data, headers } = await request<T>(buildUrl(path, params));
  return { data, nextCursor: headers.get('X-Next-Cursor') };
};

/**
 * Realtime-by-polling. Replaces Firestore onSnapshot: repeatedly calls `fetcher`
 * and invokes `callback` with the result. Returns an unsubscribe function with
 * the same ergonomics as a Firestore listener.
 *
 * `onError` lets a caller surface staleness instead of silently showing old data
 * forever, which is what the previous console-only version did.
 */
export const poll = <T>(
  fetcher: () => Promise<T>,
  callback: (data: T) => void,
  intervalMs = 5000,
  onError?: (error: unknown, consecutiveFailures: number) => void,
): (() => void) => {
  let active = true;
  let failures = 0;
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
      failures = 0;
      if (active) callback(data);
    } catch (e) {
      failures++;
      if (__DEV__) console.warn('[poll] fetch failed', e);
      onError?.(e, failures);
    } finally {
      // Back off while failing so a dead endpoint isn't hammered every 5s.
      const delay = failures > 2 ? Math.min(intervalMs * 2 ** (failures - 2), 60_000) : intervalMs;
      if (active) timer = setTimeout(tick, delay);
    }
  };
  tick();
  return () => {
    active = false;
    if (timer) clearTimeout(timer);
  };
};

export interface CallApiOptions {
  timeoutMs?: number;
  /** Retry a WRITE. Only safe for actions the server makes idempotent. */
  retries?: number;
  /** Don't end the session on a 401 (for pre-login auth screens). */
  allowUnauthenticated?: boolean;
}

export const callApi = async (action: string, data: any = {}, options: CallApiOptions = {}) => {
  const isAuthAction = AUTH_ACTIONS.has(action);
  const path = isAuthAction ? '/auth' : '/api';

  try {
    const { data: json } = await request<any>(`${API_BASE_URL}${path}`, {
      method: 'POST',
      body: { action, ...data },
      timeoutMs: options.timeoutMs,
      retries: options.retries ?? 0,
      // Auth actions run pre-login; a 401 there is an expected outcome, not an
      // expired session.
      allowUnauthenticated: options.allowUnauthenticated ?? isAuthAction,
    });
    return json;
  } catch (error: any) {
    if (__DEV__) console.error(`[API Error] Path: ${path}, Action: ${action}`, error);
    throw error;
  }
};
