/**
 * Ownership checks and query-parameter bounds — the two places this API leaked.
 *
 * Both classes of defect share a shape: an id or a number arrived from the client
 * and was used without asking whether the caller was entitled to it, or whether it
 * was even in range. Neither shows up in a typecheck, and neither had a test.
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

async function read(env: TestEnv, path: string, uid?: string) {
  const res = await app.request(
    `http://x${path}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedUser(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 0, createdAt: ts, updatedAt: ts } as any);
}

async function seedStory(env: TestEnv, id: string, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.stories)
    .values({
      id,
      userId: uid,
      username: uid,
      mediaUrl: `https://cdn.test/${id}.jpg`,
      mediaType: 'photo',
      visibility: 'public',
      createdAt: ts,
      expiresAt: ts + 86_400_000,
      ...extra,
    } as any);
}

// ===========================================================================
/**
 * THE STORY IDOR.
 *
 * `createHighlight` stored `storyIds` verbatim with no validation at all, and
 * `GET /read/highlights/:id/stories` checked visibility against the HIGHLIGHT's
 * owner — which, for a highlight the attacker created, is the attacker. So:
 * harvest a victim's story ids from the public `GET /read/users/:id/stories`, pin
 * them into your own highlight, and that endpoint served the victim's full story
 * rows to anyone, unauthenticated, labelled with your username.
 */
describe('highlight story ownership', () => {
  it('refuses to create a highlight containing someone else\'s story', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'attacker');
    await seedUser(env, 'victim');
    await seedStory(env, 'victim_story', 'victim');

    const res = await call(env, 'attacker', 'createHighlight', {
      name: 'Mine',
      storyIds: ['victim_story'],
    });

    expect(res.status).toBe(403);
    expect(await drizzleOf(env).select().from(schema.highlights).all()).toHaveLength(0);
  });

  it('refuses to pin someone else\'s story into a highlight you own', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'attacker');
    await seedUser(env, 'victim');
    await seedStory(env, 'victim_story', 'victim');
    const created = await call(env, 'attacker', 'createHighlight', { name: 'Mine', storyIds: [] });
    expect(created.status).toBe(200);

    const res = await call(env, 'attacker', 'addStoryToHighlight', {
      highlightId: created.body.highlightId,
      storyId: 'victim_story',
    });

    expect(res.status).toBe(403);
    const h = await drizzleOf(env)
      .select()
      .from(schema.highlights)
      .where(eq(schema.highlights.id, created.body.highlightId))
      .get();
    expect((h?.storyIds as string[]) ?? []).toEqual([]);
  });

  it('allows a highlight of your own stories', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedStory(env, 's1', 'alice');
    await seedStory(env, 's2', 'alice');

    const created = await call(env, 'alice', 'createHighlight', {
      name: 'Trip',
      storyIds: ['s1', 's2'],
    });

    expect(created.status).toBe(200);
    const view = await read(env, `/read/highlights/${created.body.highlightId}/stories`);
    expect(view.body?.stories?.map((s: any) => s.id).sort()).toEqual(['s1', 's2']);
  });

  /**
   * Defence in depth: a highlight written BEFORE the write-side validation existed
   * still cannot leak, because the read filters by author too.
   */
  it('never serves a foreign story from a pre-existing poisoned highlight', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'attacker');
    await seedUser(env, 'victim');
    await seedStory(env, 'victim_story', 'victim', { visibility: 'private' });
    await seedStory(env, 'attacker_story', 'attacker');
    // Written directly, as the old unvalidated handler would have.
    await drizzleOf(env)
      .insert(schema.highlights)
      .values({
        id: 'poisoned',
        userId: 'attacker',
        name: 'Mine',
        coverImageUrl: null,
        storyIds: ['attacker_story', 'victim_story'] as any,
        createdAt: Date.now(),
      } as any);

    const view = await read(env, '/read/highlights/poisoned/stories');

    const ids = (view.body?.stories ?? []).map((s: any) => s.id);
    expect(ids).toEqual(['attacker_story']);
    expect(ids).not.toContain('victim_story');
  });

  it('rejects a storyIds value that is not an array of ids', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    // A nested object used to be JSON-stored and then blew up on read.
    expect((await call(env, 'alice', 'createHighlight', { storyIds: { nope: 1 } })).status).toBe(400);
    expect((await call(env, 'alice', 'createHighlight', { storyIds: [42] })).status).toBe(400);
  });

  it('caps how many stories one highlight may hold', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const res = await call(env, 'alice', 'createHighlight', {
      storyIds: Array.from({ length: 101 }, (_, i) => `s${i}`),
    });

    expect(res.status).toBe(400);
  });
});

// ===========================================================================
/**
 * `videoStatus` selected `playbackUrl`/`mp4Url` for any 50 caller-supplied guids
 * with no `ownerUid` predicate, so it resolved direct playback links for anyone's
 * uploads — including ones not yet attached to any public object.
 */
describe('videoStatus ownership', () => {
  async function seedVideo(env: TestEnv, id: string, ownerUid: string) {
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.videos)
      .values({
        id,
        ownerUid,
        provider: 'bunny',
        status: 'ready',
        playbackUrl: `https://cdn.test/${id}/playlist.m3u8`,
        mp4Url: `https://cdn.test/${id}/720p.mp4`,
        createdAt: ts,
        updatedAt: ts,
      } as any);
  }

  it('returns only the caller\'s own videos', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedVideo(env, 'alice_vid', 'alice');
    await seedVideo(env, 'bob_vid', 'bob');

    const res = await call(env, 'alice', 'videoStatus', { videoIds: ['alice_vid', 'bob_vid'] });

    expect(res.status).toBe(200);
    expect(res.body.videos.map((v: any) => v.id)).toEqual(['alice_vid']);
    // And nothing leaked the other row's playback urls.
    expect(JSON.stringify(res.body)).not.toContain('bob_vid');
  });

  it('returns nothing for a guid the caller does not own', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'attacker');
    await seedUser(env, 'victim');
    await seedVideo(env, 'victim_vid', 'victim');

    const res = await call(env, 'attacker', 'videoStatus', { videoIds: ['victim_vid'] });

    expect(res.status).toBe(200);
    expect(res.body.videos).toEqual([]);
  });
});

// ===========================================================================
/**
 * Pagination bounds. `Math.min(parseInt(...), max)` is unsafe at BOTH ends:
 * `?limit=-1` passes through untouched and SQLite reads a negative LIMIT as NO
 * LIMIT, and `?limit=abc` yields NaN which then gets bound as the LIMIT parameter.
 * `/read/matches` is `optionalAuth`, so this was reachable unauthenticated and its
 * result was written into the shared cache under a caller-chosen key.
 */
describe('pagination bounds', () => {
  async function seedMatches(env: TestEnv, n: number) {
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    const ts = Date.now();
    const rows = Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      contestId: 'c1',
      status: 'active',
      type: 'photo',
      title: `Battle ${i}`,
      entryFee: 10,
      userA: { uid: 'alice', username: 'alice', mediaUrl: 'https://cdn.test/a.jpg' } as any,
      userB: { uid: 'bob', username: 'bob', mediaUrl: 'https://cdn.test/b.jpg' } as any,
      totalVotes: 0,
      createdAt: ts - i * 1000,
      expiresAt: ts + 86_400_000,
    }));
    await drizzleOf(env).insert(schema.contestMatches).values(rows as any);
  }

  it('a negative limit does not become "no limit"', async () => {
    const { env } = makeEnv();
    await seedMatches(env, 8);

    const res = await read(env, '/read/matches?limit=-1');

    expect(res.status).toBe(200);
    // The floor is 1 — the whole table must not come back.
    expect(res.body).toHaveLength(1);
  });

  it('a non-numeric limit falls back to the default instead of binding NaN', async () => {
    const { env } = makeEnv();
    await seedMatches(env, 8);

    const res = await read(env, '/read/matches?limit=abc');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(8); // default 30, capped by what exists
  });

  it('still enforces the documented maximum', async () => {
    const { env } = makeEnv();
    await seedMatches(env, 8);

    const res = await read(env, '/read/matches?limit=99999');

    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(8);
  });

  it('a garbage cursor returns the first page rather than an empty one', async () => {
    const { env } = makeEnv();
    await seedMatches(env, 5);

    const res = await read(env, '/read/matches?cursor=abc');

    expect(res.status).toBe(200);
    // NaN in the WHERE clause silently matched nothing, so a paginated list just
    // stopped with nothing to debug.
    expect(res.body).toHaveLength(5);
  });

  it('bounds the authenticated paginators too', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const ts = Date.now();
    await drizzleOf(env)
      .insert(schema.notifications)
      .values(
        Array.from({ length: 6 }, (_, i) => ({
          id: `n${i}`,
          recipientId: 'alice',
          title: `n${i}`,
          body: 'x',
          type: 'system',
          read: false,
          createdAt: ts - i * 1000,
        })) as any,
      );

    // `-2` on a `limit + 1` paginator used to produce the same unbounded dump.
    const negative = await read(env, '/read/notifications?limit=-2', 'alice');
    expect(negative.status).toBe(200);
    expect(negative.body).toHaveLength(1);

    const garbageCursor = await read(env, '/read/notifications?cursor=abc', 'alice');
    expect(garbageCursor.status).toBe(200);
    expect(garbageCursor.body).toHaveLength(6);
  });
});
