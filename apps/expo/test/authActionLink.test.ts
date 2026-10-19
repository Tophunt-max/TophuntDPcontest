/**
 * Firebase email action links, and the routing that makes them reachable.
 *
 * THE BUG: the password reset email arrived and its link opened the app — on the
 * WELCOME/LOGIN screen, with no way to set a password. Firebase's template action
 * URL points at tophunt.in, and once that URL is customised Firebase stops
 * handling the link itself: it forwards the browser to
 * `/__/auth/action?mode=resetPassword&oobCode=…` and expects the app to finish
 * the flow. `oobCode` appeared NOWHERE in the codebase, so the path matched no
 * route and fell through to login.
 *
 * Two halves have to hold for that to work, and each fails silently on its own:
 *
 *  1. the `/__/auth/action` path must reach the handler route. A path segment
 *     starting with `__` cannot be an expo-router file route, so public/_worker.js
 *     redirects it. If that redirect regresses, the link goes back to landing on
 *     the login screen — with no error anywhere.
 *  2. `oobCode` must survive the redirect byte for byte. It IS the credential;
 *     re-encoding it turns a working link into "invalid-action-code", which reads
 *     exactly like an expired link and would send everyone hunting the wrong
 *     problem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const verifyPasswordResetCode = vi.fn(async () => 'user@example.com');
const confirmPasswordReset = vi.fn(async () => {});
const applyActionCode = vi.fn(async () => {});
const checkActionCode = vi.fn(async () => ({ data: { email: 'user@example.com' } }));

vi.mock('firebase/auth', () => ({
  verifyPasswordResetCode: (...a: any[]) => (verifyPasswordResetCode as any)(...a),
  confirmPasswordReset: (...a: any[]) => (confirmPasswordReset as any)(...a),
  applyActionCode: (...a: any[]) => (applyActionCode as any)(...a),
  checkActionCode: (...a: any[]) => (checkActionCode as any)(...a),
}));
vi.mock('@/src/services/firebase/initFirebase', () => ({ auth: { __fake: true } }));

const authError = (code: string) => Object.assign(new Error(`raw ${code}`), { code });

beforeEach(() => {
  verifyPasswordResetCode.mockReset().mockResolvedValue('user@example.com');
  confirmPasswordReset.mockReset().mockResolvedValue(undefined as any);
  applyActionCode.mockReset().mockResolvedValue(undefined as any);
  checkActionCode.mockReset().mockResolvedValue({ data: { email: 'user@example.com' } } as any);
});

// --- 1. the path reaches the handler ---------------------------------------
/**
 * These run the REAL public/_worker.js — the file Cloudflare Pages serves — not a
 * copy of its routing rule. A test that re-implemented the rule would keep
 * passing after the worker changed, which is precisely the regression it exists
 * to catch.
 *
 * `HTMLRewriter` and `caches` are workerd globals with no Node equivalent, so
 * they are stubbed. The redirect under test returns before either is reached.
 */
describe('the /__/auth/action redirect in public/_worker.js', () => {
  const load = async () => {
    (globalThis as any).HTMLRewriter ??= class {
      on() { return this; }
      transform(r: any) { return r; }
    };
    (globalThis as any).caches ??= {
      default: { async match() { return undefined; }, async put() {}, async delete() { return false; } },
    };
    return (await import('../public/_worker.js' as any)).default;
  };

  const fakeEnv = {
    ASSETS: { fetch: async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }) },
  };
  const fakeCtx = { waitUntil() {}, passThroughOnException() {} };

  const get = async (url: string) => {
    const worker = await load();
    return worker.fetch(new Request(url, { headers: { accept: 'text/html' } }), fakeEnv, fakeCtx);
  };

  it('sends the Firebase path to the handler route', async () => {
    const res = await get('https://tophunt.in/__/auth/action?mode=resetPassword&oobCode=ABC123');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://tophunt.in/auth/action?mode=resetPassword&oobCode=ABC123');
  });

  /**
   * The regression that made the first fix useless.
   *
   * Keying on `/__/auth/action` was wrong: the Firebase console's action URL is
   * free-form, so Firebase appends its query to WHATEVER path an operator typed
   * there. The link kept landing on the login screen after a fix that verified
   * green, because the real link was never on the path being matched.
   *
   * Every shape below is a plausible console value, and each one must reach the
   * handler on the strength of the payload alone.
   */
  it.each([
    ['the site root', 'https://tophunt.in/?mode=resetPassword&oobCode=ABC123'],
    ['the bare origin', 'https://tophunt.in?mode=resetPassword&oobCode=ABC123'],
    ['the login screen', 'https://tophunt.in/auth/login?mode=resetPassword&oobCode=ABC123'],
    ['an invented path', 'https://tophunt.in/reset-password?mode=resetPassword&oobCode=ABC123'],
    ['a path that looks like a blog permalink', 'https://tophunt.in/some-slug?mode=resetPassword&oobCode=ABC123'],
  ])('claims an action link arriving at %s', async (_label, url) => {
    const res = await get(url);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/auth/action?');
    expect(res.headers.get('location')).toContain('oobCode=ABC123');
  });

  it('claims verifyEmail and recoverEmail links too', async () => {
    for (const mode of ['verifyEmail', 'recoverEmail']) {
      const res = await get(`https://tophunt.in/?mode=${mode}&oobCode=ABC123`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toContain(`mode=${mode}`);
    }
  });

  it('ignores an oobCode without a known mode, and a mode without a code', async () => {
    // Both halves are required, so an unrelated `?mode=` on some future screen
    // cannot hijack a page.
    expect((await get('https://tophunt.in/?oobCode=ABC123')).status).not.toBe(302);
    expect((await get('https://tophunt.in/?mode=resetPassword')).status).not.toBe(302);
    expect((await get('https://tophunt.in/?mode=darkTheme&oobCode=ABC123')).status).not.toBe(302);
  });

  it('does not redirect the handler route onto itself', async () => {
    // The handler carries exactly these params, so without the guard every load
    // of it would redirect forever.
    const res = await get('https://tophunt.in/auth/action?mode=resetPassword&oobCode=ABC123');
    expect(res.status).not.toBe(302);
  });

  it('preserves the oobCode byte for byte, including characters that re-encode badly', async () => {
    // Real oobCodes are long, mixed-case base64url — they contain - . and _.
    const code = 'AB-cd_EF12.34-xyz_QQ';
    const res = await get(`https://tophunt.in/__/auth/action?mode=resetPassword&oobCode=${code}&lang=en`);
    const location = res.headers.get('location') || '';
    // The code IS the credential. Re-encoding it produces
    // "auth/invalid-action-code", which reads exactly like an expired link and
    // would send everyone hunting the wrong problem.
    expect(location).toContain(`oobCode=${code}`);
    expect(location).toContain('lang=en');
  });

  describe('Firebase sign-in helper pages are proxied first-party', () => {
    const realFetch = globalThis.fetch;
    let calls: { url: string; method: string; body: string | null }[] = [];
    beforeEach(() => {
      calls = [];
      (globalThis as any).fetch = vi.fn(async (input: any, init: any = {}) => {
        const body = init.body ? await new Response(init.body).text() : null;
        calls.push({ url: String(input), method: init.method || 'GET', body });
        return new Response('<html>firebase handler</html>', {
          status: 200,
          headers: { 'content-type': 'text/html', 'x-upstream': 'firebase' },
        });
      });
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it('serves /__/auth/handler from firebaseapp.com, query intact, never redirected', async () => {
      // The OAuth handler needs Firebase's own hosted files: redirecting it would
      // break social sign-in, so it is fetched and passed through.
      const res = await get('https://tophunt.in/__/auth/handler?apiKey=K&providerId=google.com&v=10');
      expect(res.status).toBe(200);
      expect(calls[0].url).toBe('https://tophuntdpcontest.firebaseapp.com/__/auth/handler?apiKey=K&providerId=google.com&v=10');
      expect(await res.text()).toContain('firebase handler');
      expect(res.headers.get('x-upstream')).toBe('firebase');
      // Firebase's page, not ours: the app CSP must not be stamped on it.
      expect(res.headers.get('content-security-policy')).toBeNull();
      expect(res.headers.get('strict-transport-security')).toBeTruthy();
    });

    it('proxies the iframe, its scripts and /__/firebase/init.json', async () => {
      for (const path of ['/__/auth/iframe?apiKey=K', '/__/auth/handler.js', '/__/firebase/init.json']) {
        await get(`https://tophunt.in${path}`);
      }
      expect(calls.map((c) => c.url)).toEqual([
        'https://tophuntdpcontest.firebaseapp.com/__/auth/iframe?apiKey=K',
        'https://tophuntdpcontest.firebaseapp.com/__/auth/handler.js',
        'https://tophuntdpcontest.firebaseapp.com/__/firebase/init.json',
      ]);
    });

    it("forwards Apple's form POST back to the handler", async () => {
      const worker = await load();
      await worker.fetch(
        new Request('https://tophunt.in/__/auth/handler', {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: 'code=abc&state=xyz',
        }),
        fakeEnv,
        fakeCtx,
      );
      expect(calls[0].method).toBe('POST');
      expect(calls[0].body).toBe('code=abc&state=xyz');
    });

    it('does not proxy the email-action path or anything outside /__/', async () => {
      await get('https://tophunt.in/__/auth/action?mode=resetPassword&oobCode=A');
      await get('https://tophunt.in/auth/login');
      expect(calls).toHaveLength(0);
    });
  });

  it('the app CSP allows the scripts and frames Firebase sign-in needs', async () => {
    const res = await get('https://tophunt.in/auth/login');
    const csp: string = res.headers.get('content-security-policy') || '';
    const directive = (name: string) => csp.split(';').map((d: string) => d.trim()).find((d: string) => d.startsWith(name + ' ')) || '';
    // gapi: without it every social sign-in failed with auth/internal-error.
    expect(directive('script-src')).toContain('https://apis.google.com');
    // The auth iframe, first-party on tophunt.in, or on firebaseapp.com elsewhere.
    expect(directive('frame-src')).toContain("'self'");
    expect(directive('frame-src')).toContain('https://*.firebaseapp.com');
  });

  it('leaves the handler route itself alone, so the redirect cannot loop', async () => {
    const res = await get('https://tophunt.in/auth/action?mode=resetPassword&oobCode=X');
    expect(res.status).not.toBe(302);
  });
});

// --- 2. mode parsing -------------------------------------------------------
describe('parseMode', () => {
  it('recognises the modes Firebase sends', async () => {
    const { parseMode } = await import('@/src/services/auth/actionLink');
    expect(parseMode('resetPassword')).toBe('resetPassword');
    expect(parseMode('verifyEmail')).toBe('verifyEmail');
    expect(parseMode('recoverEmail')).toBe('recoverEmail');
  });

  it('treats anything else as unknown rather than guessing', async () => {
    const { parseMode } = await import('@/src/services/auth/actionLink');
    // Guessing resetPassword for an unknown mode would show a set-password form
    // for a link that is not one.
    expect(parseMode('signIn')).toBe('unknown');
    expect(parseMode(undefined)).toBe('unknown');
    expect(parseMode('')).toBe('unknown');
  });
});

// --- 3. the reset flow -----------------------------------------------------
describe('verifyResetCode', () => {
  it('returns the address the link belongs to, so the screen can name it', async () => {
    const { verifyResetCode } = await import('@/src/services/auth/actionLink');
    await expect(verifyResetCode('CODE')).resolves.toEqual({ email: 'user@example.com' });
    expect(verifyPasswordResetCode).toHaveBeenCalledWith({ __fake: true }, 'CODE');
  });

  it('surfaces an expired link before any form is shown', async () => {
    verifyPasswordResetCode.mockRejectedValueOnce(authError('auth/expired-action-code'));
    const { verifyResetCode } = await import('@/src/services/auth/actionLink');
    await expect(verifyResetCode('OLD')).rejects.toMatchObject({ code: 'auth/expired-action-code' });
  });
});

describe('completePasswordReset', () => {
  it('sends the code and the new password to Firebase', async () => {
    const { completePasswordReset } = await import('@/src/services/auth/actionLink');
    await completePasswordReset('CODE', 'Str0ng!Pass');
    expect(confirmPasswordReset).toHaveBeenCalledWith({ __fake: true }, 'CODE', 'Str0ng!Pass');
  });
});

describe('applyEmailActionCode', () => {
  it('applies the code and reports the address', async () => {
    const { applyEmailActionCode } = await import('@/src/services/auth/actionLink');
    await expect(applyEmailActionCode('CODE')).resolves.toEqual({ email: 'user@example.com' });
    expect(applyActionCode).toHaveBeenCalledWith({ __fake: true }, 'CODE');
  });

  it('still applies the code when the read-only lookup fails', async () => {
    // checkActionCode is only there to name the address; losing it must not stop
    // the verification itself.
    checkActionCode.mockRejectedValueOnce(new Error('nope'));
    const { applyEmailActionCode } = await import('@/src/services/auth/actionLink');
    await expect(applyEmailActionCode('CODE')).resolves.toEqual({ email: null });
    expect(applyActionCode).toHaveBeenCalled();
  });
});

// --- 4. error text ---------------------------------------------------------
describe('messageForActionError', () => {
  it('tells the user to request a new link on the dead-end codes', async () => {
    const { messageForActionError } = await import('@/src/services/auth/actionLink');
    // Firebase's own text for expired and invalid codes is near-identical and
    // mentions no way out, which is the only thing the user can act on.
    expect(messageForActionError('auth/expired-action-code')).toMatch(/expired/i);
    expect(messageForActionError('auth/expired-action-code')).toMatch(/request a new/i);
    expect(messageForActionError('auth/invalid-action-code')).toMatch(/request a new/i);
  });

  it('never returns an empty message for an unknown code', async () => {
    const { messageForActionError } = await import('@/src/services/auth/actionLink');
    expect(messageForActionError(undefined)).toMatch(/request a new password reset email/i);
    expect(messageForActionError('auth/something-new')).toBeTruthy();
  });
});


// --- 5. the client-side net ------------------------------------------------
/**
 * The worker only sees links that arrive as a fresh HTTP navigation. A NATIVE
 * deep link never reaches it, and neither does an in-app navigation that already
 * carries the params — so the same payload rule has to exist on the client.
 */
describe('actionLinkRedirect (client net)', () => {
  it('claims a link regardless of which route it landed on', async () => {
    const { actionLinkRedirect } = await import('@/src/services/auth/actionLink');
    expect(actionLinkRedirect({ mode: 'resetPassword', oobCode: 'ABC' }, false)).toEqual({
      mode: 'resetPassword',
      oobCode: 'ABC',
    });
  });

  it('does nothing when the handler is already showing', async () => {
    // This is what keeps it from fighting the worker's redirect: by the time the
    // app boots, the browser is already on /auth/action.
    const { actionLinkRedirect } = await import('@/src/services/auth/actionLink');
    expect(actionLinkRedirect({ mode: 'resetPassword', oobCode: 'ABC' }, true)).toBeNull();
  });

  it('does nothing without an oobCode', async () => {
    const { actionLinkRedirect } = await import('@/src/services/auth/actionLink');
    expect(actionLinkRedirect({ mode: 'resetPassword' }, false)).toBeNull();
    expect(actionLinkRedirect({ mode: 'resetPassword', oobCode: '' }, false)).toBeNull();
    expect(actionLinkRedirect({}, false)).toBeNull();
  });

  it('still forwards a code whose mode is unrecognised', async () => {
    // The handler can then say the link is unusable. Showing the login screen
    // instead — the original bug — tells the user nothing at all.
    const { actionLinkRedirect } = await import('@/src/services/auth/actionLink');
    expect(actionLinkRedirect({ mode: 'somethingNew', oobCode: 'ABC' }, false)).toEqual({
      mode: 'unknown',
      oobCode: 'ABC',
    });
  });

  it('ignores non-string params rather than coercing them', async () => {
    const { actionLinkRedirect } = await import('@/src/services/auth/actionLink');
    expect(actionLinkRedirect({ mode: 'resetPassword', oobCode: ['a', 'b'] as any }, false)).toBeNull();
  });
});
