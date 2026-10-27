/**
 * The reconcile cron is the safety net under Qencode's single-delivery callback.
 *
 * What must hold, and would silently rot without a test:
 *  - a video stuck in `processing` past the stale window is re-checked against
 *    Qencode and promoted to whatever it actually is, so a lost callback never
 *    strands a "Processing…" overlay;
 *  - "ready" needs the playlist to really be in R2 — Qencode saying "completed"
 *    alone must not publish a video that 404s;
 *  - a source whose encode never started (Qencode down during the upload) is
 *    started by the cron;
 *  - an upload that never became a job is closed and its objects deleted;
 *  - with Qencode not live (R2 mode) the whole thing no-ops.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq as drizzleEq } from 'drizzle-orm';

// Notifications are not what this test is about.
vi.mock('../src/lib/notify', () => ({ createNotification: async () => {} }));

import {
  reconcileVideos,
  PROCESSING_STALE_MS,
  PROCESSING_GIVE_UP_MS,
  START_RETRY_AFTER_MS,
  UPLOAD_ABANDON_MS,
} from '../src/lib/videoReconcile';
import { makeEnv, drizzleOf, type TestEnv } from './helpers/harness';
import { installFakeQencode, QENCODE_ENV, selectVideoProvider, writeEncodedOutput, type FakeQencode } from './helpers/qencode';
import { schema } from '../src/db';

const V = {
  ready: '00000000-0000-4000-8000-000000000001',
  fail: '00000000-0000-4000-8000-000000000002',
  enc: '00000000-0000-4000-8000-000000000003',
  fresh: '00000000-0000-4000-8000-000000000004',
  noPlaylist: '00000000-0000-4000-8000-000000000005',
  unstarted: '00000000-0000-4000-8000-000000000006',
  aband: '00000000-0000-4000-8000-000000000007',
  slow: '00000000-0000-4000-8000-000000000008',
  ancient: '00000000-0000-4000-8000-000000000009',
};

let q: FakeQencode;
beforeEach(() => {
  q = installFakeQencode();
});
afterEach(() => q.restore());

async function liveEnv(): Promise<TestEnv> {
  const { env } = makeEnv(QENCODE_ENV);
  await selectVideoProvider(env, 'qencode');
  return env;
}

function seedVideo(env: TestEnv, row: Partial<typeof schema.videos.$inferInsert> & { id: string }) {
  return drizzleOf(env)
    .insert(schema.videos)
    .values({
      ownerUid: 'u1',
      provider: 'qencode',
      status: 'processing',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...row,
    })
    .run();
}

const rowOf = (env: TestEnv, id: string) =>
  drizzleOf(env).select().from(schema.videos).where(drizzleEq(schema.videos.id, id)).get();

const stale = () => Date.now() - (PROCESSING_STALE_MS + 60_000);

describe('reconcileVideos — stuck processing', () => {
  it('promotes a stale processing video that Qencode reports completed and R2 holds', async () => {
    const env = await liveEnv();
    await seedVideo(env, { id: V.ready, jobId: 'job-r', sourceKey: `video-src/${V.ready}.mp4`, updatedAt: stale(), targetType: 'story' });
    await env.MEDIA.put(`video-src/${V.ready}.mp4`, new Uint8Array([1]));
    await writeEncodedOutput(env, V.ready);
    q.jobs.set('job-r', { status: 'completed', duration: '12.4' });

    const res = await reconcileVideos(env as any);

    expect(res.promotedReady).toBe(1);
    const row = await rowOf(env, V.ready);
    expect(row?.status).toBe('ready');
    expect(row?.playbackUrl).toBe(`https://cdn.test/videos/${V.ready}/playlist.m3u8`);
    expect(row?.thumbnailUrl).toBe(`https://cdn.test/videos/${V.ready}/thumbnail.jpg`);
    expect(row?.mp4Url).toBeNull();
    expect(row?.durationSec).toBe(12);
    // The raw source is no longer needed once the HLS exists.
    expect(env.MEDIA._objects.has(`video-src/${V.ready}.mp4`)).toBe(false);
    expect(row?.sourceKey).toBeNull();
  });

  it('marks a video failed when Qencode says completed but no playlist reached R2', async () => {
    // A wrong destination or a revoked R2 token looks exactly like this. Calling
    // it ready would publish a story whose video 404s forever.
    const env = await liveEnv();
    await seedVideo(env, { id: V.noPlaylist, jobId: 'job-np', updatedAt: stale() });
    q.jobs.set('job-np', { status: 'completed' });

    const res = await reconcileVideos(env as any);

    expect(res.promotedFailed).toBe(1);
    const row = await rowOf(env, V.noPlaylist);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toMatch(/no playlist/i);
  });

  it('marks a stale processing video failed when Qencode reports an error, and deletes what was stored', async () => {
    const env = await liveEnv();
    await seedVideo(env, { id: V.fail, jobId: 'job-f', sourceKey: `video-src/${V.fail}.mp4`, updatedAt: stale() });
    await env.MEDIA.put(`video-src/${V.fail}.mp4`, new Uint8Array([1]));
    await env.MEDIA.put(`videos/${V.fail}/video_1/segment-0.ts`, new Uint8Array([1]));
    q.jobs.set('job-f', { status: 'error', error: 1, error_description: 'Source video decoding error' });

    const res = await reconcileVideos(env as any);

    expect(res.promotedFailed).toBe(1);
    const row = await rowOf(env, V.fail);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toMatch(/decoding/i);
    expect(env.MEDIA._objects.has(`video-src/${V.fail}.mp4`)).toBe(false);
    expect(env.MEDIA._objects.has(`videos/${V.fail}/video_1/segment-0.ts`)).toBe(false);
  });

  it('leaves a still-encoding video in processing', async () => {
    const env = await liveEnv();
    await seedVideo(env, { id: V.enc, jobId: 'job-e', updatedAt: stale() });
    q.jobs.set('job-e', { status: 'encoding' });

    const res = await reconcileVideos(env as any);

    expect(res.processingChecked).toBe(1);
    expect(res.promotedReady + res.promotedFailed).toBe(0);
    expect((await rowOf(env, V.enc))?.status).toBe('processing');
  });

  it('gives up on a video that has been processing for hours', async () => {
    const env = await liveEnv();
    await seedVideo(env, {
      id: V.ancient,
      jobId: 'job-a',
      createdAt: Date.now() - (PROCESSING_GIVE_UP_MS + 60_000),
      updatedAt: stale(),
    });
    q.jobs.set('job-a', { status: 'queued' });

    const res = await reconcileVideos(env as any);

    expect(res.promotedFailed).toBe(1);
    expect((await rowOf(env, V.ancient))?.status).toBe('failed');
  });

  it('does NOT poll a processing video that is not yet stale', async () => {
    const env = await liveEnv();
    await seedVideo(env, { id: V.fresh, jobId: 'job-fr', updatedAt: Date.now() });

    const res = await reconcileVideos(env as any);

    expect(res.processingChecked).toBe(0);
    expect(q.calls).not.toContain('/v1/status');
  });
});

describe('reconcileVideos — encodes that never started', () => {
  it('starts the encode for an uploaded source that has no job yet', async () => {
    const env = await liveEnv();
    await env.MEDIA.put(`video-src/${V.unstarted}.mp4`, new Uint8Array([1]));
    await seedVideo(env, {
      id: V.unstarted,
      status: 'uploading',
      sourceKey: `video-src/${V.unstarted}.mp4`,
      updatedAt: Date.now() - (START_RETRY_AFTER_MS + 1_000),
    });

    const res = await reconcileVideos(env as any);

    expect(res.encodesStarted).toBe(1);
    const row = await rowOf(env, V.unstarted);
    expect(row?.status).toBe('processing');
    expect(row?.jobId).toBe(q.started[0].taskToken);
    // No request, so no callback: this job resolves by polling.
    expect(q.started[0].query.query.callback_url).toBeUndefined();
  });

  it('keeps the row uploading (for the next tick) when Qencode is still down', async () => {
    const env = await liveEnv();
    q.failStart = true;
    await seedVideo(env, {
      id: V.unstarted,
      status: 'uploading',
      sourceKey: `video-src/${V.unstarted}.mp4`,
      updatedAt: Date.now() - (START_RETRY_AFTER_MS + 1_000),
    });

    const res = await reconcileVideos(env as any);

    expect(res.encodesStarted).toBe(0);
    const row = await rowOf(env, V.unstarted);
    expect(row?.status).toBe('uploading');
    expect(row?.jobId).toBeNull();
  });
});

describe('reconcileVideos — abandoned uploads', () => {
  it('closes an old uploading row and deletes its source', async () => {
    const env = await liveEnv();
    q.failStart = true; // so pass 2 cannot rescue it first
    await env.MEDIA.put(`video-src/${V.aband}.mp4`, new Uint8Array([1]));
    await seedVideo(env, {
      id: V.aband,
      status: 'uploading',
      sourceKey: `video-src/${V.aband}.mp4`,
      createdAt: Date.now() - (UPLOAD_ABANDON_MS + 60_000),
    });

    const res = await reconcileVideos(env as any);

    expect(res.abandoned).toBe(1);
    const row = await rowOf(env, V.aband);
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toMatch(/abandoned/i);
    expect(env.MEDIA._objects.has(`video-src/${V.aband}.mp4`)).toBe(false);
  });

  it('leaves a recent uploading row alone (slow connection, still going)', async () => {
    const env = await liveEnv();
    await seedVideo(env, { id: V.slow, status: 'uploading', createdAt: Date.now() });

    const res = await reconcileVideos(env as any);

    expect(res.abandoned).toBe(0);
    expect((await rowOf(env, V.slow))?.status).toBe('uploading');
  });
});

describe('reconcileVideos — provider guard', () => {
  it('no-ops when Qencode is not the provider (R2 mode has no encode step)', async () => {
    const { env } = makeEnv(QENCODE_ENV);
    await selectVideoProvider(env, 'r2');
    await seedVideo(env, { id: V.enc, jobId: 'job-x', updatedAt: stale() });

    const res = await reconcileVideos(env as any);

    expect(res.skipped).toBe(true);
    expect(q.calls).toEqual([]);
  });

  it('no-ops when Qencode is selected but its credentials are missing', async () => {
    const { env } = makeEnv({ ...QENCODE_ENV, QENCODE_API_KEY: '' });
    await selectVideoProvider(env, 'qencode');

    const res = await reconcileVideos(env as any);

    expect(res.skipped).toBe(true);
  });
});
