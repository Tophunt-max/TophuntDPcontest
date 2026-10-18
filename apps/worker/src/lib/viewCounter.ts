/**
 * Coalesced blog view counter.
 *
 * `/read/blog/:slug` used to issue `UPDATE blog_posts SET view_count = view_count + 1`
 * on EVERY request, cache hits included — one D1 write per page view, on the one
 * public, unauthenticated, crawler-facing endpoint. D1's free plan allows 100,000
 * rows written per day for the whole app.
 *
 * Views are now buffered per isolate and flushed as ONE batch per window:
 *
 *   - The first view in a window registers a single `waitUntil` that sleeps
 *     FLUSH_WINDOW_MS and then writes every buffered `+n` in one `DB.batch`.
 *     `waitUntil` keeps the isolate alive for the flush, so a low-traffic isolate
 *     still writes its views; sleeping costs wall time, not CPU.
 *   - Later views in the same window only bump the in-memory count.
 *
 * So a post read 500 times in 20s by one isolate costs one row write, not 500.
 *
 * What it gives up, deliberately: a view count is an editorial metric, not money or
 * authorization. A hard isolate crash inside the window loses at most that window's
 * buffered views, and the displayed number already lagged by the post cache's TTL.
 * A failed flush puts its counts back (bounded by MAX_KEYS), and the next view in
 * the isolate schedules a new flush, so a D1 blip delays views rather than dropping
 * them — unless the isolate is evicted before another view arrives.
 */
import type { Env } from "../types";

export const FLUSH_WINDOW_MS = 20_000;
/** Distinct posts held in the buffer; beyond this a view is written immediately. */
const MAX_KEYS = 500;

const pending = new Map<string, number>();
/** When the pending flush was scheduled (0 = none). See `recordBlogView`. */
let flushScheduledAt = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Write the buffer. Exported for tests; never throws. */
export async function flushBlogViews(env: Env): Promise<number> {
  flushScheduledAt = 0;
  if (pending.size === 0) return 0;
  const batch = [...pending.entries()];
  pending.clear();
  try {
    await env.DB.batch(
      batch.map(([id, n]) =>
        env.DB.prepare("UPDATE blog_posts SET view_count = COALESCE(view_count, 0) + ? WHERE id = ?").bind(n, id),
      ),
    );
    return batch.length;
  } catch (e) {
    console.error("[viewCounter] flush failed; re-queued (continuing)", batch.length, e);
    for (const [id, n] of batch) {
      if (pending.size >= MAX_KEYS && !pending.has(id)) break;
      pending.set(id, (pending.get(id) ?? 0) + n);
    }
    return 0;
  }
}

/** Count one view of `postId`. Never throws and never delays the response. */
export function recordBlogView(
  env: Env,
  ctx: { waitUntil(p: Promise<unknown>): void },
  postId: string,
  windowMs: number = FLUSH_WINDOW_MS,
): void {
  if (!postId) return;
  if (!pending.has(postId) && pending.size >= MAX_KEYS) {
    // Buffer full of distinct posts (a crawler sweep): fall back to a direct write
    // rather than growing memory without bound.
    ctx.waitUntil(
      env.DB.prepare("UPDATE blog_posts SET view_count = COALESCE(view_count, 0) + 1 WHERE id = ?")
        .bind(postId)
        .run()
        .catch(() => {}),
    );
    return;
  }
  pending.set(postId, (pending.get(postId) ?? 0) + 1);
  // A flush is pending unless none was scheduled, or the scheduled one is overdue
  // (its waitUntil was cancelled before it ran — then nothing would ever reset the
  // flag and this isolate would buffer forever). Overdue → schedule a fresh one.
  const now = Date.now();
  if (flushScheduledAt && now - flushScheduledAt < windowMs * 2) return;
  flushScheduledAt = now;
  ctx.waitUntil(sleep(windowMs).then(() => flushBlogViews(env)));
}

/** Test hook. */
export function __resetBlogViewsForTests(): void {
  pending.clear();
  flushScheduledAt = 0;
}
export function __pendingBlogViews(): ReadonlyMap<string, number> {
  return pending;
}
