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
import { telemetryRoute } from '../../src/routes/telemetry';
import { uploadRoute } from '../../src/routes/upload';
import { webhookRoute } from '../../src/routes/webhook';
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
    return this.allSync();
  }

  allSync() {
    const rows = this.db.prepare(this.sql).all(...this.params).map((r: any) => ({ ...r }));
    return { results: rows, success: true, meta: {} };
  }

  async run() {
    return this.runSync();
  }

  runSync() {
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
  /**
   * Like D1, a batch is ONE transaction: if any statement throws, every earlier
   * statement in the batch is rolled back. (The shim used to commit statement by
   * statement, so all-or-nothing behaviour could not be tested.)
   *
   * Also like D1, a batch is SERIALIZED: it runs start to finish without yielding,
   * so two concurrent batches can never interleave their statements.
   */
  async batch(stmts: ShimStatement[]) {
    const out: any[] = [];
    this.db.exec('SAVEPOINT d1_batch');
    try {
      for (const s of stmts) out.push(isSelectLike(s.sql) ? s.allSync() : s.runSync());
      this.db.exec('RELEASE d1_batch');
    } catch (e) {
      this.db.exec('ROLLBACK TO d1_batch');
      this.db.exec('RELEASE d1_batch');
      throw e;
    }
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

/**
 * Stand-in for the ChatArchive Durable Object (one instance per chatId).
 *
 * Message bodies moved out of the D1 `messages` table into per-chat DOs, so the
 * handlers now call `env.CHAT_ARCHIVE.get(id).append/history/…` instead of
 * touching D1. `src/chatArchive.ts` imports `cloudflare:workers`, which cannot
 * load in Node (the same reason the app can't import src/index.ts here), so this
 * fake mirrors the DO's behaviour in memory.
 *
 * Crucially it SEEDS from the D1 `messages` table on first touch, exactly like
 * the real DO — so a test that pre-inserts legacy rows sees them, and the
 * lazy-migration path is actually exercised rather than stubbed away.
 */
export function fakeChatArchive(sqlite: SqliteDb) {
  interface Msg { id: string; senderId: string; text: string | null; read: number; createdAt: number; type?: string; mediaUrl?: string | null }
  const stores = new Map<string, { seeded: boolean; msgs: Map<string, Msg> }>();
  const store = (chatId: string) => {
    let s = stores.get(chatId);
    if (!s) {
      s = { seeded: false, msgs: new Map() };
      stores.set(chatId, s);
    }
    return s;
  };
  const seed = (chatId: string) => {
    const s = store(chatId);
    if (s.seeded) return;
    const rows = sqlite
      .prepare('SELECT id, sender_id, text, read, created_at FROM messages WHERE chat_id = ?')
      .all(chatId) as any[];
    for (const r of rows) {
      if (!s.msgs.has(r.id)) {
        s.msgs.set(r.id, {
          id: r.id,
          senderId: r.sender_id,
          text: r.text ?? null,
          read: r.read ? 1 : 0,
          createdAt: Number(r.created_at),
        });
      }
    }
    s.seeded = true;
  };
  const out = (m: Msg, chatId: string) => ({ id: m.id, senderId: m.senderId, text: m.text, createdAt: m.createdAt, chatId });
  const pub = (m: Msg) => ({ id: m.id, senderId: m.senderId, text: m.text, type: m.type || 'text', mediaUrl: m.mediaUrl ?? null, createdAt: m.createdAt });
  // Same order as the DO's (created_at, id) index.
  const byTimeId = (a: Msg, b: Msg) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const makeStub = (chatId: string) => ({
    async append(cid: string, m: { id: string; senderId: string; text: string | null; createdAt: number; type?: string; mediaUrl?: string | null }) {
      seed(cid);
      const s = store(cid);
      const existing = s.msgs.get(m.id);
      if (existing) return { message: pub(existing), inserted: false };
      const row = { ...m, read: 0 };
      s.msgs.set(m.id, row);
      return { message: pub(row), inserted: true };
    },
    async latest(cid: string, opts: { beforeTs?: number | null; beforeId?: string | null; after?: number; limit?: number } = {}) {
      seed(cid);
      const after = Number(opts.after) || 0;
      const cap = Math.min(Math.max(Number(opts.limit) || 200, 1), 200);
      const older = (m: Msg) =>
        opts.beforeTs == null || m.createdAt < opts.beforeTs || (m.createdAt === opts.beforeTs && m.id < (opts.beforeId ?? ''));
      return [...store(cid).msgs.values()]
        .filter((m) => m.createdAt > after && older(m))
        .sort(byTimeId)
        .slice(-cap)
        .map(pub);
    },
    async history(cid: string, since = 0, limit = 200) {
      seed(cid);
      return [...store(cid).msgs.values()]
        .filter((m) => m.createdAt > (Number(since) || 0))
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, limit)
        .map((m) => ({ id: m.id, senderId: m.senderId, text: m.text, createdAt: m.createdAt }));
    },
    async markRead(cid: string, reader: string) {
      seed(cid);
      let updated = 0;
      for (const m of store(cid).msgs.values()) {
        if (m.senderId !== reader && m.read === 0) {
          m.read = 1;
          updated++;
        }
      }
      return { updated };
    },
    async purge(cid: string) {
      const s = store(cid);
      const deleted = s.msgs.size;
      s.msgs.clear();
      s.seeded = false;
      return { deleted };
    },
    async deleteBySender(cid: string, uid: string) {
      seed(cid);
      const s = store(cid);
      let deleted = 0;
      for (const [id, m] of [...s.msgs]) {
        if (m.senderId === uid) {
          s.msgs.delete(id);
          deleted++;
        }
      }
      return { deleted };
    },
    async listBySender(cid: string, uid: string, limit: number) {
      seed(cid);
      return [...store(cid).msgs.values()]
        .filter((m) => m.senderId === uid)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((m) => out(m, cid));
    },
    async deleteOne(cid: string, id: string) {
      seed(cid);
      const deleted = store(cid).msgs.delete(id) ? 1 : 0;
      return { deleted };
    },
    async recent(cid: string, limit: number) {
      seed(cid);
      return [...store(cid).msgs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, limit)
        .map((m) => out(m, cid));
    },
  });
  return {
    _stores: stores,
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
  const objects = new Map<string, { body: any; httpMetadata?: any; customMetadata?: Record<string, string>; size: number }>();
  const deleted: string[] = [];
  const puts: string[] = [];
  const sizeOf = (body: any): number =>
    body == null ? 0 : typeof body === 'string' ? new TextEncoder().encode(body).length : Number(body.byteLength ?? body.length ?? 0);
  return {
    _objects: objects,
    /** Keys passed to delete(), in order, including keys that did not exist. */
    _deleted: deleted,
    /** Keys passed to put(), in order — lets a test prove an object was NOT re-uploaded. */
    _puts: puts,
    async put(key: string, body: any, opts?: any) {
      puts.push(key);
      objects.set(key, { body, httpMetadata: opts?.httpMetadata, customMetadata: opts?.customMetadata, size: sizeOf(body) });
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
      return existing
        ? { key, size: existing.size, httpMetadata: existing.httpMetadata, customMetadata: existing.customMetadata }
        : null;
    },
    /** Like the real binding: one key or an array of keys. */
    async delete(key: string | string[]) {
      for (const k of Array.isArray(key) ? key : [key]) {
        deleted.push(k);
        objects.delete(k);
      }
    },
    /** Prefix listing with the real binding's pagination shape. */
    async list(opts: { prefix?: string; cursor?: string; limit?: number } = {}) {
      const prefix = opts.prefix ?? '';
      const limit = opts.limit ?? 1000;
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const page = keys.slice(start, start + limit);
      const truncated = start + limit < keys.length;
      return {
        objects: page.map((k) => ({ key: k, size: objects.get(k)!.size })),
        truncated,
        ...(truncated ? { cursor: String(start + limit) } : {}),
      };
    },
  };
}

/**
 * A fake contest-entry image: real JPEG/PNG magic bytes (so the server's sniffer
 * accepts it) followed by a marker naming the photo and its pixel size, which
 * `fakeImages` reads back to report dimensions and to identify which entry was
 * drawn where.
 */
export function fakePhoto(label: string, opts: { width?: number; height?: number; format?: 'jpeg' | 'png' } = {}): Uint8Array {
  const magic = opts.format === 'png' ? [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] : [0xff, 0xd8, 0xff, 0xe0];
  const marker = new TextEncoder().encode(`|${label}|${opts.width ?? 1080}x${opts.height ?? 1350}|`);
  return new Uint8Array([...magic, ...marker]);
}

/**
 * Recording stand-in for the Cloudflare Images binding (`env.IMAGES`).
 *
 * Implements the slice the VS renderer uses — info(), input().transform()
 * .draw().output() — and records the resolved draw tree of every output, so a
 * test can assert which participant's photo landed in which panel, with what
 * crop, and where the badge went. A photo whose label contains "corrupt" fails
 * decoding the way the real binding does (error 9412).
 */
export function fakeImages(opts: { failOutput?: () => Error | null } = {}) {
  const outputs: any[] = [];
  const read = async (s: any): Promise<Uint8Array> => new Uint8Array(await new Response(s).arrayBuffer());
  const describe = (b: Uint8Array) => {
    const m = new TextDecoder().decode(b).match(/\|([^|]*)\|(\d+)x(\d+)\|/);
    return m ? { label: m[1], width: Number(m[2]), height: Number(m[3]) } : null;
  };
  const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50;
  const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;

  function transformer(source: Promise<Uint8Array>) {
    const ops: any[] = [];
    const t: any = {
      _ops: ops,
      _source: source,
      transform(x: any) {
        ops.push({ transform: x });
        return t;
      },
      draw(img: any, o: any) {
        ops.push({ draw: img, options: o });
        return t;
      },
      async output(o: any) {
        const tree = await resolve(t);
        const err = opts.failOutput?.();
        if (err) throw err;
        outputs.push({ ...tree, output: o });
        const bytes = new Uint8Array([0xff, 0xd8, 0xff, ...new TextEncoder().encode(JSON.stringify(tree))]);
        return {
          image: () => new Blob([bytes]).stream(),
          contentType: () => o.format,
          response: () => new Response(bytes),
        };
      },
    };
    return t;
  }
  async function resolve(t: any): Promise<any> {
    const bytes = await t._source;
    const d = describe(bytes);
    return {
      source: d?.label ?? (isPng(bytes) ? 'generated-png' : 'unknown'),
      ops: await Promise.all(
        t._ops.map(async (op: any) => {
          if (!op.draw) return op;
          const child = op.draw._ops ? await resolve(op.draw) : { source: describe(await read(op.draw))?.label ?? 'generated-png', ops: [] };
          return { draw: child, options: op.options };
        }),
      ),
    };
  }
  return {
    _outputs: outputs,
    async info(stream: any) {
      const b = await read(stream);
      const d = describe(b);
      if ((!isJpeg(b) && !isPng(b)) || d?.label.includes('corrupt')) {
        throw Object.assign(new Error('IMAGES_INFO_ERROR 9412: Input is not an image'), { code: 9412 });
      }
      return { format: isPng(b) ? 'image/png' : 'image/jpeg', fileSize: b.length, width: d?.width ?? 100, height: d?.height ?? 100 };
    },
    input(stream: any) {
      return transformer(read(stream));
    },
    text() {
      throw new Error('text() is intentionally unused by the VS renderer');
    },
    hosted: {} as any,
  };
}

export interface TestEnv {
  DB: any;
  MEDIA: ReturnType<typeof fakeR2>;
  CACHE_KV: ReturnType<typeof fakeKV>;
  OTP_KV: ReturnType<typeof fakeKV>;
  RATE_LIMITER: ReturnType<typeof fakeRateLimiter>;
  CHAT_ARCHIVE: ReturnType<typeof fakeChatArchive>;
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
    CHAT_ARCHIVE: fakeChatArchive(sqlite),
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

/**
 * Replace the always-miss `caches` stub with one that REALLY STORES, for the
 * duration of a test.
 *
 * Lives here rather than in one suite because the Cache API is now the app's primary
 * read cache (lib/edgeCache.ts): any test that wants to observe caching at all —
 * that an entry is written, that a hit still runs per-viewer authorization, that a
 * purge clears it — needs a cache that behaves like one. With the default stub every
 * endpoint recomputes, which is deterministic but means the cache is exercised by
 * nothing.
 *
 * Keyed by request url, which is what the real Cache API does, so the key-derivation
 * helpers in lib/edgeCache.ts are genuinely under test.
 *
 * Call `restore()` in an afterEach — a cache that survives into the next test would
 * serve one test's response to another's request.
 */
export function installEdgeCache() {
  const store = new Map<string, { body: string; cacheControl: string | null; status: number }>();
  const previous = (globalThis as any).caches;
  (globalThis as any).caches = {
    default: {
      async match(req: Request) {
        const hit = store.get(req.url);
        if (!hit) return undefined;
        return new Response(hit.body, {
          status: hit.status,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      async put(req: Request, res: Response) {
        store.set(req.url, {
          body: await res.text(),
          cacheControl: res.headers.get('Cache-Control'),
          status: res.status,
        });
      },
      async delete(req: Request) {
        return store.delete(req.url);
      },
    },
  };
  return {
    store,
    keys: () => [...store.keys()],
    /** Entry keys carrying a logical cache key, decoded. Excludes url-keyed entries. */
    logicalKeys: () =>
      [...store.keys()]
        .filter((u) => u.includes('/__edge'))
        .map((u) => decodeURIComponent(new URL(u).searchParams.get('k') || '')),
    clear: () => store.clear(),
    restore: () => {
      (globalThis as any).caches = previous;
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
  app.route('/telemetry', telemetryRoute);
  app.route('/upload', uploadRoute);
  app.route('/webhook', webhookRoute);
  return app;
}

