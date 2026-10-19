/**
 * Onboarding is the ONLY way an account comes into existence.
 *
 * Regression for: a new social sign-in user pressed Back on "Fill your profile",
 * the client's useProfile hook then called `updateProfile` with made-up defaults,
 * and the Worker upserted a full account (default bio, username derived from the
 * Google name, no date of birth, no welcome bonus) that showed up in "people to
 * follow" for everyone.
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

// Bearer token is "uid" or "uid|signInProvider".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, provider] = token.split('|');
    return { uid, role: 'user', signInProvider: provider || 'google.com' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const firebaseUsers = vi.hoisted(() => new Map<string, { email: string | null; emailVerified: boolean; phoneNumber: string | null }>());
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
vi.mock('../src/lib/email', () => ({
  sendEmail: async () => true,
  sendEmailDetailed: async () => ({ ok: true, provider: 'test' }),
  emailConfigured: async () => true,
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();
beforeEach(() => firebaseUsers.clear());

async function post(env: TestEnv, route: '/api' | '/auth', token: string, action: string, data: any = {}) {
  const res = await app.request(
    route,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'CF-Connecting-IP': '203.0.113.5' },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
const api = (env: TestEnv, token: string, action: string, data: any = {}) => post(env, '/api', token, action, data);
const auth = (env: TestEnv, token: string, action: string, data: any = {}) => post(env, '/auth', token, action, data);
const read = async (env: TestEnv, token: string, p: string) => {
  const res = await app.request(`/read${p}`, { headers: { Authorization: `Bearer ${token}` } }, env, fakeCtx());
  return (await res.json().catch(() => null)) as any;
};
const user = (env: TestEnv, uid: string) => drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();

async function seedConfig(env: TestEnv) {
  await drizzleOf(env)
    .insert(schema.settings)
    .values({ id: 'appConfig', data: { rewardSettings: { signupBonus: 100 }, verificationReward: { enabled: false } } as any, updatedAt: Date.now() } as any);
  await env.CACHE_KV.delete('settings:appConfig');
}

/** What the old client auto-create left behind. */
async function seedHalfCreated(env: TestEnv, uid: string) {
  await drizzleOf(env).insert(schema.users).values({
    uid,
    username: 'santalientertainment',
    fullName: 'Santali Entertainment',
    bio: 'Hi there! I am new here.',
    email: 'santali@example.com',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as any);
}
const completedUser = (uid: string) => ({
  uid, username: uid, fullName: uid, signupCompleted: true, createdAt: Date.now(), updatedAt: Date.now(),
});

const isIncomplete = (r: { status: number; body: any }) =>
  r.status === 412 && String(r.body?.error?.message || '').includes('PROFILE_INCOMPLETE');

describe('no account without onboarding', () => {
  it('updateProfile never creates a profile row', async () => {
    const { env } = makeEnv();
    const r = await api(env, 'newbie', 'updateProfile', { username: 'newbie', fullName: 'New', bio: 'Hi there! I am new here.' });
    expect(isIncomplete(r)).toBe(true);
    expect(await user(env, 'newbie')).toBeUndefined();
  });

  it('a signed-in user with no profile can only reach the onboarding-safe actions', async () => {
    const { env } = makeEnv();
    await drizzleOf(env).insert(schema.users).values(completedUser('target') as any);
    expect(isIncomplete(await api(env, 'newbie', 'toggleFollow', { targetUserId: 'target', intent: 'follow' }))).toBe(true);
    expect(isIncomplete(await api(env, 'newbie', 'claimDailyReward'))).toBe(true);
    // Device plumbing the app shell calls is still served.
    expect(isIncomplete(await api(env, 'newbie', 'getNotificationPrefs'))).toBe(false);
  });

  it('a half-created (incomplete) row is gated the same way', async () => {
    const { env } = makeEnv();
    await seedHalfCreated(env, 'half');
    await drizzleOf(env).insert(schema.users).values(completedUser('target') as any);
    expect(isIncomplete(await api(env, 'half', 'toggleFollow', { targetUserId: 'target', intent: 'follow' }))).toBe(true);
    expect(isIncomplete(await api(env, 'half', 'updateProfile', { bio: 'x' }))).toBe(true);
  });

  it('a client cannot mark itself as signed up', async () => {
    const { env } = makeEnv();
    await drizzleOf(env).insert(schema.users).values(completedUser('alice') as any);
    await drizzleOf(env).update(schema.users).set({ signupCompleted: false }).where(eq(schema.users.uid, 'alice'));
    // completeSignup is reachable while incomplete, but writes no flag.
    await api(env, 'alice', 'completeSignup');
    expect((await user(env, 'alice'))?.signupCompleted).toBe(false);
  });
});

describe('createProfile', () => {
  it('takes email from Firebase, never the body, and stores no unproven phone', async () => {
    const { env } = makeEnv();
    firebaseUsers.set('gina', { email: 'Gina@Example.com', emailVerified: true, phoneNumber: null });
    const r = await auth(env, 'gina|google.com', 'createProfile', {
      username: 'gina', fullName: 'Gina', dob: '2000-01-01', gender: 'Female', occupation: 'Artist',
      email: 'someone-else@example.com', phone: '+919999999999',
    });
    expect(r.status).toBe(200);
    const row = await user(env, 'gina');
    expect(row).toMatchObject({ email: 'gina@example.com', phone: null, emailVerified: true, phoneVerified: false, signupCompleted: true });
  });

  it('a phone OTP sign-in stores (and verifies) the number it proved', async () => {
    const { env } = makeEnv();
    firebaseUsers.set('pat', { email: null, emailVerified: false, phoneNumber: '+919812345678' });
    const r = await auth(env, 'pat|custom', 'createProfile', { username: 'pat', fullName: 'Pat', dob: '2000-01-01' });
    expect(r.status).toBe(200);
    expect(await user(env, 'pat')).toMatchObject({ phone: '+919812345678', phoneVerified: true, email: null });
  });

  it('completes a half-created row: whole form stored, welcome bonus granted exactly once', async () => {
    const { env } = makeEnv();
    await seedConfig(env);
    await seedHalfCreated(env, 'half');
    firebaseUsers.set('half', { email: 'santali@example.com', emailVerified: true, phoneNumber: null });
    const body = { username: 'santali_real', fullName: 'Santali', dob: '1999-05-05', gender: 'Male', occupation: 'Artist' };
    expect((await auth(env, 'half|google.com', 'createProfile', body)).status).toBe(200);
    expect((await auth(env, 'half|google.com', 'createProfile', body)).status).toBe(200);
    const row = await user(env, 'half');
    expect(row).toMatchObject({ username: 'santali_real', dob: '1999-05-05', gender: 'Male', signupCompleted: true });
    expect(Number(row?.dpcoin)).toBe(100);
    const ledger = await drizzleOf(env).select().from(schema.coinTransactions).where(eq(schema.coinTransactions.uid, 'half')).all();
    expect(ledger).toHaveLength(1);
    // And the account now works.
    expect(isIncomplete(await api(env, 'half', 'updateProfile', { bio: 'hello' }))).toBe(false);
  });
});

describe('discovery shows finished accounts only', () => {
  it('suggested users and search skip incomplete profiles', async () => {
    const { env } = makeEnv();
    await seedHalfCreated(env, 'half');
    await drizzleOf(env).insert(schema.users).values({ ...completedUser('santalifan') } as any);
    await drizzleOf(env).insert(schema.users).values(completedUser('viewer') as any);
    const suggested = ((await read(env, 'viewer', '/users/suggested')) || []).map((u: any) => u.id);
    expect(suggested).not.toContain('half');
    expect(suggested).toContain('santalifan');
    const found = ((await read(env, 'viewer', '/users/search?q=santali')) || []).map((u: any) => u.id);
    expect(found).toEqual(['santalifan']);
  });
});

describe('migration 0061 backfill', () => {
  it('marks real accounts complete and leaves the auto-created ones incomplete', async () => {
    const { env, db } = makeEnv();
    const insert = (row: Record<string, any>) =>
      drizzleOf(env).insert(schema.users).values({ createdAt: 1, updatedAt: 1, signupCompleted: false, ...row } as any);
    await insert({ uid: 'legacy', username: 'legacy', fullName: 'L', bio: 'my bio', dob: '1990-01-01' });
    await insert({ uid: 'auto', username: 'auto', fullName: 'A', bio: 'Hi there! I am new here.' });
    await insert({ uid: 'autoEdited', username: 'ae', fullName: 'AE', bio: 'Hi there! I am new here.', dob: '1990-01-01' });
    await insert({ uid: 'nameless', username: null, fullName: 'N' });
    const sql = fs.readFileSync(path.join(import.meta.dirname, '..', 'migrations', '0061_signup_completed_backfill.sql'), 'utf8');
    db.exec(sql);
    const flag = async (uid: string) => (await user(env, uid))?.signupCompleted;
    expect(await flag('legacy')).toBe(true);
    expect(await flag('auto')).toBe(false);
    expect(await flag('autoEdited')).toBe(true);
    expect(await flag('nameless')).toBe(false);
  });
});
