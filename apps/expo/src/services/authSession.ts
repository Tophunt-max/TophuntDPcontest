/**
 * One app-wide Firebase session observer.
 *
 * Before this store, every `useAuth()` call started independently at
 * `{user:null, loading:true}`. Components that checked only `!user` painted a
 * guest account (Login / Signup, `?` avatar) while Firebase was restoring an
 * existing session. This module starts ONE observer at module load and exposes a
 * synchronous external-store snapshot to every screen.
 *
 * State machine:
 *   restoring -> authenticated | guest | error
 *   authenticated <-> guest (real sign-in / sign-out events)
 *
 * A watchdog never declares guest. If local persistence genuinely hangs, it
 * offers Retry / explicit Continue as guest; it does not clear Firebase data.
 */
import { onAuthStateChanged, type Unsubscribe, type User } from 'firebase/auth';
import { auth } from '@/src/services/firebase/initFirebase';
import { authFlags, type AuthSnapshot } from '@/src/lib/authState';

/**
 * How long to wait before offering Retry / Continue as guest.
 *
 * With a saved login, Firebase checks the account over the network before its
 * first event (@firebase/auth `initializeCurrentUser` -> `_reloadWithoutSaving`).
 * On a connection that is up but passes no data (mobile "No internet
 * connection" with signal bars), that request hangs until Firebase's own API
 * timeout: 30s on web, 60s on React Native (`DEFAULT_API_TIMEOUT_MS`). Firebase
 * then keeps the saved user and emits it. The old 15s watchdog fired first and
 * showed a "restore failed" screen for a session that was about to restore.
 * The watchdog now waits past Firebase's timeout, so it only catches a real
 * hang (e.g. storage that never answers); the splash says the network is slow.
 */
// `document` exists only on web (no react-native import: this module is unit-tested in Node).
const RESTORE_WATCHDOG_MS = typeof document !== 'undefined' ? 35_000 : 65_000;
const listeners = new Set<() => void>();
let observer: Unsubscribe | null = null;
let watchdog: ReturnType<typeof setTimeout> | null = null;

let snapshot: AuthSnapshot = auth.currentUser
  ? { status: 'authenticated', user: auth.currentUser, error: null }
  : { status: 'restoring', user: null, error: null };

const emit = () => listeners.forEach((fn) => fn());
const setSnapshot = (next: AuthSnapshot) => {
  if (snapshot.status === next.status && snapshot.user === next.user && snapshot.error === next.error) return;
  snapshot = next;
  emit();
};
const clearWatchdog = () => {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
};

function startObserver(): void {
  observer?.();
  observer = null;
  clearWatchdog();
  // Preserve a synchronously known Firebase user on Fast Refresh/remount.
  setSnapshot(
    auth.currentUser
      ? { status: 'authenticated', user: auth.currentUser, error: null }
      : { status: 'restoring', user: null, error: null },
  );
  observer = onAuthStateChanged(
    auth,
    (user: User | null) => {
      clearWatchdog();
      setSnapshot(user ? { status: 'authenticated', user, error: null } : { status: 'guest', user: null, error: null });
    },
    (cause: Error) => {
      clearWatchdog();
      const current = auth.currentUser;
      setSnapshot(current ? { status: 'authenticated', user: current, error: null } : { status: 'error', user: null, error: cause });
    },
  );
  watchdog = setTimeout(() => {
    if (snapshot.status !== 'restoring') return;
    const current = auth.currentUser;
    if (current) {
      setSnapshot({ status: 'authenticated', user: current, error: null });
      return;
    }
    setSnapshot({
      status: 'error',
      user: null,
      error: new Error('Session restore timed out. Your saved login was not cleared.'),
    });
  }, RESTORE_WATCHDOG_MS);
}

startObserver();

export const subscribeAuthSession = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getAuthSessionSnapshot = () => snapshot;
export const retryAuthSession = () => startObserver();

/** Explicit escape hatch from the recovery screen; never runs automatically. */
export function continueAuthSessionAsGuest(): void {
  clearWatchdog();
  // Keep the singleton observer attached: if the user signs in from the guest
  // shell (or persistence finishes late), that real Firebase event must still
  // move the whole app to `authenticated`.
  setSnapshot({ status: 'guest', user: null, error: null });
}

/** Resolve once Firebase has made its first real decision (or recovery state). */
export function waitForAuthSession(): Promise<AuthSnapshot> {
  if (authFlags(snapshot).ready || snapshot.status === 'error') return Promise.resolve(snapshot);
  return new Promise((resolve) => {
    const off = subscribeAuthSession(() => {
      const current = getAuthSessionSnapshot();
      if (!authFlags(current).ready && current.status !== 'error') return;
      off();
      resolve(current);
    });
  });
}

/** Test-only reset behind an explicit name; production never calls this. */
export const __AUTH_RESTORE_WATCHDOG_MS = RESTORE_WATCHDOG_MS;

/** Stop timers/listener between isolated unit-test module instances. */
export function __disposeAuthSessionForTests(): void {
  clearWatchdog();
  observer?.();
  observer = null;
  listeners.clear();
}