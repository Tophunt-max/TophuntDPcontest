import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { PENDING_DELETION_STATUS } from '../src/lib/accountStatus';

const app = makeApp();
const DAY_MS = 86_400_000;

async function meStatus(env: TestEnv, uid: string) {
  const res = await app.request(
    '/read/me/status',
    { headers: { Authorization: `Bearer ${uid}` } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 0, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function seedDeletionRequest(env: TestEnv, uid: string, scheduledFor: number, status = 'pending') {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.deletionRequests)
    .values({ uid, status, requestedAt: ts, scheduledFor, createdAt: ts, updatedAt: ts } as any);
}

describe('/read/me/status — pending-deletion login gate data', () => {
  it('active account: status active, deletion null', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const r = await meStatus(env, 'alice');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('active');
    expect(r.body.deletion).toBeNull();
  });

  it('pending account: returns scheduledFor + a sane daysRemaining', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { status: PENDING_DELETION_STATUS });
    const scheduledFor = Date.now() + 15 * DAY_MS;
    await seedDeletionRequest(env, 'alice', scheduledFor, 'pending');

    const r = await meStatus(env, 'alice');
    expect(r.status).toBe(200);
    expect(r.body.status).toBe(PENDING_DELETION_STATUS);
    expect(r.body.deletion).toBeTruthy();
    expect(r.body.deletion.requestStatus).toBe('pending');
    expect(r.body.deletion.scheduledFor).toBe(scheduledFor);
    // 15 days out — ceil keeps it at 15 (allow 14–15 for tick slack).
    expect(r.body.deletion.daysRemaining).toBeGreaterThanOrEqual(14);
    expect(r.body.deletion.daysRemaining).toBeLessThanOrEqual(15);
  });

  it('processing account: cannot cancel, still gated', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { status: PENDING_DELETION_STATUS });
    await seedDeletionRequest(env, 'alice', Date.now() + DAY_MS, 'processing');

    const r = await meStatus(env, 'alice');
    expect(r.body.deletion.requestStatus).toBe('processing');
  });

  it('daysRemaining is never negative when the purge is overdue', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { status: PENDING_DELETION_STATUS });
    await seedDeletionRequest(env, 'alice', Date.now() - 2 * DAY_MS, 'pending');

    const r = await meStatus(env, 'alice');
    expect(r.body.deletion.daysRemaining).toBe(0);
  });

  it('edge: status pending but no request row still gates (nulls, no crash)', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { status: PENDING_DELETION_STATUS });
    const r = await meStatus(env, 'alice');
    expect(r.body.deletion).toBeTruthy();
    expect(r.body.deletion.scheduledFor).toBeNull();
    expect(r.body.deletion.daysRemaining).toBeNull();
  });

  it('a cancelled request is treated as active (not gated)', async () => {
    const { env } = makeEnv();
    // status back to active after a cancel, request row lingering as cancelled
    await seedUser(env, 'alice', { status: 'active' });
    await seedDeletionRequest(env, 'alice', Date.now() + DAY_MS, 'cancelled');
    const r = await meStatus(env, 'alice');
    expect(r.body.status).toBe('active');
    expect(r.body.deletion).toBeNull();
  });
});
