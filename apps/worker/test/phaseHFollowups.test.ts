/**
 * Phase H follow-ups: admin sudo mode, support-ticket masking for moderators,
 * re-auth before an inline data export, the normalised word filter, per-user
 * feature rollout and short-lived WebSocket tickets.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';

// Bearer token is "uid" or "uid:role". A "#fresh" suffix is a session signed in
// just now; without it the sign-in is long past (refreshed tokens keep it).
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const fresh = token.endsWith('#fresh');
    const [uid, role] = token.replace(/#fresh$/, '').split(':');
    return { uid, role: role || 'user', authTime: fresh ? Math.floor(Date.now() / 1000) : 1_000 };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { memoReset } from '../src/lib/memo';
import { isSensitiveAdminRoute } from '../src/routes/admin';
import { redactPaymentDetails } from '../src/lib/redact';
import { normaliseForModeration } from '../src/lib/moderation';
import { inRollout, rolloutBucket, validateAppControlPatch } from '../src/lib/appControl';
import { mintWsTicket, verifyWsTicket, WS_TICKET_TTL_SEC } from '../src/lib/wsTicket';

const app = makeApp();
beforeEach(() => memoReset());

async function seedUser(env: TestEnv, uid: string, extra: Record<string, unknown> = {}) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: ts, updatedAt: ts, ...extra } as any);
}
async function adminCall(env: TestEnv, method: string, path: string, body?: any, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers['X-Admin-Secret'] = 'test-admin-secret';
  const res = await app.request(`/admin${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, env, fakeCtx());
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
const walletBody = { amount: 5, type: 'add', reason: 'goodwill credit', requestId: 'req_12345678' };

describe('admin sudo mode', () => {
  it('lists money, role, lifecycle and config writes; reads are never gated', () => {
    expect(isSensitiveAdminRoute('POST', '/users/u1/wallet')).toBe(true);
    expect(isSensitiveAdminRoute('DELETE', '/users/u1')).toBe(true);
    expect(isSensitiveAdminRoute('PATCH', '/withdrawals/w1')).toBe(true);
    expect(isSensitiveAdminRoute('PUT', '/integrations/razorpay')).toBe(true);
    expect(isSensitiveAdminRoute('GET', '/users/u1')).toBe(false);
    expect(isSensitiveAdminRoute('POST', '/reports/r1/resolve')).toBe(false);
  });

  it('a stale admin session must sign in again; a fresh one goes through', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await seedUser(env, 'adm', { role: 'admin' });
    const stale = await adminCall(env, 'POST', '/users/u1/wallet', walletBody, 'adm:admin');
    expect(stale.status).toBe(412);
    expect(stale.body.error.reason).toBe('reauth_required');
    const fresh = await adminCall(env, 'POST', '/users/u1/wallet', walletBody, 'adm:admin#fresh');
    expect(fresh.status).toBe(200);
    // Reads keep working on the old session.
    expect((await adminCall(env, 'GET', '/overview', undefined, 'adm:admin')).status).toBe(200);
  });

  it('the server-to-server secret is exempt, and a moderator still gets 403 (not a password prompt)', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await seedUser(env, 'mod', { role: 'moderator' });
    expect((await adminCall(env, 'POST', '/users/u1/wallet', { ...walletBody, requestId: 'req_secret01' })).status).toBe(200);
    expect((await adminCall(env, 'POST', '/users/u1/wallet', walletBody, 'mod:moderator')).status).toBe(403);
  });

  it('the dashboard tells the panel which role it is', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'mod', { role: 'moderator' });
    const r = await adminCall(env, 'GET', '/overview', undefined, 'mod:moderator');
    expect(r.body.viewerRole).toBe('moderator');
    expect(r.body.revenue).toBeUndefined();
  });
});

describe('support tickets for moderators', () => {
  it('masks UPI ids, emails, IFSC codes and long numbers', () => {
    const out = redactPaymentDetails('Paid to rahul@okaxis, UTR 4123 5678 9012, IFSC HDFC0001234, call +91 98765 43210, ticket #42');
    expect(out).not.toMatch(/okaxis|9012|HDFC0001234|43210/);
    expect(out).toContain('ticket #42');
    expect(redactPaymentDetails(null)).toBeNull();
  });

  it('a moderator sees the masked text; a full admin sees the original', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'mod', { role: 'moderator' });
    const ts = Date.now();
    await drizzleOf(env).insert(schema.supportTickets).values({ id: 't1', userId: 'u1', subject: 'Refund', message: 'My UPI is me@ybl', status: 'open', createdAt: ts, updatedAt: ts } as any);
    const mod = await adminCall(env, 'GET', '/support', undefined, 'mod:moderator');
    expect(mod.body[0].message).not.toContain('me@ybl');
    const recent = await adminCall(env, 'GET', '/recent-tickets', undefined, 'mod:moderator');
    expect(recent.body[0].message).not.toContain('me@ybl');
    const full = await adminCall(env, 'GET', '/support');
    expect(full.body[0].message).toBe('My UPI is me@ybl');
  });
});

describe('data export returned in the response', () => {
  it('a phone-only account on an old session must confirm it is them first', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'p1', { phone: '+919800000001' });
    const stale = await api(env, 'p1', 'exportMyData');
    expect(stale.status).toBe(412);
    expect(String(stale.body.error.message)).toMatch(/^reauth_required/);
    const fresh = await api(env, 'p1#fresh', 'exportMyData');
    expect(fresh.status).toBe(200);
    expect(fresh.body.emailed).toBe(false);
    expect(fresh.body.data).toBeTruthy();
  });
});

describe('word filter', () => {
  async function filterWith(words: string[]) {
    vi.resetModules();
    const mod = await import('../src/lib/moderation');
    const { env } = makeEnv();
    for (const word of words) await drizzleOf(env).insert(schema.bannedWords).values({ word, createdAt: 1 } as any);
    return (text: string) => mod.findBannedWord(env as any, text);
  }
  it('reads through leetspeak, accents and spaced-out letters', async () => {
    expect(normaliseForModeration('5C4M')).toBe('scam');
    const find = await filterWith(['scam']);
    expect(await find('total 5c4m bro')).toBe('scam');
    expect(await find('s.c.a.m alert')).toBe('scam');
    expect(await find('scäm')).toBe('scam');
    expect(await find('a fair deal')).toBeNull();
  });
  it('still does not trip on a word that merely contains it', async () => {
    const find = await filterWith(['ass']);
    expect(await find('first class seat')).toBeNull();
    expect(await find('a55')).toBe('ass');
  });
});

describe('feature rollout', () => {
  it('buckets are stable and grow monotonically with the percentage', () => {
    const uids = Array.from({ length: 400 }, (_, i) => `user${i}`);
    // Pinned: apps/expo/test/rollout.test.ts asserts the same values for the app's copy.
    expect(['user1', 'abc', 'Zx9'].map((u) => rolloutBucket('chat', u))).toEqual([39, 25, 40]);
    expect(rolloutBucket('stories', 'user1')).toBe(86);
    const at = (pct: number) => uids.filter((u) => inRollout({ featureRollout: { chat: pct } }, 'chat', u));
    const ten = at(10);
    const fifty = at(50);
    expect(ten.every((u) => fifty.includes(u))).toBe(true);
    expect(fifty.length).toBeGreaterThan(140);
    expect(fifty.length).toBeLessThan(260);
    expect(at(0)).toEqual([]);
    expect(at(100)).toHaveLength(400);
  });
  it('guests are in only at 100%, and absent means everyone', () => {
    expect(inRollout({ featureRollout: { chat: 99 } }, 'chat', null)).toBe(false);
    expect(inRollout({}, 'chat', null)).toBe(true);
  });
  it('rejects a percentage that is not a whole number from 0 to 100, or an unknown feature', () => {
    expect(() => validateAppControlPatch({ featureRollout: { chat: 101 } } as any)).toThrow();
    expect(() => validateAppControlPatch({ featureRollout: { chat: 12.5 } } as any)).toThrow();
    expect(() => validateAppControlPatch({ featureRollout: { nope: 10 } } as any)).toThrow();
    expect(() => validateAppControlPatch({ featureRollout: { chat: 25 } } as any)).not.toThrow();
  });
  it('the server refuses the feature for accounts outside the rollout', async () => {
    const { env } = makeEnv();
    const outside = Array.from({ length: 50 }, (_, i) => `u${i}`).find((u) => !inRollout({ featureRollout: { chat: 1 } }, 'chat', u))!;
    await seedUser(env, outside);
    const save = await app.request(
      '/admin/app-settings',
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' }, body: JSON.stringify({ featureRollout: { chat: 1 } }) },
      env,
      fakeCtx(),
    );
    expect(save.status).toBe(200);
    memoReset();
    const r = await api(env, outside, 'sendMessage');
    expect(r.status).toBe(412);
    expect(r.body.error.reason).toBe('feature_disabled');
  });
});

describe('WebSocket tickets', () => {
  const env = { ADMIN_PROXY_SECRET: 'test-admin-secret' } as any;
  it('round-trips the uid and sign-in time', async () => {
    const t = await mintWsTicket(env, 'u1', 1234, 10_000);
    expect(t!.expiresAt).toBe((10_000 + WS_TICKET_TTL_SEC) * 1000);
    expect(await verifyWsTicket(env, t!.ticket, 10_001)).toEqual({ uid: 'u1', authTime: 1234 });
  });
  it('refuses an expired, tampered or foreign-key ticket, and is off without a key', async () => {
    const t = (await mintWsTicket(env, 'u1', 1234, 10_000))!.ticket;
    expect(await verifyWsTicket(env, t, 10_000 + WS_TICKET_TTL_SEC + 1)).toBeNull();
    const [payload, sig] = t.split('.');
    const forged = btoa(JSON.stringify({ u: 'victim', a: 1234, e: 99_999 })).replace(/=+$/, '');
    expect(await verifyWsTicket(env, `${forged}.${sig}`, 10_001)).toBeNull();
    expect(await verifyWsTicket(env, `${payload}.AAAA`, 10_001)).toBeNull();
    expect(await verifyWsTicket({ ADMIN_PROXY_SECRET: 'other' } as any, t, 10_001)).toBeNull();
    expect(await mintWsTicket({} as any, 'u1', 1)).toBeNull();
    expect(await verifyWsTicket({} as any, t)).toBeNull();
  });
  it('/api hands a signed-in user a ticket bound to their uid', async () => {
    // (src/index.ts, which owns /ws, cannot be imported under Node; the route only
    // calls verifyWsTicket and then the same assertSessionUsable as the token path.)
    const { env: e } = makeEnv();
    await seedUser(e, 'u1');
    const r = await api(e, 'u1', 'createWsTicket');
    expect(typeof r.body.ticket).toBe('string');
    expect(await verifyWsTicket(e as any, r.body.ticket)).toEqual({ uid: 'u1', authTime: 1_000 });
  });
});
