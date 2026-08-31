/**
 * Re-authentication before an irreversible or credential-level action.
 *
 * Two actions can lose someone their account: deleting it, and moving the email or
 * phone number it signs in with. Both were reachable from any signed-in session,
 * however old — so the practical requirement for taking over an account was a
 * session, and nothing stood between one and the account being gone.
 *
 * The subtlety worth keeping in tests: Firebase LOOKS like it already covers this.
 * The client SDK refuses a password change on a stale session, and change-password
 * relies on that. But deletion and identifier changes go through our Worker to the
 * Admin REST API, which has no notion of recent login — so password changes were
 * protected and account deletion was not.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

/** Bearer token is the uid; `#stale` drops `auth_time`, `#old:<sec>` back-dates it. */
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    if (token.endsWith('#stale')) {
      return { uid: token.slice(0, -'#stale'.length), role: 'user' };
    }
    const aged = token.match(/^(.*)#old:(\d+)$/);
    if (aged) {
      return {
        uid: aged[1],
        role: 'user',
        authTime: Math.floor(Date.now() / 1000) - Number(aged[2]),
      };
    }
    return { uid: token, role: 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const { sentEmails, sentSms, transport } = vi.hoisted(() => ({
  sentEmails: [] as { to: string; subject: string; text?: string }[],
  sentSms: [] as { to: string; body: string }[],
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
  updateAuthUser: async () => undefined,
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
  REAUTH_FRESH_WINDOW_SEC,
  REAUTH_REQUIRED_CODE,
  hasFreshSession,
  hasReauthGrant,
} from '../src/lib/reauth';

const app = makeApp();

beforeEach(() => {
  sentEmails.length = 0;
  sentSms.length = 0;
  transport.emailOk = true;
  transport.smsOk = true;
  transport.emailConfigured = true;
  transport.smsConfigured = true;
});

async function api(env: TestEnv, token: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': '203.0.113.7',
      },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function auth(env: TestEnv, token: string, action: string, data: any = {}) {
  const res = await app.request(
    '/auth',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'CF-Connecting-IP': '203.0.113.7',
      },
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
      email: `${uid}@example.com`,
      phone: null,
      status: 'active',
      dpcoin: 0,
      createdAt: ts,
      updatedAt: ts,
      ...extra,
    } as any);
}

const codeFrom = (text: string | undefined) => String(text || '').match(/\b(\d{6})\b/)?.[1] ?? '';
const userRow = (env: TestEnv, uid: string) =>
  drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();

// ---------------------------------------------------------------------------
// 1. The freshness claim.
// ---------------------------------------------------------------------------

describe('session freshness', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  it('accepts a sign-in inside the window', () => {
    expect(hasFreshSession({ authTime: nowSec() })).toBe(true);
    expect(hasFreshSession({ authTime: nowSec() - 60 })).toBe(true);
  });

  it('rejects a sign-in older than the window', () => {
    expect(hasFreshSession({ authTime: nowSec() - REAUTH_FRESH_WINDOW_SEC - 1 })).toBe(false);
    expect(hasFreshSession({ authTime: nowSec() - 86400 })).toBe(false);
  });

  /**
   * A missing claim must read as stale. `auth_time` is standard on Firebase ID
   * tokens, so its absence means something unusual — and "unusual" is the last case
   * that should skip a security check.
   */
  it('treats a missing or malformed auth_time as stale', () => {
    expect(hasFreshSession({})).toBe(false);
    expect(hasFreshSession({ authTime: undefined })).toBe(false);
    expect(hasFreshSession({ authTime: NaN })).toBe(false);
    expect(hasFreshSession({ authTime: Infinity })).toBe(false);
  });

  /** A clock-skewed or forged future timestamp must not buy unlimited freshness. */
  it('rejects an implausibly future auth_time', () => {
    expect(hasFreshSession({ authTime: nowSec() + 3600 })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. The gate on deletion.
// ---------------------------------------------------------------------------

describe('deletion requires a recent sign-in', () => {
  it('refuses a stale session, with a code the client can act on', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await api(env, 'alice#stale', 'requestAccountDeletion', { confirm: true });

    expect(res.status).toBe(412);
    expect(res.body.error.message).toContain(REAUTH_REQUIRED_CODE);
    // Nothing started: the account is still in service.
    expect((await userRow(env, 'alice'))?.status).toBe('active');
  });

  /**
   * 412, not 401. A 401 is handled globally as an expired session and signs the
   * user out — turning "confirm it's you" into a logout, which is both hostile and
   * a way to lose the user before they finish.
   */
  it('does not present as an expired session', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const res = await api(env, 'alice#stale', 'requestAccountDeletion', { confirm: true });
    expect(res.status).not.toBe(401);
  });

  it('allows a session that just signed in', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await api(env, 'alice', 'requestAccountDeletion', { confirm: true });

    expect(res.status).toBe(200);
  });

  it('allows a stale session that passes the challenge', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const blocked = await api(env, 'alice#stale', 'requestAccountDeletion', { confirm: true });
    expect(blocked.status).toBe(412);

    const sent = await api(env, 'alice#stale', 'sendReauthOtp');
    expect(sent.status).toBe(200);
    const verified = await api(env, 'alice#stale', 'verifyReauthOtp', {
      otp: codeFrom(sentEmails.at(-1)?.text),
    });
    expect(verified.status).toBe(200);

    const res = await api(env, 'alice#stale', 'requestAccountDeletion', { confirm: true });
    expect(res.status).toBe(200);
  });

  it('gates the legacy deleteAccount alias too', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const res = await api(env, 'alice#stale', 'deleteAccount', { confirm: true });
    expect(res.status).toBe(412);
  });

  /**
   * Cancelling is the non-destructive direction, and the only way back from a
   * deletion someone did not mean to start. Putting a code in front of it would
   * make recovery harder than destruction.
   */
  it('does NOT gate cancellation', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await api(env, 'alice', 'requestAccountDeletion', { confirm: true });

    const res = await api(env, 'alice#stale', 'cancelAccountDeletion');

    expect(res.status).toBe(200);
    expect((await userRow(env, 'alice'))?.status).toBe('active');
  });

  /** Reading what would happen is not a destructive act. */
  it('does NOT gate the status check or the data export', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    expect((await api(env, 'alice#stale', 'accountDeletionStatus')).status).toBe(200);
    expect((await api(env, 'alice#stale', 'exportMyData')).status).toBe(200);
  });

  /**
   * A blocked account must still be able to delete itself — that is the store
   * requirement the deletion work exists to satisfy. Gating it behind a challenge a
   * blocked account cannot reach would be the same dead end by a longer route.
   */
  it('lets a blocked account complete the challenge and delete', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { isBlocked: true, status: 'blocked' });

    const sent = await api(env, 'alice#stale', 'sendReauthOtp');
    expect(sent.status).toBe(200);
    const verified = await api(env, 'alice#stale', 'verifyReauthOtp', {
      otp: codeFrom(sentEmails.at(-1)?.text),
    });
    expect(verified.status).toBe(200);

    const res = await api(env, 'alice#stale', 'requestAccountDeletion', { confirm: true });
    expect(res.status).toBe(200);
  });

  /**
   * An account with no email and no phone cannot be challenged. Refusing outright
   * would strand it with no deletion path at all, so the fresh-session requirement
   * stands alone — something the user can always satisfy by signing in again.
   */
  it('still tells an account with no identifiers how to proceed', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { email: null, phone: null });

    const res = await api(env, 'alice#stale', 'requestAccountDeletion', { confirm: true });

    expect(res.status).toBe(412);
    expect(res.body.error.message).toMatch(/sign out and sign in again/i);
    // And a fresh sign-in does let them through.
    expect((await api(env, 'alice', 'requestAccountDeletion', { confirm: true })).status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 3. The gate on credential changes.
// ---------------------------------------------------------------------------

describe('identifier changes require a recent sign-in', () => {
  /**
   * The code sent to the NEW address proves the caller controls that address. It
   * says nothing about whether they own THIS account — which is the whole question
   * when someone is moving the credentials.
   */
  it('refuses an email change from a stale session, before sending anything', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await auth(env, 'alice#stale', 'sendEmailOtp', { newEmail: 'attacker@evil.com' });

    expect(res.status).toBe(412);
    expect(res.body.error.message).toContain(REAUTH_REQUIRED_CODE);
    expect(sentEmails).toEqual([]);
  });

  it('refuses a phone change from a stale session', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await auth(env, 'alice#stale', 'sendPhoneOtp', { newPhone: '+919999988888' });

    expect(res.status).toBe(412);
    expect(sentSms).toEqual([]);
  });

  it('allows the change once the challenge is passed', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await api(env, 'alice#stale', 'sendReauthOtp');
    await api(env, 'alice#stale', 'verifyReauthOtp', {
      otp: codeFrom(sentEmails.at(-1)?.text),
    });
    sentEmails.length = 0;

    const res = await auth(env, 'alice#stale', 'sendEmailOtp', { newEmail: 'new@example.com' });

    expect(res.status).toBe(200);
    expect(sentEmails.length).toBe(1);
  });

  /**
   * The grant proved control of the identifier that has just been REPLACED. Letting
   * it stand would mean one code, sent to an address the user no longer uses, keeps
   * authorising changes for the rest of its window — so a single compromised inbox
   * could be walked through email, then phone, then deletion.
   */
  it('burns the grant once a credential has actually changed', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await api(env, 'alice#stale', 'sendReauthOtp');
    await api(env, 'alice#stale', 'verifyReauthOtp', { otp: codeFrom(sentEmails.at(-1)?.text) });
    expect(await hasReauthGrant(env as any, 'alice')).toBe(true);

    sentEmails.length = 0;
    await auth(env, 'alice#stale', 'sendEmailOtp', { newEmail: 'new@example.com' });
    await auth(env, 'alice#stale', 'verifyEmailOtp', { otp: codeFrom(sentEmails.at(-1)?.text) });

    expect(await hasReauthGrant(env as any, 'alice')).toBe(false);
    // So a second credential change has to prove itself again.
    const second = await auth(env, 'alice#stale', 'sendPhoneOtp', { newPhone: '+919999988888' });
    expect(second.status).toBe(412);
  });
});

// ---------------------------------------------------------------------------
// 4. The challenge itself.
// ---------------------------------------------------------------------------

describe('the challenge', () => {
  /**
   * Phone over email when both exist: a taken-over inbox is a far more common story
   * than a taken-over SIM, so the SMS is the factor more likely to still be with
   * the real owner.
   */
  it('prefers the phone number when the account has one', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919999911111' });

    const res = await api(env, 'alice#stale', 'sendReauthOtp');

    expect(res.body.method).toBe('phone');
    expect(sentSms.length).toBe(1);
    expect(sentEmails).toEqual([]);
  });

  it('falls back to email when there is no phone number', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await api(env, 'alice#stale', 'sendReauthOtp');

    expect(res.body.method).toBe('email');
    expect(sentEmails.length).toBe(1);
  });

  /** Masked: the client says where the code went without echoing the identifier. */
  it('reports a masked destination', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const res = await api(env, 'alice#stale', 'sendReauthOtp');
    expect(res.body.sentTo).toContain('@example.com');
    expect(res.body.sentTo).not.toBe('alice@example.com');
  });

  it('rejects a wrong code and does not grant', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await api(env, 'alice#stale', 'sendReauthOtp');

    const res = await api(env, 'alice#stale', 'verifyReauthOtp', { otp: '000000' });

    expect(res.status).toBe(400);
    expect(await hasReauthGrant(env as any, 'alice')).toBe(false);
  });

  it('burns the code after too many wrong guesses', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await api(env, 'alice#stale', 'sendReauthOtp');
    const real = codeFrom(sentEmails.at(-1)?.text);

    for (let i = 0; i < 5; i++) {
      await api(env, 'alice#stale', 'verifyReauthOtp', { otp: '000000' });
    }
    // Even the correct code no longer works.
    const res = await api(env, 'alice#stale', 'verifyReauthOtp', { otp: real });

    expect(res.status).toBe(429);
    expect(await hasReauthGrant(env as any, 'alice')).toBe(false);
  });

  it('is single-use', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await api(env, 'alice#stale', 'sendReauthOtp');
    const code = codeFrom(sentEmails.at(-1)?.text);

    expect((await api(env, 'alice#stale', 'verifyReauthOtp', { otp: code })).status).toBe(200);
    expect((await api(env, 'alice#stale', 'verifyReauthOtp', { otp: code })).status).toBe(404);
  });

  it('holds a cooldown between sends', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    expect((await api(env, 'alice#stale', 'sendReauthOtp')).status).toBe(200);
    expect((await api(env, 'alice#stale', 'sendReauthOtp')).status).toBe(429);
    expect(sentEmails.length).toBe(1);
  });

  /** Same contract as every other send here: report the failure, allow a retry. */
  it('reports a failed delivery and clears the cooldown', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    transport.emailOk = false;

    const failed = await api(env, 'alice#stale', 'sendReauthOtp');
    expect(failed.status).toBe(500);

    transport.emailOk = true;
    const retry = await api(env, 'alice#stale', 'sendReauthOtp');
    expect(retry.status).toBe(200);
  });

  /**
   * Scopes are separate namespaces on purpose: a code proving ownership of a NEW
   * phone number must not double as proof of identity for a deletion. Reusing one
   * scope for two meanings is how a confirmation code becomes an authorisation
   * token.
   */
  it('does not accept an identifier-change code as a re-auth code', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    // Get a grant, change the email, and capture that flow's code.
    await api(env, 'alice#stale', 'sendReauthOtp');
    await api(env, 'alice#stale', 'verifyReauthOtp', { otp: codeFrom(sentEmails.at(-1)?.text) });
    sentEmails.length = 0;
    await auth(env, 'alice#stale', 'sendEmailOtp', { newEmail: 'new@example.com' });
    const emailChangeCode = codeFrom(sentEmails.at(-1)?.text);

    // That code must not buy a re-auth grant.
    const res = await api(env, 'alice#stale', 'verifyReauthOtp', { otp: emailChangeCode });
    expect(res.status).not.toBe(200);
  });

  /**
   * Fail-CLOSED. Every other cache read in the codebase fails open so a KV blip
   * degrades to a miss — but treating "we could not check" as "verified" would let
   * an attacker bypass the gate by making KV unavailable.
   */
  it('treats an unreadable grant store as NOT verified', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const original = env.OTP_KV.get;
    (env.OTP_KV as any).get = async () => {
      throw new Error('kv down');
    };

    expect(await hasReauthGrant(env as any, 'alice')).toBe(false);

    (env.OTP_KV as any).get = original;
  });
});
