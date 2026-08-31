/**
 * A profile photo change must reach EVERY surface, not just the profile screen.
 *
 * Most surfaces render a person from a SNAPSHOT frozen at write time — a battle's
 * userA/userB blob, a chat member list, a notification actor. Those snapshots
 * captured whatever photo the user had then and were never rewritten, so a user
 * who changed their photo kept showing the old face on the feed, the inbox and
 * their notifications forever. The read path now looks the current photo up live
 * (one batched query, same mechanism as the verified badge) and injects it, so
 * the avatar is always current however old the snapshot is.
 *
 * These tests pin that: seed an OLD photo into each snapshot, a NEW photo on the
 * user's row, and assert the read returns the new one.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';

const app = makeApp();

const NEW = 'https://cdn.test/avatars/new.jpg';
const OLD = 'https://cdn.test/avatars/old.jpg';

async function read(env: TestEnv, uid: string | null, path: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({
      uid,
      username: uid,
      fullName: uid,
      status: 'active',
      dpcoin: 0,
      createdAt: ts,
      updatedAt: ts,
      ...extra,
    } as any);
}

describe('a changed profile photo reaches snapshot-backed surfaces', () => {
  it('refreshes a battle participant photo (both the url and the thumb the client prefers)', async () => {
    const { env } = makeEnv();
    // alice changed her photo to NEW; the match snapshot still has OLD.
    await seedUser(env, 'alice', { profileImageUrl: NEW });
    await seedUser(env, 'bob', { profileImageUrl: NEW });
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.contestMatches)
      .values({
        id: 'm1',
        status: 'active',
        userA: { uid: 'alice', username: 'alice', profilePic: OLD },
        userB: { uid: 'bob', username: 'bob', profilePic: OLD },
        totalVotes: 0,
        createdAt: ts,
      } as any);

    const res = await read(env, 'bob', '/matches/m1');
    // The client falls back to profilePic and PREFERS profilePicThumb — both must
    // be the current photo, or a photo change reaches only one of them.
    expect(res.body.userA.profilePic).toBe(NEW);
    expect(res.body.userA.profilePicThumb).toBe(NEW);
    expect(res.body.userA.profilePic).not.toBe(OLD);
  });

  it('clears a removed photo to an empty string so the client shows initials', async () => {
    const { env } = makeEnv();
    // alice removed her photo (users row has none); the snapshot still has OLD.
    await seedUser(env, 'alice', { profileImageUrl: null });
    await seedUser(env, 'bob');
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.contestMatches)
      .values({
        id: 'm2',
        status: 'active',
        userA: { uid: 'alice', username: 'alice', profilePic: OLD },
        userB: { uid: 'bob', username: 'bob' },
        totalVotes: 0,
        createdAt: ts,
      } as any);

    const res = await read(env, 'bob', '/matches/m2');
    expect(res.body.userA.profilePic).toBe('');
    expect(res.body.userA.profilePicThumb).toBe('');
  });

  it('refreshes a chat member photo from the users_data snapshot', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { profileImageUrl: NEW });
    await seedUser(env, 'bob', { profileImageUrl: NEW });
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.chats)
      .values({
        id: 'chat1',
        users: ['alice', 'bob'],
        usersData: [
          { uid: 'alice', displayName: 'Alice', photoURL: OLD },
          { uid: 'bob', displayName: 'Bob', photoURL: OLD },
        ],
        createdAt: ts,
        updatedAt: ts,
      } as any);

    const res = await read(env, 'bob', '/chats');
    const chat = res.body.find((c: any) => c.id === 'chat1');
    const alice = chat.usersData.find((m: any) => m.uid === 'alice');
    expect(alice.photoURL).toBe(NEW);
    expect(alice.photoURL).not.toBe(OLD);
  });

  it('refreshes a notification actor avatar from the frozen actors snapshot', async () => {
    const { env } = makeEnv();
    // alice followed bob, then changed her photo. bob's inbox still has OLD.
    await seedUser(env, 'alice', { profileImageUrl: NEW });
    await seedUser(env, 'bob');
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.notifications)
      .values({
        id: 'n1',
        recipientId: 'bob',
        title: 'New Follower',
        body: 'alice started following you.',
        type: 'follow',
        targetId: 'alice',
        image: OLD,
        actorId: 'alice',
        actors: [{ uid: 'alice', username: 'alice', avatarUrl: OLD }],
        actorCount: 1,
        createdAt: ts,
      } as any);

    const res = await read(env, 'bob', '/notifications');
    const n = res.body.find((x: any) => x.id === 'n1');
    // The row avatar the client actually renders comes from actors[0].avatarUrl.
    expect(n.actors[0].avatarUrl).toBe(NEW);
    // The actor-driven row image is refreshed too, so it never re-surfaces OLD.
    expect(n.image).toBe(NEW);
  });

  it('leaves an admin/broadcast notification image alone (no actor to refresh from)', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'bob');
    const ts = Date.now();
    const banner = 'https://cdn.test/admin/banner.jpg';
    await drizzleOf(env)
      .insert(schema.notifications)
      .values({
        id: 'n2',
        recipientId: 'bob',
        title: 'Announcement',
        body: 'Something new!',
        type: 'admin',
        image: banner,
        actorCount: 1,
        createdAt: ts,
      } as any);

    const res = await read(env, 'bob', '/notifications');
    const n = res.body.find((x: any) => x.id === 'n2');
    expect(n.image).toBe(banner);
  });
});


describe('a changed username reaches snapshot-backed surfaces', () => {
  it('refreshes a battle participant username on the feed', async () => {
    const { env } = makeEnv();
    // alice renamed herself to alice_new; the match snapshot still says alice_old.
    await seedUser(env, 'alice', { username: 'alice_new' });
    await seedUser(env, 'bob', { username: 'bob' });
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.contestMatches)
      .values({
        id: 'mu1',
        status: 'active',
        userA: { uid: 'alice', username: 'alice_old', profilePic: '' },
        userB: { uid: 'bob', username: 'bob', profilePic: '' },
        totalVotes: 0,
        createdAt: ts,
      } as any);

    const res = await read(env, 'bob', '/matches/mu1');
    expect(res.body.userA.username).toBe('alice_new');
    expect(res.body.userA.username).not.toBe('alice_old');
  });

  it('falls back to fullName when the username is empty', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { username: null, fullName: 'Alice Cooper' });
    await seedUser(env, 'bob', { username: 'bob' });
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.contestMatches)
      .values({
        id: 'mu2',
        status: 'active',
        userA: { uid: 'alice', username: 'alice_old', profilePic: '' },
        userB: { uid: 'bob', username: 'bob', profilePic: '' },
        totalVotes: 0,
        createdAt: ts,
      } as any);

    const res = await read(env, 'bob', '/matches/mu2');
    expect(res.body.userA.username).toBe('Alice Cooper');
  });

  it('refreshes a chat member displayName from the users_data snapshot', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { username: 'alice_new' });
    await seedUser(env, 'bob', { username: 'bob' });
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.chats)
      .values({
        id: 'chatu1',
        users: ['alice', 'bob'],
        usersData: [
          { uid: 'alice', displayName: 'alice_old', photoURL: null },
          { uid: 'bob', displayName: 'bob', photoURL: null },
        ],
        createdAt: ts,
        updatedAt: ts,
      } as any);

    const res = await read(env, 'bob', '/chats');
    const chat = res.body.find((c: any) => c.id === 'chatu1');
    const alice = chat.usersData.find((m: any) => m.uid === 'alice');
    expect(alice.displayName).toBe('alice_new');
  });
});
