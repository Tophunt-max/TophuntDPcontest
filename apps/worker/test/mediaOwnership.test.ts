/**
 * Deleting a story or post must never delete media another account uploaded.
 *
 * `createStory` accepts any url, and the app's "Repost" button creates a story
 * holding the ORIGINAL author's media url. Deleting by url alone then deleted
 * the author's photo/video when the repost was deleted, when the cron expired
 * the repost 24 h later, or when the reposter deleted their account, including
 * media still used by the author's Highlights or contest entry. Anyone could do
 * the same to anyone on purpose.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { resolveContests } from '../src/cron';
import { purgeDeletedAccountMedia } from '../src/lib/accountDeletion';
import { invalidateIntegrationCache } from '../src/lib/integrations';

const app = makeApp();
const BASE = 'https://cdn.test';
const GUID = '11111111-2222-4333-8444-555555555555';
const PLAYLIST = `${BASE}/videos/${GUID}/playlist.m3u8`;

/** What an encoded video leaves in the bucket. */
async function encoded(env: TestEnv) {
  await env.MEDIA.put(`videos/${GUID}/playlist.m3u8`, '#EXTM3U');
  await env.MEDIA.put(`videos/${GUID}/video_1/segment-0.ts`, new Uint8Array([0x47]));
  await env.MEDIA.put(`videos/${GUID}/thumbnail.jpg`, new Uint8Array([0xff, 0xd8, 0xff]));
}
const videoObjects = (env: TestEnv) => [...env.MEDIA._objects.keys()].filter((k) => k.startsWith(`videos/${GUID}/`));

async function call(env: TestEnv, uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` }, body: JSON.stringify({ action, ...data }) },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function seedUser(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: ts, updatedAt: ts } as any);
}

/** Put an object the way POST /upload does (uploader recorded), or as a legacy object. */
async function upload(env: TestEnv, key: string, uploader: string | null) {
  await env.MEDIA.put(key, new Uint8Array([0xff, 0xd8, 0xff]), {
    httpMetadata: { contentType: 'image/jpeg' },
    ...(uploader ? { customMetadata: { uploader } } : {}),
  });
  return `${BASE}/${key}`;
}

async function env0() {
  invalidateIntegrationCache();
  const { env } = makeEnv();
  for (const u of ['alice', 'bob']) await seedUser(env, u);
  return env;
}

describe('story media ownership on delete', () => {
  it("deleting a repost keeps the original author's photo; the author's delete removes it", async () => {
    const env = await env0();
    const url = await upload(env, 'stories/2026/10/alice.jpg', 'alice');
    const original = await call(env, 'alice', 'createStory', { mediaUrl: url, mediaType: 'image' });
    const repost = await call(env, 'bob', 'createStory', { mediaUrl: url, mediaType: 'image' });

    expect((await call(env, 'bob', 'deleteStory', { storyId: repost.body.storyId })).status).toBe(200);
    expect(env.MEDIA._objects.has('stories/2026/10/alice.jpg')).toBe(true);

    await call(env, 'alice', 'deleteStory', { storyId: original.body.storyId });
    expect(env.MEDIA._objects.has('stories/2026/10/alice.jpg')).toBe(false);
  });

  it("the 24 h expiry of a repost keeps the original author's photo", async () => {
    const env = await env0();
    const url = await upload(env, 'stories/2026/10/alice2.jpg', 'alice');
    await call(env, 'bob', 'createStory', { mediaUrl: url, mediaType: 'image' });
    await drizzleOf(env).update(schema.stories).set({ expiresAt: 1 } as any).run();

    await resolveContests(env as any);

    expect(env.MEDIA._objects.has('stories/2026/10/alice2.jpg')).toBe(true);
    expect(await drizzleOf(env).select().from(schema.stories).all()).toHaveLength(0); // the row still goes
  });

  it("a story naming someone else's encoded video cannot delete it", async () => {
    const env = await env0();
    const ts = Date.now();
    await encoded(env);
    await drizzleOf(env).insert(schema.videos).values({ id: GUID, ownerUid: 'alice', status: 'ready', createdAt: ts, updatedAt: ts } as any);
    const s = await call(env, 'bob', 'createStory', { mediaUrl: PLAYLIST, mediaType: 'video' });

    await call(env, 'bob', 'deleteStory', { storyId: s.body.storyId });

    expect(videoObjects(env)).toHaveLength(3);
    expect(await drizzleOf(env).select().from(schema.videos).where(eq(schema.videos.id, GUID)).get()).toBeTruthy();
  });

  it("the owner deleting their own story video deletes the whole folder, not just the playlist", async () => {
    // A single-key delete of the playlist URL would leave every segment and the
    // poster behind, billed and unreferenced.
    const env = await env0();
    const ts = Date.now();
    await encoded(env);
    await drizzleOf(env).insert(schema.videos).values({ id: GUID, ownerUid: 'alice', status: 'ready', createdAt: ts, updatedAt: ts } as any);
    const s = await call(env, 'alice', 'createStory', { mediaUrl: PLAYLIST, mediaType: 'video' });

    await call(env, 'alice', 'deleteStory', { storyId: s.body.storyId });

    expect(videoObjects(env)).toEqual([]);
    expect(await drizzleOf(env).select().from(schema.videos).where(eq(schema.videos.id, GUID)).get()).toBeUndefined();
  });

  it("a contest entry using someone else's encoded video is refused before any coins move", async () => {
    const env = await env0();
    const ts = Date.now();
    await drizzleOf(env).insert(schema.videos).values({ id: GUID, ownerUid: 'alice', status: 'ready', createdAt: ts, updatedAt: ts } as any);
    await drizzleOf(env).update(schema.users).set({ dpcoin: 500 } as any).where(eq(schema.users.uid, 'bob')).run();
    await drizzleOf(env).insert(schema.contests).values({
      id: 'cv', title: 'Video', type: 'video', status: 'live', totalEntryFee: 40, rewardCoins: 60, createdAt: ts,
    } as any);

    const res = await call(env, 'bob', 'startMatch', {
      contestId: 'cv', mediaUrl: PLAYLIST, mediaType: 'video', deviceId: 'b',
    });

    expect(res.body?.error?.message ?? res.body).toMatch(/another account/);
    expect(res.status).toBe(403);
    expect((await drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, 'bob')).get())?.dpcoin).toBe(500);
    expect(await drizzleOf(env).select().from(schema.contestMatches).all()).toHaveLength(0);
  });

  it('a legacy object with no uploader record is still deleted (old behaviour)', async () => {
    const env = await env0();
    const url = await upload(env, 'stories/2026/01/legacy.jpg', null);
    const s = await call(env, 'alice', 'createStory', { mediaUrl: url, mediaType: 'image' });
    await call(env, 'alice', 'deleteStory', { storyId: s.body.storyId });
    expect(env.MEDIA._objects.has('stories/2026/01/legacy.jpg')).toBe(false);
  });

  it("account deletion purges the account's own uploads but not media it merely referenced", async () => {
    const env = await env0();
    const mine = await upload(env, 'stories/2026/10/bob.jpg', 'bob');
    const theirs = await upload(env, 'stories/2026/10/alice3.jpg', 'alice');
    await purgeDeletedAccountMedia(env as any, 'bob', [mine, theirs]);
    expect(env.MEDIA._objects.has('stories/2026/10/bob.jpg')).toBe(false);
    expect(env.MEDIA._objects.has('stories/2026/10/alice3.jpg')).toBe(true);
  });
});
