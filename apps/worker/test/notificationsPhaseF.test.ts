/**
 * Notifications (Phase F): which FCM errors drop a token, token pruning against
 * the current row, the push badge, tie-stable paging, and input bounds on the
 * mark-read and token-registration actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
const h = vi.hoisted(() => ({
  sends: [] as { token: string; options: any }[],
  onSend: null as null | ((token: string) => Promise<void>),
}));
vi.mock('../src/lib/firebaseAdmin', async (orig) => ({
  ...(await orig<any>()),
  sendFcmToToken: async (_env: unknown, token: string, _n: unknown, _d: unknown, options: any) => {
    h.sends.push({ token, options });
    await h.onSend?.(token);
    return token.startsWith('dead')
      ? { ok: false, invalid: true, retryable: false, status: 404 }
      : { ok: true, invalid: false, retryable: false, status: 200 };
  },
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { sendPushNotification } from '../src/lib/notify';
import { isDeadTokenError } from '../src/lib/firebaseAdmin';

const app = makeApp();
beforeEach(() => {
  h.sends.length = 0;
  h.onSend = null;
});

async function user(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: 1, updatedAt: 1, ...extra } as any);
}
async function api(env: TestEnv, uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` }, body: JSON.stringify({ action, ...data }) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}
async function get(env: TestEnv, uid: string, path: string) {
  const res = await app.request(`/read${path}`, { headers: { Authorization: `Bearer ${uid}` } }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}
const tokensOf = async (env: TestEnv, uid: string) =>
  ((await drizzleOf(env).select({ t: schema.users.fcmTokens }).from(schema.users).where(eq(schema.users.uid, uid)).get())?.t as string[]) || [];
function notif(id: string, createdAt: number, extra: Record<string, any> = {}) {
  return { id, recipientId: 'me', title: 't', body: 'b', type: 'admin', targetId: 'x', createdAt, ...extra };
}

// ===========================================================================
describe('FCM errors that drop a token', () => {
  it('UNREGISTERED and SENDER_ID_MISMATCH do; INVALID_ARGUMENT only when it names the token', () => {
    expect(isDeadTokenError('UNREGISTERED', '')).toBe(true);
    expect(isDeadTokenError('SENDER_ID_MISMATCH', '')).toBe(true);
    expect(isDeadTokenError('INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token')).toBe(true);
    // A malformed payload must not wipe every recipient's devices.
    expect(isDeadTokenError('INVALID_ARGUMENT', 'Invalid value at message.data[0].value')).toBe(false);
    expect(isDeadTokenError('UNAVAILABLE', '')).toBe(false);
  });
});

describe('token pruning', () => {
  it('removes only the dead token and keeps one registered during the send', async () => {
    const { env } = makeEnv();
    await user(env, 'me', { fcmTokens: ['good-1', 'dead-1'] });
    // A login on another device registers a token while FCM is being called.
    h.onSend = async (token) => {
      if (token === 'dead-1') await api(env, 'me', 'registerFcmToken', { token: 'fresh-1' });
    };
    await sendPushNotification(env as any, 'me', 'hi', 'there', 'admin');
    expect(await tokensOf(env, 'me')).toEqual(['good-1', 'fresh-1']);
  });

  it('handles a user whose every token is dead', async () => {
    const { env } = makeEnv();
    await user(env, 'me', { fcmTokens: ['dead-1', 'dead-2'] });
    await sendPushNotification(env as any, 'me', 'hi', 'there', 'admin');
    expect(await tokensOf(env, 'me')).toEqual([]);
  });
});

// ===========================================================================
describe('push badge', () => {
  it('counts unseen notifications, not unread ones, and skips blocked actors', async () => {
    const { env } = makeEnv();
    await user(env, 'me', { fcmTokens: ['good-1'] });
    await user(env, 'pal');
    await user(env, 'troll');
    await drizzleOf(env).insert(schema.notifications).values([
      notif('n1', 1, { seen: true, read: false }), // looked at, never tapped: not in the badge
      notif('n2', 2, { seen: false, actorId: 'pal' }),
      notif('n3', 3, { seen: false, actorId: 'troll' }),
    ] as any);
    await api(env, 'me', 'blockUser', { targetUserId: 'troll' });

    const { createNotification } = await import('../src/lib/notify');
    await createNotification(env as any, 'me', { title: 'x', body: 'y', type: 'admin', targetId: 'z' });
    // Wait for the write-behind push.
    await new Promise((r) => setTimeout(r, 20));
    const badge = h.sends.at(-1)?.options?.badge;
    // n2 + the new row; n1 is seen, n3's actor is blocked.
    expect(badge).toBe(2);
    expect((await get(env, 'me', '/notifications/unread-count')).body.count).toBe(2);
  });
});

// ===========================================================================
describe('notification paging', () => {
  it('pages through rows that share a timestamp without skipping any', async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    await drizzleOf(env).insert(schema.notifications).values(
      Array.from({ length: 7 }, (_, i) => notif(`n${i}`, i < 5 ? 5000 : 4000 + i)) as any,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await get(env, 'me', `/notifications?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      seen.push(...r.body.map((n: any) => n.id));
      cursor = r.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('still accepts a bare-time cursor from older apps', async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    await drizzleOf(env).insert(schema.notifications).values([notif('a', 100), notif('b', 200)] as any);
    expect((await get(env, 'me', '/notifications?cursor=200')).body.map((n: any) => n.id)).toEqual(['a']);
  });
});

// ===========================================================================
describe('input bounds', () => {
  it('markNotificationsRead refuses an oversized or non-string id list', async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    expect((await api(env, 'me', 'markNotificationsRead', { notificationIds: Array.from({ length: 101 }, (_, i) => `n${i}`) })).status).toBe(400);
    expect((await api(env, 'me', 'markNotificationsRead', { notificationIds: [{ $ne: 1 }] })).status).toBe(400);
    expect((await api(env, 'me', 'markNotificationsRead', { notificationIds: ['n1'] })).status).toBe(200);
  });

  it('registerFcmToken validates the token and keeps the newest 10', async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    expect((await api(env, 'me', 'registerFcmToken', { token: '' })).status).toBe(400);
    expect((await api(env, 'me', 'registerFcmToken', { token: 'has space' })).status).toBe(400);
    expect((await api(env, 'me', 'registerFcmToken', { token: { a: 1 } })).status).toBe(400);
    for (let i = 0; i < 12; i++) await api(env, 'me', 'registerFcmToken', { token: `tok-${i}` });
    // Re-registering an existing token moves it to the newest slot.
    await api(env, 'me', 'registerFcmToken', { token: 'tok-3' });
    const t = await tokensOf(env, 'me');
    expect(t).toHaveLength(10);
    expect(t.at(-1)).toBe('tok-3');
    expect(t).not.toContain('tok-0');
  });
});
