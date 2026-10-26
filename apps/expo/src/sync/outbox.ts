import { Q } from '@nozbe/watermelondb';
import NetInfo from '@react-native-community/netinfo';

import { callApi } from '@/src/services/api';
import { auth } from '@/src/services/firebase/initFirebase';
import type { OutboxOpModel } from '@/src/database/models/OutboxOpModel';
import { classifyFailure } from './failure';

/**
 * Offline outbox for social actions.
 *
 * When a like, bookmark or follow cannot reach the server, the UI keeps the
 * user's change and hands it here. It is stored in the local database
 * (`outbox_ops`), survives restarts, and is sent when the device is back
 * online. Without it, those taps were rolled back without a word.
 *
 * Rules:
 * - Only the kinds in HANDLERS are accepted. Each sends an explicit TARGET STATE
 *   (`liked: true`, `intent: 'follow'`), never a toggle, and the server treats
 *   a repeat as a no-op (apps/worker/test/socialReplay.test.ts). So a request
 *   whose response was lost can be sent again safely.
 * - Votes, coins, payments, contest entry and withdrawals must NEVER be added.
 *   Deadlines, eligibility and balances are decided by the server when the
 *   request arrives; replaying them later would act on a world the user never
 *   saw.
 * - One row per (account, kind, target). A newer intent replaces the older one
 *   (like then unlike offline sends only "unlike"), and `revision` stops a send
 *   that was in flight from deleting the newer intent when it completes.
 * - Only the signed-in account's rows are sent. Another account's rows stay
 *   until that account signs in again or they expire.
 * - Bounded: MAX_OPS_PER_ACCOUNT rows per account, dropped after MAX_AGE_MS,
 *   MAX_ATTEMPTS sends before a row is marked failed.
 */

export type OutboxKind = 'match.like' | 'match.bookmark' | 'user.follow';

type Payloads = {
  'match.like': { liked: boolean };
  'match.bookmark': { bookmarked: boolean };
  'user.follow': { intent: 'follow' | 'unfollow' | 'cancel' };
};

const HANDLERS: { [K in OutboxKind]: { valid: (p: any) => p is Payloads[K]; send: (target: string, p: Payloads[K]) => Promise<unknown> } } = {
  'match.like': {
    valid: (p): p is Payloads['match.like'] => typeof p?.liked === 'boolean',
    send: (matchId, p) => callApi('likeContest', { matchId, liked: p.liked }),
  },
  'match.bookmark': {
    valid: (p): p is Payloads['match.bookmark'] => typeof p?.bookmarked === 'boolean',
    send: (matchId, p) => callApi('toggleBookmark', { matchId, bookmarked: p.bookmarked }),
  },
  'user.follow': {
    valid: (p): p is Payloads['user.follow'] => p?.intent === 'follow' || p?.intent === 'unfollow' || p?.intent === 'cancel',
    send: (targetUserId, p) => callApi('toggleFollow', { targetUserId, intent: p.intent }),
  },
};

export const MAX_OPS_PER_ACCOUNT = 300;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 10 * 60 * 1000;
const TABLE = 'outbox_ops';

/** Exponential backoff with ±50% jitter, so many devices coming back online do not retry in lockstep. */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
  return Math.round(base * (0.5 + random()));
}

// ---------------------------------------------------------------- deps (tests)

interface Deps {
  now: () => number;
  uid: () => string | null;
  online: () => Promise<boolean>;
  send: (kind: OutboxKind, target: string, payload: any) => Promise<unknown>;
  random: () => number;
}

const defaultDeps: Deps = {
  now: () => Date.now(),
  uid: () => auth.currentUser?.uid ?? null,
  online: async () => {
    try {
      const s = await NetInfo.fetch();
      return s.isConnected !== false && s.isInternetReachable !== false;
    } catch {
      return true;
    }
  },
  send: (kind, target, payload) => (HANDLERS[kind].send as any)(target, payload),
  random: Math.random,
};
let deps: Deps = defaultDeps;

/** Test hook. */
export function __setOutboxDepsForTests(d: Partial<Deps> | null): void {
  deps = d ? { ...defaultDeps, ...d } : defaultDeps;
  memory.clear();
  memoryAccount = null;
  draining = null;
  followUp = null;
}

async function db() {
  return (await import('@/src/database')).database;
}

// --------------------------------------------------- in-memory pending mirror
//
// The UI needs to answer "is there a pending like for this battle?" while
// rendering, synchronously. This mirrors the signed-in account's PENDING rows.

const memory = new Map<string, any>(); // `${kind}|${target}` -> payload
let memoryAccount: string | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* a listener never breaks the outbox */
    }
  }
}

/** Re-read the signed-in account's pending rows into memory. Never throws. */
export async function loadOutboxMirror(): Promise<void> {
  const uid = deps.uid();
  memory.clear();
  memoryAccount = uid;
  if (!uid) return emit();
  try {
    const rows = await (await db())
      .get<OutboxOpModel>(TABLE)
      .query(Q.where('account', uid), Q.where('status', 'pending'))
      .fetch();
    for (const r of rows) memory.set(`${r.kind}|${r.target}`, parse(r.payload));
  } catch {
    /* degraded database: the mirror is empty, the UI follows the server */
  }
  emit();
}

/**
 * The target state the user chose and the server has not confirmed yet, or
 * undefined. The UI lays this over server data so a refetch does not undo a
 * like the user made offline.
 */
export function pendingIntent<K extends OutboxKind>(kind: K, target: string): Payloads[K] | undefined {
  if (memoryAccount !== deps.uid()) return undefined;
  return memory.get(`${kind}|${target}`);
}

export function subscribeOutbox(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function parse(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- enqueue

/**
 * Store a target state to send later. Resolves false when it could not be
 * stored (not signed in, unknown kind, bad payload, account at capacity,
 * database unavailable). The caller must then roll back its optimistic UI.
 */
export async function enqueueOutbox<K extends OutboxKind>(kind: K, target: string, payload: Payloads[K]): Promise<boolean> {
  const uid = deps.uid();
  const handler = HANDLERS[kind as OutboxKind];
  if (!uid || !handler || !target || !handler.valid(payload)) return false;
  const opKey = `${uid}|${kind}|${target}`;
  const ts = deps.now();
  try {
    const database = await db();
    const stored = await database.write(async () => {
      const col = database.get<OutboxOpModel>(TABLE);
      const [existing] = await col.query(Q.where('op_key', opKey)).fetch();
      if (existing) {
        await existing.update((r) => {
          r.payload = JSON.stringify(payload);
          r.status = 'pending';
          r.attempts = 0;
          r.revision = (r.revision || 0) + 1;
          r.nextAttemptAt = ts;
          r.lastError = null;
        });
        return true;
      }
      const count = await col.query(Q.where('account', uid)).fetchCount();
      if (count >= MAX_OPS_PER_ACCOUNT) return false;
      await col.create((r) => {
        r.account = uid;
        r.kind = kind;
        r.target = target;
        r.opKey = opKey;
        r.payload = JSON.stringify(payload);
        r.status = 'pending';
        r.attempts = 0;
        r.revision = 1;
        r.nextAttemptAt = ts;
        r.lastError = null;
        r.createdAt = ts;
      });
      return true;
    });
    if (!stored) return false;
    if (memoryAccount === uid) {
      memory.set(`${kind}|${target}`, payload);
      emit();
    }
    void drainOutbox();
    return true;
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------- drain

export interface DrainResult {
  sent: number;
  failed: number;
  deferred: number;
  stoppedBecause?: 'offline' | 'signed-out' | 'auth' | 'network';
}

let draining: Promise<DrainResult> | null = null;
let followUp: Promise<DrainResult> | null = null;

/**
 * Send what is due for the signed-in account. One drain at a time; never throws.
 *
 * A request that arrives while a drain is running gets ONE follow-up drain
 * after it, instead of the running drain's result. Otherwise a drain started
 * by an offline enqueue would answer "offline" to the reconnect that asked for
 * a fresh one, and the queue would wait for the next trigger.
 */
export function drainOutbox(): Promise<DrainResult> {
  if (draining) {
    if (!followUp) {
      followUp = draining
        .catch(() => undefined)
        .then(() => {
          followUp = null;
          return drainOutbox();
        });
    }
    return followUp;
  }
  draining = runDrain().finally(() => {
    draining = null;
  });
  return draining;
}

async function runDrain(): Promise<DrainResult> {
  const out: DrainResult = { sent: 0, failed: 0, deferred: 0 };
  const uid = deps.uid();
  if (!uid) return { ...out, stoppedBecause: 'signed-out' };
  if (!(await deps.online())) return { ...out, stoppedBecause: 'offline' };
  let database;
  try {
    database = await db();
  } catch {
    return out;
  }
  const col = database.get<OutboxOpModel>(TABLE);
  const now = deps.now();
  let rows: OutboxOpModel[];
  try {
    rows = await col
      .query(Q.where('account', uid), Q.where('status', 'pending'), Q.sortBy('created_at', Q.asc))
      .fetch();
  } catch {
    return out;
  }

  for (const row of rows) {
    if (deps.uid() !== uid) return { ...out, stoppedBecause: 'signed-out' }; // account switched mid-drain
    if (now - row.createdAt > MAX_AGE_MS) {
      await destroyIfUnchanged(row, row.revision);
      continue;
    }
    if (row.nextAttemptAt > now) {
      out.deferred++;
      continue;
    }
    const payload = parse(row.payload);
    const kind = row.kind as OutboxKind;
    if (!HANDLERS[kind] || !HANDLERS[kind].valid(payload)) {
      await destroyIfUnchanged(row, row.revision); // unknown/corrupt row: never send it
      continue;
    }
    const revision = row.revision;
    try {
      await deps.send(kind, row.target, payload);
      await destroyIfUnchanged(row, revision);
      out.sent++;
    } catch (error) {
      const cls = classifyFailure(error);
      if (cls === 'duplicate') {
        await destroyIfUnchanged(row, revision);
        out.sent++;
        continue;
      }
      if (cls === 'auth') return { ...out, stoppedBecause: 'auth' }; // keep; resend after sign-in
      const message = error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
      if (cls === 'permanent' || row.attempts + 1 >= MAX_ATTEMPTS) {
        await markIfUnchanged(row, revision, (r) => {
          r.status = 'failed';
          r.attempts = r.attempts + 1;
          r.lastError = message;
        });
        out.failed++;
        continue;
      }
      await markIfUnchanged(row, revision, (r) => {
        r.attempts = r.attempts + 1;
        r.nextAttemptAt = deps.now() + backoffMs(r.attempts, deps.random);
        r.lastError = message;
      });
      out.deferred++;
      // No HTTP status means the network is gone again: stop rather than walk
      // the whole queue into the same failure.
      if (error instanceof Error && (error as any).status === undefined) {
        return { ...out, stoppedBecause: 'network' };
      }
    }
  }
  return out;
}

async function destroyIfUnchanged(row: OutboxOpModel, revision: number): Promise<void> {
  const database = await db();
  let removed = false;
  await database
    .write(async () => {
      // Re-read: the row object may be stale if enqueue rewrote it meanwhile.
      const fresh = await database.get<OutboxOpModel>(TABLE).find(row.id).catch(() => null);
      if (!fresh || fresh.revision !== revision) return;
      await fresh.destroyPermanently();
      removed = true;
    })
    .catch(() => undefined);
  if (removed && row.account === memoryAccount) {
    memory.delete(`${row.kind}|${row.target}`);
    emit();
  }
}

async function markIfUnchanged(row: OutboxOpModel, revision: number, fn: (r: OutboxOpModel) => void): Promise<void> {
  const database = await db();
  let failed = false;
  await database
    .write(async () => {
      const fresh = await database.get<OutboxOpModel>(TABLE).find(row.id).catch(() => null);
      if (!fresh || fresh.revision !== revision) return;
      await fresh.update(fn);
      failed = fresh.status === 'failed';
    })
    .catch(() => undefined);
  if (failed && row.account === memoryAccount) {
    // The server refused it: the UI should follow the server again.
    memory.delete(`${row.kind}|${row.target}`);
    emit();
  }
}

// ---------------------------------------------------------------- inspection

export interface OutboxSummary {
  pending: number;
  failed: number;
}

/** Counts for the signed-in account. */
export async function outboxSummary(): Promise<OutboxSummary> {
  const uid = deps.uid();
  if (!uid) return { pending: 0, failed: 0 };
  try {
    const col = (await db()).get<OutboxOpModel>(TABLE);
    const [pending, failed] = await Promise.all([
      col.query(Q.where('account', uid), Q.where('status', 'pending')).fetchCount(),
      col.query(Q.where('account', uid), Q.where('status', 'failed')).fetchCount(),
    ]);
    return { pending, failed };
  } catch {
    return { pending: 0, failed: 0 };
  }
}

/** Drop rows older than MAX_AGE_MS, any account. Launch housekeeping. */
export async function pruneOutbox(): Promise<void> {
  try {
    const database = await db();
    const cutoff = deps.now() - MAX_AGE_MS;
    const old = await database.get<OutboxOpModel>(TABLE).query(Q.where('created_at', Q.lt(cutoff))).fetch();
    if (!old.length) return;
    await database.write(async () => {
      await database.batch(...old.map((r) => r.prepareDestroyPermanently()));
    });
  } catch {
    /* best-effort */
  }
}
