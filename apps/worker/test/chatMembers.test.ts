import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import fs from 'node:fs';
import path from 'node:path';

// Bypass Firebase token verification: the bearer token is the uid.
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
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

async function readChats(env: TestEnv, uid: string) {
  const res = await app.request(
    '/read/chats',
    { headers: { Authorization: `Bearer ${uid}` } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => [])) as any[] };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 1000, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function members(env: TestEnv, chatId: string) {
  const rows = await drizzleOf(env)
    .select()
    .from(schema.chatMembers)
    .where(eq(schema.chatMembers.chatId, chatId))
    .all();
  return rows.map((r) => r.userId).sort();
}

describe('chat_members — indexed membership (audit §4)', () => {
  it('startChat writes both membership edges and the chat shows in each inbox', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    const r = await call(env, 'alice', 'startChat', { otherUserId: 'bob' });
    expect(r.status).toBe(200);
    const chatId = r.body.chatId as string;
    expect(chatId).toBeTruthy();

    // Both edges written.
    expect(await members(env, chatId)).toEqual(['alice', 'bob']);

    // Visible to both participants via the indexed join.
    expect((await readChats(env, 'alice')).body.map((c) => c.id)).toContain(chatId);
    expect((await readChats(env, 'bob')).body.map((c) => c.id)).toContain(chatId);
  });

  it('startChat is idempotent — a second call returns the SAME chat, no duplicate', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    const first = (await call(env, 'alice', 'startChat', { otherUserId: 'bob' })).body.chatId;
    // Either direction must resolve to the same existing chat.
    const second = (await call(env, 'bob', 'startChat', { otherUserId: 'alice' })).body.chatId;
    expect(second).toBe(first);

    const all = await drizzleOf(env).select().from(schema.chats).all();
    expect(all.length).toBe(1);
  });

  it('/read/chats does NOT list a chat the caller is not a member of', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedUser(env, 'carol');

    const chatId = (await call(env, 'alice', 'startChat', { otherUserId: 'bob' })).body.chatId;
    const carolChats = (await readChats(env, 'carol')).body.map((c) => c.id);
    expect(carolChats).not.toContain(chatId);
    expect(carolChats.length).toBe(0);
  });

  it('a non-member cannot send into the chat (404, membership seek)', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedUser(env, 'carol');

    const chatId = (await call(env, 'alice', 'startChat', { otherUserId: 'bob' })).body.chatId;
    const attempt = await call(env, 'carol', 'sendMessage', { chatId, text: 'hi' });
    expect(attempt.status).toBe(404); // "Chat not found." — non-member can't tell it exists
    // A real member can.
    expect((await call(env, 'alice', 'sendMessage', { chatId, text: 'hi' })).status).toBe(200);
  });

  it('deleteChat removes the membership edges and the chat leaves the inbox', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    const chatId = (await call(env, 'alice', 'startChat', { otherUserId: 'bob' })).body.chatId;
    expect(await members(env, chatId)).toEqual(['alice', 'bob']);

    expect((await call(env, 'alice', 'deleteChat', { chatId })).status).toBe(200);

    expect(await members(env, chatId)).toEqual([]);
    expect((await readChats(env, 'alice')).body.length).toBe(0);
    expect((await readChats(env, 'bob')).body.length).toBe(0);
  });

  it('migration backfill populates chat_members from a legacy JSON-only chat row', async () => {
    const { env, db } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    // Simulate a pre-migration chat: a `chats` row with a `users` JSON array but
    // NO chat_members rows (as every chat looked before migration 0045).
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.chats)
      .values({
        id: 'legacy-1',
        users: ['alice', 'bob'] as any,
        usersData: [] as any,
        lastMessage: null as any,
        createdAt: ts,
        updatedAt: ts,
      } as any);
    expect(await members(env, 'legacy-1')).toEqual([]); // not indexed yet

    // Re-run the real migration file (idempotent) — its INSERT OR IGNORE backfill
    // is what a deploy runs against the existing table.
    const sql = fs.readFileSync(
      path.join(import.meta.dirname, '..', 'migrations', '0045_chat_members.sql'),
      'utf8',
    );
    db.exec(sql);

    expect(await members(env, 'legacy-1')).toEqual(['alice', 'bob']);
    // And now it lists.
    expect((await readChats(env, 'alice')).body.map((c) => c.id)).toContain('legacy-1');
  });
});
