import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// Capture email sends without a real provider. vi.hoisted so the mock factory
// (which is hoisted above imports) can reference the spy.
const { sendEmailMock } = vi.hoisted(() => ({ sendEmailMock: vi.fn(async () => true) }));
vi.mock('../src/lib/email', () => ({
  sendEmail: sendEmailMock,
  sendUserEmail: vi.fn(async () => {}),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

async function call(env: TestEnv, uid: string, action: string, data: any = {}) {
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

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 0, createdAt: ts, updatedAt: ts, ...extra } as any);
}

describe('exportMyData — email delivery', () => {
  beforeEach(() => {
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValue(true);
  });

  it('emails the export as a JSON attachment and returns a masked address (no data inline)', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { email: 'alice@example.com' });

    const r = await call(env, 'alice', 'exportMyData');
    expect(r.status).toBe(200);
    expect(r.body.emailed).toBe(true);
    expect(r.body.email).toBe('a***@example.com');
    // The bundle is NOT returned inline when emailed.
    expect(r.body.data).toBeUndefined();

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const opts = sendEmailMock.mock.calls[0][1];
    expect(opts.to).toBe('alice@example.com');
    expect(opts.attachments).toHaveLength(1);
    expect(opts.attachments[0].filename).toMatch(/^tophunt-my-data-\d{4}-\d{2}-\d{2}\.json$/);
    expect(opts.attachments[0].contentType).toBe('application/json');
    // The attachment really is the user's export.
    const decoded = Buffer.from(opts.attachments[0].content, 'base64').toString('utf8');
    expect(JSON.parse(decoded).profile.uid).toBe('alice');
  });

  it('phone-only account (no email): falls back to returning the data inline, sends nothing', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'bob'); // no email

    const r = await call(env, 'bob', 'exportMyData');
    expect(r.status).toBe(200);
    expect(r.body.emailed).toBe(false);
    expect(r.body.data.profile.uid).toBe('bob');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('provider send failure: falls back to inline data rather than stranding the user', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'carol', { email: 'carol@example.com' });
    sendEmailMock.mockResolvedValue(false);

    const r = await call(env, 'carol', 'exportMyData');
    expect(r.status).toBe(200);
    expect(r.body.emailed).toBe(false);
    expect(r.body.data.profile.uid).toBe('carol');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('never leaks the fcmTokens device credential into the export', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { email: 'alice@example.com', fcmTokens: ['secret-token'] as any });

    await call(env, 'alice', 'exportMyData');
    const opts = sendEmailMock.mock.calls[0][1];
    const decoded = Buffer.from(opts.attachments[0].content, 'base64').toString('utf8');
    expect(decoded).not.toContain('secret-token');
    expect(JSON.parse(decoded).profile.fcmTokens).toBeUndefined();
  });
});
