/**
 * CHAT MESSAGE STORAGE — now in per-chat ChatArchive Durable Objects, not D1.
 *
 * These tests drive the REAL handlers (sendMessage, markChatRead, deleteChat,
 * GET /read/chats/:id/messages, the admin dump/delete, and the data export)
 * against the faithful in-memory ChatArchive fake in the harness, which — like
 * the real DO — SEEDS from the D1 `messages` table on first touch. So the
 * lazy-migration path is genuinely exercised, not stubbed away.
 *
 * What they pin:
 *   - the send path writes the body to the DO and NOT to the D1 `messages` table
 *     (the whole point: the unbounded write leaves D1's single writer);
 *   - the read path returns the same shape as before, oldest-first, `?since=`
 *     honoured, `read` omitted;
 *   - a chat that predates the cutover keeps its history (seed), and new sends
 *     append after it;
 *   - deleteChat drops the DO's messages;
 *   - admin moderation still reads and deletes, now addressed by (chatId, id);
 *   - the data export gathers sent messages across the user's chats.
 */
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
import { exportUserData } from '../src/lib/accountExport';

const app = makeApp();

async function seedUser(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 1000, createdAt: ts, updatedAt: ts } as any);
}

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

async function history(env: TestEnv, uid: string, chatId: string, since?: number) {
  const q = since != null ? `?since=${since}` : '';
  const res = await app.request(
    `/read/chats/${chatId}/messages${q}`,
    { headers: { Authorization: `Bearer ${uid}` } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => [])) as any[] };
}

async function startChat(env: TestEnv) {
  await seedUser(env, 'alice');
  await seedUser(env, 'bob');
  const r = await api(env, 'alice', 'startChat', { otherUserId: 'bob' });
  return r.body.chatId as string;
}

const d1Messages = (env: TestEnv, chatId: string) =>
  drizzleOf(env).select().from(schema.messages).where(eq(schema.messages.chatId, chatId)).all();

// ---------------------------------------------------------------------------

describe('sendMessage writes to the DO, not the D1 messages table', () => {
  it('persists the body in the archive and returns it over the read path', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);

    expect((await api(env, 'alice', 'sendMessage', { chatId, text: 'hello bob' })).status).toBe(200);

    const msgs = (await history(env, 'alice', chatId)).body;
    expect(msgs).toHaveLength(1);
    // Exact legacy shape — read is deliberately omitted.
    expect(msgs[0]).toMatchObject({ chatId, senderId: 'alice', text: 'hello bob' });
    expect(typeof msgs[0].id).toBe('string');
    expect(typeof msgs[0].createdAt).toBe('number');
    expect(msgs[0]).not.toHaveProperty('read');

    // The D1 messages table was NOT written — that write moved off D1 entirely.
    expect(await d1Messages(env, chatId)).toHaveLength(0);
  });

  it('keeps the chats preview + updated_at in D1 (the inbox sort key stays)', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: 'newest' });

    const chat = await drizzleOf(env).select().from(schema.chats).where(eq(schema.chats.id, chatId)).get();
    expect((chat?.lastMessage as any).text).toBe('newest');
    expect((chat?.lastMessage as any).senderId).toBe('alice');
  });
});

describe('reading history', () => {
  it('returns messages oldest-first and honours the ?since= cursor', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);

    await api(env, 'alice', 'sendMessage', { chatId, text: 'm1' });
    await new Promise((r) => setTimeout(r, 2));
    await api(env, 'bob', 'sendMessage', { chatId, text: 'm2' });
    await new Promise((r) => setTimeout(r, 2));
    await api(env, 'alice', 'sendMessage', { chatId, text: 'm3' });

    const all = (await history(env, 'alice', chatId)).body;
    expect(all.map((m) => m.text)).toEqual(['m1', 'm2', 'm3']);

    // Everything strictly after the first message's timestamp.
    const after = (await history(env, 'alice', chatId, all[0].createdAt)).body;
    expect(after.map((m) => m.text)).toEqual(['m2', 'm3']);
  });

  it('refuses a non-member (404, cannot tell the chat exists)', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);
    await seedUser(env, 'carol');
    expect((await history(env, 'carol', chatId)).status).toBe(404);
  });
});

describe('markChatRead', () => {
  it('succeeds for a member and does not error', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: 'hi' });
    expect((await api(env, 'bob', 'markChatRead', { chatId })).status).toBe(200);
  });
});

describe('deleteChat purges the archive', () => {
  it('removes the messages from the DO', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: 'x' });
    expect((await api(env, 'alice', 'deleteChat', { chatId })).status).toBe(200);

    // Chat is gone (404 on the member gate) and the archive holds nothing.
    expect((await history(env, 'alice', chatId)).status).toBe(404);
    expect(env.CHAT_ARCHIVE._stores.get(chatId)?.msgs.size ?? 0).toBe(0);
  });
});

describe('lazy migration — a chat that predates the cutover', () => {
  it('seeds legacy D1 messages into the DO on first read, and new sends append after', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);

    // Simulate pre-migration rows: messages written straight into D1 before the
    // archive existed. No DO involvement yet.
    const base = Date.now() - 10_000;
    await drizzleOf(env)
      .insert(schema.messages)
      .values([
        { id: 'old1', chatId, senderId: 'alice', text: 'legacy-1', read: true, createdAt: base },
        { id: 'old2', chatId, senderId: 'bob', text: 'legacy-2', read: false, createdAt: base + 1 },
      ] as any);

    // First read seeds them from D1 — history is complete across the cutover.
    const seeded = (await history(env, 'alice', chatId)).body;
    expect(seeded.map((m) => m.text)).toEqual(['legacy-1', 'legacy-2']);

    // A new message appends after the seeded history.
    await api(env, 'alice', 'sendMessage', { chatId, text: 'brand-new' });
    const after = (await history(env, 'alice', chatId)).body;
    expect(after.map((m) => m.text)).toEqual(['legacy-1', 'legacy-2', 'brand-new']);
  });
});

describe('admin moderation', () => {
  async function adminGet(env: TestEnv, path: string) {
    const res = await app.request(path, { headers: { 'X-Admin-Secret': 'test-admin-secret' } }, env, fakeCtx());
    return { status: res.status, body: (await res.json().catch(() => [])) as any };
  }
  async function adminDelete(env: TestEnv, path: string) {
    const res = await app.request(path, { method: 'DELETE', headers: { 'X-Admin-Secret': 'test-admin-secret' } }, env, fakeCtx());
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  }

  it('lists recent messages across chats with the sender username', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: 'moderate me' });

    const res = await adminGet(env, '/admin/messages');
    expect(res.status).toBe(200);
    const row = res.body.find((m: any) => m.text === 'moderate me');
    expect(row).toBeTruthy();
    expect(row.chatId).toBe(chatId);
    expect(row.username).toBe('alice');
  });

  it('deletes a single message addressed by (chatId, id)', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: 'delete me' });
    const listed = await adminGet(env, '/admin/messages');
    const target = listed.body.find((m: any) => m.text === 'delete me');
    expect(target).toBeTruthy();

    const del = await adminDelete(env, `/admin/messages/${chatId}/${target.id}`);
    expect(del.status).toBe(200);
    expect((await history(env, 'alice', chatId)).body.find((m) => m.id === target.id)).toBeUndefined();
  });
});

describe('data export gathers sent messages from the DOs', () => {
  it('includes the user`s own messages across chats, newest-first', async () => {
    const { env } = makeEnv();
    const chatId = await startChat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: 'mine-1' });
    await api(env, 'bob', 'sendMessage', { chatId, text: 'not-mine' });
    await api(env, 'alice', 'sendMessage', { chatId, text: 'mine-2' });

    const dump = await exportUserData(env as any, 'alice');
    const sent = (dump.messagesSent as any).items.map((m: any) => m.text);
    // Only alice's own messages, and not bob's.
    expect(sent).toContain('mine-1');
    expect(sent).toContain('mine-2');
    expect(sent).not.toContain('not-mine');
  });
});
