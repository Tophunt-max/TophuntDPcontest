import { vi, describe, it, expect } from 'vitest';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// Durable Object counters cannot start in this harness (see blocks.test.ts).
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({ like: 1, comment: 1, share: 1 }),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
  finalizeVotes: async () => ({ votesA: 0, votesB: 0, total: 0 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { resolveContests } from '../src/cron';

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

async function read(env: TestEnv, uid: string | null, path: string) {
  const res = await app.request(`/read${path}`, { headers: uid ? { Authorization: `Bearer ${uid}` } : {} }, env, fakeCtx());
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function admin(env: TestEnv, method: string, path: string, body?: any) {
  const res = await app.request(
    `/admin${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function seedUser(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    // Old, verified accounts, so reports are accepted and count normally.
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, dpcoin: 1000, createdAt: ts - 30 * 86_400_000, updatedAt: ts, emailVerified: true } as any);
}

async function follow(env: TestEnv, followerId: string, followingId: string) {
  await drizzleOf(env).insert(schema.follows).values({ followerId, followingId, createdAt: Date.now() } as any);
}

async function seedMatch(env: TestEnv, id: string, a: string, b: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.contestMatches)
    .values({
      id, status: 'active', type: 'photo', title: `Battle ${id}`, entryFee: 20, prizeCoins: 20,
      joinIdA: `${id}-a`,
      userA: { uid: a, username: a, mediaUrl: `${a}.jpg`, votes: 0 },
      userB: { uid: b, username: b, mediaUrl: `${b}.jpg`, votes: 0 },
      totalVotes: 0, likeCount: 0, commentCount: 0, shareCount: 0, minVotesRequired: 0,
      createdAt: ts, activatedAt: ts, expiresAt: ts + 86_400_000,
      ...extra,
    } as any);
}

async function world(...uids: string[]) {
  const { env } = makeEnv();
  for (const u of uids) await seedUser(env, u);
  return env;
}

const notifCount = async (env: TestEnv, recipient: string, type?: string) =>
  Number(
    ((await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = ?1${type ? ' AND type = ?2' : ''}`,
    )
      .bind(recipient, ...(type ? [type] : []))
      .first()) as any)?.n ?? 0,
  );

// ===========================================================================
describe('relationship: follows you, restrict and story-hide flags', () => {
  it('reports the reverse follow edge and the viewer\'s own restrict / hide state', async () => {
    const env = await world('alice', 'bob');
    expect((await read(env, 'alice', '/users/bob/relationship')).body).toEqual({
      state: 'none', followsMe: false, restrictedByMe: false, storyHiddenByMe: false,
    });
    await follow(env, 'bob', 'alice');
    await call(env, 'alice', 'restrictUser', { targetUserId: 'bob' });
    await call(env, 'alice', 'hideStoryFrom', { targetUserId: 'bob' });
    expect((await read(env, 'alice', '/users/bob/relationship')).body).toEqual({
      state: 'none', followsMe: true, restrictedByMe: true, storyHiddenByMe: true,
    });
    // One-way: bob sees none of alice's choices.
    expect((await read(env, 'bob', '/users/alice/relationship')).body).toMatchObject({
      followsMe: false, restrictedByMe: false, storyHiddenByMe: false,
    });
  });

  it('refuses self and unknown targets', async () => {
    const env = await world('alice');
    expect((await call(env, 'alice', 'restrictUser', { targetUserId: 'alice' })).status).toBe(400);
    expect((await call(env, 'alice', 'hideStoryFrom', { targetUserId: 'ghost' })).status).toBe(404);
  });
});

describe('mutual followers', () => {
  it('lists only the viewer\'s own followings who follow the target, minus blocked accounts', async () => {
    const env = await world('alice', 'target', 'm1', 'm2', 'm3', 'stranger');
    for (const m of ['m1', 'm2', 'm3']) {
      await follow(env, 'alice', m);
      await follow(env, m, 'target');
    }
    await follow(env, 'stranger', 'target'); // alice does not follow them
    expect((await read(env, 'alice', '/users/target/mutuals')).body.count).toBe(3);

    await call(env, 'alice', 'blockUser', { targetUserId: 'm2' });
    const after = (await read(env, 'alice', '/users/target/mutuals')).body;
    expect(after.count).toBe(2);
    expect(after.users.map((u: any) => u.uid).sort()).toEqual(['m1', 'm3']);
  });
});

describe('restrict', () => {
  it('hides a restricted account\'s comments from everyone but the commenter and the owner', async () => {
    const env = await world('alice', 'bob', 'troll', 'viewer');
    await seedMatch(env, 'm1', 'alice', 'bob');
    const ts = Date.now();
    await drizzleOf(env).insert(schema.matchComments).values([
      { id: 'c1', matchId: 'm1', userId: 'troll', text: 'mean', createdAt: ts },
      { id: 'c2', matchId: 'm1', userId: 'viewer', text: 'nice', createdAt: ts + 1 },
    ] as any);
    await call(env, 'alice', 'restrictUser', { targetUserId: 'troll' });

    const ids = async (uid: string | null) =>
      (await read(env, uid, '/comments?targetType=matches&targetId=m1')).body.items.map((i: any) => i.id).sort();
    expect(await ids(null)).toEqual(['c2']);
    expect(await ids('viewer')).toEqual(['c2']);
    expect(await ids('bob')).toEqual(['c2']); // the other participant did not restrict
    expect(await ids('troll')).toEqual(['c1', 'c2']);
    const own = (await read(env, 'alice', '/comments?targetType=matches&targetId=m1')).body.items;
    expect(own.find((i: any) => i.id === 'c1')?.restricted).toBe(true);

    await call(env, 'alice', 'unrestrictUser', { targetUserId: 'troll' });
    expect(await ids(null)).toEqual(['c1', 'c2']);
  });

  it('a restricted account\'s activity does not notify the owner who restricted them', async () => {
    const env = await world('alice', 'bob', 'troll');
    await seedMatch(env, 'm1', 'alice', 'bob');
    await call(env, 'alice', 'restrictUser', { targetUserId: 'troll' });
    // Commenting still works for them (they are not told).
    expect((await call(env, 'troll', 'addComment', { targetType: 'matches', targetId: 'm1', text: 'hey' })).status).toBe(200);
    // addComment notifies inside waitUntil, which this harness starts but does not await.
    await new Promise((r) => setTimeout(r, 100));
    expect(await notifCount(env, 'alice', 'match_comment')).toBe(0);
    expect(await notifCount(env, 'bob', 'match_comment')).toBe(1);
  });
});

describe('hide story from', () => {
  it('removes the owner\'s stories from that one viewer and refuses viewing', async () => {
    const env = await world('alice', 'bob', 'carol');
    const ts = Date.now();
    await drizzleOf(env).insert(schema.stories).values({
      id: 's1', userId: 'alice', mediaUrl: 's.jpg', visibility: 'public', createdAt: ts, expiresAt: ts + 86_400_000,
    } as any);
    const owners = async (uid: string) =>
      ((await read(env, uid, '/stories/feed')).body as any[]).map((s: any) => s.userId ?? s.uid);

    expect(await owners('bob')).toContain('alice');
    await call(env, 'alice', 'hideStoryFrom', { targetUserId: 'bob' });
    expect(await owners('bob')).not.toContain('alice');
    expect(await owners('carol')).toContain('alice');
    expect((await read(env, 'bob', '/users/alice/stories')).body ?? []).toHaveLength(0);
    expect((await call(env, 'bob', 'viewStory', { storyId: 's1' })).status).toBe(404);
    expect((await call(env, 'carol', 'viewStory', { storyId: 's1' })).status).toBe(200);

    await call(env, 'alice', 'unhideStoryFrom', { targetUserId: 'bob' });
    expect(await owners('bob')).toContain('alice');
  });
});

describe('Blocked & Muted lists restricted and story-hidden accounts', () => {
  it('returns all four lists', async () => {
    const env = await world('alice', 'bob', 'carol');
    await call(env, 'alice', 'restrictUser', { targetUserId: 'bob' });
    await call(env, 'alice', 'hideStoryFrom', { targetUserId: 'carol' });
    const body = (await read(env, 'alice', '/blocked')).body;
    expect(body.restricted.map((u: any) => u.uid)).toEqual(['bob']);
    expect(body.storyHidden.map((u: any) => u.uid)).toEqual(['carol']);
    expect(body.blocked).toEqual([]);
    expect(body.muted).toEqual([]);
  });
});

describe('My reports', () => {
  it('shows the reporter their own reports and the outcome, and tells them', async () => {
    const env = await world('rep', 'alice', 'bob');
    await call(env, 'rep', 'createReport', { targetType: 'user', targetId: 'bob', reason: 'spam: Spam' });
    let items = (await read(env, 'rep', '/me/reports')).body.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ targetType: 'account', targetId: 'bob', reason: 'spam: Spam', status: 'open', resolvedAt: null });

    const id = ((await env.DB.prepare('SELECT id FROM reports LIMIT 1').first()) as any).id;
    expect((await admin(env, 'POST', `/reports/${id}/resolve`, { action: 'dismiss' })).status).toBe(200);
    items = (await read(env, 'rep', '/me/reports')).body.items;
    expect(items[0].status).toBe('dismissed');
    expect(items[0].resolvedAt).toBeGreaterThan(0);
    expect(await notifCount(env, 'rep', 'report_update')).toBe(1);

    // Nobody else sees them.
    expect((await read(env, 'alice', '/me/reports')).body.items).toEqual([]);
  });
});

describe('battle ending reminder', () => {
  it('also nudges people who saved the battle, once', async () => {
    const env = await world('alice', 'bob', 'saver', 'other');
    await seedMatch(env, 'm1', 'alice', 'bob', { expiresAt: Date.now() + 30 * 60_000 });
    const ts = Date.now();
    await drizzleOf(env).insert(schema.bookmarks).values([
      { userId: 'saver', matchId: 'm1', createdAt: ts },
      { userId: 'alice', matchId: 'm1', createdAt: ts }, // a participant gets only the participant message
    ] as any);

    await resolveContests(env as any);
    await resolveContests(env as any);

    expect(await notifCount(env, 'saver', 'contest-ending')).toBe(1);
    expect(await notifCount(env, 'alice', 'contest-ending')).toBe(1);
    expect(await notifCount(env, 'other', 'contest-ending')).toBe(0);
    const note = (await env.DB.prepare("SELECT title FROM notifications WHERE recipient_id = 'saver'").first()) as any;
    expect(note.title).toBe('Last chance to vote ⏳');
  });
});
