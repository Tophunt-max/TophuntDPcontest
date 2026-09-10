/**
 * How the app reacts to a session the server has ENDED.
 *
 * ---------------------------------------------------------------------------
 * The two 401s, and why they must not be treated the same
 * ---------------------------------------------------------------------------
 * The API layer already handled one kind of 401: a token that aged out. Its recovery is
 * to force-refresh once and retry, which works, because a fresh token fixes an expired
 * one.
 *
 * Session revocation produces a 401 that a refresh CANNOT fix. The server is rejecting
 * the session's original sign-in time (`auth_time`), and a refreshed token carries the
 * same one — so the retry spends a round trip to be told exactly the same thing, and on a
 * full revocation the refresh token is gone too, so it fails outright. The server marks
 * the message with `session_revoked` precisely so the client can tell the difference.
 *
 * The user-visible half matters just as much. "Your session expired" is routine and
 * invites you to carry on; being signed out because a password changed, access was
 * recovered, or someone pressed "log out of all devices" is the one notification that
 * would tell somebody their account had been taken over. Reporting the second as the
 * first is how that goes unnoticed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    /** Queue of responses the fake fetch will return, oldest first. */
    responses: [] as Array<{ status: number; body: any }>,
    /** One entry per outbound request, recording whether a fresh token was demanded. */
    calls: [] as Array<{ forceRefresh: boolean }>,
    toasts: [] as Array<{ message: string; type: string }>,
    signOuts: 0,
    /** Set when a forced refresh should fail, as it does once refresh tokens are gone. */
    refreshFails: false,
  },
}));

vi.mock('firebase/auth', () => ({
  signOut: async () => {
    state.signOuts += 1;
  },
}));

vi.mock('@/src/services/firebase/initFirebase', () => ({
  auth: {
    currentUser: {
      getIdToken: async (forceRefresh = false) => {
        state.calls.push({ forceRefresh });
        if (forceRefresh && state.refreshFails) throw new Error('refresh token revoked');
        return forceRefresh ? 'fresh-token' : 'cached-token';
      },
    },
  },
}));

vi.mock('@/src/lib/toastBridge', () => ({
  emitToast: (message: string, type: string) => {
    state.toasts.push({ message, type });
  },
}));

vi.mock('@react-native-community/netinfo', () => ({
  default: { fetch: async () => ({ isConnected: true, isInternetReachable: true }) },
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' },
  Platform: { OS: 'android', select: (o: any) => o.android ?? o.default },
}));

const REVOKED = {
  status: 401,
  body: {
    error: {
      status: 'UNAUTHENTICATED',
      message: 'session_revoked: You were signed out for security. Please sign in again.',
    },
  },
};

const EXPIRED = {
  status: 401,
  body: { error: { status: 'UNAUTHENTICATED', message: 'Invalid or expired authentication token.' } },
};

beforeEach(() => {
  /**
   * `__DEV__` is a React Native global that the bundler injects and plain Node does not
   * have. `src/services/api.ts` reads it at module scope, to warn when
   * EXPO_PUBLIC_API_URL is unset — so this is the first test to import that module
   * directly rather than mocking it, and therefore the first to need the global.
   */
  vi.stubGlobal('__DEV__', false);
  process.env.EXPO_PUBLIC_API_URL = 'https://api.example.test';

  state.responses = [];
  state.calls = [];
  state.toasts = [];
  state.signOuts = 0;
  state.refreshFails = false;

  globalThis.fetch = (async () => {
    const next = state.responses.shift() ?? { status: 200, body: { ok: true } };
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Headers(),
      json: async () => next.body,
    } as any;
  }) as any;
});

afterEach(() => {
  vi.resetModules();
});

/** Fresh module instance per test — the sign-out guard inside it is module-level state. */
const loadApi = async () => await import('@/src/services/api');

describe('a REVOKED session', () => {
  it('does not waste a token refresh trying to recover', async () => {
    // A refresh cannot help: the server is rejecting `auth_time`, which a new token
    // repeats. Exactly one outbound request, made with the cached token.
    state.responses = [REVOKED];
    const { callApi } = await loadApi();

    await expect(callApi('markNotificationsRead', {})).rejects.toThrow();
    expect(state.calls).toEqual([{ forceRefresh: false }]);
  });

  it('signs the user out', async () => {
    state.responses = [REVOKED];
    const { callApi } = await loadApi();

    await expect(callApi('markNotificationsRead', {})).rejects.toThrow();
    expect(state.signOuts).toBe(1);
  });

  it('says it was for SECURITY, not that the session merely expired', async () => {
    state.responses = [REVOKED];
    const { callApi } = await loadApi();

    await expect(callApi('markNotificationsRead', {})).rejects.toThrow();
    expect(state.toasts).toHaveLength(1);
    expect(state.toasts[0].message).toContain('signed out for security');
    expect(state.toasts[0].message).not.toContain('expired');
  });

  it('signs out ONCE even when several requests are refused together', async () => {
    // A screen mounting fires a burst of reads. The guard is what stops that becoming a
    // stack of identical toasts.
    state.responses = [REVOKED, REVOKED, REVOKED];
    const { callApi } = await loadApi();

    await Promise.all([
      callApi('markNotificationsRead', {}).catch(() => {}),
      callApi('markNotificationsRead', {}).catch(() => {}),
      callApi('markNotificationsRead', {}).catch(() => {}),
    ]);

    expect(state.signOuts).toBe(1);
    expect(state.toasts).toHaveLength(1);
  });
});

describe('an EXPIRED session still recovers the way it always did', () => {
  it('force-refreshes once and retries', async () => {
    // The regression guard for the change above: singling out the revoked case must not
    // disturb the ordinary expiry path, which a refresh genuinely does fix.
    state.responses = [EXPIRED, { status: 200, body: { success: true } }];
    const { callApi } = await loadApi();

    await expect(callApi('markNotificationsRead', {})).resolves.toEqual({ success: true });
    expect(state.calls).toEqual([{ forceRefresh: false }, { forceRefresh: true }]);
    // Recovered, so nothing is said to the user and the session survives.
    expect(state.signOuts).toBe(0);
    expect(state.toasts).toHaveLength(0);
  });

  it('ends the session with the EXPIRED wording when the refresh does not help', async () => {
    state.responses = [EXPIRED, EXPIRED];
    const { callApi } = await loadApi();

    await expect(callApi('markNotificationsRead', {})).rejects.toThrow();
    expect(state.signOuts).toBe(1);
    expect(state.toasts[0].message).toContain('expired');
    expect(state.toasts[0].message).not.toContain('security');
  });
});

describe('a revoked session whose refresh token is also gone', () => {
  it('still signs out cleanly rather than looping', async () => {
    /**
     * What `revokeAllSessions` actually produces in the wild: the D1 cutoff refuses the
     * token AND Firebase's `validSince` invalidates the refresh token, so `getIdToken(true)`
     * throws. Skipping the refresh means that path is never even reached — but if the
     * ordering ever changed, this asserts the outcome is still one sign-out and not a
     * retry loop.
     */
    state.refreshFails = true;
    state.responses = [REVOKED];
    const { callApi } = await loadApi();

    await expect(callApi('markNotificationsRead', {})).rejects.toThrow();
    expect(state.signOuts).toBe(1);
    expect(state.calls.filter((c) => c.forceRefresh)).toHaveLength(0);
  });
});
