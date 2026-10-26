/**
 * Chat correctness (Phase F): newest-first history with older-page cursors,
 * idempotent sends via clientId, unread counter ordering, delete-for-me,
 * and block rules on typing and presence.
 *
 * The ChatArchive DO cannot run in Node; these drive the real handlers against
 * the harness fake, which mirrors the DO's ordering and idempotency.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
const { pushes } = vi.hoisted(() => ({ pushes: [] as { channel: string; payload: any }[] }));
vi.mock('../src/lib/publish', async (orig) => {
  const real = await orig<any>();
  const publish = async (_env: unknown, channel: string, payload: any) => {
    pushes.push({ channel, payload });
  };
  return {
    ...real,
    publish,
    publishMany: async (env: unknown, channels: string[], payload: any) => {
      for (const ch of channels) await publish(env, ch, payload);
    },
  };
});

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();
beforeEach(() => {
  pushes.length = 0;
});

async function seedUser(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: ts, updatedAt: ts } as any);
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
async function chat(env: TestEnv) {
  await seedUser(env, 'alice');
  await seedUser(env, 'bob');
  return (await api(env, 'alice', 'startChat', { otherUserId: 'bob' })).body.chatId as string;
}
/** Messages straight into the archive fake, with explicit times. */
function putMessages(env: TestEnv, chatId: string, n: number, base = 1_000_000) {
  const stub = env.CHAT_ARCHIVE.get(env.CHAT_ARCHIVE.idFromName(chatId));
  return Promise.all(
    Array.from({ length: n }, (_, i) =>
      stub.append(chatId, { id: `m${String(i).padStart(4, '0')}`, senderId: i % 2 ? 'bob' : 'alice', text: `t${i}`, createdAt: base + i }),
    ),
  );
}
const unread = async (env: TestEnv, uid: string) =>
  ((await env.DB.prepare('SELECT unread_count n FROM chat_members WHERE user_id = ?').bind(uid).first()) as any).n;

// ===========================================================================
describe('history', () => {
  it('opens on the NEWEST messages, oldest-first, with a cursor to older pages', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    await putMessages(env, chatId, 230);

    const first = await get(env, 'alice', `/chats/${chatId}/messages`);
    expect(first.status).toBe(200);
    expect(first.body).toHaveLength(50);
    expect(first.body[0].text).toBe('t180');
    expect(first.body[49].text).toBe('t229');
    expect(first.headers.get('Cache-Control')).toContain('no-store');

    // Walk back to the start: every message exactly once, in order.
    const seen: string[] = first.body.map((m: any) => m.id);
    let cursor = first.headers.get('X-Next-Cursor');
    while (cursor) {
      const page = await get(env, 'alice', `/chats/${chatId}/messages?before=${encodeURIComponent(cursor)}`);
      seen.unshift(...page.body.map((m: any) => m.id));
      cursor = page.headers.get('X-Next-Cursor');
    }
    expect(seen).toHaveLength(230);
    expect(new Set(seen).size).toBe(230);
    expect(seen[0]).toBe('m0000');
  });

  it('does not skip messages that share a timestamp at a page boundary', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    const stub = env.CHAT_ARCHIVE.get(env.CHAT_ARCHIVE.idFromName(chatId));
    for (let i = 0; i < 60; i++) await stub.append(chatId, { id: `s${String(i).padStart(3, '0')}`, senderId: 'alice', text: 'x', createdAt: 5000 });
    const first = await get(env, 'alice', `/chats/${chatId}/messages`);
    const next = await get(env, 'alice', `/chats/${chatId}/messages?before=${encodeURIComponent(first.headers.get('X-Next-Cursor')!)}`);
    expect(new Set([...first.body, ...next.body].map((m: any) => m.id)).size).toBe(60);
  });

  it('keeps ?since= working for older clients', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    await putMessages(env, chatId, 5, 100);
    const r = await get(env, 'alice', `/chats/${chatId}/messages?since=102`);
    expect(r.body.map((m: any) => m.text)).toEqual(['t3', 't4']);
  });
});

// ===========================================================================
describe('sendMessage idempotency', () => {
  it('a retry with the same clientId stores one message and counts it once', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    const a = await api(env, 'alice', 'sendMessage', { chatId, text: 'hi', clientId: 'abcd1234-retry' });
    const b = await api(env, 'alice', 'sendMessage', { chatId, text: 'hi', clientId: 'abcd1234-retry' });
    expect(a.body).toMatchObject({ success: true, duplicate: false });
    expect(b.body).toMatchObject({ success: true, duplicate: true });
    expect(b.body.message.id).toBe(a.body.message.id);
    expect(b.body.message.createdAt).toBe(a.body.message.createdAt);

    const rows = (await get(env, 'bob', `/chats/${chatId}/messages`)).body;
    expect(rows.filter((m: any) => m.text === 'hi')).toHaveLength(1);
    expect(await unread(env, 'bob')).toBe(1);
  });

  it('without a clientId, each send is a new message (old clients)', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: 'hi' });
    await api(env, 'alice', 'sendMessage', { chatId, text: 'hi' });
    expect((await get(env, 'bob', `/chats/${chatId}/messages`)).body).toHaveLength(2);
  });

  it('rejects a malformed clientId', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    expect((await api(env, 'alice', 'sendMessage', { chatId, text: 'hi', clientId: 'x' })).status).toBe(400);
    expect((await api(env, 'alice', 'sendMessage', { chatId, text: 'hi', clientId: 'a/b/c/d/e/f' })).status).toBe(400);
  });

  it('returns the stored message so the client can replace its bubble', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    const r = await api(env, 'alice', 'sendMessage', { chatId, text: 'yo', clientId: 'client-0001' });
    expect(r.body.message).toMatchObject({ id: 'alice_client-0001', chatId, senderId: 'alice', text: 'yo', type: 'text' });
  });
});

// ===========================================================================
describe('delete for me', () => {
  it('hides the history before the delete for that member only, and the chat returns on a new message', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: 'before' });
    await new Promise((r) => setTimeout(r, 5));
    await api(env, 'alice', 'deleteChat', { chatId });

    expect((await get(env, 'alice', `/chats/${chatId}/messages`)).body).toEqual([]);
    expect((await get(env, 'alice', `/chats/${chatId}/messages/search?q=before`)).body).toEqual([]);
    expect((await get(env, 'bob', `/chats/${chatId}/messages`)).body.map((m: any) => m.text)).toEqual(['before']);

    await new Promise((r) => setTimeout(r, 5));
    await api(env, 'bob', 'sendMessage', { chatId, text: 'after' });
    expect((await get(env, 'alice', '/chats')).body).toHaveLength(1);
    expect((await get(env, 'alice', `/chats/${chatId}/messages`)).body.map((m: any) => m.text)).toEqual(['after']);
  });
});

// ===========================================================================
describe('blocks', () => {
  it('a blocked member cannot send typing signals', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    expect((await api(env, 'bob', 'setTyping', { chatId })).status).toBe(200);
    await api(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    pushes.length = 0;
    expect((await api(env, 'bob', 'setTyping', { chatId })).status).toBe(403);
    expect(pushes.filter((p) => p.payload.type === 'typing')).toHaveLength(0);
  });

  it('presence is not fanned out to a blocked chat partner', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    await seedUser(env, 'carol');
    const other = (await api(env, 'alice', 'startChat', { otherUserId: 'carol' })).body.chatId;
    await api(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // The real publishPresence, with publish captured by the mock above.
    const { publishPresence } = await vi.importActual<any>('../src/lib/publish');
    const sent: string[] = [];
    const fakeHub = { idFromName: (n: string) => n, get: (n: string) => ({ fetch: async () => (sent.push(n), new Response('ok')) }) };
    await publishPresence({ ...env, REALTIME: fakeHub } as any, 'alice', true, Date.now());
    expect(sent).toContain(`chat:${other}`);
    expect(sent).toContain('user:carol');
    expect(sent).not.toContain(`chat:${chatId}`);
    expect(sent).not.toContain('user:bob');
  });
});

// ===========================================================================
describe('markChatRead', () => {
  it('clears the counter before the read flags (no lost increment)', async () => {
    const { env } = makeEnv();
    const chatId = await chat(env);
    await api(env, 'alice', 'sendMessage', { chatId, text: '1' });
    expect(await unread(env, 'bob')).toBe(1);

    // A message lands right after the read flags are set (message 2 is unread):
    // its increment must survive.
    const realGet = env.CHAT_ARCHIVE.get.bind(env.CHAT_ARCHIVE);
    (env.CHAT_ARCHIVE as any).get = (id: any) => {
      const s = realGet(id);
      return {
        ...s,
        markRead: async (cid: string, reader: string) => {
          const r = await s.markRead(cid, reader);
          (env.CHAT_ARCHIVE as any).get = realGet;
          await api(env, 'alice', 'sendMessage', { chatId, text: '2' });
          return r;
        },
      };
    };
    await api(env, 'bob', 'markChatRead', { chatId });
    expect(await unread(env, 'bob')).toBe(1);
  });
});
