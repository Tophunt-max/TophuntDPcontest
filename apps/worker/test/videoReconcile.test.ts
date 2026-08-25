/**
 * The reconcile cron is the safety net under Bunny's single-delivery webhook.
 *
 * What must hold, and would silently rot without a test:
 *  - a video stuck in `processing` past the stale window is re-checked against
 *    Bunny and promoted to whatever it actually is (ready/failed), so a lost
 *    webhook never strands a "Processing…" overlay forever;
 *  - a `processing` row that is genuinely still encoding, or one that is not yet
 *    stale, is left alone (no premature failure, no wasted Bunny call);
 *  - an upload the user abandoned is closed and its Bunny object deleted, so it
 *    stops costing us and no client waits on it;
 *  - with Bunny not configured (R2 mode) the whole thing no-ops.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const getVideoMock = vi.fn();
const deleteVideoMock = vi.fn();

vi.mock('../src/lib/bunny', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/bunny')>();
  return {
    ...actual, // keep the real mapBunnyStatus
    bunnyConfigured: async () => bunnyOn,
    getVideo: (...a: any[]) => getVideoMock(...a),
    deleteVideo: (...a: any[]) => deleteVideoMock(...a),
    bunnyThumbnailUrl: async (_e: any, g: string) => `https://cdn.test/${g}/thumbnail.jpg`,
    bunnyPlaybackUrl: async (_e: any, g: string) => `https://cdn.test/${g}/playlist.m3u8`,
    bunnyMp4Url: async (_e: any, g: string) => `https://cdn.test/${g}/play_720p.mp4`,
  };
});

// Notifications are not what this test is about, and firing them needs more of
// the notify stack than the harness provides.
vi.mock('../src/lib/notify', () => ({ createNotification: async () => {} }));

import { reconcileVideos, PROCESSING_STALE_MS, UPLOAD_ABANDON_MS } from '../src/lib/videoReconcile';
import { makeEnv, drizzleOf } from './helpers/harness';
import { schema } from '../src/db';

let bunnyOn = true;

function seedVideo(db: ReturnType<typeof drizzleOf>, row: Partial<typeof schema.videos.$inferInsert> & { id: string }) {
  return db.insert(schema.videos).values({
    ownerUid: 'u1',
    provider: 'bunny',
    status: 'processing',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...row,
  }).run();
}

beforeEach(() => {
  bunnyOn = true;
  getVideoMock.mockReset();
  deleteVideoMock.mockReset().mockResolvedValue(undefined);
});

describe('reconcileVideos — stuck processing', () => {
  it('promotes a stale processing video that Bunny now reports ready', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    const staleTs = Date.now() - (PROCESSING_STALE_MS + 60_000);
    await seedVideo(db, { id: 'vid-ready', status: 'processing', updatedAt: staleTs, targetType: 'story' });
    // Bunny status 4 = resolution done (playable).
    getVideoMock.mockResolvedValue({ status: 4, length: 12 });

    const res = await reconcileVideos(env);

    expect(res.promotedReady).toBe(1);
    const row = await db.select().from(schema.videos).where(eq('vid-ready')).get();
    expect(row?.status).toBe('ready');
    expect(row?.playbackUrl).toBe('https://cdn.test/vid-ready/playlist.m3u8');
    expect(row?.mp4Url).toBe('https://cdn.test/vid-ready/play_720p.mp4');
    expect(row?.durationSec).toBe(12);
  });

  it('marks a stale processing video failed when Bunny reports failure', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await seedVideo(db, { id: 'vid-fail', status: 'processing', updatedAt: Date.now() - (PROCESSING_STALE_MS + 1) });
    getVideoMock.mockResolvedValue({ status: 5 }); // 5 = failed

    const res = await reconcileVideos(env);

    expect(res.promotedFailed).toBe(1);
    const row = await db.select().from(schema.videos).where(eq('vid-fail')).get();
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toMatch(/encoding failure/i);
  });

  it('leaves a still-encoding video in processing', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await seedVideo(db, { id: 'vid-enc', status: 'processing', updatedAt: Date.now() - (PROCESSING_STALE_MS + 1) });
    getVideoMock.mockResolvedValue({ status: 2 }); // 2 = still encoding

    const res = await reconcileVideos(env);

    expect(res.processingChecked).toBe(1);
    expect(res.promotedReady).toBe(0);
    expect(res.promotedFailed).toBe(0);
    const row = await db.select().from(schema.videos).where(eq('vid-enc')).get();
    expect(row?.status).toBe('processing');
  });

  it('does NOT touch a processing video that is not yet stale', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await seedVideo(db, { id: 'vid-fresh', status: 'processing', updatedAt: Date.now() });

    const res = await reconcileVideos(env);

    expect(res.processingChecked).toBe(0);
    expect(getVideoMock).not.toHaveBeenCalled();
    const row = await db.select().from(schema.videos).where(eq('vid-fresh')).get();
    expect(row?.status).toBe('processing');
  });
});

describe('reconcileVideos — abandoned uploads', () => {
  it('closes an old uploading row and frees its Bunny object', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await seedVideo(db, { id: 'vid-aband', status: 'uploading', createdAt: Date.now() - (UPLOAD_ABANDON_MS + 60_000) });

    const res = await reconcileVideos(env);

    expect(res.abandoned).toBe(1);
    expect(deleteVideoMock).toHaveBeenCalledWith(expect.anything(), 'vid-aband');
    const row = await db.select().from(schema.videos).where(eq('vid-aband')).get();
    expect(row?.status).toBe('failed');
    expect(row?.errorMessage).toMatch(/abandoned/i);
  });

  it('leaves a recent uploading row alone (slow connection, still going)', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await seedVideo(db, { id: 'vid-slow', status: 'uploading', createdAt: Date.now() });

    const res = await reconcileVideos(env);

    expect(res.abandoned).toBe(0);
    expect(deleteVideoMock).not.toHaveBeenCalled();
    const row = await db.select().from(schema.videos).where(eq('vid-slow')).get();
    expect(row?.status).toBe('uploading');
  });
});

describe('reconcileVideos — provider guard', () => {
  it('no-ops when Bunny is not configured (R2 mode has no encode step)', async () => {
    bunnyOn = false;
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await seedVideo(db, { id: 'vid-x', status: 'processing', updatedAt: Date.now() - (PROCESSING_STALE_MS + 1) });

    const res = await reconcileVideos(env);

    expect(res.skipped).toBe(true);
    expect(getVideoMock).not.toHaveBeenCalled();
  });
});

// Small helper so the assertions above read cleanly.
import { eq as drizzleEq } from 'drizzle-orm';
function eq(id: string) {
  return drizzleEq(schema.videos.id, id);
}
