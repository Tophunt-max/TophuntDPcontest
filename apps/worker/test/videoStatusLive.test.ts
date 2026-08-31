/**
 * `videoStatus` re-checks an unfinished encode against Bunny on demand.
 *
 * Why this exists: Bunny's encode webhook is OPTIONAL and is configured in their
 * dashboard, not by this code. On a deployment without it, the ONLY thing that
 * ever moved a row out of `processing` was the reconcile cron — which waits 15
 * minutes before spending a Bunny call and runs every 10. So a video that Bunny
 * finished in under a minute kept showing "Processing…" in the app for up to ~25
 * minutes, which is exactly what it looked like in the wild.
 *
 * The client already polls this action every 5s, so the fix is for the poll
 * itself to ask Bunny. These tests pin that it does, that it stays cheap
 * (throttled by `updatedAt`, so extra viewers cannot amplify the calls), and that
 * a Bunny failure still returns the stored row instead of breaking the poll.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const getVideoMock = vi.fn();
let bunnyOn = true;

vi.mock('../src/lib/bunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/bunny')>();
  return {
    ...actual, // keep the real mapBunnyStatus
    bunnyConfigured: async () => bunnyOn,
    getVideo: (...a: any[]) => getVideoMock(...a),
    deleteVideo: async () => undefined,
    bunnyThumbnailUrl: async (_e: any, g: string) => `https://cdn.test/${g}/thumbnail.jpg`,
    bunnyPlaybackUrl: async (_e: any, g: string) => `https://cdn.test/${g}/playlist.m3u8`,
    bunnyMp4Url: async (_e: any, g: string) => `https://cdn.test/${g}/play_720p.mp4`,
  };
});
vi.mock('../src/lib/notify', () => ({ createNotification: async () => {} }));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 0, votesB: 0, total: 0, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import { LIVE_STATUS_RECHECK_MS } from '../src/lib/videoReconcile';
import * as schema from '../src/db/schema';

const app = makeApp();

beforeEach(() => {
  bunnyOn = true;
  getVideoMock.mockReset();
});

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

async function seedUser(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, status: 'active', dpcoin: 0, createdAt: ts, updatedAt: ts } as any);
}

/** A video row whose last check was `ageMs` ago. */
async function seedVideo(env: TestEnv, id: string, videoStatus: string, ageMs: number) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.videos)
    .values({
      id,
      ownerUid: 'u1',
      provider: 'bunny',
      status: videoStatus,
      targetType: 'story',
      createdAt: ts - ageMs,
      updatedAt: ts - ageMs,
    } as any);
}

const STALE = LIVE_STATUS_RECHECK_MS + 5_000;

describe('videoStatus live recheck', () => {
  it('asks Bunny for a processing video and returns it READY in the same response', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await seedVideo(env, 'vid1', 'processing', STALE);
    // Bunny status 4 = resolution done (playable).
    getVideoMock.mockResolvedValue({ status: 4, length: 9 });

    const res = await status(env, 'u1', ['vid1']);

    expect(res.status).toBe(200);
    expect(getVideoMock).toHaveBeenCalledTimes(1);
    // The overlay clears on THIS poll — no waiting for the 15-minute cron.
    expect(res.body.videos[0].status).toBe('ready');
    expect(res.body.videos[0].playbackUrl).toBe('https://cdn.test/vid1/playlist.m3u8');
  });

  it('does NOT call Bunny again for a video checked within the window', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    // Checked just now — a 5s client poll must not spend a Bunny call.
    await seedVideo(env, 'vid2', 'processing', 1_000);
    getVideoMock.mockResolvedValue({ status: 4 });

    const res = await status(env, 'u1', ['vid2']);

    expect(getVideoMock).not.toHaveBeenCalled();
    expect(res.body.videos[0].status).toBe('processing');
  });

  it('leaves a genuinely-still-encoding video as processing', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await seedVideo(env, 'vid3', 'processing', STALE);
    // Bunny status 1 = still processing.
    getVideoMock.mockResolvedValue({ status: 1 });

    const res = await status(env, 'u1', ['vid3']);

    expect(getVideoMock).toHaveBeenCalledTimes(1);
    expect(res.body.videos[0].status).toBe('processing');
  });

  it('surfaces a Bunny encode failure instead of spinning forever', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await seedVideo(env, 'vid4', 'processing', STALE);
    // Bunny status 5 = failed.
    getVideoMock.mockResolvedValue({ status: 5 });

    const res = await status(env, 'u1', ['vid4']);

    expect(res.body.videos[0].status).toBe('failed');
  });

  it('still returns the stored row when the Bunny call throws (fail-open)', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await seedVideo(env, 'vid5', 'processing', STALE);
    getVideoMock.mockRejectedValue(new Error('bunny down'));

    const res = await status(env, 'u1', ['vid5']);

    expect(res.status).toBe(200);
    expect(res.body.videos[0].status).toBe('processing');
  });

  it('never calls Bunny for an already-ready video', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    await seedVideo(env, 'vid6', 'ready', STALE);

    const res = await status(env, 'u1', ['vid6']);

    expect(getVideoMock).not.toHaveBeenCalled();
    expect(res.body.videos[0].status).toBe('ready');
  });

  it('no-ops the live check when Bunny is not the provider', async () => {
    const { env } = makeEnv();
    bunnyOn = false;
    await seedUser(env, 'u1');
    await seedVideo(env, 'vid7', 'processing', STALE);

    const res = await status(env, 'u1', ['vid7']);

    expect(getVideoMock).not.toHaveBeenCalled();
    expect(res.body.videos[0].status).toBe('processing');
  });
});
