/**
 * POST /webhook/qencode — authentication and the "never trust the body" rule.
 *
 * Qencode cannot sign callbacks or send headers, so the only credential is the
 * per-video HMAC in the callback URL. These tests pin that:
 *  - the endpoint fails closed (503) when Qencode is not live;
 *  - a missing or wrong signature, or one minted for a different video, is 400;
 *  - a valid callback still decides nothing itself: the job is re-read from
 *    Qencode and the playlist from R2, so a body claiming "completed" for a job
 *    that is not, or for output that is not there, changes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/notify', () => ({ createNotification: async () => {} }));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import { installFakeQencode, QENCODE_ENV, selectVideoProvider, writeEncodedOutput, type FakeQencode } from './helpers/qencode';
import * as schema from '../src/db/schema';
import { callbackSignature, qencodeConfig } from '../src/lib/qencode';

const app = makeApp();
const VID = '7b0c9d8e-1f2a-4b3c-8d4e-5f6a7b8c9d0e';
const OTHER = '11111111-2222-4333-8444-555555555555';

let q: FakeQencode;
beforeEach(() => {
  q = installFakeQencode();
});
afterEach(() => q.restore());

async function liveEnv(): Promise<TestEnv> {
  const { env } = makeEnv(QENCODE_ENV);
  await selectVideoProvider(env, 'qencode');
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.videos)
    .values({ id: VID, ownerUid: 'u1', provider: 'qencode', status: 'processing', jobId: 'job-1', createdAt: ts, updatedAt: ts } as any)
    .run();
  return env;
}

async function sigFor(env: TestEnv, id: string) {
  return callbackSignature((await qencodeConfig(env as any))!, id);
}

async function post(env: TestEnv, query: string, form: Record<string, string> = { task_token: 'job-1', event: 'saved' }) {
  const res = await app.request(
    `/webhook/qencode${query}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const statusOf = async (env: TestEnv) =>
  (await drizzleOf(env).select().from(schema.videos).where(eq(schema.videos.id, VID)).get())?.status;

describe('POST /webhook/qencode — authentication', () => {
  it('fails closed with 503 when Qencode is not the live provider', async () => {
    const env = await liveEnv();
    await selectVideoProvider(env, 'r2');
    const res = await post(env, `?v=${VID}&sig=whatever`);
    expect(res.status).toBe(503);
  });

  it('rejects a call with no signature', async () => {
    const env = await liveEnv();
    expect((await post(env, `?v=${VID}`)).status).toBe(400);
  });

  it('rejects a wrong signature', async () => {
    const env = await liveEnv();
    expect((await post(env, `?v=${VID}&sig=${'0'.repeat(64)}`)).status).toBe(400);
  });

  it("rejects a valid signature for a DIFFERENT video", async () => {
    // A leaked callback URL authorises a re-check of one video, never another.
    const env = await liveEnv();
    expect((await post(env, `?v=${VID}&sig=${await sigFor(env, OTHER)}`)).status).toBe(400);
  });
});

describe('POST /webhook/qencode — state comes from Qencode and R2, not the body', () => {
  it('promotes the video to ready when Qencode confirms and the playlist exists', async () => {
    const env = await liveEnv();
    q.jobs.set('job-1', { status: 'completed', duration: '8.0' });
    await writeEncodedOutput(env, VID);

    const res = await post(env, `?v=${VID}&sig=${await sigFor(env, VID)}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(await statusOf(env)).toBe('ready');
  });

  it('does not promote on a "saved" callback while Qencode still says encoding', async () => {
    const env = await liveEnv();
    q.jobs.set('job-1', { status: 'encoding' });
    await writeEncodedOutput(env, VID);

    const res = await post(env, `?v=${VID}&sig=${await sigFor(env, VID)}`);

    expect(res.body.status).toBe('processing');
    expect(await statusOf(env)).toBe('processing');
  });

  it('ignores a callback carrying a job token that is not this video\'s job', async () => {
    const env = await liveEnv();
    q.jobs.set('job-other', { status: 'completed' });
    await writeEncodedOutput(env, VID);

    const res = await post(env, `?v=${VID}&sig=${await sigFor(env, VID)}`, { task_token: 'job-other', event: 'saved' });

    expect(res.body.ignored).toBe('stale_job');
    expect(await statusOf(env)).toBe('processing');
  });

  it('acks a queued event without asking Qencode anything', async () => {
    const env = await liveEnv();
    const res = await post(env, `?v=${VID}&sig=${await sigFor(env, VID)}`, { task_token: 'job-1', event: 'queued' });
    expect(res.status).toBe(200);
    expect(q.calls).not.toContain('/v1/status');
  });

  it('acks an unknown video (deleted mid-encode) with 200', async () => {
    const env = await liveEnv();
    await drizzleOf(env).delete(schema.videos).run();
    const res = await post(env, `?v=${VID}&sig=${await sigFor(env, VID)}`);
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('unknown_video');
  });
});
