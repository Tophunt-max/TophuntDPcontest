/**
 * Test harness that runs the REAL worker handlers in plain Node.
 *
 * Cloudflare's `workerd` runtime cannot start in every CI/sandbox (it needs CPU
 * affinity syscalls), so instead of `vitest-pool-workers` we back the drizzle
 * D1 driver with Node's built-in `node:sqlite`. The drizzle-d1 driver only
 * needs a tiny surface (`prepare/bind/all/run/raw` + `batch`), which we
 * implement here — so the handlers exercise the same SQL, the same conditional
 * UPDATEs, and the same `meta.changes` guards they use in production.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// `node:sqlite` is a very new builtin that Vite/Vitest's resolver doesn't know
// how to externalize yet, so load it through createRequire to bypass bundling.
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as typeof import('node:sqlite');
type SqliteDb = InstanceType<typeof DatabaseSync>;
import { Hono } from 'hono';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../../src/db/schema';
import { ApiError, errorBody } from '../../src/lib/http';
import { memoReset } from '../../src/lib/memo';
import { normalizeSpec, windowIdFor } from '../../src/lib/rateLimitWindow';
import { apiRoute } from '../../src/routes/api';
import { readRoute } from '../../src/routes/read';
import { adminRoute } from '../../src/routes/admin';
import { authRoute } from '../../src/routes/auth';

const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'migrations');

const isSelectLike = (sql: string) => /^\s*(select|pragma|with)/i.test(sql) || /returning/i.test(sql);

/** A single D1-compatible prepared statement backed by node:sqlite. */
class ShimStatement {
  params: any[] = [];
  constructor(public db: SqliteDb, public sql: string) {}

  bind(...params: any[]) {
    this.params = params;
    return this;
  }

  async all() {
    const rows = this.db.prepare(this.sql).all(...this.params).map((r: any) => ({ ...r }));
    return { results: rows, success: true, meta: {} };
  }

  async run() {
    const info = this.db.prepare(this.sql).run(...this.params);
    const changes = Number(info.changes);
    return {
      success: true,
      results: [],
      meta: {
        changes,
        last_row_id: Number(info.lastInsertRowid),
        rows_written: changes,
        rows_read: 0,
        duration: 0,
        changed_db: changes > 0,
      },
    };
  }

  async raw() {
    const rows = this.db.prepare(this.sql).all(...this.params) as any[];
    return rows.map((r) => Object.values(r));
  }

  async first(col?: string) {
    const row: any = this.db.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
}

/** Minimal D1Database shim (only what drizzle-orm/d1 calls). */
class D1Shim {
  constructor(public db: SqliteDb) {}
  prepare(sql: string) {
    return new ShimStatement(this.db, sql);
  }
  async batch(stmts: ShimStatement[]) {
    const out: any[] = [];
    for (const s of stmts) out.push(isSelectLike(s.sql) ? await s.all() : await s.run());
    return out;
  }
  async exec(sql: string) {
    this.db.exec(sql);
    return { count: 0, duration: 0 };
  }
}

/**
 * Stand-in for the RateLimiter Durable Object.
 *
 * Needed because `src/rateLimiter.ts` imports `cloudflare:workers`, which cannot
 * load in Node — the same reason `makeApp()` below cannot import `src/index.ts`.
 * Without a binding here every `rateLimit()` call would throw inside the client
 * and take its failure branch, which silently means "allowed" for the fail-open
 * keys and "refused" for every fail-closed one: money, OTP and upload tests would
 * fail for a reason that has nothing to do with what they assert.
 *
 * The window arithmetic is imported from src/lib/rateLimitWindow rather than
 * re-derived, so this fake cannot drift from the actor on the one detail where an
 * off-by-one would be invisible. The rest is a deliberate line-for-line mirror of
 * `RateLimiter.consume()` — including that specs are consumed in order and the
 * walk stops at the first denial without refunding earlier ones.
 *
 * What this does NOT cover is the actor's SQLite plumbing and its pruning alarm.
 * That matches the existing policy for VoteCounter (see test/README.md): a DO class
 * itself needs the workerd runtime.
 */
export function fakeRateLimiter() {
  const counts = new Map<string, number>();
  const makeStub = (shard: string) => ({
    async consume(specs: Array<{ key: string; max: number; windowSec: number }>) {
      if (!Array.isArray(specs) || specs.length === 0) return { allowed: true, deniedKey: null };
      for (const raw of specs) {
        const key = String(raw?.key ?? '');
        if (!key) continue;
        const { max, windowSec } = normalizeSpec(raw?.max, raw?.windowSec);
        if (max === 0) return { allowed: false, deniedKey: key };
        const cell = `${shard}|${key}|${windowIdFor(Date.now(), windowSec)}`;
        const current = counts.get(cell) ?? 0;
        if (current >= max) return { allowed: false, deniedKey: key };
        counts.set(cell, current + 1);
      }
      return { allowed: true, deniedKey: null };
    },
    async peek(key: string, windowSec: number) {
      const { windowSec: w } = normalizeSpec(0, windowSec);
      return counts.get(`${shard}|${key}|${windowIdFor(Date.now(), w)}`) ?? 0;
    },
    async reset(key: string) {
      for (const cell of [...counts.keys()]) {
        if (cell.startsWith(`${shard}|${key}|`)) counts.delete(cell);
      }
    },
  });
  return {
    /** Counter cells, for assertions. Keyed `shard|key|windowId`. */
    _counts: counts,
    idFromName(name: string) {
      return { name } as any;
    },
    get(id: { name: string }) {
      return makeStub(id.name);
    },
  };
}

/** Simple in-memory KV that mimics the bits the handlers use. */
export function fakeKV() {
  const map = new Map<string, string>();
  return {
    _map: map,
    async get(key: string, type?: 'json' | 'text') {
      const v = map.get(key);
      if (v == null) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key: string, value: string) {
      map.set(key, typeof value === 'string' ? value : String(value));
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
}

/**
 * Minimal R2 bucket stand-in.
 *
 * Records every key put and deleted, because storage side effects are otherwise
 * invisible to a test: the handlers deliberately treat an R2 failure as
 * non-fatal, so a delete that never happens produces exactly the same response
 * body as one that did. Cleaning up an object nobody references is a pure cost
 * concern, and cost regressions are the kind that go unnoticed for months.
 */
export function fakeR2() {
  const objects = new Map<string, { body: any; httpMetadata?: any }>();
  const deleted: string[] = [];
  return {
    _objects: objects,
    /** Keys passed to delete(), in order, including keys that did not exist. */
    _deleted: deleted,
    async put(key: string, body: any, opts?: any) {
      objects.set(key, { body, httpMetadata: opts?.httpMetadata });
      return { key };
    },
    async get(key: string) {
      return objects.get(key) ?? null;
    },
    /**
     * Present because real code branches on it: `putVerifiedImage` heads the key
     * first and skips the write when the object already exists, which is the
     * content-hash deduplication. Without `head` here that path threw
     * "env.MEDIA.head is not a function" instead of being exercised, so the dedup
     * was untestable — and `lib/health.ts` heads `health/probe` too.
     */
    async head(key: string) {
      const existing = objects.get(key);
      return existing ? { key, size: 0, httpMetadata: existing.httpMetadata } : null;
    },
    async delete(key: string) {
      deleted.push(key);
      objects.delete(key);
    },
  };
}

export interface TestEnv {
  DB: any;
  MEDIA: ReturnType<typeof fakeR2>;
  CACHE_KV: ReturnType<typeof fakeKV>;
  OTP_KV: ReturnType<typeof fakeKV>;
  RATE_LIMITER: ReturnType<typeof fakeRateLimiter>;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  R2_PUBLIC_BASE_URL: string;
  ALLOWED_ORIGINS: string;
  FIREBASE_PROJECT_ID: string;
  [k: string]: any;
}

/** Fresh in-memory DB with all migrations applied + a ready-to-use env. */
export function makeEnv(overrides: Partial<TestEnv> = {}): { env: TestEnv; db: SqliteDb } {
  // lib/memo.ts caches in MODULE state, which outlives a single test in the same
  // Vitest module registry. Every test here builds a fresh D1 and a fresh fake
  // KV, so without this reset a settings blob or block set memoised by the
  // previous test would be served against this test's database — passing or
  // failing depending on file order, which is the worst kind of flake.
  memoReset();

  const sqlite = new DatabaseSync(':memory:');
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8'));

  const env: TestEnv = {
    DB: new D1Shim(sqlite),
    MEDIA: fakeR2(),
    CACHE_KV: fakeKV(),
    OTP_KV: fakeKV(),
    RATE_LIMITER: fakeRateLimiter(),
    RAZORPAY_KEY_ID: 'rzp_test_key',
    RAZORPAY_KEY_SECRET: 'rzp_test_secret',
    R2_PUBLIC_BASE_URL: 'https://cdn.test',
    ALLOWED_ORIGINS: '*',
    FIREBASE_PROJECT_ID: 'test-project',
    // Shared server-to-server admin secret. Sending it as X-Admin-Secret is the
    // simplest way to exercise /admin routes at superadmin level.
    ADMIN_PROXY_SECRET: 'test-admin-secret',
    ...overrides,
  };
  return { env, db: sqlite };
}

/**
 * `caches` is a Workers global with no Node equivalent, so any endpoint using
 * `edgeCached` (blog categories, the blog sitemap feed, …) previously threw
 * `ReferenceError: caches is not defined` and returned 500 in tests — which is why
 * none of them had any.
 *
 * This is an always-miss, never-store stub: it makes those endpoints reachable
 * while keeping every test deterministic, since a real cache would let one test's
 * response satisfy the next one's request.
 */
if (!(globalThis as any).caches) {
  (globalThis as any).caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {
        /* discard */
      },
      async delete() {
        return false;
      },
    },
  };
}

/** A no-op ExecutionContext that swallows waitUntil rejections. */
export function fakeCtx() {
  return {
    waitUntil(p: Promise<any>) {
      if (p && typeof (p as any).catch === 'function') (p as any).catch(() => {});
    },
    passThroughOnException() {},
  } as any;
}

/** Drizzle handle over the same underlying sqlite (for seeding/asserting). */
export function drizzleOf(env: TestEnv) {
  return drizzle(env.DB, { schema });
}

/**
 * Mount the real /api and /read routes on a fresh Hono app with the same
 * error→HTTP mapping the production entry uses (src/index.ts onError). We can't
 * import src/index.ts directly because it registers Durable Objects that import
 * `cloudflare:workers` (unavailable in Node), so we replicate just the mapping.
 *
 * /read is mounted because several behaviours are only observable across the two:
 * a write to /api followed by a read from /read is what proves, for example, that
 * a block actually removes someone from the feed rather than merely recording a
 * row.
 */
export function makeApp() {
  const app = new Hono();
  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json(errorBody(err), err.status);
    // Surface unexpected errors so a failing test shows the real cause.
    console.error('[test onError]', err);
    return c.json(errorBody(new ApiError('internal', 'Internal server error.')), 500);
  });
  app.route('/api', apiRoute);
  app.route('/read', readRoute);
  // /auth is where the signup bonus is granted, which is a balance change and so
  // has to be provable in a test.
  app.route('/auth', authRoute);
  // /admin carries the money-critical operator actions — approving and rejecting
  // payouts, crediting manual deposits, adjusting balances. Authenticate with the
  // `X-Admin-Secret: ADMIN_PROXY_SECRET` header, which the gate treats as
  // superadmin and so satisfies requireFullAdmin without a Firebase token.
  app.route('/admin', adminRoute);
  return app;
}

