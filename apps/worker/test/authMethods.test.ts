/**
 * Admin-managed sign-in / sign-up methods (lib/authMethods.ts): what the app is
 * told (GET /read/app-config), what an admin may save (POST /admin/app-settings),
 * and — the part a hidden button cannot do — the server refusing NEW accounts
 * through a method that is switched off.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

// Token format in this file: "<uid>" or "<uid>|<sign_in_provider>".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, provider] = token.split('|');
    return { uid, role: 'user', signInProvider: provider || undefined };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const { sms, authCalls } = vi.hoisted(() => ({
  sms: [] as { to: string; body: string }[],
  authCalls: [] as { fn: string; arg: any }[],
}));

vi.mock('../src/lib/sms', () => ({
  sendSms: async (_e: unknown, to: string, body: string) => {
    sms.push({ to, body });
    return true;
  },
  sendSmsDetailed: async () => ({ ok: true, provider: 'test' }),
  smsConfigured: async () => true,
}));
vi.mock('../src/lib/email', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, provider: 'test' }),
  emailConfigured: async () => true,
}));
vi.mock('../src/lib/firebaseAdmin', () => ({
  // createProfile reads email/phone from Firebase's record, not the body.
  lookupAuthUser: async (_env: unknown, uid: string) => ({ email: `${uid}@example.com`, emailVerified: false, phoneNumber: null }),
  revokeRefreshTokens: async () => undefined,
  createAuthUser: async (_e: unknown, input: any) => {
    authCalls.push({ fn: 'createAuthUser', arg: input });
    return `fb_${input.phone || input.email || 'x'}`;
  },
  createCustomToken: async (_e: unknown, uid: string) => `token_${uid}`,
  updateAuthUser: async () => undefined,
  getUserByEmail: async () => null,
  deleteAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { resolveAuthMethods, validateAuthMethods, signupMethodForProvider } from '../src/lib/authMethods';

const app = makeApp();
beforeEach(() => {
  sms.length = 0;
  authCalls.length = 0;
});

let ipSeq = 1;
async function auth(env: TestEnv, action: string, data: any = {}, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': `198.51.100.${ipSeq++ % 250}` };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await app.request('/auth', { method: 'POST', headers, body: JSON.stringify({ action, ...data }) }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function api(env: TestEnv, token: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ action, ...data }) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function admin(env: TestEnv, method: string, path: string, body?: unknown) {
  const res = await app.request(
    `/admin${path}`,
    { method, headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' }, body: body === undefined ? undefined : JSON.stringify(body) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const appConfig = async (env: TestEnv) => (await (await app.request('/read/app-config', {}, env, fakeCtx())).json()) as any;
const setMethods = (env: TestEnv, authMethods: any) => admin(env, 'POST', '/app-settings', { authMethods });
const userRow = (env: TestEnv, uid: string) => drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get() as Promise<any>;
const lastCode = () => String(sms.at(-1)?.body || '').match(/\b(\d{6})\b/)?.[1] ?? '';
const profile = (name: string, extra: Record<string, any> = {}) => ({ username: name, fullName: name, platform: 'web', ...extra });

describe('resolveAuthMethods', () => {
  it('keeps the legacy flags for configs saved before authMethods existed', () => {
    const m = resolveAuthMethods({});
    expect(m.google.enabled).toBe(true);
    // Apple needs the Firebase provider enabled first, so it is opt-in.
    expect(m.apple.enabled).toBe(false);
    expect(resolveAuthMethods({ authMethods: { apple: { enabled: true } } }).apple.enabled).toBe(true);
    // Facebook was opt-in (`facebookLogin === true`), and stays off until turned on.
    expect(m.facebook.enabled).toBe(false);
    expect(m.signupsEnabled).toBe(true);
    expect(resolveAuthMethods({ googleLogin: false, facebookLogin: true }).google.enabled).toBe(false);
    expect(resolveAuthMethods({ facebookLogin: true }).facebook.enabled).toBe(true);
  });

  it('per-platform switches override, and new settings win over legacy ones', () => {
    const m = resolveAuthMethods({ googleLogin: false, authMethods: { google: { enabled: true, ios: false } } });
    expect(m.google).toEqual({ enabled: true, web: true, android: true, ios: false });
  });

  it('maps Firebase sign-in providers to the method that creates the account', () => {
    expect(signupMethodForProvider('google.com')).toBe('google');
    expect(signupMethodForProvider('password')).toBe('emailSignup');
    expect(signupMethodForProvider('custom')).toBe('phone');
    expect(signupMethodForProvider('anonymous')).toBeNull();
  });

  it('refuses a configuration that leaves a platform with no way to sign in', () => {
    const allOff = { google: { enabled: false }, facebook: { enabled: false }, apple: { enabled: false }, phone: { enabled: false }, password: { ios: false } };
    expect(validateAuthMethods(allOff, { authMethods: allOff })).toMatch(/ios/);
    expect(validateAuthMethods({ google: { enabled: 'yes' } }, {})).toMatch(/true or false/);
    expect(validateAuthMethods({ bogus: true }, {})).toMatch(/not a known setting/);
    expect(validateAuthMethods({ google: { enabled: false } }, { authMethods: { google: { enabled: false } } })).toBeNull();
  });
});

describe('admin control + what the app is told', () => {
  it('a saved switch reaches /read/app-config in the new AND the legacy shape', async () => {
    const { env } = makeEnv();
    expect((await setMethods(env, { google: { enabled: false }, apple: { enabled: true, web: false } })).status).toBe(200);
    const cfg = await appConfig(env);
    expect(cfg.authMethods.google.enabled).toBe(false);
    expect(cfg.authMethods.apple).toEqual({ enabled: true, web: false, android: true, ios: true });
    // Already-shipped builds read `authSettings`.
    expect(cfg.authSettings.googleLogin).toBe(false);
    expect(cfg.authSettings.appleLogin).toBe(true); // saved on, web off: on somewhere
    expect(cfg.googleLogin).toBe(false);
  });

  it('rejects a lock-out and unknown keys, and audits a change', async () => {
    const { env } = makeEnv();
    const lockout = await setMethods(env, {
      google: { enabled: false }, facebook: { enabled: false }, apple: { enabled: false }, phone: { enabled: false }, password: { enabled: false },
    });
    expect(lockout.status).toBe(400);
    expect((await setMethods(env, { google: { enabled: 1 } })).status).toBe(400);
    expect((await setMethods(env, { signupsEnabled: false, signupsClosedMessage: 'Kal aana' })).status).toBe(200);
    const audit = await env.DB.prepare("SELECT action FROM admin_audit_log WHERE action = 'settings.authMethods.update'").all<any>();
    expect(audit.results.length).toBe(1);
    const m = await admin(env, 'GET', '/auth-methods');
    expect(m.body.methods.signupsEnabled).toBe(false);
    expect(Array.isArray(m.body.signups30d)).toBe(true);
  });
});

describe('server enforcement of sign-up switches', () => {
  it('email sign-up off: `create` is refused before any Firebase account is made', async () => {
    const { env } = makeEnv();
    await setMethods(env, { emailSignup: { enabled: false } });
    const r = await auth(env, 'create', { email: 'new@example.com', password: 'Str0ng!Pass', username: 'newbie', platform: 'web' });
    expect(r.status).toBe(412);
    expect(r.body.error?.message || r.body.message || JSON.stringify(r.body)).toMatch(/Email se naya account/);
    expect(authCalls.filter((c) => c.fn === 'createAuthUser')).toHaveLength(0);
  });

  it('email sign-up on: the account is created and its provider recorded', async () => {
    const { env } = makeEnv();
    const r = await auth(env, 'create', { email: 'new@example.com', password: 'Str0ng!Pass', username: 'newbie', platform: 'web' });
    expect(r.status).toBe(200);
    expect((await userRow(env, r.body.uid)).authProvider).toBe('password');
  });

  it('Google off: a Google token cannot create a profile; a Google token is fine when on', async () => {
    const { env } = makeEnv();
    await setMethods(env, { google: { enabled: false } });
    expect((await auth(env, 'createProfile', profile('gina'), 'g1|google.com')).status).toBe(412);
    expect(await userRow(env, 'g1')).toBeUndefined();
    // Another method still works.
    expect((await auth(env, 'createProfile', profile('apu'), 'a1|custom')).status).toBe(200);
    expect((await userRow(env, 'a1')).authProvider).toBe('custom');
    // Apple is opt-in: refused until switched on.
    expect((await auth(env, 'createProfile', profile('appl'), 'p1|apple.com')).status).toBe(412);
  });

  it('a platform switch is honoured for the platform the app reports', async () => {
    const { env } = makeEnv();
    await setMethods(env, { apple: { enabled: true, web: false } });
    expect((await auth(env, 'createProfile', profile('webby', { platform: 'web' }), 'w1|apple.com')).status).toBe(412);
    expect((await auth(env, 'createProfile', profile('iossy', { platform: 'ios' }), 'i1|apple.com')).status).toBe(200);
  });

  it('signups closed: nobody new gets in, but a finished account re-running createProfile is not refused', async () => {
    const { env } = makeEnv();
    expect((await auth(env, 'createProfile', profile('early'), 'e1|google.com')).status).toBe(200);
    await setMethods(env, { signupsEnabled: false, signupsClosedMessage: 'Registration band hai' });
    const late = await auth(env, 'createProfile', profile('late'), 'l1|google.com');
    expect(late.status).toBe(412);
    expect(JSON.stringify(late.body)).toMatch(/Registration band hai/);
    expect((await auth(env, 'createProfile', profile('early'), 'e1|google.com')).status).toBe(200);
  });

  it('signups closed also blocks the profile auto-create fallback (completeSignup with no row)', async () => {
    const { env } = makeEnv();
    await setMethods(env, { signupsEnabled: false });
    const r = await api(env, 'ghost|google.com', 'completeSignup', {});
    expect(r.status).toBe(412);
    expect(await userRow(env, 'ghost')).toBeUndefined();
  });

  it('phone off: no SMS is sent at all', async () => {
    const { env } = makeEnv();
    await setMethods(env, { phone: { enabled: false } });
    const r = await auth(env, 'sendPhoneLoginOtp', { phone: '+919876543210', platform: 'android' });
    expect(r.status).toBe(412);
    expect(sms).toHaveLength(0);
  });

  it('signups closed: a known number still signs in by phone, an unknown one is refused after the code', async () => {
    const { env } = makeEnv();
    const ts = Date.now();
    await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid: 'known', username: 'known', phone: '+919876543210', status: 'active', signupCompleted: true, createdAt: ts, updatedAt: ts } as any);
    await setMethods(env, { signupsEnabled: false });

    await auth(env, 'sendPhoneLoginOtp', { phone: '+919876543210' });
    const ok = await auth(env, 'phoneSignIn', { phone: '+919876543210', code: lastCode() });
    expect(ok.status).toBe(200);
    expect(ok.body.uid).toBe('known');

    await auth(env, 'sendPhoneLoginOtp', { phone: '+919811111111' });
    const no = await auth(env, 'phoneSignIn', { phone: '+919811111111', code: lastCode() });
    expect(no.status).toBe(412);
    expect(authCalls.filter((c) => c.fn === 'createAuthUser')).toHaveLength(0);
  });
});
