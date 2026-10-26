/**
 * Distribution eligibility: which battles may be ranked into For You, the
 * Explore lists (/read/matches open/recent/hot/ending) and universal search.
 *
 * - Invite-only battles (`is_private`) are for the invited player only.
 * - A battle with a participant who is pending deletion, deleted, or blocked by
 *   an admin is not distributed. A direct link (/read/matches/:id) still opens it.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

async function get(env: TestEnv, path: string, uid?: string) {
  const res = await app.request(`/read${path}`, { headers: uid ? { Authorization: `Bearer ${uid}` } : {} }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function user(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: 1, updatedAt: 1, ...extra } as any);
}

async function match(env: TestEnv, id: string, a: string, b: string, extra: Record<string, any> = {}) {
  const now = Date.now();
  await drizzleOf(env)
    .insert(schema.contestMatches)
    .values({
      id,
      status: 'active',
      type: 'photo',
      title: `Dance battle ${id}`,
      userA: { uid: a, username: a, mediaUrl: 'https://media.example.com/a.jpg' },
      userB: { uid: b, username: b, mediaUrl: 'https://media.example.com/b.jpg' },
      createdAt: now,
      activatedAt: now,
      expiresAt: now + 3_600_000,
      ...extra,
    } as any);
}

const ids = (list: any[]) => list.map((m: any) => m.id).sort();
const forYou = async (env: TestEnv, uid?: string) =>
  ids((await get(env, '/matches?status=active&sort=foryou&limit=20', uid)).body.items);
const list = async (env: TestEnv, sort: string) =>
  ids((await get(env, `/matches?status=active&sort=${sort}&limit=20`)).body);
const search = async (env: TestEnv, uid?: string) => ids((await get(env, '/search?q=dance', uid)).body.battles);

async function world() {
  const { env } = makeEnv();
  for (const u of ['me', 'pa', 'pb', 'pc', 'pd']) await user(env, u);
  await match(env, 'open', 'pa', 'pb');
  return env;
}

describe('invite-only battles', () => {
  it('are left out of For You and every Explore list', async () => {
    const env = await world();
    await match(env, 'invite', 'pc', 'pd', { isPrivate: true });

    expect(await forYou(env, 'me')).toEqual(['open']);
    expect(await forYou(env)).toEqual(['open']);
    for (const sort of ['recent', 'hot', 'ending']) expect(await list(env, sort)).toEqual(['open']);
    expect(await search(env)).toEqual(['open']);
  });

  it('still open from a direct link', async () => {
    const env = await world();
    await match(env, 'invite', 'pc', 'pd', { isPrivate: true });
    expect((await get(env, '/matches/invite', 'pc')).body?.id).toBe('invite');
  });
});

describe('battles with an out-of-service participant', () => {
  const cases: Array<[string, Record<string, any>]> = [
    ['pending deletion', { status: 'pending_deletion' }],
    ['deleted', { status: 'deleted' }],
    ['blocked by an admin', { isBlocked: true }],
  ];

  for (const [label, patch] of cases) {
    it(`are not distributed when a participant is ${label}`, async () => {
      const env = await world();
      await match(env, 'gone', 'pc', 'pd');
      await drizzleOf(env).update(schema.users).set(patch as any).where(eq(schema.users.uid, 'pd'));

      expect(await forYou(env, 'me')).toEqual(['open']);
      expect(await forYou(env)).toEqual(['open']);
      for (const sort of ['recent', 'hot', 'ending']) expect(await list(env, sort)).toEqual(['open']);
      expect(await search(env, 'me')).toEqual(['open']);
      expect(await search(env)).toEqual(['open']);
    });
  }

  it('still open from a direct link', async () => {
    const env = await world();
    await match(env, 'gone', 'pc', 'pd');
    await drizzleOf(env).update(schema.users).set({ isBlocked: true } as any).where(eq(schema.users.uid, 'pd'));
    expect((await get(env, '/matches/gone', 'me')).body?.id).toBe('gone');
  });

  it('keep paging intact: the next cursor counts the dropped row', async () => {
    const env = await world();
    await match(env, 'gone', 'pc', 'pd', { totalVotes: 99 });
    await drizzleOf(env).update(schema.users).set({ status: 'deleted' } as any).where(eq(schema.users.uid, 'pc'));
    const res = await app.request('/read/matches?status=active&sort=hot&limit=1', {}, env, fakeCtx());
    // The hidden battle ranked first and was dropped; the page is empty but the cursor moves on.
    expect(await res.json()).toEqual([]);
    const cursor = res.headers.get('X-Next-Cursor');
    expect(cursor).toBeTruthy();
    const next = await get(env, `/matches?status=active&sort=hot&limit=1&cursor=${cursor}`);
    expect(ids(next.body)).toEqual(['open']);
  });
});
