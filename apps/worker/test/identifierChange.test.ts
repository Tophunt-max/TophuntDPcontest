/**
 * Changing the email address or phone number on an account.
 *
 * These are the account's CREDENTIALS, not profile decoration: the email is what
 * Firebase password reset targets, and `users.phone` is the sole lookup key for
 * phone sign-in and phone password reset. Every `describe` below is a real defect
 * found auditing that flow, so these are regression tests first.
 *
 * The one to read first is "the OTP flow is the only way in". `updateProfile`
 * listed `phone` among its writable columns, so a single unauthenticated-by-OTP
 * request could point any account at any unclaimed number — and then receive that
 * number's login codes. That is an account-takeover primitive sitting inside a
 * "edit your profile" endpoint, and nothing in the test suite would have noticed.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

/**
 * Bypass Firebase token verification: the bearer token is the uid.
 *
 * A `#stale` suffix produces a token with NO `auth_time`, i.e. a session that
 * cannot satisfy the re-authentication gate. Plain uids are treated as having just
 * signed in, so tests that are not about re-auth are unaffected by it.
 */
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const stale = token.endsWith('#stale');
    const [uid, role] = (stale ? token.slice(0, -'#stale'.length) : token).split(':');
    return {
      uid,
      role: role || 'user',
      email: `${uid}@example.com`,
      ...(stale ? {} : { authTime: Math.floor(Date.now() / 1000) }),
    };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const { sentEmails, sentSms, authUpdates, transport } = vi.hoisted(() => ({
  sentEmails: [] as { to: string; subject: string; text?: string }[],
  sentSms: [] as { to: string; body: string }[],
  authUpdates: [] as Record<string, unknown>[],
  // Lets a test simulate a dead provider or an unconfigured one.
  transport: { emailOk: true, smsOk: true, emailConfigured: true, smsConfigured: true },
}));

vi.mock('../src/lib/email', () => ({
  sendEmail: async (_env: unknown, opts: any) => {
    if (!transport.emailOk) return false;
    sentEmails.push({ to: opts.to, subject: opts.subject, text: opts.text });
    return true;
  },
  sendEmailDetailed: async () => ({ ok: true, provider: 'test' }),
  emailConfigured: async () => transport.emailConfigured,
}));

vi.mock('../src/lib/sms', () => ({
  sendSms: async (_env: unknown, to: string, body: string) => {
    if (!transport.smsOk) return false;
    sentSms.push({ to, body });
    return true;
  },
  sendSmsDetailed: async () => ({ ok: true, provider: 'test' }),
  smsConfigured: async () => transport.smsConfigured,
}));

vi.mock('../src/lib/firebaseAdmin', () => ({
  updateAuthUser: async (_env: unknown, uid: string, fields: Record<string, unknown>) => {
    authUpdates.push({ uid, ...fields });
  },
  createAuthUser: async () => 'new-uid',
  createCustomToken: async () => 'custom-token',
  getUserByEmail: async () => null,
  deleteAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import {
  assertValidEmail,
  assertValidPhone,
  normalizeEmail,
} from '../src/lib/identifierChange';

const app = makeApp();

beforeEach(() => {
  sentEmails.length = 0;
  sentSms.length = 0;
  authUpdates.length = 0;
  transport.emailOk = true;
  transport.smsOk = true;
  transport.emailConfigured = true;
  transport.smsConfigured = true;
});

async function api(env: TestEnv, uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function auth(env: TestEnv, uid: string | null, action: string, data: any = {}) {
  const res = await app.request(
    '/auth',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(uid ? { Authorization: `Bearer ${uid}` } : {}),
        'CF-Connecting-IP': '203.0.113.9',
      },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function read(env: TestEnv, uid: string | null, path: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({
      uid,
      username: uid,
      fullName: uid,
      email: `${uid}@example.com`,
      phone: null,
      status: 'active',
      dpcoin: 0,
      createdAt: ts,
      updatedAt: ts,
      ...extra,
    } as any);
}

const userRow = (env: TestEnv, uid: string) =>
  drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();

/** Pull the 6-digit code out of whatever we just "sent". */
const codeFrom = (text: string | undefined) => String(text || '').match(/\b(\d{6})\b/)?.[1] ?? '';
const lastEmailCode = () => codeFrom(sentEmails.at(-1)?.text);
const lastSmsCode = () => codeFrom(sentSms.at(-1)?.body);

/** Clear the per-destination cooldown, to test a limit further down the stack. */
const clearCooldowns = async (env: TestEnv) => {
  for (const key of [...(env.OTP_KV as any)._map.keys()]) {
    if (String(key).startsWith('otpcd:')) await env.OTP_KV.delete(key);
  }
};

// ---------------------------------------------------------------------------
// 1. The OTP flow is the only way in.
// ---------------------------------------------------------------------------

describe('the OTP flow is the only way to change an identifier', () => {
  /**
   * `phone` was in `updateProfile`'s COLUMN_KEYS, so this request set the column
   * directly. Because D1 `users.phone` is what `phoneSignIn`, `sendOtpToPhone` and
   * `updatePasswordWithPhone` all resolve against, claiming an unclaimed number
   * meant claiming its login codes and its password resets.
   */
  it('refuses to change the phone number through updateProfile', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+911111111111' });

    const res = await api(env, 'alice', 'updateProfile', { phone: '+919999999999' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/verification flow/i);
    expect((await userRow(env, 'alice'))?.phone).toBe('+911111111111');
  });

  it('refuses to change the email through updateProfile', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await api(env, 'alice', 'updateProfile', { email: 'attacker@evil.com' });

    expect(res.status).toBe(400);
    expect((await userRow(env, 'alice'))?.email).toBe('alice@example.com');
  });

  /**
   * Rejected loudly rather than dropped on purpose. A client that believes it just
   * changed the user's number, and is told nothing, passes that belief on to the
   * user — who then waits for a login code at a number we never recorded.
   */
  it('rejects rather than silently ignoring, even alongside valid fields', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await api(env, 'alice', 'updateProfile', {
      fullName: 'Alice Cooper',
      phone: '+919999999999',
    });

    expect(res.status).toBe(400);
    // The whole write is refused, so the user is never left half-updated.
    expect((await userRow(env, 'alice'))?.fullName).toBe('alice');
  });

  it('still lets ordinary profile fields through', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await api(env, 'alice', 'updateProfile', {
      fullName: 'Alice Cooper',
      bio: 'hello',
      instagram: 'alice',
    });

    expect(res.status).toBe(200);
    const row = await userRow(env, 'alice');
    expect(row?.fullName).toBe('Alice Cooper');
    expect(row?.bio).toBe('hello');
    expect((row?.extra as any).instagram).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// 2. `extra` must not be able to impersonate a column.
// ---------------------------------------------------------------------------

describe('users.extra cannot shadow a real column', () => {
  /**
   * Any key `updateProfile` did not recognise was stored in the `extra` JSON blob,
   * and `GET /read/users/:id` merged that blob OVER the top level. So the account
   * could assert things about itself and have the API serve them as fact: a
   * verified badge, a coin balance, a follower count, an admin role. The database
   * was never wrong, which is exactly why it went unnoticed — and the poisoned
   * object was written into the shared 30s profile cache, so other viewers read it
   * too.
   */
  it('ignores attempts to write privileged columns', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    const res = await api(env, 'alice', 'updateProfile', {
      verified: true,
      dpcoin: 999999,
      role: 'admin',
      followersCount: 5000,
      status: 'vip',
      isBlocked: false,
      xp: 12345,
    });
    expect(res.status).toBe(200);

    const row = await userRow(env, 'alice');
    expect(row?.verified).toBe(false);
    expect(row?.dpcoin).toBe(0);
    expect(row?.role).toBe('user');
    expect(row?.followersCount).toBe(0);
    // And none of it was smuggled into `extra` either.
    expect(row?.extra ?? {}).toEqual({});

    const profile = await read(env, 'bob', '/users/alice');
    expect(profile.body.verified).toBe(false);
    expect(profile.body.dpcoin).toBe(0);
    expect(profile.body.role).toBe('user');
    expect(profile.body.followersCount).toBe(0);
  });

  it('still merges genuine extra fields into the profile', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    await api(env, 'alice', 'updateProfile', {
      facebook: 'fb.alice',
      twitter: 'tw.alice',
      instagram: 'ig.alice',
    });

    const profile = await read(env, 'bob', '/users/alice');
    expect(profile.body.facebook).toBe('fb.alice');
    expect(profile.body.instagram).toBe('ig.alice');
  });

  /**
   * No backfill migration ships with the write-side fix, so rows already carrying
   * a poisoned blob have to be neutralised on read. Without this the exploit keeps
   * paying out for every account that already used it.
   */
  it('neutralises a blob that was already poisoned before the fix', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', {
      verified: false,
      dpcoin: 5,
      extra: { verified: true, dpcoin: 999999, email: 'attacker@evil.com', facebook: 'fb.alice' },
    });
    await seedUser(env, 'bob');

    const profile = await read(env, 'bob', '/users/alice');

    expect(profile.body.verified).toBe(false);
    expect(profile.body.dpcoin).toBe(5);
    expect(profile.body.email).toBe('alice@example.com');
    // The legitimate key in the same blob still comes through.
    expect(profile.body.facebook).toBe('fb.alice');
  });
});

// ---------------------------------------------------------------------------
// 3. Validation and normalisation.
// ---------------------------------------------------------------------------

describe('email validation', () => {
  it('normalises case and surrounding whitespace', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
  });

  /**
   * The unique index on `users.email` is byte-exact, not NOCASE. So an
   * unnormalised change path could store `Victim@Example.com` alongside an
   * existing `victim@example.com` — two rows for one address, with the index
   * unable to object.
   */
  it('stores a normalised address end to end', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const sent = await auth(env, 'alice', 'sendEmailOtp', { newEmail: '  New.Alice@EXAMPLE.com ' });
    expect(sent.status).toBe(200);
    const confirmed = await auth(env, 'alice', 'verifyEmailOtp', { otp: lastEmailCode() });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.email).toBe('new.alice@example.com');
    expect((await userRow(env, 'alice'))?.email).toBe('new.alice@example.com');
  });

  it('rejects malformed addresses', () => {
    for (const bad of ['', '   ', 'nope', 'a@b', 'a@@b.com', 'a b@c.com', 'a@b .com', '@b.com']) {
      expect(() => assertValidEmail(bad), `${JSON.stringify(bad)} should be rejected`).toThrow();
    }
  });

  it('accepts ordinary addresses', () => {
    for (const good of ['a@b.co', 'first.last+tag@sub.example.co.uk', 'A_B@Example.Com']) {
      expect(() => assertValidEmail(good)).not.toThrow();
    }
  });

  /**
   * Signup rejects disposable domains. Applying that only at signup is no policy
   * at all: the change path was the way around it.
   */
  it('applies the disposable-domain policy on the change path too', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await auth(env, 'alice', 'sendEmailOtp', { newEmail: ' Foo@Mailinator.COM ' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/temporary email/i);
    expect(sentEmails).toEqual([]);
  });

  /**
   * Sending a code to the address ALREADY on the account is not an error — it is
   * the only way to verify an address that was never confirmed. This used to throw
   * "That is already your email address", which left an unverified email
   * un-verifiable: the one endpoint that could send a code refused to send one to
   * the address that needed it.
   */
  it('sends a verify-only code for the address already on file', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'ALICE@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.verifyOnly).toBe(true);
    expect(sentEmails.length).toBe(1);
    expect(sentEmails[0].to).toBe('alice@example.com');
  });
});

describe('verifying the identifier already on the account', () => {
  /**
   * The profile screen shows "Not verified — tap to send a code" for an address
   * that was never confirmed. That hint was inert, because the only path to a code
   * refused an unchanged address. This is the whole point of the verify-only path.
   */
  it('marks an unchanged email verified without moving it or alerting anyone', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    expect((await userRow(env, 'alice'))?.emailVerified).toBe(false);

    const sent = await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'alice@example.com' });
    expect(sent.body.verifyOnly).toBe(true);
    const confirmed = await auth(env, 'alice', 'verifyEmailOtp', { otp: lastEmailCode() });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.verifyOnly).toBe(true);
    const row = await userRow(env, 'alice');
    expect(row?.email).toBe('alice@example.com');
    expect(row?.emailVerified).toBe(true);
    expect(row?.emailVerifiedAt).toBeGreaterThan(0);
    // Nothing moved, so Firebase is untouched and no security alert is sent.
    expect(authUpdates).toEqual([]);
    expect(sentEmails.length).toBe(1); // only the code itself
  });

  it('marks an unchanged phone verified the same way', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919999900001' });

    const sent = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+91 99999 00001' });
    expect(sent.body.verifyOnly).toBe(true);
    const confirmed = await auth(env, 'alice', 'verifyPhoneOtp', { otp: lastSmsCode() });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.verifyOnly).toBe(true);
    const row = await userRow(env, 'alice');
    expect(row?.phone).toBe('+919999900001');
    expect(row?.phoneVerified).toBe(true);
    expect(authUpdates).toEqual([]);
  });

  /**
   * The re-auth gate protects credential MOVEMENT. Proving the identifier you
   * already have takes nothing away from anyone, so it must not require a recent
   * sign-in — otherwise a stale session could never clear its own "unverified"
   * warning.
   */
  it('does not require re-authentication for a verify-only send', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await auth(env, 'alice#stale', 'sendEmailOtp', { newEmail: 'alice@example.com' });

    expect(res.status).toBe(200);
    expect(res.body.verifyOnly).toBe(true);
  });
});

describe('phone validation', () => {
  /**
   * `normalizePhone` only strips non-digits, so it returns a truthy value for "+"
   * or "1". The change path accepted those and paid to send an SMS to them, while
   * the login OTP path had the length guard all along.
   */
  it('rejects numbers that are not plausibly dialable', () => {
    for (const bad of ['', '+', '1', '12345', 'abcdef', '+' + '9'.repeat(20)]) {
      expect(() => assertValidPhone(bad), `${JSON.stringify(bad)} should be rejected`).toThrow();
    }
  });

  it('accepts and normalises a real number', () => {
    expect(assertValidPhone(' +91 99999-88888 ')).toBe('+919999988888');
  });

  it('does not send an SMS to a number it just rejected', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const res = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+1' });
    expect(res.status).toBe(400);
    expect(sentSms).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Uniqueness.
// ---------------------------------------------------------------------------

describe('uniqueness', () => {
  /**
   * `assertIdentifiersAvailable` existed and was called at signup and on profile
   * edit — but not here. A duplicate therefore surfaced as a raw
   * `UNIQUE constraint failed` 500, after the single-use code had been spent.
   */
  it('refuses a taken email BEFORE spending a code or an email', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob', { email: 'taken@example.com' });

    const res = await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'taken@example.com' });

    expect(res.status).toBe(409);
    expect(sentEmails).toEqual([]);
    // Nothing stored, so no cooldown was burned on a request that could not work.
    expect([...(env.OTP_KV as any)._map.keys()]).toEqual([]);
  });

  it('refuses a taken phone number before sending an SMS', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob', { phone: '+919999988888' });

    const res = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999988888' });

    expect(res.status).toBe(409);
    expect(sentSms).toEqual([]);
  });

  /**
   * The ten-minute window the send-time check cannot cover: the address was free
   * when the code was issued and taken by the time it was entered. Re-checking at
   * confirm time is what stops that becoming a 500 with the Firebase login already
   * moved.
   */
  it('re-checks at confirm time, and does not touch Firebase when it fails', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    const sent = await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'contested@example.com' });
    expect(sent.status).toBe(200);
    const code = lastEmailCode();

    // Someone else takes it in the meantime.
    await drizzleOf(env)
      .update(schema.users)
      .set({ email: 'contested@example.com' })
      .where(eq(schema.users.uid, 'bob'));

    const res = await auth(env, 'alice', 'verifyEmailOtp', { otp: code });

    expect(res.status).toBe(409);
    expect(authUpdates).toEqual([]);
    expect((await userRow(env, 'alice'))?.email).toBe('alice@example.com');
  });
});

// ---------------------------------------------------------------------------
// 5. Abuse and cost.
// ---------------------------------------------------------------------------

describe('send abuse controls', () => {
  /**
   * The one that mattered most. Every limit used to be keyed on the CALLER's uid,
   * so the per-uid cooldown did nothing to protect a TARGET: N accounts could all
   * point us at the same number, and one account could walk through many different
   * numbers a minute apart. Each SMS is our money and someone else's phone.
   */
  it('stops several accounts texting the same number', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'mallory');

    const first = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999900001' });
    expect(first.status).toBe(200);

    const second = await auth(env, 'mallory', 'sendPhoneOtp', { newPhone: '+919999900001' });
    expect(second.status).toBe(429);
    expect(sentSms.length).toBe(1);
  });

  it('stops one account texting many different numbers in a burst', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    expect((await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999900001' })).status).toBe(200);
    const second = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999900002' });

    expect(second.status).toBe(429);
    expect(sentSms.length).toBe(1);
  });

  /** A per-destination daily cap behind the cooldown, so waiting it out is finite. */
  it('caps sends to one destination per day', async () => {
    const { env } = makeEnv();
    for (const uid of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) await seedUser(env, uid);

    const statuses: number[] = [];
    for (const uid of ['u1', 'u2', 'u3', 'u4', 'u5', 'u6']) {
      await clearCooldowns(env);
      statuses.push((await auth(env, uid, 'sendPhoneOtp', { newPhone: '+919999900009' })).status);
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
  });

  it('applies the same protection to email', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'mallory');

    expect((await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'victim@example.com' })).status).toBe(200);
    expect((await auth(env, 'mallory', 'sendEmailOtp', { newEmail: 'victim@example.com' })).status).toBe(429);
    expect(sentEmails.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Delivery failure.
// ---------------------------------------------------------------------------

describe('delivery failure', () => {
  /**
   * `sendEmail` / `sendSms` return a boolean and never throw, and both callers
   * ignored it. A dead provider stored the code, started the 60s cooldown, returned
   * `{success:true}` and opened the "enter the code" sheet — for a code that would
   * never arrive. Ten blind retries later the user was locked out for the hour,
   * with the only trace a Worker log line.
   */
  it('reports a failed SMS instead of claiming success', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    transport.smsOk = false;

    const res = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999900001' });

    expect(res.status).toBe(500);
    expect(res.body.error.message).toMatch(/couldn't send/i);
  });

  /** And leaves the user able to retry AT ONCE, rather than behind a dead cooldown. */
  it('clears the stored code and the cooldown so a retry works immediately', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    transport.smsOk = false;
    await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999900001' });
    expect([...(env.OTP_KV as any)._map.keys()]).toEqual([]);

    transport.smsOk = true;
    const retry = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999900001' });
    expect(retry.status).toBe(200);
    expect(sentSms.length).toBe(1);
  });

  it('refuses up front when no provider is configured', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    transport.smsConfigured = false;

    const res = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999900001' });

    expect(res.status).toBe(500);
    // Nothing stored, so the user is not left holding a cooldown for a code that
    // was never going to be sent.
    expect([...(env.OTP_KV as any)._map.keys()]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 7. Firebase / D1 consistency.
// ---------------------------------------------------------------------------

describe('Firebase and D1 stay in agreement', () => {
  it('moves the email in both places', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'new@example.com' });
    const res = await auth(env, 'alice', 'verifyEmailOtp', { otp: lastEmailCode() });

    expect(res.status).toBe(200);
    expect((await userRow(env, 'alice'))?.email).toBe('new@example.com');
    expect(authUpdates).toEqual([{ uid: 'alice', email: 'new@example.com' }]);
  });

  /**
   * Firebase owns the email for sign-in and password reset, so a D1 failure after
   * the Firebase write left the user signing in with an address their own profile
   * denied — and no screen able to explain it.
   */
  it('rolls the Firebase email back when the D1 write fails', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'new@example.com' });
    const code = lastEmailCode();

    const original = env.DB.prepare;
    (env as any).DB.prepare = (sql: string) => {
      if (/update\s+"?users"?\s+set/i.test(sql) && /email/i.test(sql)) {
        throw new Error('d1 exploded');
      }
      return original.call(env.DB, sql);
    };

    const res = await auth(env, 'alice', 'verifyEmailOtp', { otp: code });
    (env as any).DB.prepare = original;

    expect(res.status).toBe(500);
    // Forward, then back to where it started.
    expect(authUpdates).toEqual([
      { uid: 'alice', email: 'new@example.com' },
      { uid: 'alice', email: 'alice@example.com' },
    ]);
    expect((await userRow(env, 'alice'))?.email).toBe('alice@example.com');
  });

  /**
   * `updateAuthUser` had no `phoneNumber` parameter, so the number could never be
   * synced. The old one stayed attached to the Firebase identity forever, which
   * made it un-signup-able for whoever the carrier gave it to next.
   */
  it('syncs the phone number to Firebase as well as D1', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+911111111111' });

    await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999988888' });
    const res = await auth(env, 'alice', 'verifyPhoneOtp', { otp: lastSmsCode() });

    expect(res.status).toBe(200);
    expect((await userRow(env, 'alice'))?.phone).toBe('+919999988888');
    expect(authUpdates).toEqual([{ uid: 'alice', phoneNumber: '+919999988888' }]);
  });

  /**
   * Best-effort on purpose: D1 is the source of truth for phone sign-in, so a
   * Firebase hiccup must not fail a change whose authoritative write has already
   * committed.
   */
  it('completes the phone change even if the Firebase sync fails', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const admin = await import('../src/lib/firebaseAdmin');
    const spy = vi
      .spyOn(admin, 'updateAuthUser')
      .mockRejectedValueOnce(new Error('identity toolkit down'));

    await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999988888' });
    const res = await auth(env, 'alice', 'verifyPhoneOtp', { otp: lastSmsCode() });

    expect(res.status).toBe(200);
    expect((await userRow(env, 'alice'))?.phone).toBe('+919999988888');
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// 8. Verification state.
// ---------------------------------------------------------------------------

describe('verification is recorded', () => {
  /**
   * Nothing recorded this before. An address typed at signup and never confirmed
   * was indistinguishable from a proven one — while still being the address
   * Firebase password reset targets. The Worker could not gate anything on it
   * because it genuinely did not know.
   */
  it('starts unverified and becomes verified only through the OTP', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const before = await userRow(env, 'alice');
    expect(before?.emailVerified).toBe(false);
    expect(before?.emailVerifiedAt).toBeNull();

    await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'new@example.com' });
    await auth(env, 'alice', 'verifyEmailOtp', { otp: lastEmailCode() });

    const after = await userRow(env, 'alice');
    expect(after?.emailVerified).toBe(true);
    expect(after?.emailVerifiedAt).toBeGreaterThan(0);
    // Verifying one identifier says nothing about the other.
    expect(after?.phoneVerified).toBe(false);
  });

  it('records phone verification independently', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999988888' });
    await auth(env, 'alice', 'verifyPhoneOtp', { otp: lastSmsCode() });

    const row = await userRow(env, 'alice');
    expect(row?.phoneVerified).toBe(true);
    expect(row?.emailVerified).toBe(false);
  });

  it('does not mark anything verified on a wrong code', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'new@example.com' });
    const res = await auth(env, 'alice', 'verifyEmailOtp', { otp: '000000' });

    expect(res.status).toBe(400);
    const row = await userRow(env, 'alice');
    expect(row?.emailVerified).toBe(false);
    expect(row?.email).toBe('alice@example.com');
  });
});

// ---------------------------------------------------------------------------
// 9. Telling the owner.
// ---------------------------------------------------------------------------

describe('the account holder is told', () => {
  /**
   * The only defence a victim has against a session hijack that swaps the
   * credentials. Nothing notified anyone before: an attacker with a briefly
   * unlocked phone could move the email to their own, and the owner's first
   * indication would be a password reset that no longer worked.
   */
  it('alerts the OLD email address after the change', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'new@example.com' });
    const code = lastEmailCode();
    sentEmails.length = 0;
    const confirmed = await auth(env, 'alice', 'verifyEmailOtp', { otp: code });
    expect(confirmed.status).toBe(200);

    const alert = sentEmails.find((m) => m.to === 'alice@example.com');
    expect(alert, 'no alert was sent to the old address').toBeTruthy();
    expect(alert!.subject).toMatch(/changed/i);
    // Masked: the alert goes to an address that may no longer be the owner's, so
    // it must not hand over the full new one.
    expect(alert!.text).not.toContain('new@example.com');
  });

  it('alerts the OLD phone number after the change', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+911111111111' });

    await auth(env, 'alice', 'sendPhoneOtp', { newPhone: '+919999988888' });
    const code = lastSmsCode();
    sentSms.length = 0;
    await auth(env, 'alice', 'verifyPhoneOtp', { otp: code });

    const alert = sentSms.find((m) => m.to === '+911111111111');
    expect(alert, 'no alert was sent to the old number').toBeTruthy();
    expect(alert!.body).toMatch(/changed/i);
    expect(alert!.body).not.toContain('+919999988888');
  });

  it('leaves an in-app record inside the account', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'new@example.com' });
    await auth(env, 'alice', 'verifyEmailOtp', { otp: lastEmailCode() });

    const rows = await drizzleOf(env)
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.recipientId, 'alice'))
      .all();
    expect(rows.some((r) => /email address was changed/i.test(String(r.title)))).toBe(true);
  });

  /**
   * The public profile is served from a shared KV entry, so without invalidation
   * the old address kept being handed out until the TTL lapsed.
   */
  it('drops the cached profile so the old address stops being served', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    await read(env, 'bob', '/users/alice'); // warm the cache
    await auth(env, 'alice', 'sendEmailOtp', { newEmail: 'new@example.com' });
    await auth(env, 'alice', 'verifyEmailOtp', { otp: lastEmailCode() });

    const profile = await read(env, 'bob', '/users/alice');
    expect(profile.body.email).toBe('new@example.com');
  });
});
