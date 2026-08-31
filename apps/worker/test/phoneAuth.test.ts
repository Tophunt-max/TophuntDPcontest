/**
 * Phone-OTP auth flows: LOGIN and password RESET.
 *
 * These two had no test coverage at all, despite being the paths where a wrong
 * OTP scope or a mis-keyed lookup would either lock everyone out or let anyone in.
 * The most important assertions here are the cross-flow ones: a code minted to log
 * in must not reset a password, and a code minted to reset must not sign anyone in.
 *
 * The phone-CHANGE and RE-AUTH flows are covered in identifierChange.test.ts and
 * reauth.test.ts; this file is the login + reset half.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const { sms, transport, authCalls } = vi.hoisted(() => ({
  sms: [] as { to: string; body: string }[],
  transport: { smsOk: true, smsConfigured: true },
  authCalls: [] as { fn: string; arg: any }[],
}));

vi.mock('../src/lib/sms', () => ({
  sendSms: async (_e: unknown, to: string, body: string) => {
    if (!transport.smsOk) return false;
    sms.push({ to, body });
    return true;
  },
  sendSmsDetailed: async () => ({ ok: transport.smsOk, provider: 'test' }),
  smsConfigured: async () => transport.smsConfigured,
}));

vi.mock('../src/lib/email', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, provider: 'test' }),
  emailConfigured: async () => true,
}));

vi.mock('../src/lib/firebaseAdmin', () => ({
  createAuthUser: async (_e: unknown, input: any) => {
    authCalls.push({ fn: 'createAuthUser', arg: input });
    return `fb_${input.phone || 'x'}`;
  },
  createCustomToken: async (_e: unknown, uid: string) => {
    authCalls.push({ fn: 'createCustomToken', arg: uid });
    return `token_${uid}`;
  },
  updateAuthUser: async (_e: unknown, uid: string, fields: any) => {
    authCalls.push({ fn: 'updateAuthUser', arg: { uid, fields } });
  },
  getUserByEmail: async () => null,
  deleteAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

beforeEach(() => {
  sms.length = 0;
  authCalls.length = 0;
  transport.smsOk = true;
  transport.smsConfigured = true;
});

async function auth(env: TestEnv, action: string, data: any = {}, ip = '203.0.113.4') {
  const res = await app.request(
    '/auth',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({
      uid,
      username: uid,
      fullName: uid,
      status: 'active',
      dpcoin: 0,
      createdAt: ts,
      updatedAt: ts,
      ...extra,
    } as any);
}

const userRow = (env: TestEnv, uid: string) =>
  drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();
const lastCode = () => String(sms.at(-1)?.body || '').match(/\b(\d{6})\b/)?.[1] ?? '';

/** Clear per-destination cooldowns so a cap further down the stack can be tested. */
const clearCooldowns = async (env: TestEnv) => {
  for (const key of [...(env.OTP_KV as any)._map.keys()]) {
    if (String(key).startsWith('otpcd:')) await env.OTP_KV.delete(key);
  }
};

// ---------------------------------------------------------------------------
// LOGIN
// ---------------------------------------------------------------------------

describe('phone login', () => {
  it('signs in an existing user and marks the number verified', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111', signupCompleted: true });

    const sent = await auth(env, 'sendPhoneLoginOtp', { phone: '+919990001111' });
    expect(sent.status).toBe(200);
    expect(sms.length).toBe(1);

    const signin = await auth(env, 'phoneSignIn', { phone: '+919990001111', code: lastCode() });
    expect(signin.status).toBe(200);
    expect(signin.body.customToken).toBe('token_alice');
    expect(signin.body.isNewUser).toBe(false);
    expect(signin.body.signupCompleted).toBe(true);

    // Receiving and entering a code on this number proves control of it.
    expect((await userRow(env, 'alice'))?.phoneVerified).toBe(true);
  });

  it('creates a Firebase identity for an unrecognised number', async () => {
    const { env } = makeEnv();

    await auth(env, 'sendPhoneLoginOtp', { phone: '+919992223333' });
    const signin = await auth(env, 'phoneSignIn', { phone: '+919992223333', code: lastCode() });

    expect(signin.status).toBe(200);
    expect(signin.body.isNewUser).toBe(true);
    expect(authCalls.some((c) => c.fn === 'createAuthUser')).toBe(true);
  });

  it('rejects a wrong code and never signs in', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });
    await auth(env, 'sendPhoneLoginOtp', { phone: '+919990001111' });

    const res = await auth(env, 'phoneSignIn', { phone: '+919990001111', code: '000000' });
    expect(res.status).toBe(400);
    expect(res.body.customToken).toBeUndefined();
  });

  it('refuses a blocked account even with the right code', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111', isBlocked: true, status: 'blocked' });
    await auth(env, 'sendPhoneLoginOtp', { phone: '+919990001111' });

    const res = await auth(env, 'phoneSignIn', { phone: '+919990001111', code: lastCode() });
    expect(res.status).toBe(403);
  });

  it('reports a failed send and clears the cooldown so retry is immediate', async () => {
    const { env } = makeEnv();
    transport.smsOk = false;

    const failed = await auth(env, 'sendPhoneLoginOtp', { phone: '+919990001111' });
    expect(failed.status).toBe(500);

    transport.smsOk = true;
    const retry = await auth(env, 'sendPhoneLoginOtp', { phone: '+919990001111' });
    expect(retry.status).toBe(200); // not blocked by a leftover 60s cooldown
    expect(sms.length).toBe(1);
  });

  it('rejects a malformed number before sending', async () => {
    const { env } = makeEnv();
    const res = await auth(env, 'sendPhoneLoginOtp', { phone: '+1' });
    expect(res.status).toBe(400);
    expect(sms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PASSWORD RESET
// ---------------------------------------------------------------------------

describe('password reset by phone', () => {
  it('sends a code to a registered number', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });

    const res = await auth(env, 'sendOtpToPhone', { phone: '+919990001111' });
    expect(res.status).toBe(200);
    expect(sms.length).toBe(1);
  });

  /** Anti-enumeration: an unknown number gets the same success, but no SMS. */
  it('returns the same success for an unknown number without sending', async () => {
    const { env } = makeEnv();
    const res = await auth(env, 'sendOtpToPhone', { phone: '+915550009999' });
    expect(res.status).toBe(200);
    expect(sms).toEqual([]);
  });

  it('reports a failed send to a registered number and clears the cooldown', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });
    transport.smsOk = false;

    const failed = await auth(env, 'sendOtpToPhone', { phone: '+919990001111' });
    expect(failed.status).toBe(500);
    // No stored code left behind for a message that never went.
    expect([...(env.OTP_KV as any)._map.keys()].some((k) => String(k).startsWith('otp:pwreset:'))).toBe(false);

    transport.smsOk = true;
    const retry = await auth(env, 'sendOtpToPhone', { phone: '+919990001111' });
    expect(retry.status).toBe(200);
    expect(sms.length).toBe(1);
  });

  it('caps sends to one number per day', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });

    const statuses: number[] = [];
    for (let i = 0; i < 9; i++) {
      await clearCooldowns(env); // step past the 60s cooldown, exercise the daily cap
      statuses.push((await auth(env, 'sendOtpToPhone', { phone: '+919990001111' })).status);
    }
    expect(statuses.slice(0, 8).every((s) => s === 200)).toBe(true);
    expect(statuses[8]).toBe(429);
  });

  it('requires a verified OTP before the password can be changed', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });
    await auth(env, 'sendOtpToPhone', { phone: '+919990001111' });

    // Knowing only the number, without passing the code, must not authorise it.
    const premature = await auth(env, 'updatePasswordWithPhone', {
      phone: '+919990001111',
      newPassword: 'Str0ng!Pass9',
    });
    expect(premature.status).toBe(403);

    await auth(env, 'verifyOtp', { phone: '+919990001111', code: lastCode() });
    const done = await auth(env, 'updatePasswordWithPhone', {
      phone: '+919990001111',
      newPassword: 'Str0ng!Pass9',
    });
    expect(done.status).toBe(200);
    expect(authCalls.some((c) => c.fn === 'updateAuthUser' && c.arg.fields.password)).toBe(true);
  });

  it('cannot be replayed: the verified flag is consumed once', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });
    await auth(env, 'sendOtpToPhone', { phone: '+919990001111' });
    await auth(env, 'verifyOtp', { phone: '+919990001111', code: lastCode() });

    const first = await auth(env, 'updatePasswordWithPhone', { phone: '+919990001111', newPassword: 'Str0ng!Pass9' });
    expect(first.status).toBe(200);
    const second = await auth(env, 'updatePasswordWithPhone', { phone: '+919990001111', newPassword: 'An0ther!Pass9' });
    expect(second.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// CROSS-FLOW ISOLATION — the assertions that matter most
// ---------------------------------------------------------------------------

describe('codes cannot cross between flows', () => {
  /**
   * Login stores its code under scope `phone`, id `login:<number>`; reset verifies
   * scope `pwreset`, id `<number>`. Disjoint, so a login code must not clear a
   * password.
   */
  it('a login code does not verify a password reset', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });

    await auth(env, 'sendPhoneLoginOtp', { phone: '+919990001111' });
    const loginCode = lastCode();

    const res = await auth(env, 'verifyOtp', { phone: '+919990001111', code: loginCode });
    expect(res.status).not.toBe(200);
  });

  /** And a reset code must not sign anyone in. */
  it('a reset code does not sign in', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });

    await auth(env, 'sendOtpToPhone', { phone: '+919990001111' });
    const resetCode = lastCode();

    const res = await auth(env, 'phoneSignIn', { phone: '+919990001111', code: resetCode });
    expect(res.status).not.toBe(200);
    expect(res.body.customToken).toBeUndefined();
  });

  /** No login code was ever issued, so sign-in has nothing to verify against. */
  it('sign-in fails when no login code was requested', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919990001111' });

    const res = await auth(env, 'phoneSignIn', { phone: '+919990001111', code: '123456' });
    expect(res.status).not.toBe(200);
  });
});
