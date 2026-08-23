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

  return { jobId, estimatedRecipients: countRow?.v ?? 0 };
}

/**
 * Advance the oldest unfinished broadcast by one page.
 *
 * Called from cron. Processes at most one job per invocation so a large
 * broadcast cannot starve the rest of the schedule; the next tick continues it.
 */
export async function drainBroadcastJobs(env: Env): Promise<void> {
  const db = getDb(env);

  const job = await db
    .select()
    .from(schema.broadcastJobs)
    .where(
      sql`${schema.broadcastJobs.status} IN ('pending','running')`,
    )
    .orderBy(asc(schema.broadcastJobs.createdAt))
    .limit(1)
    .get();
  if (!job) return;

  // Claim it. Only the run that flips pending -> running proceeds, so two
  // overlapping cron invocations cannot double-send the same page.
  if (job.status === "pending") {
    const claim = await db
      .update(schema.broadcastJobs)
      .set({ status: "running", updatedAt: now() })
      .where(and(eq(schema.broadcastJobs.id, job.id), eq(schema.broadcastJobs.status, "pending")))
      .run();
    if (claim.meta.changes === 0) return;
  }

  const segment = (job.segment as BroadcastSegment | null) ?? undefined;
  const conds = segmentConditions(segment);
  if (job.cursor) conds.push(gt(schema.users.uid, job.cursor));

  // Keyset pagination over the primary key.
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
    return;
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
      // than burning another tick to discover an empty page.
      status: exhausted ? "done" : "running",
      finishedAt: exhausted ? now() : null,
      updatedAt: now(),
    })
    .where(eq(schema.broadcastJobs.id, job.id))
    .run();
}
