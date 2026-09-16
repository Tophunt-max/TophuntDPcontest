/**
 * Admin broadcast fan-out, as a resumable background job.
 *
 * The previous implementation did this inside the admin's HTTP request:
 *
 *     const rows = await db.select({ uid }).from(users).all();   // EVERY user
 *     for (const batch of chunks(rows, 50))
 *       await Promise.all(batch.map(createNotification));        // insert + WS + FCM each
 *
 * That loads the whole user table into a Worker's memory and performs an insert,
 * a WebSocket publish and one FCM call per device inside a single invocation. It
 * works at a few hundred users and cannot survive a real one — the request dies
 * on CPU or wall-clock limits partway through, with no record of how far it got.
 *
 * Now the request only writes a `broadcast_jobs` row, and the existing 10-minute
 * cron drains it a page at a time. Properties that matter:
 *
 *  - **Resumable.** Progress is a keyset cursor over `users.uid` (the primary
 *    key), so a crashed or timed-out run resumes exactly where it stopped. No
 *    OFFSET scan, and never more than one page in memory.
 *  - **Observable.** `processed` / `failed` / `status` are on the row.
 *  - **Cancellable.** Flip `status` to `cancelled` and the drain stops.
 */
import { and, asc, eq, gt, gte, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { newId, now } from "./ids";
import { createNotification } from "./notify";

export interface BroadcastSegment {
  /** Only users on this platform ("web" | "android" | "ios"). */
  platform?: string;
  /** Only users at or above this level. */
  minLevel?: number;
}

export interface EnqueueBroadcastInput {
  title: string;
  body: string;
  image?: string;
  type?: string;
  data?: Record<string, string>;
  segment?: BroadcastSegment;
  createdBy?: string | null;
}

/**
 * How many recipients to process per cron tick.
 *
 * Each one is an insert + a WebSocket publish + an FCM call per device, so this
 * is deliberately conservative: it must comfortably fit a cron invocation
 * alongside the other work in the same schedule.
 */
const PAGE_SIZE = 100;

/**
 * How long a `running`/`pending` job may sit untouched before the cron safety net
 * takes it over. In normal operation the QUEUE drives a job page-by-page in
 * seconds, bumping `updatedAt` each page, so it never goes stale and cron never
 * touches it. Cron only steps in when the queue path stalled (binding absent, a
 * message lost, the consumer erroring past its retries).
 */
const STALE_MS = 2 * 60 * 1000;

/** The body of a broadcast queue message: which job to advance by one page. */
export interface BroadcastQueueMessage {
  jobId: string;
}

/**
 * Kick a broadcast onto the queue for immediate processing. Fail-open: with no
 * queue binding (local dev, or before `wrangler queues create`) this is a no-op
 * and the cron safety net drains the job instead — just not instantly.
 */
async function sendBroadcastQueueMessage(env: Env, jobId: string): Promise<void> {
  try {
    await env.BROADCAST_QUEUE?.send({ jobId } satisfies BroadcastQueueMessage);
  } catch (e) {
    console.error("[broadcast] queue send failed (cron will drain)", jobId, e);
  }
}

function segmentConditions(segment?: BroadcastSegment | null) {
  const conds: any[] = [];
  if (segment?.platform) conds.push(eq(schema.users.platform, segment.platform));
  if (typeof segment?.minLevel === "number") conds.push(gte(schema.users.level, segment.minLevel));
  return conds;
}

/**
 * Queue a broadcast and return its id plus the number of users it will target.
 *
 * The estimate is a single COUNT so the admin UI can still show "will reach N
 * users" — the real delivered figure lands on `processed` as the job drains.
 */
export async function enqueueBroadcast(
  env: Env,
  input: EnqueueBroadcastInput,
): Promise<{ jobId: string; estimatedRecipients: number }> {
  const db = getDb(env);
  const ts = now();
  const jobId = newId();

  const conds = segmentConditions(input.segment);
  const countRow = await db
    .select({ v: sql<number>`count(*)` })
    .from(schema.users)
    .where(conds.length ? and(...conds) : (undefined as any))
    .get();

  await db.insert(schema.broadcastJobs).values({
    id: jobId,
    title: input.title,
    body: input.body,
    image: input.image ?? null,
    type: input.type || "admin",
    data: input.data ?? null,
    segment: input.segment ?? null,
    status: "pending",
    cursor: null,
    processed: 0,
    failed: 0,
    createdBy: input.createdBy ?? null,
    createdAt: ts,
    updatedAt: ts,
  });

  // Start it NOW via the queue. The old design waited for the next 10-minute cron
  // tick even to begin, and then took one more tick per page. See the queue
  // consumer in index.ts, which advances one page and re-enqueues the next.
  await sendBroadcastQueueMessage(env, jobId);

  return { jobId, estimatedRecipients: countRow?.v ?? 0 };
}

type BroadcastJob = typeof schema.broadcastJobs.$inferSelect;

/**
 * Move a job from `pending` to `running`, atomically. Returns true if this caller
 * owns the run. A job already `running` is treated as claimed (the queue continues
 * it page by page); anything terminal returns false.
 *
 * The atomic `WHERE status = 'pending'` is what stops two racing starts — the
 * queue consumer and a cron safety-net tick — from both sending the first page.
 */
async function claimRunning(env: Env, job: BroadcastJob): Promise<boolean> {
  if (job.status === "running") return true;
  if (job.status !== "pending") return false;
  const claim = await getDb(env)
    .update(schema.broadcastJobs)
    .set({ status: "running", updatedAt: now() })
    .where(and(eq(schema.broadcastJobs.id, job.id), eq(schema.broadcastJobs.status, "pending")))
    .run();
  return (claim.meta.changes ?? 0) > 0;
}

/**
 * Send one page of a RUNNING job and advance its keyset cursor. Returns whether
 * the job is now finished (the table for its segment is exhausted).
 *
 * Never more than one page in memory; a crash or timeout resumes from `cursor`.
 */
async function runBroadcastPage(env: Env, job: BroadcastJob): Promise<{ done: boolean }> {
  const db = getDb(env);
  const segment = (job.segment as BroadcastSegment | null) ?? undefined;
  const conds = segmentConditions(segment);
  if (job.cursor) conds.push(gt(schema.users.uid, job.cursor));

  const page = await db
    .select({ uid: schema.users.uid })
    .from(schema.users)
    .where(conds.length ? and(...conds) : (undefined as any))
    .orderBy(asc(schema.users.uid))
    .limit(PAGE_SIZE)
    .all();

  if (!page.length) {
    await db
      .update(schema.broadcastJobs)
      .set({ status: "done", finishedAt: now(), updatedAt: now() })
      .where(eq(schema.broadcastJobs.id, job.id))
      .run();
    return { done: true };
  }

  let processed = 0;
  let failed = 0;
  for (const row of page) {
    try {
      await createNotification(env, row.uid, {
        title: job.title,
        body: job.body,
        type: job.type,
        targetId: "broadcast",
        image: job.image ?? undefined,
        data: (job.data as Record<string, string>) ?? undefined,
        // Every recipient gets their own distinct notification — grouping makes
        // no sense for a broadcast.
        noCollapse: true,
      });
      processed += 1;
    } catch (e) {
      failed += 1;
      console.error("[broadcast] recipient failed", job.id, row.uid, e);
    }
  }

  const lastUid = page[page.length - 1].uid;
  const exhausted = page.length < PAGE_SIZE;

  await db
    .update(schema.broadcastJobs)
    .set({
      cursor: lastUid,
      processed: (job.processed ?? 0) + processed,
      failed: (job.failed ?? 0) + failed,
      // A short final page means the table is exhausted, so finish now rather
      // than burning another round to discover an empty page.
      status: exhausted ? "done" : "running",
      finishedAt: exhausted ? now() : null,
      updatedAt: now(),
    })
    .where(eq(schema.broadcastJobs.id, job.id))
    .run();

  return { done: exhausted };
}

/**
 * Advance ONE broadcast by one page — the queue consumer's unit of work.
 *
 * Loads the job by id, claims it, and sends a page. Returns `done` so the consumer
 * knows whether to re-enqueue the next page. Terminal or missing jobs (already
 * done, or CANCELLED mid-flight) return `{ done: true }` so the queue chain stops.
 */
export async function processBroadcastJob(env: Env, jobId: string): Promise<{ done: boolean }> {
  const job = await getDb(env)
    .select()
    .from(schema.broadcastJobs)
    .where(eq(schema.broadcastJobs.id, jobId))
    .get();
  if (!job || job.status === "done" || job.status === "cancelled" || job.status === "failed") {
    return { done: true };
  }
  // Lost the start race to the cron safety net — let that path carry it.
  if (!(await claimRunning(env, job))) return { done: true };
  return runBroadcastPage(env, { ...job, status: "running" });
}

/**
 * Cron SAFETY NET — resume a broadcast the queue path failed to finish.
 *
 * The queue (see index.ts `queue()`) is the primary driver and processes a job in
 * seconds. This only claims a job that has been sitting `pending`/`running` for
 * longer than `STALE_MS`, i.e. one whose queue chain broke (binding missing, a
 * message lost, the consumer exhausted its retries). A healthy, actively-draining
 * job bumps `updatedAt` every page, so it is never stale and is left to the queue.
 *
 * One page per invocation, so a recovering broadcast cannot starve the rest of the
 * schedule; the next tick continues it.
 */
export async function drainBroadcastJobs(env: Env): Promise<void> {
  const db = getDb(env);
  const staleBefore = now() - STALE_MS;

  const job = await db
    .select()
    .from(schema.broadcastJobs)
    .where(
      sql`${schema.broadcastJobs.status} IN ('pending','running') AND ${schema.broadcastJobs.updatedAt} < ${staleBefore}`,
    )
    .orderBy(asc(schema.broadcastJobs.createdAt))
    .limit(1)
    .get();
  if (!job) return;

  if (!(await claimRunning(env, job))) return;
  await runBroadcastPage(env, { ...job, status: "running" });
}
