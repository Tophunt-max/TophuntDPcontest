/**
 * The RateLimiter actor's SQL, executed for real.
 *
 * `src/rateLimiter.ts` imports `cloudflare:workers` and cannot load in Node, so the
 * counter itself — the boundary condition, the upsert, the pruning cycle — would
 * otherwise be the one part of a rate limiter with no test at all. The DDL and every
 * statement live in `src/lib/rateLimitSql.ts` precisely so this file can run them
 * VERBATIM against `node:sqlite` (the same engine backing the D1 shim in
 * test/helpers/harness.ts).
 *
 * What this covers that test/rateLimiter.test.ts cannot: that `max` really admits
 * exactly `max`, that `ON CONFLICT` increments instead of resetting, and that the
 * pruner drops dead rows without touching live ones. What it still does not cover is
 * the actor's own scheduling — `ctx.storage.setAlarm` needs workerd — so the alarm's
 * re-arm DECISION is reproduced here from the same query it uses, and the decision
 * itself is asserted rather than the scheduling call.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

import {
  RATE_LIMIT_DDL,
  SQL_CONSUME,
  SQL_NEXT_EXPIRY,
  SQL_PRUNE,
  SQL_RESET,
  SQL_SELECT_COUNT,
} from '../src/lib/rateLimitSql';
import { windowExpiresAt, windowIdFor } from '../src/lib/rateLimitWindow';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');

/** A fresh in-memory database with the actor's schema applied. */
function freshActor() {
  const db = new DatabaseSync(':memory:');
  for (const stmt of RATE_LIMIT_DDL) db.exec(stmt);
  return db;
}

/**
 * `RateLimiter.consume()` for one spec, using the production statements.
 *
 * Mirrors the actor's control flow around the same SQL: read, compare, upsert.
 */
function consume(
  db: InstanceType<typeof DatabaseSync>,
  key: string,
  max: number,
  windowSec: number,
  nowMs: number,
): boolean {
  const windowId = windowIdFor(nowMs, windowSec);
  const rows = db.prepare(SQL_SELECT_COUNT).all(key, windowId) as Array<{ count: number }>;
  const current = rows.length > 0 ? Number(rows[0].count) || 0 : 0;
  if (current >= max) return false;
  db.prepare(SQL_CONSUME).run(key, windowId, windowExpiresAt(windowId, windowSec));
  return true;
}

describe('the counter admits exactly `max`', () => {
  it('allows max requests and denies the next', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    // Guards the direction of `current >= max`. With `>` this would allow 4.
    expect([1, 2, 3].map(() => consume(db, 'vote:alice', 3, 60, now))).toEqual([true, true, true]);
    expect(consume(db, 'vote:alice', 3, 60, now)).toBe(false);
  });

  it('increments on conflict rather than resetting the row to 1', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 5; i++) consume(db, 'like:alice', 10, 60, now);
    const rows = db.prepare(SQL_SELECT_COUNT).all('like:alice', windowIdFor(now, 60)) as Array<{
      count: number;
    }>;
    // An ON CONFLICT that assigned instead of adding would leave this at 1, and the
    // limit would then be unreachable — a limiter that never limits.
    expect(rows[0].count).toBe(5);
  });

  it('starts a fresh budget in the next window', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    expect(consume(db, 'msg:alice', 1, 60, now)).toBe(true);
    expect(consume(db, 'msg:alice', 1, 60, now + 59_999)).toBe(false);
    expect(consume(db, 'msg:alice', 1, 60, now + 60_000)).toBe(true);
  });

  it('keeps one row per (key, window) and never two describing the same window', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 4; i++) consume(db, 'post:alice', 10, 3600, now + i * 1000);
    const all = db.prepare('SELECT COUNT(*) AS n FROM windows').all() as Array<{ n: number }>;
    expect(all[0].n).toBe(1);
  });

  it('refreshes expires_at when a key is reused with a different window size', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    // Not reachable from any current call site, but the pruner trusts expires_at:
    // a row whose expiry described a different window than its window_id would be
    // collected at the wrong time.
    consume(db, 'shared:alice', 10, 60, now);
    const before = (db.prepare('SELECT expires_at FROM windows').all() as any[])[0].expires_at;
    // Same window_id can only be hit by the same windowSec, so assert directly on
    // the statement instead: a second insert for the same row must move the expiry.
    db.prepare(SQL_CONSUME).run('shared:alice', windowIdFor(now, 60), Number(before) + 5_000);
    const after = (db.prepare('SELECT expires_at, count FROM windows').all() as any[])[0];
    expect(Number(after.expires_at)).toBe(Number(before) + 5_000);
    expect(Number(after.count)).toBe(2);
  });

  it('isolates keys from each other', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    expect(consume(db, 'like:alice', 1, 60, now)).toBe(true);
    expect(consume(db, 'like:alice', 1, 60, now)).toBe(false);
    // Same subject, different action — the stored key retains the action prefix, so
    // no two limits can share a budget.
    expect(consume(db, 'comment:alice', 1, 60, now)).toBe(true);
  });

  it('forgets a key on reset', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    consume(db, 'withdraw:alice', 1, 3600, now);
    expect(consume(db, 'withdraw:alice', 1, 3600, now)).toBe(false);
    db.prepare(SQL_RESET).run('withdraw:alice');
    expect(consume(db, 'withdraw:alice', 1, 3600, now)).toBe(true);
  });
});

describe('pruning', () => {
  const PRUNE_GRACE_MS = 60_000; // must match src/rateLimiter.ts

  /** The alarm body: prune, then decide whether to re-arm. */
  function runAlarm(db: InstanceType<typeof DatabaseSync>, nowMs: number) {
    db.prepare(SQL_PRUNE).run(nowMs - PRUNE_GRACE_MS);
    const rows = db.prepare(SQL_NEXT_EXPIRY).all() as Array<{
      next: number | null;
      remaining: number;
    }>;
    const remaining = Number(rows[0]?.remaining) || 0;
    if (remaining === 0) return { rearmed: false, at: 0 };
    const next = Number(rows[0]?.next) || 0;
    return { rearmed: true, at: Math.max(next, nowMs) + PRUNE_GRACE_MS };
  }

  it('never deletes a live row', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    consume(db, 'vote:alice', 10, 60, now); // expires at now+60s
    runAlarm(db, now + 1_000);
    expect((db.prepare('SELECT COUNT(*) AS n FROM windows').all() as any[])[0].n).toBe(1);
  });

  it('deletes a dead row once it is past the grace period', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    consume(db, 'vote:alice', 10, 60, now);
    const res = runAlarm(db, now + 60_000 + PRUNE_GRACE_MS + 1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM windows').all() as any[])[0].n).toBe(0);
    // Storage is empty, so the actor should be allowed to be reclaimed.
    expect(res.rearmed).toBe(false);
  });

  it('re-arms while ANY row remains, including one expiring exactly now', () => {
    // This is the bug the review caught. Absolute windows make rows expire on
    // aligned instants and the alarm is scheduled from one of them, so "fires
    // exactly at an expiry" is the normal case. The row is spared by the grace
    // period and is not in the future either, so a `next > now` test would re-arm
    // nothing and leave that row in storage forever — keeping the actor alive by
    // means of the very residue the alarm exists to remove.
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    consume(db, 'vote:alice', 10, 60, now);
    const expiry = now + 60_000;
    const res = runAlarm(db, expiry);
    expect((db.prepare('SELECT COUNT(*) AS n FROM windows').all() as any[])[0].n).toBe(1);
    expect(res.rearmed).toBe(true);
    expect(res.at).toBeGreaterThan(expiry);
  });

  it('schedules from the EARLIEST expiry, so short windows are not pinned to long ones', () => {
    // Re-arming from MAX(expires_at) would hold a day of 60-second rows alongside
    // any 24-hour row (upload_day, exportdata, otpsend_num, pushday) and then delete
    // thousands in one alarm — and deletes are billed as rows written, so that
    // arrives as a single spike against the daily budget.
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    consume(db, 'upload_day:alice', 10, 86_400, now);
    consume(db, 'vote:alice', 10, 60, now);
    const res = runAlarm(db, now + 1);
    expect(res.rearmed).toBe(true);
    // Next visit is driven by the 60s row, not the 24h one.
    expect(res.at).toBeLessThan(now + 86_400_000);
  });

  it('drains multiple dead windows across repeated alarms', () => {
    const db = freshActor();
    const now = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 5; i++) consume(db, 'msg:alice', 10, 60, now + i * 60_000);
    expect((db.prepare('SELECT COUNT(*) AS n FROM windows').all() as any[])[0].n).toBe(5);
    let t = now;
    for (let i = 0; i < 12; i++) {
      const res = runAlarm(db, t);
      if (!res.rearmed) break;
      t = res.at;
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM windows').all() as any[])[0].n).toBe(0);
  });
});
