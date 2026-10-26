import { AppState } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { signOut } from 'firebase/auth';
import { auth } from './firebase/initFirebase';
import { markOnboardingIncomplete, PROFILE_INCOMPLETE_CODE } from '../lib/profileCompletion';
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
 * Set EXPO_PUBLIC_API_URL to the deployed Worker URL (production:
 * https://api.tophunt.in).
 */

// The Worker base URL MUST be provided via EXPO_PUBLIC_API_URL (set per
// environment in eas.json / .env). We keep a last-resort fallback so the app
// never fetches an undefined URL, but warn loudly in development when the env
// var is missing so staging/dev builds don't silently hit production.
//
// This is also the realtime WebSocket origin (src/services/realtime.ts rewrites
// http -> ws), so it must be the API host — never the web host.
const FALLBACK_API_URL = 'https://api.tophunt.in';

if (!process.env.EXPO_PUBLIC_API_URL && __DEV__) {
  console.warn(
    '[api] EXPO_PUBLIC_API_URL is not set — falling back to the production Worker URL. ' +
      'Set EXPO_PUBLIC_API_URL in your .env / EAS env to target the right backend.',
  );
}

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_URL || FALLBACK_API_URL;

/**
 * The server marks a 401 with this token in the message when the SESSION was ended,
 * rather than merely having expired.
 *
 * Mirrors `SESSION_REVOKED_CODE` in the Worker's `lib/sessionRevocation.ts`, the same way
 * `src/services/auth/reauth.ts` mirrors `REAUTH_REQUIRED_CODE`. A duplicated string
 * literal rather than a shared import because the two apps do not share a package — and
 * the Worker keeps the marker in the MESSAGE precisely so the HTTP status can stay 401,
 * which is what makes the existing sign-out path below work unchanged.
 */
const SESSION_REVOKED_CODE = 'session_revoked';

/** Request budget. Uploads set their own, longer, timeout. */
const DEFAULT_TIMEOUT_MS = 20_000;
/** Reads are safe to repeat; two retries covers a tunnel or a lift. */
const READ_RETRIES = 2;

// Actions handled by the /auth route (was the `authHandler` callable).
//
// Membership here decides ROUTING: an action in this set goes to the public
// `/auth` endpoint (no Firebase token required); anything else goes to `/api`,
// which is behind requireApiAuth and rejects a tokenless request with "User must
// be logged in." So every PRE-LOGIN action MUST be listed here — otherwise the
// screen that runs before sign-in (phone login, password reset) fails on its
// very first call. `sendPhoneLoginOtp` was missing, which broke "Send OTP" on
// the phone-login screen with exactly that error.
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
  'sendPhoneLoginOtp',
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
    // No status: the request never got an answer. `request()` maps network
    // and timeout failures to ApiCallError BEFORE asking this, so this branch
    // used to see every network failure and call it permanent: reads were
    // never retried after a dropped connection, despite READ_RETRIES.
    if (error.status === undefined) return error.code !== 'functions/cancelled';
    // 5xx and 429 are transient; 4xx means the request itself is wrong.
    return error.status === 429 || error.status >= 500;
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
/**
 * Suppresses the automatic sign-out while the app is DELIBERATELY ending its session.
 *
 * `logoutAllDevices` revokes this session server-side and only then signs out locally. Any
 * request already in flight in that gap — the realtime heartbeat, the periodic settings
 * refetch — comes back 401 with the revocation marker and would fire "You were signed out
 * for security" as an error toast, immediately before the success toast for the thing the
 * user just chose to do. Two toasts with opposite framing for one action.
 *
 * `SignOutOptions.skipPushTokenUnregister` already documents this exact collision for the
 * push-token detach call; this closes the rest of the window.
 */
let deliberateSignOut = false;
export function beginDeliberateSignOut() {
  deliberateSignOut = true;
}
export function endDeliberateSignOut() {
  deliberateSignOut = false;
}

/**
 * End the session from OUTSIDE the request path.
 *
 * The WebSocket layer needs this. A rejected upgrade surfaces to React Native as an
 * ordinary close with no status, so `realtime.ts` cannot tell "revoked session" from
 * "tunnel dropped" and reconnects forever — leaving an app that is sitting on a screen
 * with no API traffic showing a signed-in UI on a dead session indefinitely. A streak of
 * closes that never reached `onopen` is the signal it does have, and this is where that
 * signal has to land so the sign-out stays deduplicated with the one below.
 */
export async function endRejectedSession() {
  await endExpiredSession(true);
}

let endingSession = false;
async function endExpiredSession(revoked = false) {
  if (endingSession || deliberateSignOut || !auth.currentUser) return;
  endingSession = true;
  try {
    /**
     * Two different messages, because these are two different events to the user.
     *
     * "Expired" is routine — a token aged out, sign in and carry on. "Signed out for
     * security" means something HAPPENED to the account: a password was changed, access
     * was recovered, or someone pressed "log out of all devices". Reporting the second
     * as the first is how a user shrugs off the one notification that would have told
     * them about a takeover.
     */
    emitToast(
      revoked
        ? 'You were signed out for security. Please sign in again.'
        : 'Your session expired. Please sign in again.',
      'error',
    );
    const uid = auth.currentUser?.uid;
    await signOut(auth);
    const { clearCachedIdentity } = await import('@/src/lib/cachedIdentity');
    await clearCachedIdentity(uid);
  } catch (e) {
    console.error('[api] sign-out after 401 failed', e);
  } finally {
    // Allow a future expiry to be handled once the user is back in.
    setTimeout(() => {
      endingSession = false;
    }, 5_000);
  }
}

/**
 * Route a still-signed-in caller to the account-deletion reactivation gate.
 *
 * The server refuses writes from an account that is pending deletion with a
 * `failed-precondition` "scheduled for deletion" error (see the Worker's
 * `requireApiAuth`). That is the immediate signal that this session is on a closing
 * account — most often because the deletion was requested on another device. Rather
 * than surface a confusing raw error, we send the user to the gate where they can
 * cancel. The splash + DeletionGuard cover cold start and focus; this covers the
 * mid-session case at the exact moment it is detected.
 *
 * Deduped so a burst of failing writes cannot stack redirects, and a no-op when
 * signed out. Lazy-imports expo-router so this service module carries no navigation
 * dependency at load time.
 */
let routingToDeletionGate = false;
async function routeToDeletionGate() {
  if (routingToDeletionGate || !auth.currentUser) return;
  routingToDeletionGate = true;
  try {
    emitToast('Your account is scheduled for deletion. Cancel it to keep using TopHunt.', 'info');
    const { router } = await import('expo-router');
    router.replace('/account-scheduled-deletion');
  } catch (e) {
    console.error('[api] route to deletion gate failed', e);
  } finally {
    setTimeout(() => {
      routingToDeletionGate = false;
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
  /** Bypass every HTTP cache (browser, OS) — for state that must be live. */
  noStore?: boolean;
  /**
   * Caller cancellation (React Query passes one to every queryFn). An aborted
   * request fails with `functions/cancelled` and is never retried.
   */
  signal?: AbortSignal;
}

/** Options for the GET helpers (`readApi` and friends). */
export interface ReadOptions {
  /** Cancel when the caller no longer needs the answer (screen left, newer search). */
  signal?: AbortSignal;
}

/** Thrown when the CALLER aborted. Not a failure: nothing to show, nothing to retry. */
export function isCancelledError(error: unknown): boolean {
  return error instanceof ApiCallError && error.code === 'functions/cancelled';
}

const cancelledError = () => new ApiCallError('functions/cancelled', 'Request cancelled');

/**
 * One signal that aborts on the caller's signal OR the timeout. Says which one
 * fired, so a timeout is not mistaken for a cancellation.
 */
function requestSignal(timeoutMs: number, external?: AbortSignal): { signal: AbortSignal; cancelled: () => boolean; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMExceptionLike('TimeoutError')), timeoutMs);
  const onAbort = () => controller.abort(new DOMExceptionLike('AbortError'));
  if (external) {
    if (external.aborted) onAbort();
    else external.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cancelled: () => !!external?.aborted,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    },
  };
}

/** `DOMException` is not on every RN runtime; only `name` is ever read. */
class DOMExceptionLike extends Error {
  constructor(name: string) {
    super(name);
    this.name = name;
  }
}

/**
 * App Control refusals the server marks with a machine-readable `reason`
 * ("maintenance", "update_required", "feature_disabled"). The live-config
 * component listens and refetches, so the screen catches up with the server.
 */
type ControlSignalListener = (reason: string) => void;
const controlSignalListeners = new Set<ControlSignalListener>();
export function onControlSignal(fn: ControlSignalListener): () => void {
  controlSignalListeners.add(fn);
  return () => controlSignalListeners.delete(fn);
}

/**
 * Native builds tell the server their version, for the hard-update gate (web
 * never). Set once at startup by the root layout (`setClientVersionHeaders`),
 * so this module stays free of native-only imports.
 */
let NATIVE_VERSION_HEADERS: Record<string, string> = {};
export function setClientVersionHeaders(platform: string, version: string): void {
  NATIVE_VERSION_HEADERS =
    platform === 'android' || platform === 'ios' ? { 'X-App-Platform': platform, 'X-App-Version': version } : {};
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
    noStore = false,
    signal: external,
  } = options;

  let lastError: unknown;
  if (external?.aborted) throw cancelledError();

  // attempt 0..retries, plus one extra attempt reserved for a token refresh.
  for (let attempt = 0; attempt <= retries; attempt++) {
    let refreshedForThisAttempt = false;

    for (let authTry = 0; authTry < 2; authTry++) {
      const headers: Record<string, string> = {
        ...NATIVE_VERSION_HEADERS,
        ...(await authHeader(authTry === 1)),
      };
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const sig = requestSignal(timeoutMs, external);
      try {
        const res = await fetch(path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          ...(noStore ? { cache: 'no-store' as RequestCache } : {}),
          signal: sig.signal,
        });

        const json: any = await res.json().catch(() => null);

        if (res.ok) return { data: json as T, headers: res.headers };

        /**
         * A REVOKED session, as opposed to an expired one.
         *
         * The server ends sessions on a password change, an account recovery, an admin
         * intervention, or the user's own "log out of all devices" — and marks the 401
         * so the two cases are distinguishable (see the Worker's
         * `SESSION_REVOKED_CODE`). The refresh retry below is skipped for it, and that
         * is not just an optimisation: refreshing cannot help, because the server is
         * rejecting the session's ORIGINAL sign-in time and a new token carries the same
         * one. Retrying would spend a network round trip to be told the same thing, and
         * on a `revokeAllSessions` the refresh token is gone too, so it fails anyway.
         */
        const revoked = res.status === 401 && String(json?.error?.message || '').includes(SESSION_REVOKED_CODE);

        // 401: the token may simply have expired. Force-refresh once and retry
        // the SAME attempt before treating it as a real failure.
        if (res.status === 401 && !revoked && authTry === 0 && auth.currentUser) {
          refreshedForThisAttempt = true;
          continue;
        }
        if (res.status === 401 && !allowUnauthenticated && auth.currentUser) {
          await endExpiredSession(revoked);
        }

        // The account is pending deletion — the server refuses writes from it. Route
        // to the reactivation gate instead of bubbling a raw "failed-precondition".
        if (
          auth.currentUser &&
          String(json?.error?.message || '').toLowerCase().includes('scheduled for deletion')
        ) {
          void routeToDeletionGate();
        }

        const reason = typeof json?.error?.reason === 'string' ? json.error.reason : '';
        if (reason) controlSignalListeners.forEach((fn) => {
          try {
            fn(reason);
          } catch {
            /* listener errors never break a request */
          }
        });
        const status = (json?.error?.status || 'INTERNAL').toLowerCase().replace(/_/g, '-');
        // The server says this account has not finished onboarding: tell the root
        // guard, which sends the user back to the profile form (src/lib/profileCompletion.ts).
        if (res.status === 412 && auth.currentUser && String(json?.error?.message || '').includes(PROFILE_INCOMPLETE_CODE)) {
          markOnboardingIncomplete(auth.currentUser.uid);
        }
        throw new ApiCallError(
          `functions/${status}`,
          json?.error?.message || `Request failed (${res.status})`,
          res.status,
        );
      } catch (e: any) {
        // The caller gave up: stop now, whatever the error looks like.
        if (sig.cancelled()) throw cancelledError();
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
      } finally {
        sig.dispose();
      }
    }

    const canRetry = attempt < retries && isRetryable(lastError);
    if (!canRetry) break;
    // Known offline: another attempt cannot succeed. Retrying used to spend up
    // to the full timeout per attempt while the screen showed a spinner.
    if (lastError instanceof ApiCallError && lastError.status === undefined && (await isOffline())) break;
    // Exponential backoff with jitter, so a flaky network does not produce a
    // synchronised retry storm across every screen.
    await sleep(400 * 2 ** attempt + Math.random() * 200);
    if (external?.aborted) throw cancelledError();
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

/**
 * Identical GETs in flight at the same time share one network request.
 *
 * Several screens and cards ask for the same thing at once (a profile header
 * and its follow button, two cards for one battle, a remount during a fetch).
 * Each used to send its own request. The key includes the signed-in uid, so
 * two accounts never share an answer. Each caller can still cancel on its own:
 * the shared request is aborted only when EVERY caller has.
 *
 * A caller other than the first gets a deep copy, so one screen mutating its
 * result cannot change another's.
 */
interface InFlight {
  promise: Promise<RawResponse<any>>;
  controller: AbortController;
  waiters: number;
}
const inFlight = new Map<string, InFlight>();

function sharedGet<T>(url: string, noStore: boolean, opts: ReadOptions = {}): Promise<RawResponse<T>> {
  if (opts.signal?.aborted) return Promise.reject(cancelledError());
  const key = `${auth.currentUser?.uid ?? 'guest'}|${noStore ? 'live' : 'std'}|${url}`;
  let entry = inFlight.get(key);
  const first = !entry;
  if (!entry) {
    const controller = new AbortController();
    const promise = request<T>(url, { noStore, signal: controller.signal }).finally(() => {
      if (inFlight.get(key) === created) inFlight.delete(key);
    });
    const created: InFlight = { promise, controller, waiters: 0 };
    entry = created;
    inFlight.set(key, created);
  }
  const shared = entry;
  shared.waiters++;
  let done = false;
  const leave = () => {
    if (done) return;
    done = true;
    shared.waiters--;
    if (shared.waiters === 0) {
      shared.controller.abort();
      // A new caller must not join a request that is being torn down.
      if (inFlight.get(key) === shared) inFlight.delete(key);
    }
  };
  return new Promise<RawResponse<T>>((resolve, reject) => {
    const onAbort = () => {
      leave();
      reject(cancelledError());
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    shared.promise.then(
      (res) => {
        opts.signal?.removeEventListener('abort', onAbort);
        if (done) return;
        done = true;
        shared.waiters--;
        resolve(first ? res : { data: cloneJson(res.data), headers: res.headers });
      },
      (err) => {
        opts.signal?.removeEventListener('abort', onAbort);
        if (done) return;
        done = true;
        shared.waiters--;
        reject(err);
      },
    );
  });
}

function cloneJson<T>(v: T): T {
  return v == null || typeof v !== 'object' ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Test hook: how many shared GETs are in flight. */
export function __inFlightCountForTests(): number {
  return inFlight.size;
}

/** GET a /read endpoint on the Worker, attaching the ID token if present. */
export const readApi = async (path: string, params?: Record<string, any>, opts?: ReadOptions) => {
  const { data } = await sharedGet<any>(buildUrl(path, params), false, opts);
  return data;
};

/** `readApi` that bypasses every HTTP cache (live state such as App Control). */
export const readApiLive = async (path: string, params?: Record<string, any>, opts?: ReadOptions) => {
  const { data } = await sharedGet<any>(buildUrl(path, params), true, opts);
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
  opts?: ReadOptions,
): Promise<{ data: T; nextCursor: string | null }> => {
  const { data, headers } = await sharedGet<T>(buildUrl(path, params), false, opts);
  return { data, nextCursor: headers.get('X-Next-Cursor') };
};

/**
 * Like `readApi` but returns the response headers too, for endpoints that carry
 * a side value in an exposed header (e.g. `/read/notifications?withUnread=1`
 * returns the badge count in `X-Unread-Count`). Headers must be listed in the
 * Worker's API_EXPOSED_HEADERS to be readable on web.
 */
export const readApiWithHeaders = async <T = any>(
  path: string,
  params?: Record<string, any>,
  opts?: ReadOptions,
): Promise<{ data: T; headers: Headers }> => {
  const { data, headers } = await sharedGet<T>(buildUrl(path, params), false, opts);
  return { data, headers };
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
