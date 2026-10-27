/**
 * Contest battle → VS composite → two linked Stories.
 *
 * The defect this suite pins: creating a battle used to auto-publish a Story with
 * the creator's RAW entry while the match was still waiting for an opponent
 * (`startMatch` inserted a `contest_announcement` row). Now nothing is published
 * until a real two-participant join, and then the SERVER composes one VS image
 * and publishes exactly one Story per participant, idempotently and recoverably.
 */
import { vi, describe, it, expect } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { inflateSync } from 'node:zlib';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

vi.mock('../src/lib/firebaseAdmin', () => ({
  revokeRefreshTokens: async () => undefined,
  deleteAuthUser: async () => undefined,
  updateAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  getUserByEmail: async () => null,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

// The vote/engagement counters live in a Durable Object that cannot start here.
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
  finalizeVotes: async () => ({ votesA: 0, votesB: 0, total: 0 }),
}));

import { makeEnv, makeApp, drizzleOf, fakeImages, fakePhoto, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { storyMediaType, sweepVsComposites } from '../src/lib/matchStories';
import {
  ensureMatchShareImage,
  publicVsStoryStatus,
  reconcileVsPublications,
  runVsPublication,
  STORY_TTL_MS,
  TransientVsError,
  VS_IMAGE_RETAIN_MS,
  VS_LEASE_MS,
  VS_MAX_ATTEMPTS,
  vsCardKey,
  vsStoryId,
} from '../src/lib/vsPublication';
import {
  cardHandle,
  encodeCanvasPng,
  encodePngRgba,
  imagesBindingRenderer,
  planVsLayout,
  rasterizeVsBadge,
  sanitizeCardText,
} from '../src/lib/vsComposite';
import { resolveContests } from '../src/cron';
import { executeAccountDeletion } from '../src/lib/accountDeletion';
import { invalidateIntegrationCache } from '../src/lib/integrations';

const app = makeApp();
const BASE = 'https://cdn.test';

/** ExecutionContext that keeps waitUntil promises so a test can await them. */
function collectingCtx() {
  const pending: Promise<any>[] = [];
  return {
    pending,
    waitUntil(p: Promise<any>) {
      pending.push(Promise.resolve(p).catch(() => {}));
    },
    passThroughOnException() {},
    async drain() {
      while (pending.length) await Promise.all(pending.splice(0));
    },
  } as any;
}

async function call(env: TestEnv, uid: string, action: string, data: any = {}, ctx = collectingCtx()) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    ctx,
  );
  await ctx.drain();
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function read(env: TestEnv, uid: string | null, path: string) {
  const ctx = collectingCtx();
  const res = await app.request(path, { headers: uid ? { Authorization: `Bearer ${uid}` } : {} }, env, ctx);
  await ctx.drain();
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function admin(env: TestEnv, method: string, path: string, body?: any) {
  const ctx = collectingCtx();
  const res = await app.request(
    `/admin${path}`,
    {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    env,
    ctx,
  );
  await ctx.drain();
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, dpcoin: 1000, lockedCoins: 1000, createdAt: ts, updatedAt: ts, ...extra } as any);
}

async function seedContest(env: TestEnv, id = 'c1', extra: Record<string, any> = {}) {
  await drizzleOf(env)
    .insert(schema.contests)
    .values({
      id, title: 'Best Smile', type: 'photo', status: 'live',
      totalEntryFee: 40, rewardCoins: 40, voteDurationDays: 1, autoCancelHours: 24,
      minVotes: 0, createdAt: Date.now(), ...extra,
    } as any);
}

/**
 * Upload a fake entry photo to R2 the way POST /upload would (including the
 * uploader provenance it records), and return its public url. The uploader is
 * the label's prefix ("bob-photo" -> bob) unless given; `null` simulates an
 * object uploaded before provenance existed.
 */
async function entry(env: TestEnv, label: string, opts: Parameters<typeof fakePhoto>[1] & { uploader?: string | null } = {}) {
  const key = `contests/2026/10/${label}.${opts.format === 'png' ? 'png' : 'jpg'}`;
  const uploader = opts.uploader === undefined ? label.split('-')[0] : opts.uploader;
  await env.MEDIA.put(key, fakePhoto(label, opts), {
    httpMetadata: { contentType: 'image/jpeg' },
    ...(uploader ? { customMetadata: { uploader } } : {}),
  });
  return `${BASE}/${key}`;
}

function photoEnv(overrides: Record<string, any> = {}) {
  const images = fakeImages();
  const { env } = makeEnv({ IMAGES: images, ...overrides } as any);
  return { env, images };
}

const allStories = (env: TestEnv) => drizzleOf(env).select().from(schema.stories).all();
const matchRow = (env: TestEnv, id: string) =>
  drizzleOf(env).select().from(schema.contestMatches).where(eq(schema.contestMatches.id, id)).get();
const userRow = (env: TestEnv, uid: string) =>
  drizzleOf(env).select().from(schema.users).where(eq(schema.users.uid, uid)).get();

/** alice creates (photo), returning the match id and her entry url. */
async function createBattle(env: TestEnv, opts: { aliceUrl?: string } = {}) {
  await seedUser(env, 'alice');
  await seedUser(env, 'bob');
  await seedContest(env);
  const aliceUrl = opts.aliceUrl ?? (await entry(env, 'alice-photo'));
  const res = await call(env, 'alice', 'startMatch', {
    contestId: 'c1', mediaUrl: aliceUrl, mediaType: 'photo', deviceId: 'device-a',
  });
  expect(res.status).toBe(200);
  return { matchId: res.body.matchId as string, aliceUrl, startBody: res.body };
}

/** alice creates, bob joins; the join's waitUntil (the publication) is awaited. */
async function fullBattle(env: TestEnv, opts: { bobUrl?: string; aliceUrl?: string } = {}) {
  const { matchId, aliceUrl } = await createBattle(env, opts);
  const bobUrl = opts.bobUrl ?? (await entry(env, 'bob-photo'));
  const join = await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: bobUrl, mediaType: 'photo', deviceId: 'device-b' });
  return { matchId, aliceUrl, bobUrl, join };
}

const cardUrl = (matchId: string) => `${BASE}/${vsCardKey(matchId)}`;

// ===========================================================================
describe('reproduction: creating a battle', () => {
  it('saves the entry, stays waiting, and publishes NO story', async () => {
    const { env } = photoEnv();
    const { matchId, aliceUrl, startBody } = await createBattle(env);

    const m = await matchRow(env, matchId);
    expect(m?.status).toBe('waiting_for_opponent');
    expect((m?.userA as any).uid).toBe('alice');
    expect((m?.userA as any).mediaUrl).toBe(aliceUrl);
    expect(m?.userB).toBeNull();
    // Not eligible for publication until a real join.
    expect(m?.vsStoryStatus).toBeNull();
    // The defect: this used to be one `contest_announcement` row carrying the raw entry.
    expect(await allStories(env)).toHaveLength(0);
    expect(startBody.vsStoryStatus).toBe('waiting_for_opponent');
  });

  it('ignores client-supplied completion state', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'alice');
    await seedContest(env);
    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: await entry(env, 'alice-photo'), mediaType: 'photo', deviceId: 'd',
      status: 'completed', vsStoryStatus: 'published', vs_story_status: 'published', userB: { uid: 'mallory' },
    });
    const m = await matchRow(env, res.body.matchId);
    expect(m?.status).toBe('waiting_for_opponent');
    expect(m?.vsStoryStatus).toBeNull();
    expect(m?.userB).toBeNull();
    expect(await allStories(env)).toHaveLength(0);
  });

  it('keeps manual story creation working (personal story, own media)', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'alice');
    await createBattle(env).catch(() => undefined);
    const res = await call(env, 'alice', 'createStory', { mediaUrl: `${BASE}/stories/images/x.jpg`, mediaType: 'image' });
    expect(res.status).toBe(200);
    const rows = await allStories(env);
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('user');
    expect(rows[0].mediaUrl).toBe(`${BASE}/stories/images/x.jpg`);
    // And deleting it still frees its own media.
    expect((await call(env, 'alice', 'deleteStory', { storyId: rows[0].id })).status).toBe(200);
    expect(env.MEDIA._deleted).toContain('stories/images/x.jpg');
  });
});

// ===========================================================================
describe('joining: one composite, two linked stories', () => {
  it('publishes exactly two stories, one per participant, sharing one composite', async () => {
    const { env } = photoEnv();
    const { matchId, aliceUrl, bobUrl, join } = await fullBattle(env);
    expect(join.status).toBe(200);
    expect(join.body.status).toBe('active');
    expect(join.body.vsStoryStatus).toBe('preparing');

    const m = await matchRow(env, matchId);
    expect(m?.status).toBe('active');
    expect(m?.vsStoryStatus).toBe('published');
    expect(m?.vsImageUrl).toBe(cardUrl(matchId));

    const rows = await allStories(env);
    expect(rows).toHaveLength(2);
    const byUser = Object.fromEntries(rows.map((r: any) => [r.userId, r]));
    expect(Object.keys(byUser).sort()).toEqual(['alice', 'bob']);
    for (const uid of ['alice', 'bob']) {
      const s = byUser[uid];
      expect(s.id).toBe(vsStoryId(matchId, uid));
      expect(s.type).toBe('contest_vs');
      expect(s.matchId).toBe(matchId);
      expect(s.mediaUrl).toBe(cardUrl(matchId));
      expect(s.mediaType).toBe('image');
      expect(s.visibility).toBe('public');
      expect(s.username).toBe(uid);
      expect(s.expiresAt - s.createdAt).toBe(STORY_TTL_MS);
    }
    expect(byUser.alice.createdAt).toBe(byUser.bob.createdAt);
    // A raw single entry is never published by the contest flow.
    expect(rows.some((r: any) => r.mediaUrl === aliceUrl || r.mediaUrl === bobUrl)).toBe(false);

    // ONE stored object, carrying provenance; both originals preserved.
    expect(env.MEDIA._puts.filter((k) => k.startsWith('vs-cards/'))).toEqual([vsCardKey(matchId)]);
    const obj = env.MEDIA._objects.get(vsCardKey(matchId))!;
    expect(obj.httpMetadata.contentType).toBe('image/jpeg');
    expect(obj.customMetadata).toMatchObject({ matchId, uidA: 'alice', uidB: 'bob', version: '1' });
    expect(env.MEDIA._objects.has('contests/2026/10/alice-photo.jpg')).toBe(true);
    expect(env.MEDIA._objects.has('contests/2026/10/bob-photo.jpg')).toBe(true);
  });

  it('applies the owner\'s privacy: a private account\'s VS story is followers-only', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    await drizzleOf(env).update(schema.users).set({ isPrivate: true } as any).where(eq(schema.users.uid, 'bob')).run();
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    const byUser = Object.fromEntries((await allStories(env)).map((r: any) => [r.userId, r]));
    expect(byUser.alice.visibility).toBe('public');
    expect(byUser.bob.visibility).toBe('followers');
  });

  it('refuses a self-join, and the creator never gets a story', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    const res = await call(env, 'alice', 'joinMatch', {
      matchId, mediaUrl: await entry(env, 'alice-2'), mediaType: 'photo', deviceId: 'other',
    });
    expect(res.status).toBe(412);
    expect((await matchRow(env, matchId))?.status).toBe('waiting_for_opponent');
    expect(await allStories(env)).toHaveLength(0);
  });

  it('refuses a joiner who submits the creator\'s media as their own, before charging', async () => {
    const { env } = photoEnv();
    const { matchId, aliceUrl } = await createBattle(env);
    const res = await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: aliceUrl, mediaType: 'photo', deviceId: 'b' });
    expect(res.status).toBe(400);
    expect(Number((await userRow(env, 'bob'))?.dpcoin)).toBe(1000);
    expect((await matchRow(env, matchId))?.userB).toBeNull();
    expect(await allStories(env)).toHaveLength(0);
  });

  it('concurrent joins: one wins, one logical publication, one composite', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    await seedUser(env, 'carol');
    const [bobUrl, carolUrl] = [await entry(env, 'bob-photo'), await entry(env, 'carol-photo')];
    const results = await Promise.all([
      call(env, 'bob', 'joinMatch', { matchId, mediaUrl: bobUrl, mediaType: 'photo', deviceId: 'b' }),
      call(env, 'carol', 'joinMatch', { matchId, mediaUrl: carolUrl, mediaType: 'photo', deviceId: 'c' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 412]);
    const rows = await allStories(env);
    expect(rows).toHaveLength(2);
    const joiner = (await matchRow(env, matchId))?.userB as any;
    expect(rows.map((r: any) => r.userId).sort()).toEqual(['alice', joiner.uid].sort());
    expect(env.MEDIA._puts.filter((k) => k.startsWith('vs-cards/'))).toHaveLength(1);
    // The loser was not charged.
    const loser = joiner.uid === 'bob' ? 'carol' : 'bob';
    expect(Number((await userRow(env, loser))?.dpcoin)).toBe(1000);
  });

  it('a second join of a full battle is refused and changes nothing', async () => {
    const { env } = photoEnv();
    const { matchId } = await fullBattle(env);
    await seedUser(env, 'carol');
    const res = await call(env, 'carol', 'joinMatch', {
      matchId, mediaUrl: await entry(env, 'carol-photo'), mediaType: 'photo', deviceId: 'c',
    });
    expect(res.status).toBe(412);
    expect(await allStories(env)).toHaveLength(2);
    expect(((await matchRow(env, matchId))?.userB as any).uid).toBe('bob');
  });

  it('duplicate and concurrent completion events produce one logical result', async () => {
    const { env } = photoEnv();
    const images = env.IMAGES as ReturnType<typeof fakeImages>;
    const { matchId } = await createBattle(env);
    // No renderer yet: the join-time kick schedules a retry instead of publishing.
    const savedImages = env.IMAGES;
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    expect((await matchRow(env, matchId))?.vsStoryStatus).toBe('pending');
    (env as any).IMAGES = savedImages;
    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();

    const outcomes = await Promise.all([1, 2, 3, 4].map(() => runVsPublication(env as any, matchId)));
    expect(outcomes.filter((o) => o.outcome === 'published')).toHaveLength(1);
    expect(outcomes.every((o) => ['published', 'busy', 'already_published'].includes(o.outcome))).toBe(true);
    expect(images._outputs).toHaveLength(1);
    expect(await allStories(env)).toHaveLength(2);

    // And again, after the fact.
    expect((await runVsPublication(env as any, matchId)).outcome).toBe('already_published');
    expect(images._outputs).toHaveLength(1);
    expect(await allStories(env)).toHaveLength(2);
  });
});

// ===========================================================================
describe('ineligible matches never publish', () => {
  it('a waiting match that expires and is refunded never gets a story', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    await drizzleOf(env).update(schema.contestMatches).set({ expiresAt: Date.now() - 1 } as any).run();
    await resolveContests(env as any);
    expect((await matchRow(env, matchId))?.status).not.toBe('waiting_for_opponent');
    expect(await runVsPublication(env as any, matchId)).toEqual({ outcome: 'not_eligible' });
    expect(await allStories(env)).toHaveLength(0);
  });

  it('a battle cancelled before publication is skipped, never published', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    const savedImages = env.IMAGES;
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    expect((await admin(env, 'POST', `/matches/${matchId}/cancel`)).status).toBe(200);
    (env as any).IMAGES = savedImages;
    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();

    expect((await runVsPublication(env as any, matchId)).outcome).toBe('skipped');
    expect((await matchRow(env, matchId))?.vsStoryStatus).toBe('skipped');
    expect(await allStories(env)).toHaveLength(0);
  });

  it('cancelling a published battle removes its VS stories', async () => {
    const { env } = photoEnv();
    const { matchId } = await fullBattle(env);
    expect(await allStories(env)).toHaveLength(2);
    expect((await admin(env, 'POST', `/matches/${matchId}/cancel`)).status).toBe(200);
    expect(await allStories(env)).toHaveLength(0);
  });

  it('a battle that settled while pending is skipped', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    const savedImages = env.IMAGES;
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    (env as any).IMAGES = savedImages;
    await drizzleOf(env).update(schema.contestMatches).set({ status: 'completed', vsStoryNextAt: 0 } as any).run();
    expect((await runVsPublication(env as any, matchId)).outcome).toBe('skipped');
    expect(await allStories(env)).toHaveLength(0);
  });

  it('participants who block each other after joining get no VS story', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    const savedImages = env.IMAGES;
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    (env as any).IMAGES = savedImages;
    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
    expect(await runVsPublication(env as any, matchId)).toMatchObject({ outcome: 'failed', reason: 'participants_blocked' });
    expect(await allStories(env)).toHaveLength(0);
  });
});

// ===========================================================================
describe('the composite image', () => {
  it('maps userA left, userB right, with correct handles, title and a centred VS badge', async () => {
    const { env, images } = photoEnv();
    const { matchId } = await fullBattle(env);
    expect(images._outputs).toHaveLength(1);
    const tree = images._outputs[0];
    const layout = planVsLayout();

    expect(tree.output.format).toBe('image/jpeg');
    const draws = tree.ops.filter((o: any) => o.draw);
    const left = draws.find((d: any) => d.options.left === layout.leftPanel.left && d.options.top === layout.leftPanel.top);
    const right = draws.find((d: any) => d.options.left === layout.rightPanel.left && d.options.top === layout.rightPanel.top);
    expect(left.draw.source).toBe('alice-photo');
    expect(right.draw.source).toBe('bob-photo');
    // Badge drawn last (topmost), centred horizontally across the gutter.
    const badge = draws[draws.length - 1];
    expect(badge.options).toEqual({ left: layout.badge.left, top: layout.badge.top });
    expect(layout.badge.left + layout.badge.width / 2).toBe(layout.width / 2);

    const meta: any = (await matchRow(env, matchId))?.vsImageMeta;
    expect(meta.labels).toEqual({ left: '@ALICE', right: '@BOB', title: 'BEST SMILE', footer: 'PHOTO BATTLE  -  VOTE ON TOPHUNT.IN' });
    expect(meta).toMatchObject({ width: 1080, height: 1920, renderer: 'cf-images-binding', version: '1' });
  });

  it('crops every shape the same way — fill the panel, never stretch, flatten transparency', async () => {
    const images = fakeImages();
    const renderer = imagesBindingRenderer(images as any);
    const shapes = [
      fakePhoto('portrait', { width: 1080, height: 1920 }),
      fakePhoto('landscape', { width: 4032, height: 3024 }),
      fakePhoto('transparent', { width: 800, height: 800, format: 'png' }),
      fakePhoto('tiny-res', { width: 320, height: 240 }),
    ];
    for (const bytes of shapes) {
      await renderer.render({ left: { bytes, username: 'a' }, right: { bytes: fakePhoto('other'), username: 'b' }, title: 't', kind: 'photo' });
    }
    const layout = planVsLayout();
    for (const out of images._outputs) {
      const panel = out.ops.find((o: any) => o.draw && o.options.left === layout.leftPanel.left).draw;
      const crop = panel.ops[0].transform;
      expect(crop).toEqual({ width: layout.leftPanel.width - 12, height: layout.leftPanel.height - 12, fit: 'cover', gravity: 'auto', background: '#000000' });
      expect(panel.ops[1].transform).toEqual({ border: { color: '#FFFFFF', width: 6 } });
    }
  });

  it('fails safely on malformed, unsupported, tiny or untrusted inputs', async () => {
    const cases: Array<[string, (env: TestEnv) => Promise<string>, string]> = [
      ['corrupt bytes', (env) => entry(env, 'bob-corrupt'), 'malformed_media'],
      ['too small to show', (env) => entry(env, 'bob-tiny', { width: 20, height: 20 }), 'unsupported_dimensions'],
      ['not an image at all', async (env) => {
        await env.MEDIA.put('contests/2026/10/bob.bin', new TextEncoder().encode('PK\u0003\u0004 zip archive'));
        return `${BASE}/contests/2026/10/bob.bin`;
      }, 'unsupported_format'],
      ['external url', async () => 'https://evil.example/bob.jpg', 'untrusted_media'],
      ['owned but wrong prefix', async (env) => {
        await env.MEDIA.put('deposits/2026/10/x.jpg', fakePhoto('x'));
        return `${BASE}/deposits/2026/10/x.jpg`;
      }, 'untrusted_media'],
      ['missing object', async () => `${BASE}/contests/2026/10/gone.jpg`, 'media_missing'],
    ];
    for (const [name, bobMedia, reason] of cases) {
      const { env } = photoEnv();
      const { matchId } = await createBattle(env);
      const join = await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await bobMedia(env), mediaType: 'photo', deviceId: 'b' });
      expect(join.status, name).toBe(200); // the paid join itself never fails on rendering
      const m = await matchRow(env, matchId);
      expect(m?.vsStoryStatus, name).toBe('failed');
      expect(m?.vsStoryError, name).toContain(reason);
      expect(m?.status, name).toBe('active');
      expect(await allStories(env), name).toHaveLength(0);
      expect(env.MEDIA._puts.some((k) => k.startsWith('vs-cards/')), name).toBe(false);
      // A failure is observable in the admin error log.
      const logs = await drizzleOf(env).select().from(schema.errorLogs).all();
      expect(logs.some((l: any) => String(l.message).includes(matchId)), name).toBe(true);
    }
  });

  it('a video battle never renders from the video itself, and waits for real posters', async () => {
    // Credential lookups are cached per isolate; start from this env's values.
    invalidateIntegrationCache();
    const { env } = photoEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedContest(env, 'cv', { type: 'video' });
    const gA = '11111111-1111-4111-8111-111111111111';
    const gB = '22222222-2222-4222-8222-222222222222';
    const playlist = (id: string) => `${env.R2_PUBLIC_BASE_URL}/videos/${id}/playlist.m3u8`;
    const ts = Date.now();
    for (const [id, owner] of [[gA, 'alice'], [gB, 'bob']]) {
      await drizzleOf(env).insert(schema.videos).values({ id, ownerUid: owner, status: 'processing', createdAt: ts, updatedAt: ts } as any);
    }
    const created = await call(env, 'alice', 'startMatch', {
      contestId: 'cv', mediaUrl: playlist(gA), mediaType: 'video', deviceId: 'a',
    });
    const matchId = created.body.matchId;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: playlist(gB), mediaType: 'video', deviceId: 'b' });

    // Still encoding: transient, nothing published, originals untouched.
    let m = await matchRow(env, matchId);
    expect(m?.vsStoryStatus).toBe('pending');
    expect(m?.vsStoryError).toContain('video_not_ready');
    expect(await allStories(env)).toHaveLength(0);

    // Encoded, with the posters Qencode wrote next to each playlist. Read from
    // the bucket, never fetched from a URL.
    for (const [id, name] of [[gA, 'alice-poster'], [gB, 'bob-poster']]) {
      await drizzleOf(env).update(schema.videos)
        .set({ status: 'ready', thumbnailUrl: `${env.R2_PUBLIC_BASE_URL}/videos/${id}/thumbnail.jpg` } as any)
        .where(eq(schema.videos.id, id)).run();
      await env.MEDIA.put(`videos/${id}/thumbnail.jpg`, fakePhoto(name));
    }
    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
    expect((await runVsPublication(env as any, matchId)).outcome).toBe('published');
    invalidateIntegrationCache();
    m = await matchRow(env, matchId);
    const images = env.IMAGES as ReturnType<typeof fakeImages>;
    const draws = images._outputs[0].ops.filter((o: any) => o.draw).map((d: any) => d.draw.source);
    expect(draws.slice(0, 2)).toEqual(['alice-poster', 'bob-poster']);
    // The story is the poster image; the battle keeps both original videos.
    const rows = await allStories(env);
    expect(rows).toHaveLength(2);
    expect(rows.every((r: any) => r.mediaType === 'image' && r.mediaUrl === cardUrl(matchId))).toBe(true);
    expect((m?.userA as any).mediaUrl).toBe(playlist(gA));
    expect((m?.userB as any).mediaUrl).toBe(playlist(gB));
  });

  it('refuses to treat a photo entry in a video battle as a photo battle', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedContest(env, 'cv', { type: 'video' });
    const created = await call(env, 'alice', 'startMatch', {
      contestId: 'cv', mediaUrl: await entry(env, 'alice-photo'), mediaType: 'photo', deviceId: 'a',
    });
    await call(env, 'bob', 'joinMatch', {
      matchId: created.body.matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b',
    });
    const m = await matchRow(env, created.body.matchId);
    expect(m?.vsStoryStatus).toBe('failed');
    expect(m?.vsStoryError).toContain('media_type_mismatch');
  });
});

// ===========================================================================
describe('card text and raster helpers', () => {
  it('sanitises display text to the drawable alphabet', () => {
    expect(cardHandle('alice_99')).toBe('@ALICE_99');
    expect(cardHandle('@@josé.l')).toBe('@JOSE.L');
    // Bidi overrides, zero-width joiners, control chars, emoji and markup vanish.
    expect(cardHandle('\u202Eevil\u200D\u0007<script>😀')).toBe('@EVILSCRIPT');
    expect(cardHandle('😀😀')).toBe('@PLAYER');
    expect(cardHandle('a'.repeat(40))).toBe(`@${'A'.repeat(15)}..`);
    expect(sanitizeCardText('  Best   Smile!  ', 24)).toBe('BEST SMILE!');
  });

  it('encodes valid PNGs: a 1080x1920 split canvas and an opaque-centred badge', async () => {
    const canvas = await encodeCanvasPng();
    expect([...canvas.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(canvas.buffer, canvas.byteOffset);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([1080, 1920]);

    const badge = rasterizeVsBadge(240);
    const centre = (120 * 240 + 120) * 4;
    expect(badge.data[centre + 3]).toBe(255);
    expect(badge.data[3]).toBe(0); // corner is transparent: it is a disc
    const png = await encodePngRgba(badge);
    // Round-trip the IDAT through zlib to prove the stream is real.
    const idatLen = new DataView(png.buffer, png.byteOffset).getUint32(33);
    const raw = inflateSync(Buffer.from(png.slice(41, 41 + idatLen)));
    expect(raw.length).toBe((240 * 4 + 1) * 240);
  });
});

// ===========================================================================
describe('recovery and retries', () => {
  async function pendingBattle() {
    const { env, images } = photoEnv();
    const { matchId } = await createBattle(env);
    const saved = env.IMAGES;
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    (env as any).IMAGES = saved;
    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
    return { env, images, matchId };
  }

  it('a missing renderer is a transient, observable, retryable state', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    const m = await matchRow(env, matchId);
    expect(m?.status).toBe('active'); // battle is live and votable regardless
    expect(m?.vsStoryStatus).toBe('pending');
    expect(m?.vsStoryError).toContain('renderer_unavailable');
    expect(Number(m?.vsStoryNextAt)).toBeGreaterThan(Date.now());
    expect(await allStories(env)).toHaveLength(0);
  });

  it('retries after the composite was uploaded but before the DB recorded it — reusing it', async () => {
    const { env, images, matchId } = await pendingBattle();
    // The persist UPDATE fails once, after the R2 put has happened.
    const realPrepare = env.DB.prepare.bind(env.DB);
    let failOnce = true;
    env.DB.prepare = (sqlText: string) => {
      if (failOnce && sqlText.includes('SET vs_image_url = ?')) {
        failOnce = false;
        throw new Error('D1 transient');
      }
      return realPrepare(sqlText);
    };
    expect((await runVsPublication(env as any, matchId)).outcome).toBe('retry_scheduled');
    env.DB.prepare = realPrepare;
    expect(env.MEDIA._objects.has(vsCardKey(matchId))).toBe(true);
    expect(await allStories(env)).toHaveLength(0);

    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
    expect((await runVsPublication(env as any, matchId)).outcome).toBe('published');
    // Same deterministic object reused: rendered once, uploaded once, no orphan.
    expect(images._outputs).toHaveLength(1);
    expect(env.MEDIA._puts.filter((k) => k.startsWith('vs-cards/'))).toEqual([vsCardKey(matchId)]);
    expect((await matchRow(env, matchId))?.vsImageMeta).toMatchObject({ reused: true });
  });

  it('retries after only Story A exists, recovering B on the same window', async () => {
    const { env, matchId } = await pendingBattle();
    const t0 = Date.now() - 60_000;
    await drizzleOf(env).insert(schema.stories).values({
      id: vsStoryId(matchId, 'alice'), userId: 'alice', username: 'alice', mediaUrl: cardUrl(matchId),
      mediaType: 'image', type: 'contest_vs', matchId, contestTitle: 'Best Smile',
      createdAt: t0, expiresAt: t0 + STORY_TTL_MS,
    } as any);
    expect((await runVsPublication(env as any, matchId)).outcome).toBe('published');
    const rows = await allStories(env);
    expect(rows).toHaveLength(2);
    const b = rows.find((r: any) => r.userId === 'bob')!;
    expect(b.createdAt).toBe(t0);
    expect(b.expiresAt).toBe(t0 + STORY_TTL_MS);
  });

  it('a crashed worker\'s lease is reclaimed; both stories already present are not duplicated', async () => {
    const { env, matchId } = await pendingBattle();
    expect((await runVsPublication(env as any, matchId)).outcome).toBe('published');
    // Simulate: published rows exist, but the status flip was "lost".
    await drizzleOf(env).update(schema.contestMatches)
      .set({ vsStoryStatus: 'processing', vsStoryClaim: 'dead', vsStoryClaimedAt: Date.now() - VS_LEASE_MS - 1 } as any).run();
    // A live lease is respected...
    expect((await runVsPublication(env as any, matchId, { nowMs: Date.now() - VS_LEASE_MS })).outcome).toBe('busy');
    // ...an expired one is taken over by the cron.
    const r = await reconcileVsPublications(env as any);
    expect(r).toMatchObject({ attempted: 1, published: 1 });
    expect(await allStories(env)).toHaveLength(2);
  });

  it('a render timeout and an R2 failure back off without losing either entry', async () => {
    const { env, matchId } = await pendingBattle();
    const hang = { id: 'hang', render: () => new Promise<any>(() => {}) };
    expect(await runVsPublication(env as any, matchId, { renderer: hang, renderTimeoutMs: 20 })).toMatchObject({
      outcome: 'retry_scheduled', reason: 'render_timeout',
    });
    let m = await matchRow(env, matchId);
    expect(m?.vsStoryStatus).toBe('pending');
    // Attempt 1 was the join-time kick with no renderer; this is attempt 2.
    expect(m?.vsStoryAttempts).toBe(2);
    const firstNext = Number(m?.vsStoryNextAt);
    expect(firstNext).toBeGreaterThan(Date.now());

    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
    const realPut = env.MEDIA.put;
    env.MEDIA.put = async (key: string, ...rest: any[]) => {
      if (key.startsWith('vs-cards/')) throw new Error('R2 503');
      return (realPut as any)(key, ...rest);
    };
    expect((await runVsPublication(env as any, matchId)).reason).toBe('r2_put_failed');
    env.MEDIA.put = realPut;
    m = await matchRow(env, matchId);
    expect(m?.vsStoryAttempts).toBe(3);
    expect(m?.vsStoryError).toContain('r2_put_failed');
    // Entries untouched by any failure path.
    expect((m?.userA as any).mediaUrl).toContain('alice-photo');
    expect((m?.userB as any).mediaUrl).toContain('bob-photo');
    expect(env.MEDIA._deleted).toEqual([]);
    expect(await allStories(env)).toHaveLength(0);
    // A partial failure never masquerades as published.
    expect(publicVsStoryStatus(m as any)).toBe('preparing');
  });

  it('exhausted retries become a repairable failure, and the admin retry publishes', async () => {
    const { env, matchId } = await pendingBattle();
    const flaky = { id: 'flaky', render: async () => { throw new TransientVsError('render_failed'); } };
    for (let i = 0; i < VS_MAX_ATTEMPTS; i++) {
      await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
      await runVsPublication(env as any, matchId, { renderer: flaky });
    }
    const m = await matchRow(env, matchId);
    expect(m?.vsStoryStatus).toBe('failed');
    expect(m?.vsStoryError).toContain('retries_exhausted');
    expect(publicVsStoryStatus(m as any)).toBe('failed');
    // The cron does not churn on a failed row.
    expect((await reconcileVsPublications(env as any)).attempted).toBe(0);

    // Only admins may repair, and the action is audited.
    const forbidden = await app.request(`/admin/matches/${matchId}/vs-story/retry`, { method: 'POST', headers: { Authorization: 'Bearer alice' } }, env, collectingCtx());
    expect([401, 403]).toContain(forbidden.status);
    const repaired = await admin(env, 'POST', `/matches/${matchId}/vs-story/retry`);
    expect(repaired.status).toBe(200);
    expect(repaired.body.outcome).toBe('published');
    expect(await allStories(env)).toHaveLength(2);
    const audit = await drizzleOf(env).select().from(schema.adminAuditLog).where(eq(schema.adminAuditLog.action, 'match.vsStory.retry')).all();
    expect(audit).toHaveLength(1);
    // Published work cannot be "retried" into duplicates.
    expect((await admin(env, 'POST', `/matches/${matchId}/vs-story/retry`)).status).toBe(412);
    expect(await allStories(env)).toHaveLength(2);
  });
});

// ===========================================================================
describe('reads: feed, profile ring, status, privacy', () => {
  it('each owner\'s ring carries their VS story with the shared composite', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'carol');
    const { matchId } = await fullBattle(env);
    const feed = await read(env, 'carol', '/read/stories/feed');
    const groups = Object.fromEntries(feed.body.map((g: any) => [g.userId, g]));
    for (const uid of ['alice', 'bob']) {
      expect(groups[uid].stories).toHaveLength(1);
      expect(groups[uid].stories[0].mediaUrl).toBe(cardUrl(matchId));
      expect(groups[uid].stories[0].type).toBe('contest_vs');
      expect(groups[uid].username).toBe(uid);
    }
    const ring = await read(env, 'carol', '/read/users/bob/stories');
    expect(ring.body.stories.map((s: any) => s.id)).toEqual([vsStoryId(matchId, 'bob')]);
    expect((await read(env, 'carol', `/read/matches/${matchId}`)).body.vsStoryStatus).toBe('live');
  });

  it('a viewer who blocked the OPPONENT never sees them through the owner\'s VS story', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'carol');
    const { matchId, aliceUrl } = await fullBattle(env);
    await call(env, 'carol', 'blockUser', { targetUserId: 'bob' });

    const feed = await read(env, 'carol', '/read/stories/feed');
    expect(feed.body.find((g: any) => g.userId === 'bob')).toBeUndefined();
    const alice = feed.body.find((g: any) => g.userId === 'alice').stories[0];
    expect(alice.mediaUrl).toBe(aliceUrl);
    expect(alice.mediaUrl).not.toBe(cardUrl(matchId));
    expect(alice.type).toBe('contest_entry_solo');

    const ring = await read(env, 'carol', '/read/users/alice/stories');
    expect(ring.body.stories[0].mediaUrl).toBe(aliceUrl);
  });

  it('getMatchStoryStatus reports the server-confirmed state, to participants only', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'carol');
    const { matchId } = await createBattle(env);
    expect((await call(env, 'alice', 'getMatchStoryStatus', { matchId })).body.storyStatus).toBe('waiting_for_opponent');

    const saved = env.IMAGES;
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    expect((await call(env, 'bob', 'getMatchStoryStatus', { matchId })).body.storyStatus).toBe('preparing');

    // A due poll nudges the workflow — no re-submission, no second fee.
    (env as any).IMAGES = saved;
    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
    await call(env, 'bob', 'getMatchStoryStatus', { matchId });
    const live = await call(env, 'bob', 'getMatchStoryStatus', { matchId });
    expect(live.body).toMatchObject({ storyStatus: 'live', storyId: vsStoryId(matchId, 'bob'), vsImageUrl: cardUrl(matchId) });
    expect(Number((await userRow(env, 'bob'))?.dpcoin)).toBe(980);

    expect((await call(env, 'carol', 'getMatchStoryStatus', { matchId })).status).toBe(403);
  });
});

// ===========================================================================
describe('lifecycle and cleanup of the shared composite', () => {
  it('one user deleting their story keeps the other story and the composite', async () => {
    const { env } = photoEnv();
    const { matchId } = await fullBattle(env);
    expect((await call(env, 'alice', 'deleteStory', { storyId: vsStoryId(matchId, 'alice') })).status).toBe(200);
    const rows = await allStories(env);
    expect(rows.map((r: any) => r.userId)).toEqual(['bob']);
    expect(env.MEDIA._deleted).toEqual([]);
    await sweepVsComposites(env as any, Date.now());
    expect(env.MEDIA._objects.has(vsCardKey(matchId))).toBe(true);
    expect((await matchRow(env, matchId))?.vsImageUrl).toBe(cardUrl(matchId));
  });

  it('the composite outlives the Stories for sharing, then is deleted after retention; the match is kept', async () => {
    const { env } = photoEnv();
    const { matchId, aliceUrl, bobUrl } = await fullBattle(env);
    const m0 = await matchRow(env, matchId);
    // Retained through voting + grace, not just the 24h story window.
    expect(Number(m0?.vsImageRetainUntil)).toBeGreaterThanOrEqual(Number(m0?.expiresAt) + VS_IMAGE_RETAIN_MS);

    // Only Alice's has expired: Bob's still displays the card.
    await drizzleOf(env).update(schema.stories).set({ expiresAt: Date.now() - 1 } as any)
      .where(eq(schema.stories.userId, 'alice')).run();
    await sweepVsComposites(env as any, Date.now());
    expect(env.MEDIA._deleted).toEqual([]);

    // Both Stories gone: the battle is still being shared, so the card stays.
    await drizzleOf(env).update(schema.stories).set({ expiresAt: Date.now() - 1 } as any).run();
    await resolveContests(env as any);
    expect(env.MEDIA._deleted).toEqual([]);
    expect((await matchRow(env, matchId))?.vsImageUrl).toBe(cardUrl(matchId));

    // Retention over: deleted, column cleared, history intact.
    await sweepVsComposites(env as any, Number(m0?.vsImageRetainUntil) + 1);
    expect(env.MEDIA._deleted).toEqual([vsCardKey(matchId)]);
    const m = await matchRow(env, matchId);
    expect(m?.vsImageUrl).toBeNull();
    expect((m?.userA as any).mediaUrl).toBe(aliceUrl);
    expect((m?.userB as any).mediaUrl).toBe(bobUrl);
    expect(env.MEDIA._objects.has('contests/2026/10/alice-photo.jpg')).toBe(true);
  });

  it('both users deleting early still leaves no orphan once retention has passed', async () => {
    const { env } = photoEnv();
    const { matchId } = await fullBattle(env);
    for (const uid of ['alice', 'bob']) await call(env, uid, 'deleteStory', { storyId: vsStoryId(matchId, uid) });
    await sweepVsComposites(env as any, Date.now() + STORY_TTL_MS + 1);
    expect(env.MEDIA._deleted).toEqual([]); // still within the sharing retention
    const retain = Number((await matchRow(env, matchId))?.vsImageRetainUntil);
    await sweepVsComposites(env as any, retain + 1);
    expect(env.MEDIA._deleted).toEqual([vsCardKey(matchId)]);
  });

  it('a personal story that names the composite cannot delete it', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'mallory');
    const { matchId } = await fullBattle(env);
    const s = await call(env, 'mallory', 'createStory', { mediaUrl: cardUrl(matchId), mediaType: 'image' });
    await call(env, 'mallory', 'deleteStory', { storyId: s.body.storyId });
    expect(env.MEDIA._deleted).toEqual([]);
    expect(env.MEDIA._objects.has(vsCardKey(matchId))).toBe(true);
  });

  it('account deletion destroys composites showing the user and the stories displaying them', async () => {
    const { env } = photoEnv();
    const { matchId } = await fullBattle(env);
    await executeAccountDeletion(env as any, 'bob');
    expect(env.MEDIA._deleted).toContain(vsCardKey(matchId));
    expect(await allStories(env)).toHaveLength(0);
    expect((await matchRow(env, matchId))?.vsImageUrl).toBeNull();
  });

  it('the old client capture path can no longer set the card', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    const upload = `${BASE}/vs-cards/2026/10/client.jpg`;
    const early = await call(env, 'alice', 'setMatchVsImage', { matchId, imageUrl: upload });
    expect(early.status).toBe(412);

    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    const late = await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: upload });
    expect(late.body).toMatchObject({ alreadySet: true, vsImageUrl: cardUrl(matchId) });
    expect((await matchRow(env, matchId))?.vsImageUrl).toBe(cardUrl(matchId));
    await call(env, 'bob', 'setMatchVsImage', { matchId, imageUrl: cardUrl(matchId) });
    expect(env.MEDIA._objects.has(vsCardKey(matchId))).toBe(true);
    // Read-only: it never deletes anything.
    expect(env.MEDIA._deleted).toEqual([]);
  });

  it('nobody can delete another battle\'s live composite through setMatchVsImage', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'mallory');
    const { matchId } = await fullBattle(env);
    const victim = cardUrl(matchId);
    // Unknown match, and a real but unrelated match the attacker is not in.
    expect((await call(env, 'mallory', 'setMatchVsImage', { matchId: 'nope', imageUrl: victim })).status).toBe(404);
    await seedContest(env, 'c2');
    const own = await call(env, 'mallory', 'startMatch', {
      contestId: 'c2', mediaUrl: await entry(env, 'mallory-photo'), mediaType: 'photo', deviceId: 'm',
    });
    expect((await call(env, 'mallory', 'setMatchVsImage', { matchId: own.body.matchId, imageUrl: victim })).status).toBe(412);
    expect((await call(env, 'mallory', 'setMatchVsImage', { matchId, imageUrl: victim })).status).toBe(403);
    expect(env.MEDIA._deleted).toEqual([]);
    expect(env.MEDIA._objects.has(vsCardKey(matchId))).toBe(true);
  });
});

// ===========================================================================
describe('entry provenance', () => {
  it('a joiner cannot enter another account\'s upload, and is not charged', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'carol');
    const { matchId } = await createBattle(env);
    const carols = await entry(env, 'carol-photo');
    const res = await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: carols, mediaType: 'photo', deviceId: 'b' });
    expect(res.status).toBe(403);
    expect(Number((await userRow(env, 'bob'))?.dpcoin)).toBe(1000);
    expect((await matchRow(env, matchId))?.userB).toBeNull();
    expect(await allStories(env)).toHaveLength(0);
  });

  it('a creator cannot start a battle with another account\'s upload', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'alice');
    await seedContest(env);
    const res = await call(env, 'alice', 'startMatch', {
      contestId: 'c1', mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'a',
    });
    expect(res.status).toBe(403);
    expect(Number((await userRow(env, 'alice'))?.dpcoin)).toBe(1000);
  });

  it('publication itself refuses an entry whose provenance names someone else', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    // Legacy object (no provenance) passes the join; then its provenance is
    // revealed as another account's — the composite must not be built from it.
    const url = await entry(env, 'bob-photo', { uploader: null });
    const saved = env.IMAGES;
    delete (env as any).IMAGES;
    expect((await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: url, mediaType: 'photo', deviceId: 'b' })).status).toBe(200);
    env.MEDIA._objects.get('contests/2026/10/bob-photo.jpg')!.customMetadata = { uploader: 'carol' };
    (env as any).IMAGES = saved;
    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
    expect(await runVsPublication(env as any, matchId)).toMatchObject({ outcome: 'failed', reason: 'untrusted_media' });
    expect(await allStories(env)).toHaveLength(0);
  });

  it('pre-provenance uploads still work for the legitimate flow', async () => {
    const { env } = photoEnv();
    const aliceUrl = await entry(env, 'alice-photo', { uploader: null });
    const { matchId } = await createBattle(env, { aliceUrl });
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo', { uploader: null }), mediaType: 'photo', deviceId: 'b' });
    expect((await matchRow(env, matchId))?.vsStoryStatus).toBe('published');
  });
});

describe('visibility and takedown', () => {
  it('a private account\'s VS story reaches only its followers', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'stranger');
    await seedUser(env, 'fan');
    const { matchId } = await createBattle(env);
    await drizzleOf(env).update(schema.users).set({ isPrivate: true } as any).where(eq(schema.users.uid, 'bob')).run();
    await drizzleOf(env).insert(schema.follows).values({ followerId: 'fan', followingId: 'bob', createdAt: Date.now() } as any);
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });

    const groupsFor = async (uid: string) =>
      Object.fromEntries(((await read(env, uid, '/read/stories/feed')).body as any[]).map((g) => [g.userId, g]));
    expect((await groupsFor('stranger')).bob).toBeUndefined();
    expect((await groupsFor('stranger')).alice).toBeDefined(); // the public side is unaffected
    expect((await groupsFor('fan')).bob.stories[0].id).toBe(vsStoryId(matchId, 'bob'));
    expect((await groupsFor('bob')).bob.stories[0].id).toBe(vsStoryId(matchId, 'bob'));
    const anon = await read(env, null, '/read/users/bob/stories');
    expect(anon.body?.stories?.some((s: any) => s.type === 'contest_vs') ?? false).toBe(false);
  });

  it('highlights apply the same opponent-hidden rule', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'carol');
    const { matchId, aliceUrl } = await fullBattle(env);
    const h = await call(env, 'alice', 'createHighlight', { name: 'wins', storyIds: [vsStoryId(matchId, 'alice')] });
    expect(h.status).toBe(200);
    await call(env, 'carol', 'blockUser', { targetUserId: 'bob' });
    const res = await read(env, 'carol', `/read/highlights/${h.body.highlightId}/stories`);
    expect(res.body.stories[0].mediaUrl).toBe(aliceUrl);
    expect(res.body.stories[0].type).toBe('contest_entry_solo');
  });

  it('a battle removed through moderation loses its VS stories', async () => {
    const { env } = photoEnv();
    const { matchId } = await fullBattle(env);
    await drizzleOf(env).insert(schema.reports).values({ id: 'r1', targetType: 'match', targetId: matchId, status: 'open', createdAt: Date.now() } as any);
    expect((await admin(env, 'POST', '/reports/r1/resolve', { action: 'remove' })).status).toBe(200);
    expect(await allStories(env)).toHaveLength(0);
    expect((await runVsPublication(env as any, matchId)).outcome).not.toBe('published');
  });

  it('a worker that loses its lease mid-render writes nothing', async () => {
    const { env, images } = photoEnv();
    const { matchId } = await createBattle(env);
    const saved = env.IMAGES;
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    (env as any).IMAGES = saved;
    await drizzleOf(env).update(schema.contestMatches).set({ vsStoryNextAt: 0 } as any).run();
    const real = imagesBindingRenderer(images as any);
    const stealing = {
      id: 'stealing',
      render: async (input: any) => {
        const out = await real.render(input);
        await drizzleOf(env).update(schema.contestMatches).set({ vsStoryClaim: 'someone-else', vsStoryClaimedAt: Date.now() } as any).run();
        return out;
      },
    };
    expect((await runVsPublication(env as any, matchId, { renderer: stealing })).outcome).toBe('busy');
    expect(env.MEDIA._puts.some((k) => k.startsWith('vs-cards/'))).toBe(false);
    expect(await allStories(env)).toHaveLength(0);
  });
});

describe('canonical share asset (getMatchShareImage)', () => {
  const share = (env: TestEnv, uid: string, matchId: string) => call(env, uid, 'getMatchShareImage', { matchId });

  /** An active two-player battle written by pre-0055 code: no publication state, no stories. */
  async function legacyBattle(env: TestEnv, extra: Record<string, any> = {}) {
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    const ts = Date.now();
    await drizzleOf(env).insert(schema.contestMatches).values({
      id: 'legacy1', status: 'active', type: 'photo', title: 'Best Smile', createdAt: ts, activatedAt: ts,
      expiresAt: ts + 86_400_000, joinIdA: 'JN-A', joinIdB: 'JN-B',
      userA: { uid: 'alice', username: 'alice', joinId: 'JN-A', mediaUrl: await entry(env, 'alice-photo', { uploader: null }), mediaType: 'photo' },
      userB: { uid: 'bob', username: 'bob', joinId: 'JN-B', mediaUrl: await entry(env, 'bob-photo', { uploader: null }), mediaType: 'photo' },
      ...extra,
    } as any);
    return 'legacy1';
  }

  it('a completed photo battle resolves to its one canonical composite', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'viewer');
    const { matchId, aliceUrl, bobUrl } = await fullBattle(env);
    const res = await share(env, 'viewer', matchId);
    expect(res.body).toEqual({ matchId, status: 'ready', url: cardUrl(matchId), kind: 'photo' });
    // The same object both participants' Stories display.
    const stories = await allStories(env);
    expect(new Set(stories.map((r: any) => r.mediaUrl))).toEqual(new Set([res.body.url]));
    expect([aliceUrl, bobUrl]).not.toContain(res.body.url);
  });

  it('never hands out a participant photo while waiting or preparing', async () => {
    const { env } = photoEnv();
    const { matchId } = await createBattle(env);
    expect((await share(env, 'alice', matchId)).body).toMatchObject({ status: 'waiting_for_opponent', url: null });
    delete (env as any).IMAGES;
    await call(env, 'bob', 'joinMatch', { matchId, mediaUrl: await entry(env, 'bob-photo'), mediaType: 'photo', deviceId: 'b' });
    expect((await share(env, 'bob', matchId)).body).toMatchObject({ status: 'preparing', url: null });
  });

  it('regenerates a swept/lifecycle-deleted image at the same url without touching Stories', async () => {
    const { env, images } = photoEnv();
    const { matchId } = await fullBattle(env);
    const before = (await allStories(env)).map((r: any) => r.id).sort();
    env.MEDIA._objects.delete(vsCardKey(matchId)); // R2 lifecycle rule removed it
    const res = await share(env, 'alice', matchId);
    expect(res.body).toMatchObject({ status: 'ready', url: cardUrl(matchId) });
    expect(images._outputs).toHaveLength(2);
    expect(env.MEDIA._objects.has(vsCardKey(matchId))).toBe(true);
    expect((await allStories(env)).map((r: any) => r.id).sort()).toEqual(before);
    const m = await matchRow(env, matchId);
    expect(m?.vsStoryStatus).toBe('published');
    expect(m?.vsStoryClaim).toBeNull();
  });

  it('serves an existing card without re-rendering, and extends its retention', async () => {
    const { env, images } = photoEnv();
    const { matchId } = await fullBattle(env);
    await drizzleOf(env).update(schema.contestMatches).set({ vsImageRetainUntil: 1 } as any).run();
    await share(env, 'alice', matchId);
    expect(images._outputs).toHaveLength(1);
    expect(Number((await matchRow(env, matchId))?.vsImageRetainUntil)).toBeGreaterThan(Date.now());
  });

  it('gives legacy battles a server-rendered card on share — and never creates Stories', async () => {
    const { env } = photoEnv();
    const id = await legacyBattle(env);
    const res = await share(env, 'alice', id);
    expect(res.body).toMatchObject({ status: 'ready', url: cardUrl(id) });
    expect(await allStories(env)).toHaveLength(0);
    expect((await matchRow(env, id))?.vsStoryStatus).toBeNull();
  });

  it('replaces a legacy client-captured card instead of serving its untrusted pixels', async () => {
    const { env } = photoEnv();
    await env.MEDIA.put('vs-cards/2026/09/client.jpg', fakePhoto('client-card'));
    const id = await legacyBattle(env, { vsImageUrl: `${BASE}/vs-cards/2026/09/client.jpg` });
    const res = await share(env, 'alice', id);
    expect(res.body.url).toBe(cardUrl(id));
    expect(env.MEDIA._deleted).toEqual(['vs-cards/2026/09/client.jpg']);
  });

  it('concurrent shares render once', async () => {
    const { env, images } = photoEnv();
    const id = await legacyBattle(env);
    const out = await Promise.all([1, 2, 3].map(() => share(env, 'alice', id)));
    expect(images._outputs).toHaveLength(1);
    expect(out.filter((r) => r.body.status === 'ready').length).toBeGreaterThanOrEqual(1);
    expect(out.every((r) => r.body.status === 'ready' || r.body.status === 'preparing')).toBe(true);
    expect(out.every((r) => r.body.url === null || r.body.url === cardUrl(id))).toBe(true);
  });

  it('refuses blocked viewers, and reports cancelled or untrusted battles as unavailable', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'carol');
    const { matchId } = await fullBattle(env);
    await call(env, 'bob', 'blockUser', { targetUserId: 'carol' });
    expect((await share(env, 'carol', matchId)).status).toBe(403);

    const { env: env2 } = photoEnv();
    const id = await legacyBattle(env2);
    await drizzleOf(env2).update(schema.contestMatches).set({ status: 'cancelled' } as any).run();
    expect((await share(env2, 'alice', id)).body).toMatchObject({ status: 'unavailable', reason: 'cancelled', url: null });

    const { env: env3 } = photoEnv();
    const id3 = await legacyBattle(env3);
    await drizzleOf(env3).update(schema.contestMatches)
      .set({ userB: { uid: 'bob', username: 'bob', joinId: 'JN-B', mediaUrl: 'https://evil.example/x.jpg', mediaType: 'photo' } } as any).run();
    expect((await share(env3, 'alice', id3)).body).toMatchObject({ status: 'unavailable', reason: 'untrusted_media', url: null });
  });

  it('regenerates for a COMPLETED battle (the main post-voting share case)', async () => {
    const { env } = photoEnv();
    const id = await legacyBattle(env, { status: 'completed', winnerUid: 'alice' });
    const res = await share(env, 'alice', id);
    expect(res.body).toMatchObject({ status: 'ready', url: cardUrl(id) });
  });

  it('a takedown during the render leaves no image behind', async () => {
    const { env, images } = photoEnv();
    const id = await legacyBattle(env);
    const real = imagesBindingRenderer(images as any);
    const out = await ensureMatchShareImage(env as any, id, {
      renderer: {
        id: 'cancel-mid-render',
        render: async (input: any) => {
          const r = await real.render(input);
          await drizzleOf(env).update(schema.contestMatches).set({ status: 'cancelled' } as any).run();
          return r;
        },
      },
    });
    expect(out).toMatchObject({ status: 'unavailable', url: null });
    expect((await matchRow(env, id))?.vsImageUrl ?? null).toBeNull();
    expect(env.MEDIA._objects.has(vsCardKey(id))).toBe(false);
    expect((await matchRow(env, id))?.vsStoryClaim).toBeNull();
  });

  it('a participant deleting their account during the render: the face is not republished', async () => {
    const { env, images } = photoEnv();
    const id = await legacyBattle(env);
    const real = imagesBindingRenderer(images as any);
    const out = await ensureMatchShareImage(env as any, id, {
      renderer: {
        id: 'delete-mid-render',
        render: async (input: any) => {
          const r = await real.render(input);
          await drizzleOf(env).update(schema.users).set({ status: 'deleted' } as any).where(eq(schema.users.uid, 'bob')).run();
          return r;
        },
      },
    });
    expect(out.status).toBe('unavailable');
    expect(env.MEDIA._puts.some((k) => k.startsWith('vs-cards/'))).toBe(false);
    expect((await matchRow(env, id))?.vsImageUrl ?? null).toBeNull();
  });

  it('account deletion also removes an orphan at the deterministic key', async () => {
    const { env } = photoEnv();
    const id = await legacyBattle(env);
    await env.MEDIA.put(vsCardKey(id), fakePhoto('orphan'));
    await executeAccountDeletion(env as any, 'bob');
    expect(env.MEDIA._objects.has(vsCardKey(id))).toBe(false);
  });

  it('takedown ends retention so the next sweep removes the image', async () => {
    const { env } = photoEnv();
    const { matchId } = await fullBattle(env);
    expect((await admin(env, 'POST', `/matches/${matchId}/cancel`)).status).toBe(200);
    await sweepVsComposites(env as any, Date.now());
    expect(env.MEDIA._deleted).toContain(vsCardKey(matchId));
    expect((await matchRow(env, matchId))?.vsImageUrl).toBeNull();
  });

  it('treats any server render version as canonical (live Stories keep their image)', async () => {
    const { env, images } = photoEnv();
    const id = await legacyBattle(env);
    await env.MEDIA.put(`vs-cards/battles/${id}-v0.jpg`, fakePhoto('older-render'));
    await drizzleOf(env).update(schema.contestMatches).set({ vsImageUrl: `${BASE}/vs-cards/battles/${id}-v0.jpg` } as any).run();
    const res = await share(env, 'alice', id);
    expect(res.body).toMatchObject({ status: 'ready', url: `${BASE}/vs-cards/battles/${id}-v0.jpg` });
    expect(images._outputs).toHaveLength(0);
    expect(env.MEDIA._deleted).toEqual([]);
  });

  it('plain reads never consume the per-battle render budget, and do not write on every read', async () => {
    const { env } = photoEnv();
    const { matchId } = await fullBattle(env);
    const retain0 = Number((await matchRow(env, matchId))?.vsImageRetainUntil);
    for (let i = 0; i < 25; i++) {
      expect((await share(env, 'alice', matchId)).body.status).toBe('ready');
    }
    // Retention was already well ahead, so no write happened.
    expect(Number((await matchRow(env, matchId))?.vsImageRetainUntil)).toBe(retain0);
  });

  it('the per-battle render budget bounds repeated regeneration', async () => {
    const { env } = photoEnv();
    const id = await legacyBattle(env);
    const statuses: string[] = [];
    for (let i = 0; i < 22; i++) {
      env.MEDIA._objects.delete(vsCardKey(id)); // force a render every time
      statuses.push((await share(env, 'alice', id)).body.status);
    }
    expect(statuses.slice(0, 20).every((st) => st === 'ready')).toBe(true);
    expect(statuses.slice(20)).toEqual(['unavailable', 'unavailable']);
  });

  it('a video battle shares its poster composite, never a raw video', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    const ts = Date.now();
    await drizzleOf(env).insert(schema.contestMatches).values({
      id: 'v1', status: 'active', type: 'video', title: 'Dance', createdAt: ts, joinIdA: 'A', joinIdB: 'B',
      userA: { uid: 'alice', joinId: 'A', mediaUrl: 'https://vz.test/x/playlist.m3u8', mediaType: 'video' },
      userB: { uid: 'bob', joinId: 'B', mediaUrl: 'https://vz.test/y/playlist.m3u8', mediaType: 'video' },
    } as any);
    const res = await share(env, 'alice', 'v1');
    expect(res.body.kind).toBe('video');
    expect(res.body.status).toBe('unavailable'); // not an encoded video of ours: no fake image
    expect(res.body.url).toBeNull();
  });
});

describe('regression: battle mechanics around publication', () => {
  it('entry fees are charged once each, and voting works on the published battle', async () => {
    const { env } = photoEnv();
    await seedUser(env, 'voter');
    const { matchId } = await fullBattle(env);
    expect(Number((await userRow(env, 'alice'))?.dpcoin)).toBe(980);
    expect(Number((await userRow(env, 'bob'))?.dpcoin)).toBe(980);
    const ledger = await drizzleOf(env).select().from(schema.coinTransactions)
      .where(and(eq(schema.coinTransactions.type, 'contest_entry_fee'))).all();
    expect(ledger).toHaveLength(2);
    const vote = await call(env, 'voter', 'submitVote', { matchId, votedForUid: 'alice', deviceId: 'voter-device' });
    expect(vote.status).toBe(200);
  });

  it('storyMediaType still normalises legacy "photo"', () => {
    expect(storyMediaType('photo')).toBe('image');
    expect(storyMediaType('video')).toBe('video');
    expect(storyMediaType(undefined)).toBe('image');
  });
});
