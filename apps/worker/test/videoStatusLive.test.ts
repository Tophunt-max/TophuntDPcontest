/**
 * `videoStatus` re-checks an unfinished encode against Qencode on demand.
 *
 * Why this exists: the callback is a single best-effort delivery, and a job the
 * cron (re)started has no callback at all. Without a live check the ONLY thing
 * that moved a row out of `processing` would be the reconcile cron — which waits
 * 15 minutes and runs every 10 — so a video encoded in a minute would show
 * "Processing…" for up to ~25.
 *
 * The client already polls this action every 5s, so the poll itself asks
 * Qencode. These tests pin that it does, that it stays cheap (throttled by
 * `updatedAt`, so extra viewers cannot amplify the calls), and that a Qencode
 * failure still returns the stored row instead of breaking the poll.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/notify', () => ({ createNotification: async () => {} }));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 0, votesB: 0, total: 0, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import { installFakeQencode, QENCODE_ENV, selectVideoProvider, writeEncodedOutput, type FakeQencode } from './helpers/qencode';
import { LIVE_STATUS_RECHECK_MS } from '../src/lib/videoReconcile';
import { mapQencodeStatus, videoIdFromUrl } from '../src/lib/qencode';
import * as schema from '../src/db/schema';

const app = makeApp();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

let q: FakeQencode;
beforeEach(() => {
  q = installFakeQencode();
});
afterEach(() => q.restore());

async function status(env: TestEnv, uid: string, videoIds: string[]) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
      body: JSON.stringify({ action: 'videoStatus', videoIds }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function liveEnv(provider: 'qencode' | 'r2' = 'qencode'): Promise<TestEnv> {
  const { env } = makeEnv(QENCODE_ENV);
  await selectVideoProvider(env, provider);
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ signupCompleted: true, uid: 'u1', username: 'u1', fullName: 'u1', status: 'active', dpcoin: 0, createdAt: ts, updatedAt: ts } as any);
  return env;
}

/** A video row whose last check was `ageMs` ago, with Qencode job `job-<id>`. */
async function seedVideo(env: TestEnv, vid: string, videoStatus: string, ageMs: number) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.videos)
    .values({
      id: vid,
      ownerUid: 'u1',
      provider: 'qencode',
      status: videoStatus,
      jobId: `job-${vid}`,
      targetType: 'story',
      createdAt: ts - ageMs,
      updatedAt: ts - ageMs,
    } as any);
}

const STALE = LIVE_STATUS_RECHECK_MS + 5_000;
const statusCalls = () => q.calls.filter((c) => c === '/v1/status').length;

describe('videoStatus live recheck', () => {
  it('asks Qencode for a processing video and returns it READY in the same response', async () => {
    const env = await liveEnv();
    await seedVideo(env, id(1), 'processing', STALE);
    q.jobs.set(`job-${id(1)}`, { status: 'completed', duration: '9' });
    await writeEncodedOutput(env, id(1));

    const res = await status(env, 'u1', [id(1)]);

    expect(res.status).toBe(200);
    expect(statusCalls()).toBe(1);
    // The overlay clears on THIS poll — no waiting for the 15-minute cron.
    expect(res.body.videos[0].status).toBe('ready');
    expect(res.body.videos[0].playbackUrl).toBe(`https://cdn.test/videos/${id(1)}/playlist.m3u8`);
  });

  it('does NOT call Qencode again for a video checked within the window', async () => {
    const env = await liveEnv();
    await seedVideo(env, id(2), 'processing', 1_000);
    q.jobs.set(`job-${id(2)}`, { status: 'completed' });

    const res = await status(env, 'u1', [id(2)]);

    expect(statusCalls()).toBe(0);
    expect(res.body.videos[0].status).toBe('processing');
  });

  it('leaves a genuinely-still-encoding video as processing', async () => {
    const env = await liveEnv();
    await seedVideo(env, id(3), 'processing', STALE);
    q.jobs.set(`job-${id(3)}`, { status: 'encoding' });

    const res = await status(env, 'u1', [id(3)]);

    expect(statusCalls()).toBe(1);
    expect(res.body.videos[0].status).toBe('processing');
  });

  it('surfaces an encode failure instead of spinning forever', async () => {
    const env = await liveEnv();
    await seedVideo(env, id(4), 'processing', STALE);
    q.jobs.set(`job-${id(4)}`, { status: 'error', error: 1, error_description: 'bad source' });

    const res = await status(env, 'u1', [id(4)]);

    expect(res.body.videos[0].status).toBe('failed');
  });

  it('still returns the stored row when the Qencode call fails (fail-open)', async () => {
    const env = await liveEnv();
    await seedVideo(env, id(5), 'processing', STALE);
    q.failStatus = true;

    const res = await status(env, 'u1', [id(5)]);

    expect(res.status).toBe(200);
    expect(res.body.videos[0].status).toBe('processing');
  });

  it('never calls Qencode for an already-ready video', async () => {
    const env = await liveEnv();
    await seedVideo(env, id(6), 'ready', STALE);

    const res = await status(env, 'u1', [id(6)]);

    expect(statusCalls()).toBe(0);
    expect(res.body.videos[0].status).toBe('ready');
  });

  it('no-ops the live check when Qencode is not the provider', async () => {
    const env = await liveEnv('r2');
    await seedVideo(env, id(7), 'processing', STALE);

    const res = await status(env, 'u1', [id(7)]);

    expect(statusCalls()).toBe(0);
    expect(res.body.videos[0].status).toBe('processing');
  });
});

describe('videoIdFromUrl', () => {
  const env = { R2_PUBLIC_BASE_URL: 'https://media.test', R2_LEGACY_BASE_URLS: 'https://old.test/media' } as any;
  const v = id(9);

  it('recovers the id from the playlist, the poster or a segment on any owned base', () => {
    expect(videoIdFromUrl(env, `https://media.test/videos/${v}/playlist.m3u8`)).toBe(v);
    expect(videoIdFromUrl(env, `https://media.test/videos/${v}/thumbnail.jpg`)).toBe(v);
    expect(videoIdFromUrl(env, `https://media.test/videos/${v}/video_1/segment-3.ts`)).toBe(v);
    expect(videoIdFromUrl(env, `https://old.test/media/videos/${v}/playlist.m3u8`)).toBe(v);
  });

  it('returns null for anything that is not an encoded video of ours', () => {
    expect(videoIdFromUrl(env, `https://media.test/stories/2026/10/${v}.mp4`)).toBeNull();
    expect(videoIdFromUrl(env, `https://evil.test/videos/${v}/playlist.m3u8`)).toBeNull();
    expect(videoIdFromUrl(env, `https://media.test/videos/not-a-uuid/playlist.m3u8`)).toBeNull();
    // The retired Bunny shape.
    expect(videoIdFromUrl(env, `https://vz-x.b-cdn.net/${v}/playlist.m3u8`)).toBeNull();
    expect(videoIdFromUrl(env, null)).toBeNull();
  });
});

describe('mapQencodeStatus', () => {
  it('maps Qencode job states onto ours', () => {
    expect(mapQencodeStatus(null)).toBe('processing');
    for (const s of ['queued', 'downloading', 'encoding', 'saving']) {
      expect(mapQencodeStatus({ status: s, error: false, errorDescription: null, durationSec: null })).toBe('processing');
    }
    expect(mapQencodeStatus({ status: 'completed', error: false, errorDescription: null, durationSec: 3 })).toBe('ready');
    expect(mapQencodeStatus({ status: 'completed', error: true, errorDescription: 'x', durationSec: null })).toBe('failed');
  });
});
