/**
 * Registration verification reward: 10 coins at signup, +90 once BOTH email and
 * mobile are verified by server-side proof — exactly once, never on client say-so.
 *
 * The real OTP flows (lib/identifierChange.ts) are driven end to end; only the
 * outbound transports (email, SMS, Firebase Admin) are faked.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', email: `${uid}@example.com`, authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const { sentEmails, sentSms, firebaseUsers } = vi.hoisted(() => ({
  sentEmails: [] as { to: string; text?: string }[],
  sentSms: [] as { to: string; body: string }[],
  firebaseUsers: new Map<string, { email: string | null; emailVerified: boolean; phoneNumber: string | null }>(),
}));

vi.mock('../src/lib/email', () => ({
  sendEmail: async (_env: unknown, opts: any) => {
    sentEmails.push({ to: opts.to, text: opts.text });
    return true;
  },
  sendEmailDetailed: async () => ({ ok: true, provider: 'test' }),
  emailConfigured: async () => true,
}));
vi.mock('../src/lib/sms', () => ({
  sendSms: async (_env: unknown, to: string, body: string) => {
    sentSms.push({ to, body });
    return true;
  },
  sendSmsDetailed: async () => ({ ok: true, provider: 'test' }),
  smsConfigured: async () => true,
}));
vi.mock('../src/lib/firebaseAdmin', () => ({
  revokeRefreshTokens: async () => undefined,
  updateAuthUser: async () => undefined,
  createAuthUser: async () => 'new-uid',
  createCustomToken: async () => 'custom-token',
  getUserByEmail: async () => null,
  deleteAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
  lookupAuthUser: async (_env: unknown, uid: string) => firebaseUsers.get(uid) ?? null,
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import {
  canonicalIdentifier,
  nextPromptAt,
  parseVerificationRewardConfig,
  tryCreditVerificationReward,
  getVerificationStatus,
  VERIFICATION_REWARD_DEFAULTS,
} from '../src/lib/verificationReward';

const app = makeApp();
const PHONE = '+919876543210';
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  sentEmails.length = 0;
  sentSms.length = 0;
  firebaseUsers.clear();
});

async function post(env: TestEnv, route: '/api' | '/auth', token: string | null, action: string, data: any = {}) {
  const res = await app.request(
    route,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.7',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const api = (env: TestEnv, token: string | null, action: string, data: any = {}) => post(env, '/api', token, action, data);
const auth = (env: TestEnv, token: string | null, action: string, data: any = {}) => post(env, '/auth', token, action, data);

async function status(env: TestEnv, token: string | null) {
  const res = await app.request('/read/me/verification', { headers: token ? { Authorization: `Bearer ${token}` } : {} }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedConfig(env: TestEnv, appConfig: Record<string, any>) {
  await drizzleOf(env).insert(schema.settings).values({ id: 'appConfig', data: appConfig as any, updatedAt: Date.now() } as any)
    .onConflictDoUpdate({ target: schema.settings.id, set: { data: appConfig as any } });
  await env.CACHE_KV.delete('settings:appConfig');
}

/** A brand-new account through the real signup path (createProfile). */
async function signup(env: TestEnv, uid: string, phone: string | null = PHONE) {
  const res = await auth(env, uid, 'createProfile', { username: uid, fullName: uid, email: `${uid}@example.com`, phone });
  expect(res.status).toBe(200);
}

const user = (env: TestEnv, uid: string) => drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();
const ledger = (env: TestEnv, uid: string) =>
  drizzleOf(env).select().from(schema.coinTransactions).where(eq(schema.coinTransactions.uid, uid)).all();
const enrolment = (env: TestEnv, uid: string) =>
  drizzleOf(env).select().from(schema.verificationRewards).where(eq(schema.verificationRewards.uid, uid)).get();
const balance = async (env: TestEnv, uid: string) => Number((await user(env, uid))?.dpcoin ?? 0);
const ledgerSum = async (env: TestEnv, uid: string) => (await ledger(env, uid)).reduce((t, r: any) => t + Number(r.amount), 0);

const codeFrom = (t?: string) => String(t || '').match(/\b(\d{6})\b/)?.[1] ?? '';
const clearCooldowns = async (env: TestEnv) => {
  for (const key of [...(env.OTP_KV as any)._map.keys()]) if (String(key).startsWith('otpcd:')) await env.OTP_KV.delete(key);
};

/** Prove the CURRENT email through the real OTP flow (verify-only mode). */
async function verifyEmail(env: TestEnv, uid: string) {
  await clearCooldowns(env);
  const sent = await auth(env, uid, 'sendEmailOtp', { newEmail: `${uid}@example.com` });
  expect(sent.status).toBe(200);
  expect(sent.body.verifyOnly).toBe(true);
  return auth(env, uid, 'verifyEmailOtp', { otp: codeFrom(sentEmails.at(-1)?.text) });
}
/** Prove the CURRENT phone through the real OTP flow (verify-only mode). */
async function verifyPhone(env: TestEnv, uid: string, phone = PHONE) {
  await clearCooldowns(env);
  const sent = await auth(env, uid, 'sendPhoneOtp', { newPhone: phone });
  expect(sent.status).toBe(200);
  return auth(env, uid, 'verifyPhoneOtp', { otp: codeFrom(sentSms.at(-1)?.body) });
}

// ===========================================================================
describe('registration reward', () => {
  it('a new account receives exactly 10 coins, ledgered, and is enrolled for 90 more', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    expect(await balance(env, 'alice')).toBe(10);
    const rows = await ledger(env, 'alice');
    expect(rows.map((r: any) => [r.id, r.type, Number(r.amount)])).toEqual([['signup_bonus:alice', 'signup_bonus', 10]]);
    expect(await enrolment(env, 'alice')).toMatchObject({ registrationReward: 10, completionReward: 90, completedAt: null });

    const s = await status(env, 'alice');
    expect(s.body).toMatchObject({
      enrolled: true, registrationReward: 10, completionReward: 90, totalReward: 100, earnedReward: 10,
      completed: false, emailVerified: false, phoneVerified: false, remaining: ['email', 'phone'],
    });
  });

  it('a repeated / retried signup never re-grants or re-enrols', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    await signup(env, 'alice');
    expect(await balance(env, 'alice')).toBe(10);
    expect(await ledger(env, 'alice')).toHaveLength(1);
  });

  it('uses the admin-configured amounts, snapshotting the promise at signup', async () => {
    const { env } = makeEnv();
    await seedConfig(env, { verificationReward: { registrationReward: 20, completionReward: 80 } });
    await signup(env, 'alice');
    expect(await balance(env, 'alice')).toBe(20);
    // A later change does not re-price alice's promise.
    await seedConfig(env, { verificationReward: { registrationReward: 5, completionReward: 10, maxTotalReward: 15 } });
    expect((await enrolment(env, 'alice'))?.completionReward).toBe(80);
  });

  it('feature disabled: legacy signup bonus, no enrolment, no completion bonus', async () => {
    const { env } = makeEnv();
    await seedConfig(env, { rewardSettings: { signupBonus: 100 }, verificationReward: { enabled: false } });
    await signup(env, 'alice');
    expect(await balance(env, 'alice')).toBe(100);
    expect(await enrolment(env, 'alice')).toBeUndefined();
  });
});

// ===========================================================================
describe('completion bonus requires BOTH verifications', () => {
  it('email only: no bonus', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    const r = await verifyEmail(env, 'alice');
    expect(r.status).toBe(200);
    expect(r.body.verificationReward).toMatchObject({ credited: false, reason: 'phone_unverified' });
    expect(await balance(env, 'alice')).toBe(10);
    expect((await status(env, 'alice')).body).toMatchObject({ emailVerified: true, phoneVerified: false, earnedReward: 10, remaining: ['phone'] });
  });

  it('phone only: no bonus', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    const r = await verifyPhone(env, 'alice');
    expect(r.body.verificationReward).toMatchObject({ credited: false, reason: 'email_unverified' });
    expect(await balance(env, 'alice')).toBe(10);
  });

  it('both: exactly 90 more, total 100, ledger explains the balance', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    await verifyEmail(env, 'alice');
    const r = await verifyPhone(env, 'alice');
    expect(r.body.verificationReward).toEqual({ credited: true, coins: 90, reason: 'credited' });
    expect(await balance(env, 'alice')).toBe(100);
    expect(await ledgerSum(env, 'alice')).toBe(100);
    expect((await ledger(env, 'alice')).map((x: any) => x.id).sort()).toEqual(['signup_bonus:alice', 'verification_bonus:alice']);
    expect((await status(env, 'alice')).body).toMatchObject({ completed: true, earnedReward: 100, remaining: [], promptDue: false });
  });

  it('re-verifying and re-claiming after completion credits nothing more', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    await verifyEmail(env, 'alice');
    await verifyPhone(env, 'alice');
    const again = await verifyEmail(env, 'alice');
    expect(again.body.verificationReward).toMatchObject({ credited: false, reason: 'already_completed' });
    const claim = await api(env, 'alice', 'claimVerificationReward');
    expect(claim.body.reward).toMatchObject({ credited: false, reason: 'already_completed' });
    expect(await balance(env, 'alice')).toBe(100);
    expect(await ledger(env, 'alice')).toHaveLength(2);
  });

  it('a wrong OTP verifies nothing and pays nothing', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    await verifyEmail(env, 'alice');
    await clearCooldowns(env);
    await auth(env, 'alice', 'sendPhoneOtp', { newPhone: PHONE });
    const real = codeFrom(sentSms.at(-1)?.body);
    const bad = await auth(env, 'alice', 'verifyPhoneOtp', { otp: real === '000000' ? '111111' : '000000' });
    expect(bad.status).toBe(400);
    expect((await user(env, 'alice'))?.phoneVerified).toBe(false);
    expect(await balance(env, 'alice')).toBe(10);
  });

  it('honours the configured resend cooldown', async () => {
    const { env } = makeEnv();
    await seedConfig(env, { verificationReward: { smsResendCooldownSec: 120 } });
    await signup(env, 'alice');
    const sent = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: PHONE });
    expect(sent.body.cooldownSeconds).toBe(120);
    const again = await auth(env, 'alice', 'sendPhoneOtp', { newPhone: PHONE });
    expect(again.status).toBe(429);
  });
});

// ===========================================================================
describe('idempotency, concurrency and partial failure', () => {
  async function bothVerifiedDirect(env: TestEnv, uid: string) {
    await signup(env, uid);
    await env.DB.prepare(`UPDATE users SET email_verified = 1, phone_verified = 1 WHERE uid = ?`).bind(uid).run();
  }

  it('concurrent claims produce exactly one credit', async () => {
    const { env } = makeEnv();
    await bothVerifiedDirect(env, 'alice');
    const results = await Promise.all(Array.from({ length: 6 }, () => api(env, 'alice', 'claimVerificationReward')));
    expect(results.filter((r) => r.body.reward?.credited)).toHaveLength(1);
    expect(await balance(env, 'alice')).toBe(100);
    expect(await ledger(env, 'alice')).toHaveLength(2);
  });

  it('a retry after a committed credit (response lost) does not pay again', async () => {
    const { env } = makeEnv();
    await bothVerifiedDirect(env, 'alice');
    expect((await tryCreditVerificationReward(env as any, 'alice')).credited).toBe(true);
    // The client never saw that response and retries:
    expect(await tryCreditVerificationReward(env as any, 'alice')).toMatchObject({ credited: false, reason: 'already_completed' });
    expect(await balance(env, 'alice')).toBe(100);
  });

  it('a failure inside the credit leaves no partial reward, and a retry then succeeds once', async () => {
    const { env } = makeEnv();
    await bothVerifiedDirect(env, 'alice');
    const original = env.DB.batch.bind(env.DB);
    let fail = true;
    env.DB.batch = async (stmts: any[]) => {
      if (fail && stmts.some((s) => /verification_reward_claims/.test(String(s.sql)))) {
        fail = false;
        // Run the statements, then blow up: the transactional batch must roll back.
        await original(stmts.concat([env.DB.prepare('INSERT INTO no_such_table VALUES (1)')]));
      }
      return original(stmts);
    };
    await expect(tryCreditVerificationReward(env as any, 'alice')).rejects.toThrow();
    expect(await balance(env, 'alice')).toBe(10);
    expect(await ledger(env, 'alice')).toHaveLength(1);
    expect((await enrolment(env, 'alice'))?.completedAt).toBeNull();

    expect((await tryCreditVerificationReward(env as any, 'alice')).credited).toBe(true);
    expect(await balance(env, 'alice')).toBe(100);
  });

  it('a phone (or email) that already earned the bonus on another account cannot earn it again', async () => {
    const { env } = makeEnv();
    await bothVerifiedDirect(env, 'alice');
    expect((await tryCreditVerificationReward(env as any, 'alice')).credited).toBe(true);
    // alice moves off the number; bob registers with a trivially different
    // spelling of it and verifies it.
    await env.DB.prepare(`UPDATE users SET phone = '+919000000001' WHERE uid = 'alice'`).run();
    await signup(env, 'bob', '9876543210');
    await env.DB.prepare(`UPDATE users SET email_verified = 1, phone_verified = 1 WHERE uid = 'bob'`).run();
    expect(await tryCreditVerificationReward(env as any, 'bob')).toMatchObject({ credited: false, reason: 'identifier_already_rewarded' });
    expect(await balance(env, 'bob')).toBe(10);
  });

  it('existing (pre-feature) accounts are never enrolled or paid, even fully verified', async () => {
    const { env } = makeEnv();
    const ts = Date.now();
    await drizzleOf(env).insert(schema.users).values({
      uid: 'veteran', username: 'veteran', fullName: 'v', email: 'veteran@example.com', phone: PHONE,
      emailVerified: true, phoneVerified: true, dpcoin: 100, createdAt: ts, updatedAt: ts,
    } as any);
    const r = await api(env, 'veteran', 'claimVerificationReward');
    expect(r.body.reward).toMatchObject({ credited: false, reason: 'not_enrolled' });
    expect(await balance(env, 'veteran')).toBe(100);
    expect((await status(env, 'veteran')).body).toMatchObject({ enrolled: false, promptDue: false });
  });

  it('a blocked account is not paid', async () => {
    const { env } = makeEnv();
    await bothVerifiedDirect(env, 'alice');
    await env.DB.prepare(`UPDATE users SET is_blocked = 1 WHERE uid = 'alice'`).run();
    expect(await tryCreditVerificationReward(env as any, 'alice')).toMatchObject({ credited: false, reason: 'account_restricted' });
    expect(await balance(env, 'alice')).toBe(10);
  });

  it('disabling the feature pauses completion credits without losing the promise', async () => {
    const { env } = makeEnv();
    await bothVerifiedDirect(env, 'alice');
    await seedConfig(env, { verificationReward: { enabled: false } });
    expect(await tryCreditVerificationReward(env as any, 'alice')).toMatchObject({ reason: 'disabled' });
    await seedConfig(env, { verificationReward: { enabled: true } });
    expect((await tryCreditVerificationReward(env as any, 'alice')).coins).toBe(90);
  });
});

// ===========================================================================
describe('never trusts the client', () => {
  it('forged flags, uid and amount in the request are ignored', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    await signup(env, 'bob', '+919811111111');
    await env.DB.prepare(`UPDATE users SET email_verified = 1, phone_verified = 1 WHERE uid = 'bob'`).run();

    const forged = await api(env, 'alice', 'claimVerificationReward', {
      uid: 'bob', userId: 'bob', amount: 5000, coins: 5000, emailVerified: true, phoneVerified: true,
    });
    expect(forged.body.reward).toMatchObject({ credited: false, reason: 'email_unverified' });
    expect(await balance(env, 'alice')).toBe(10);
    expect(await balance(env, 'bob')).toBe(10); // not paid via alice's request

    await api(env, 'alice', 'updateProfile', { emailVerified: true, phoneVerified: true, email_verified: 1 });
    const a = await user(env, 'alice');
    expect([a?.emailVerified, a?.phoneVerified]).toEqual([false, false]);
  });

  it('unauthenticated callers are rejected', async () => {
    const { env } = makeEnv();
    expect((await api(env, null, 'claimVerificationReward')).status).toBe(401);
    expect((await api(env, null, 'refreshVerification')).status).toBe(401);
    expect((await status(env, null)).status).toBe(401);
  });

  it('status is the caller\'s own and masks contact details', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    await signup(env, 'bob', '+919811111111');
    const s = (await status(env, 'alice')).body;
    expect(s.email).toBe('al***@example.com');
    expect(s.phone).toBe('+91****3210');
    expect(JSON.stringify(s)).not.toContain('bob');
    expect(JSON.stringify(s)).not.toContain('9876543210');
  });
});

// ===========================================================================
describe('trusted refresh from Firebase', () => {
  it('accepts Firebase email verification only for the address on the profile', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    firebaseUsers.set('alice', { email: 'someone-else@example.com', emailVerified: true, phoneNumber: null });
    await api(env, 'alice', 'refreshVerification');
    expect((await user(env, 'alice'))?.emailVerified).toBe(false);

    firebaseUsers.set('alice', { email: 'Alice@Example.com', emailVerified: true, phoneNumber: PHONE });
    const r = await api(env, 'alice', 'refreshVerification');
    expect(r.status).toBe(200);
    expect(r.body.reward).toMatchObject({ credited: true, coins: 90 });
    expect(await balance(env, 'alice')).toBe(100);
  });

  it('does not accept an unverified Firebase email or a different phone', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    firebaseUsers.set('alice', { email: 'alice@example.com', emailVerified: false, phoneNumber: '+919000000009' });
    const r = await api(env, 'alice', 'refreshVerification');
    expect(r.body.status).toMatchObject({ emailVerified: false, phoneVerified: false });
    expect(await balance(env, 'alice')).toBe(10);
  });
});

// ===========================================================================
describe('reminders', () => {
  const cfg = VERIFICATION_REWARD_DEFAULTS;
  const row = (promptCount: number, lastPromptAt: number | null, completedAt: number | null = null) => ({ promptCount, lastPromptAt, completedAt });

  it('first prompt immediately, then +3 days, then every 7 days, at most 5 times', () => {
    const t = 1_000_000_000_000;
    expect(nextPromptAt(row(0, null), cfg)).toBe(0);
    expect(nextPromptAt(row(1, t), cfg)).toBe(t + 3 * DAY);
    expect(nextPromptAt(row(2, t), cfg)).toBe(t + 7 * DAY);
    expect(nextPromptAt(row(4, t), cfg)).toBe(t + 7 * DAY);
    expect(nextPromptAt(row(5, t), cfg)).toBeNull();
    expect(nextPromptAt(row(1, t, t), cfg)).toBeNull(); // completed
    expect(nextPromptAt(null, cfg)).toBeNull(); // not enrolled
  });

  it('is server-side: shown once, not again before 3 days, due after; multi-device showings count once', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    expect((await status(env, 'alice')).body.promptDue).toBe(true);

    const [a, b] = await Promise.all([api(env, 'alice', 'markVerificationPromptShown'), api(env, 'alice', 'markVerificationPromptShown')]);
    expect([a.body.recorded, b.body.recorded].filter(Boolean)).toHaveLength(1);
    expect((await enrolment(env, 'alice'))?.promptCount).toBe(1);

    const shownAt = Number((await enrolment(env, 'alice'))?.lastPromptAt);
    expect((await getVerificationStatus(env as any, 'alice', shownAt + 2 * DAY)).promptDue).toBe(false);
    expect((await getVerificationStatus(env as any, 'alice', shownAt + 3 * DAY)).promptDue).toBe(true);
  });

  it('stops once completed', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    await verifyEmail(env, 'alice');
    await verifyPhone(env, 'alice');
    expect((await status(env, 'alice')).body.promptDue).toBe(false);
    expect((await api(env, 'alice', 'markVerificationPromptShown')).body.recorded).toBe(false);
  });
});

// ===========================================================================
describe('admin configuration', () => {
  async function save(env: TestEnv, verificationReward: any, token?: string) {
    const res = await app.request(
      '/admin/app-settings',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : { 'X-Admin-Secret': 'test-admin-secret' }) },
        body: JSON.stringify({ verificationReward }),
      },
      env,
      fakeCtx(),
    );
    return res.status;
  }

  it.each([
    [{ registrationReward: -1 }],
    [{ completionReward: 1.5 }],
    [{ completionReward: '90' }],
    [{ registrationReward: 50, completionReward: 90 }], // 140 > max 100
    [{ maxTotalReward: 10_000_001 }],
    [{ initialReminderDays: 0 }],
    [{ smsResendCooldownSec: 5 }],
    [{ enabled: 'yes' }],
    [{ somethingElse: 1 }],
  ])('rejects %j', async (patch) => {
    const { env } = makeEnv();
    expect(await save(env, patch)).toBe(400);
  });

  it('accepts a consistent config, audits it, and non-admins / moderators cannot change it', async () => {
    const { env } = makeEnv();
    expect(await save(env, { registrationReward: 20, completionReward: 80, maxTotalReward: 100 })).toBe(200);
    const audit = await drizzleOf(env).select().from(schema.adminAuditLog).all();
    expect(audit.some((a: any) => a.action === 'settings.verificationReward.update')).toBe(true);

    await drizzleOf(env).insert(schema.users).values({ uid: 'mod', username: 'mod', fullName: 'm', role: 'moderator', createdAt: 1, updatedAt: 1 } as any);
    await drizzleOf(env).insert(schema.users).values({ uid: 'joe', username: 'joe', fullName: 'j', createdAt: 1, updatedAt: 1 } as any);
    expect(await save(env, { completionReward: 0 }, 'mod:moderator')).toBe(403);
    expect(await save(env, { completionReward: 0 }, 'joe')).toBe(403);
  });

  it('stats are full-admin only and reflect enrolment and completions', async () => {
    const { env } = makeEnv();
    await signup(env, 'alice');
    await signup(env, 'bob', '+919811111111');
    await env.DB.prepare(`UPDATE users SET email_verified = 1, phone_verified = 1 WHERE uid = 'alice'`).run();
    await env.DB.prepare(`UPDATE users SET email_verified = 1 WHERE uid = 'bob'`).run();
    await tryCreditVerificationReward(env as any, 'alice');
    const res = await app.request('/admin/verification-reward', { headers: { 'X-Admin-Secret': 'test-admin-secret' } }, env, fakeCtx());
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.config).toMatchObject({ registrationReward: 10, completionReward: 90, maxTotalReward: 100 });
    expect(body.stats).toMatchObject({ enrolled: 2, completed: 1, pendingEmailOnly: 1, completionCoinsCredited: 90, completionCredits: 1 });

    await drizzleOf(env).insert(schema.users).values({ uid: 'mod', username: 'mod', fullName: 'm', role: 'moderator', createdAt: 1, updatedAt: 1 } as any);
    const denied = await app.request('/admin/verification-reward', { headers: { Authorization: 'Bearer mod:moderator' } }, env, fakeCtx());
    expect(denied.status).toBe(403);
  });

  it('parsing a stored config never exceeds the cap', () => {
    expect(parseVerificationRewardConfig({ registrationReward: 60, completionReward: 90, maxTotalReward: 100 })).toMatchObject({
      registrationReward: 60, completionReward: 40,
    });
    expect(parseVerificationRewardConfig({ registrationReward: -5, completionReward: 'x' })).toMatchObject({
      registrationReward: 10, completionReward: 90,
    });
  });
});

describe('identifier canonicalisation', () => {
  it('collapses trivial variants of one phone / mailbox', () => {
    expect(canonicalIdentifier('phone', '+91 98765-43210')).toBe(canonicalIdentifier('phone', '9876543210'));
    expect(canonicalIdentifier('phone', '0091 9876543210')).toBe(canonicalIdentifier('phone', '+919876543210'));
    expect(canonicalIdentifier('email', 'A.l.i.c.e+promo@GoogleMail.com')).toBe(canonicalIdentifier('email', 'alice@gmail.com'));
    expect(canonicalIdentifier('email', 'a.b@example.com')).not.toBe(canonicalIdentifier('email', 'ab@example.com'));
  });
});
