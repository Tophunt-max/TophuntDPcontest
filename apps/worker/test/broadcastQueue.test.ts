import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

import { makeEnv, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { enqueueBroadcast, processBroadcastJob, drainBroadcastJobs } from '../src/lib/broadcast';

/** Minimal stand-in for a Cloudflare Queue producer that records sends. */
function fakeQueue() {
  const sent: { jobId: string }[] = [];
  return {
    _sent: sent,
    async send(msg: { jobId: string }) {
      sent.push(msg);
    },
  };
}

async function seedUsers(env: TestEnv, n: number, prefix = 'u') {
  const db = drizzleOf(env);
  const ts = Date.now();
  const rows = Array.from({ length: n }, (_, i) => {
    const uid = `${prefix}${String(i).padStart(4, '0')}`;
    return { uid, username: uid, fullName: uid, dpcoin: 0, createdAt: ts, updatedAt: ts };
  });
  for (let i = 0; i < rows.length; i += 50) {
    await db.insert(schema.users).values(rows.slice(i, i + 50) as any);
  }
}

const notifCount = async (env: TestEnv) =>
  (await drizzleOf(env).select().from(schema.notifications).all()).length;

const getJob = (env: TestEnv, id: string) =>
  drizzleOf(env).select().from(schema.broadcastJobs).where(eq(schema.broadcastJobs.id, id)).get();

describe('broadcast fan-out over Cloudflare Queues', () => {
  it('enqueueBroadcast writes the job and sends ONE queue message with its id', async () => {
    const q = fakeQueue();
    const { env } = makeEnv({ BROADCAST_QUEUE: q as any });
    await seedUsers(env, 3);

    const { jobId, estimatedRecipients } = await enqueueBroadcast(env, { title: 'Hi', body: 'Yo' });
    expect(estimatedRecipients).toBe(3);
    expect(q._sent).toEqual([{ jobId }]);
    expect((await getJob(env, jobId))?.status).toBe('pending');
  });

  it('fail-open: with NO queue binding it still enqueues the job (cron will drain)', async () => {
    const { env } = makeEnv(); // no BROADCAST_QUEUE
    await seedUsers(env, 2);
    const { jobId } = await enqueueBroadcast(env, { title: 'T', body: 'B' });
    expect((await getJob(env, jobId))?.status).toBe('pending');
  });

  it('processBroadcastJob delivers one page and finishes when the audience fits', async () => {
    const { env } = makeEnv();
    await seedUsers(env, 5);
    const { jobId } = await enqueueBroadcast(env, { title: 'T', body: 'B' });

    const r = await processBroadcastJob(env, jobId);
    expect(r.done).toBe(true);
    expect(await notifCount(env)).toBe(5);
    const job = await getJob(env, jobId);
    expect(job?.status).toBe('done');
    expect(job?.processed).toBe(5);
  });

  it('drains a multi-page audience across rounds, each recipient exactly once', async () => {
    const { env } = makeEnv();
    await seedUsers(env, 120); // PAGE_SIZE is 100
    const { jobId } = await enqueueBroadcast(env, { title: 'T', body: 'B' });

    const r1 = await processBroadcastJob(env, jobId);
    expect(r1.done).toBe(false);
    expect((await getJob(env, jobId))?.processed).toBe(100);

    const r2 = await processBroadcastJob(env, jobId);
    expect(r2.done).toBe(true);
    expect(await notifCount(env)).toBe(120);
    expect((await getJob(env, jobId))?.processed).toBe(120);
  });

  it('a cancelled job is not processed', async () => {
    const { env } = makeEnv();
    await seedUsers(env, 3);
    const { jobId } = await enqueueBroadcast(env, { title: 'T', body: 'B' });
    await drizzleOf(env)
      .update(schema.broadcastJobs)
      .set({ status: 'cancelled' })
      .where(eq(schema.broadcastJobs.id, jobId));

    const r = await processBroadcastJob(env, jobId);
    expect(r.done).toBe(true);
    expect(await notifCount(env)).toBe(0);
  });

  it('cron safety net leaves a FRESH job to the queue but resumes a STALE one', async () => {
    const { env } = makeEnv();
    await seedUsers(env, 3);
    const { jobId } = await enqueueBroadcast(env, { title: 'T', body: 'B' });

    // Fresh (just created) — the queue owns it, cron must not touch it.
    await drainBroadcastJobs(env);
    expect(await notifCount(env)).toBe(0);
    expect((await getJob(env, jobId))?.status).toBe('pending');

    // Simulate a broken queue chain: the job has sat untouched past STALE_MS.
    await drizzleOf(env)
      .update(schema.broadcastJobs)
      .set({ updatedAt: Date.now() - 5 * 60 * 1000 })
      .where(eq(schema.broadcastJobs.id, jobId));

    await drainBroadcastJobs(env);
    expect(await notifCount(env)).toBe(3);
    expect((await getJob(env, jobId))?.status).toBe('done');
  });

  it('the queue-consumer chain (process → re-enqueue) drains everything once', async () => {
    const q = fakeQueue();
    const { env } = makeEnv({ BROADCAST_QUEUE: q as any });
    await seedUsers(env, 120);
    const { jobId } = await enqueueBroadcast(env, { title: 'T', body: 'B' }); // sends 1 message

    // Mirror index.ts queue(): pop a message, advance one page, re-enqueue if not done.
    let guard = 0;
    while (q._sent.length && guard++ < 50) {
      const { jobId: jid } = q._sent.shift()!;
      const { done } = await processBroadcastJob(env, jid);
      if (!done) await q.send({ jobId: jid });
    }

    expect(await notifCount(env)).toBe(120);
    expect((await getJob(env, jobId))?.status).toBe('done');
    expect(q._sent.length).toBe(0); // chain terminated cleanly
  });
});
