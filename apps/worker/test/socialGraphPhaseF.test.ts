/**
 * Social graph and comments (Phase F): race-safe counters, block cleanup,
 * tie-stable follower paging, comment idempotency, private-post threads and
 * comment likes.
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
const h = vi.hoisted(() => ({ comments: new Map<string, number>() }));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async (_env: unknown, matchId: string, name: string, delta: number) => {
    if (name === 'comment') h.comments.set(matchId, (h.comments.get(matchId) ?? 0) + delta);
    return { like: 0, comment: h.comments.get(matchId) ?? 0, share: 0 };
  },
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

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
async function get(env: TestEnv, path: string, uid?: string) {
  const res = await app.request(`/read${path}`, { headers: uid ? { Authorization: `Bearer ${uid}` } : {} }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => null)) as any, headers: res.headers };
}
const counts = async (env: TestEnv, uid: string) =>
  (await drizzleOf(env)
    .select({ followers: schema.users.followersCount, following: schema.users.followingCount })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get())!;
async function match(env: TestEnv, id: string) {
  await drizzleOf(env).insert(schema.contestMatches).values({
    id, status: 'active', type: 'photo', title: id,
    userA: { uid: 'pa', username: 'pa' }, userB: { uid: 'pb', username: 'pb' },
    createdAt: Date.now(), expiresAt: Date.now() + 3_600_000,
  } as any);
}

// ===========================================================================
describe('unfollow', () => {
  it('two concurrent unfollows decrement once', async () => {
    const { env } = makeEnv();
    await user(env, 'me', { followingCount: 5 });
    await user(env, 'star', { followersCount: 9 });
    await api(env, 'me', 'toggleFollow', { targetUserId: 'star', intent: 'follow' });
    expect(await counts(env, 'me')).toMatchObject({ following: 6 });

    await Promise.all([
      api(env, 'me', 'toggleFollow', { targetUserId: 'star', intent: 'unfollow' }),
      api(env, 'me', 'toggleFollow', { targetUserId: 'star', intent: 'unfollow' }),
    ]);
    expect(await counts(env, 'me')).toMatchObject({ following: 5 });
    expect(await counts(env, 'star')).toMatchObject({ followers: 9 });
  });
});

describe('block', () => {
  it('removes the blocked person\'s follow-request notification', async () => {
    const { env } = makeEnv();
    await user(env, 'owner', { isPrivate: true });
    await user(env, 'fan');
    expect((await api(env, 'fan', 'toggleFollow', { targetUserId: 'owner', intent: 'follow' })).body.requested).toBe(true);
    const before = await env.DB.prepare("SELECT COUNT(*) n FROM notifications WHERE recipient_id='owner' AND type='follow_request'").first<any>();
    expect(before.n).toBe(1);

    await api(env, 'owner', 'blockUser', { targetUserId: 'fan' });
    const after = await env.DB.prepare("SELECT COUNT(*) n FROM notifications WHERE recipient_id='owner' AND type='follow_request'").first<any>();
    expect(after.n).toBe(0);
  });
});

describe('followers paging', () => {
  it('does not skip followers who share a timestamp (e.g. approved together on going public)', async () => {
    const { env } = makeEnv();
    await user(env, 'star');
    const fans = Array.from({ length: 7 }, (_, i) => `fan${i}`);
    for (const f of fans) await user(env, f);
    await drizzleOf(env).insert(schema.follows).values(fans.map((f) => ({ followerId: f, followingId: 'star', createdAt: 5000 })) as any);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r = await get(env, `/users/star/followers?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'star');
      const list = Array.isArray(r.body) ? r.body : r.body.items;
      seen.push(...list.map((u: any) => u.id));
      cursor = r.headers.get('X-Next-Cursor');
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual([...fans].sort());
  });
});

// ===========================================================================
describe('addComment', () => {
  it('two in-flight requests with one clientId store, count and notify once', async () => {
    const { env } = makeEnv();
    h.comments.clear();
    await user(env, 'me');
    await user(env, 'pa');
    await user(env, 'pb');
    await match(env, 'm1');
    const send = () => api(env, 'me', 'addComment', { targetType: 'matches', targetId: 'm1', text: 'nice', clientId: 'c_same_attempt1' });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const rows = await env.DB.prepare("SELECT COUNT(*) n FROM match_comments WHERE match_id='m1'").first<any>();
    expect(rows.n).toBe(1);
    expect(h.comments.get('m1')).toBe(1);
  });

  it('refuses a battle or post that does not exist', async () => {
    const { env } = makeEnv();
    await user(env, 'me');
    expect((await api(env, 'me', 'addComment', { targetType: 'matches', targetId: 'nope', text: 'x' })).status).toBe(404);
    expect((await api(env, 'me', 'addComment', { targetType: 'posts', targetId: 'nope', text: 'x' })).status).toBe(404);
  });

  it('keeps a private account\'s post thread to its followers (write and read)', async () => {
    const { env } = makeEnv();
    await user(env, 'owner', { isPrivate: true });
    await user(env, 'friend');
    await user(env, 'stranger');
    await drizzleOf(env).insert(schema.posts).values({ id: 'p1', userId: 'owner', createdAt: 1 } as any);
    await drizzleOf(env).insert(schema.follows).values({ followerId: 'friend', followingId: 'owner', createdAt: 1 } as any);

    expect((await api(env, 'friend', 'addComment', { targetType: 'posts', targetId: 'p1', text: 'hi' })).status).toBe(200);
    expect((await api(env, 'stranger', 'addComment', { targetType: 'posts', targetId: 'p1', text: 'hi' })).status).toBe(403);

    expect((await get(env, '/comments?targetType=posts&targetId=p1', 'friend')).body.items).toHaveLength(1);
    const locked = await get(env, '/comments?targetType=posts&targetId=p1', 'stranger');
    expect(locked.body).toMatchObject({ items: [], locked: true });
    expect((await get(env, '/comments?targetType=posts&targetId=p1')).body.items).toEqual([]);
  });
});

describe('deleteComment', () => {
  it('a double delete decrements once', async () => {
    const { env } = makeEnv();
    h.comments.clear();
    await user(env, 'me');
    await match(env, 'm1');
    const { body } = await api(env, 'me', 'addComment', { targetType: 'matches', targetId: 'm1', text: 'x' });
    await Promise.all([
      api(env, 'me', 'deleteComment', { targetType: 'matches', targetId: 'm1', commentId: body.commentId }),
      api(env, 'me', 'deleteComment', { targetType: 'matches', targetId: 'm1', commentId: body.commentId }),
    ]);
    expect(h.comments.get('m1')).toBe(0);
  });
});

describe('likeComment', () => {
  async function setup() {
    const { env } = makeEnv();
    await user(env, 'me');
    await user(env, 'author');
    await match(env, 'm1');
    const { body } = await api(env, 'author', 'addComment', { targetType: 'matches', targetId: 'm1', text: 'x' });
    return { env, id: body.commentId as string };
  }
  const likeCount = async (env: TestEnv, id: string) =>
    (await env.DB.prepare('SELECT like_count n FROM match_comments WHERE id = ?').bind(id).first<any>()).n;

  it('an explicit state is replay-safe', async () => {
    const { env, id } = await setup();
    for (let i = 0; i < 3; i++) {
      expect((await api(env, 'me', 'likeComment', { commentId: id, targetType: 'matches', liked: true })).body).toMatchObject({ liked: true, likeCount: 1 });
    }
    expect((await api(env, 'me', 'likeComment', { commentId: id, targetType: 'matches', liked: false })).body).toMatchObject({ liked: false, likeCount: 0 });
  });

  it('two concurrent likes count once', async () => {
    const { env, id } = await setup();
    await Promise.all([
      api(env, 'me', 'likeComment', { commentId: id, targetType: 'matches' }),
      api(env, 'me', 'likeComment', { commentId: id, targetType: 'matches' }),
    ]);
    expect(await likeCount(env, id)).toBeLessThanOrEqual(1);
  });

  it('refuses a comment that does not exist', async () => {
    const { env } = await setup();
    expect((await api(env, 'me', 'likeComment', { commentId: 'ghost', targetType: 'matches', liked: true })).status).toBe(404);
  });
});
