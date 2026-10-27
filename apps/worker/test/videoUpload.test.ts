/**
 * The Qencode upload flow end to end: createVideoUpload -> POST /upload/video.
 *
 * What is pinned here:
 *  - a client that does not say `upload: "worker"` (a Bunny-era build) is told
 *    video is not configured instead of a response it would misread;
 *  - the bytes are verified as video before anything is paid for, stored under
 *    `video-src/`, and the encode is started with the source presigned and the
 *    output pointed at `videos/<id>/` in OUR bucket;
 *  - a retry after a lost response does not start a second (billed) encode;
 *  - nobody can upload into someone else's video id;
 *  - Qencode being down does not fail the upload — the cron starts it later;
 *  - once Qencode is live, POST /upload refuses raw video.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/notify', () => ({ createNotification: async () => {} }));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import { installFakeQencode, QENCODE_ENV, selectVideoProvider, type FakeQencode } from './helpers/qencode';
import * as schema from '../src/db/schema';
import { reconcileVideos, START_RETRY_AFTER_MS } from '../src/lib/videoReconcile';

const app = makeApp();

/** Smallest body the sniffer accepts as MP4: a box size, then `ftyp` + brand. */
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0, 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1]);

let q: FakeQencode;
beforeEach(() => {
  q = installFakeQencode();
});
afterEach(() => q.restore());

async function seedUser(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid, username: uid, fullName: uid, status: 'active', createdAt: ts, updatedAt: ts } as any);
}

async function liveEnv(): Promise<TestEnv> {
  const { env } = makeEnv(QENCODE_ENV);
  await selectVideoProvider(env, 'qencode');
  for (const u of ['alice', 'bob']) await seedUser(env, u);
  return env;
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

async function sendBytes(env: TestEnv, uid: string, path: string, bytes: Uint8Array, fileType = 'video/mp4') {
  const sep = path.includes('?') ? '&' : '?';
  const res = await app.request(
    `https://api.test${path}${sep}fileType=${encodeURIComponent(fileType)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': fileType, Authorization: `Bearer ${uid}`, 'Content-Length': String(bytes.byteLength) },
      body: bytes,
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const rowOf = (env: TestEnv, id: string) =>
  drizzleOf(env).select().from(schema.videos).where(eq(schema.videos.id, id)).get();

describe('createVideoUpload', () => {
  it('answers a Bunny-era client (no upload flag) as not configured', async () => {
    const env = await liveEnv();
    const res = await api(env, 'alice', 'createVideoUpload', { targetType: 'story' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: false, r2Fallback: false });
    expect(await drizzleOf(env).select().from(schema.videos).all()).toHaveLength(0);
  });

  it('reports not configured, with the R2 fallback open, while R2 is the provider', async () => {
    const { env } = makeEnv(QENCODE_ENV);
    await selectVideoProvider(env, 'r2');
    await seedUser(env, 'alice');
    const res = await api(env, 'alice', 'createVideoUpload', { upload: 'worker' });
    expect(res.body).toEqual({ configured: false, r2Fallback: true });
  });

  it('creates an uploading row and returns where to send the bytes', async () => {
    const env = await liveEnv();
    const res = await api(env, 'alice', 'createVideoUpload', { upload: 'worker', targetType: 'story' });

    expect(res.body.configured).toBe(true);
    const id = res.body.videoId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.uploadPath).toBe(`/upload/video?videoId=${id}`);
    expect(res.body.playbackUrl).toBe(`https://cdn.test/videos/${id}/playlist.m3u8`);
    const row = await rowOf(env, id);
    expect(row).toMatchObject({ ownerUid: 'alice', provider: 'qencode', status: 'uploading', targetType: 'story' });
    // Nothing is spent until the bytes arrive.
    expect(q.started).toHaveLength(0);
  });
});

describe('POST /upload/video', () => {
  it('stores the verified source and starts the encode into our bucket', async () => {
    const env = await liveEnv();
    const created = await api(env, 'alice', 'createVideoUpload', { upload: 'worker', targetType: 'story' });
    const id = created.body.videoId;

    const res = await sendBytes(env, 'alice', created.body.uploadPath, MP4);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, videoId: id, status: 'processing' });
    expect(res.body.publicUrl).toBe(`https://cdn.test/videos/${id}/playlist.m3u8`);

    const row0 = await rowOf(env, id);
    const sourceKey = row0!.sourceKey!;
    // Not derivable from the (public) video id: the raw original stays unlinkable.
    expect(sourceKey).toMatch(/^video-src\/[0-9a-f-]{36}\.mp4$/);
    expect(sourceKey).not.toContain(id);
    const src = env.MEDIA._objects.get(sourceKey);
    expect(src?.customMetadata?.uploader).toBe('alice');

    expect(q.started).toHaveLength(1);
    const { query } = q.started[0].query;
    // Source: a presigned GET on the R2 S3 endpoint, not a public URL.
    expect(query.source).toContain(`https://acct123.r2.cloudflarestorage.com/tophunt-media/${sourceKey}`);
    expect(query.source).toContain('X-Amz-Signature=');
    // Output: HLS into videos/<id>/ and a poster next to it.
    const hls = query.format.find((f: any) => f.output === 'advanced_hls');
    expect(hls.destination.url).toBe(`s3://acct123.r2.cloudflarestorage.com/tophunt-media/videos/${id}/`);
    expect(hls.stream.map((s: any) => s.resolution)).toEqual([360, 480, 720]);
    const thumb = query.format.find((f: any) => f.output === 'thumbnail');
    expect(thumb.destination.url).toBe(`s3://acct123.r2.cloudflarestorage.com/tophunt-media/videos/${id}/thumbnail.jpg`);
    // The callback comes back to the origin the upload arrived on, signed per video.
    expect(query.callback_url).toMatch(new RegExp(`^https://api\\.test/webhook/qencode\\?v=${id}&sig=[0-9a-f]{64}$`));

    const row = await rowOf(env, id);
    expect(row).toMatchObject({ status: 'processing', jobId: q.started[0].taskToken, sourceKey });
  });

  it('answers a retry from the row without starting a second encode', async () => {
    const env = await liveEnv();
    const created = await api(env, 'alice', 'createVideoUpload', { upload: 'worker' });
    await sendBytes(env, 'alice', created.body.uploadPath, MP4);

    const retry = await sendBytes(env, 'alice', created.body.uploadPath, MP4);

    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('processing');
    expect(q.started).toHaveLength(1);
  });

  it('refuses bytes that are not a video before paying for anything', async () => {
    const env = await liveEnv();
    const created = await api(env, 'alice', 'createVideoUpload', { upload: 'worker' });

    const res = await sendBytes(env, 'alice', created.body.uploadPath, JPEG, 'video/mp4');

    expect(res.status).toBe(400);
    expect(q.started).toHaveLength(0);
    expect([...env.MEDIA._objects.keys()].some((k) => k.startsWith('video-src/'))).toBe(false);
  });

  it("refuses an upload into someone else's video id, without confirming it exists", async () => {
    const env = await liveEnv();
    const created = await api(env, 'alice', 'createVideoUpload', { upload: 'worker' });

    const res = await sendBytes(env, 'bob', created.body.uploadPath, MP4);

    expect(res.status).toBe(404);
    expect(q.started).toHaveLength(0);
  });

  it('still succeeds when Qencode is down, and the cron starts the encode later', async () => {
    const env = await liveEnv();
    const created = await api(env, 'alice', 'createVideoUpload', { upload: 'worker' });
    const id = created.body.videoId;
    q.failStart = true;

    const res = await sendBytes(env, 'alice', created.body.uploadPath, MP4);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('uploading');
    expect(env.MEDIA._objects.has((await rowOf(env, id))!.sourceKey!)).toBe(true);

    q.failStart = false;
    await drizzleOf(env)
      .update(schema.videos)
      .set({ updatedAt: Date.now() - (START_RETRY_AFTER_MS + 1_000) })
      .where(eq(schema.videos.id, id))
      .run();
    const r = await reconcileVideos(env as any);

    expect(r.encodesStarted).toBe(1);
    expect((await rowOf(env, id))?.status).toBe('processing');
  });

  it('is refused while R2 is the provider', async () => {
    const env = await liveEnv();
    const created = await api(env, 'alice', 'createVideoUpload', { upload: 'worker' });
    await selectVideoProvider(env, 'r2');

    const res = await sendBytes(env, 'alice', created.body.uploadPath, MP4);

    expect(res.status).toBe(412); // failed-precondition
    expect(res.body?.error?.message ?? '').toMatch(/not configured/i);
  });
});

describe('POST /upload once Qencode is live', () => {
  it('refuses a raw video, naming the flow to use instead', async () => {
    const env = await liveEnv();
    const res = await sendBytes(env, 'alice', '/upload?folder=stories', MP4);
    expect(res.status).toBe(412); // failed-precondition
    expect(res.body?.error?.message ?? '').toMatch(/createVideoUpload/);
  });
});
