import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Database } from '@nozbe/watermelondb';

import { reportError } from '@/src/lib/reportError';

/**
 * Health and recovery for the on-device database.
 *
 * Everything in this database is a CACHE or a replay-safe queue (see
 * docs/LOCAL_DATA.md): Story content, the Home snapshot, and queued Story
 * views/reactions. Nothing in it is the only copy of something the server needs,
 * so when the database cannot be opened or migrated, wiping it and starting
 * empty is always safe. Before this module, a setup failure was only logged:
 * every later read and write failed, callers fell back to the network, and the
 * cache and queue stayed dead for the life of the install with nothing
 * reporting it.
 *
 * Recovery is one `unsafeResetDatabase()` attempt, rate-limited per device so a
 * failure that a reset cannot fix (a disk that rejects writes, a native module
 * that is not linked) cannot turn into a reset on every launch.
 */

export type DatabaseStatus = 'ok' | 'recovered' | 'degraded';

export type DatabaseIssue =
  | 'setup-failed'
  | 'reset-failed'
  | 'reset-rate-limited'
  | 'quota-exceeded'
  | 'storage-closed'
  | 'overwritten-by-other-tab';

export interface DatabaseHealth {
  status: DatabaseStatus;
  issues: DatabaseIssue[];
  lastError: string | null;
}

/** When the last automatic reset ran, epoch ms. Per device, not per account. */
export const LAST_RESET_KEY = 'tophunt.localDb.lastResetAt';
/** At most one automatic reset per device per this window. */
export const RESET_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const state: DatabaseHealth = { status: 'ok', issues: [], lastError: null };

let recovery: (() => Promise<unknown>) | null = null;
let recoveryPending = false;
let recoveryStarted = false;

function addIssue(issue: DatabaseIssue, error?: unknown): void {
  if (!state.issues.includes(issue)) state.issues.push(issue);
  if (error) state.lastError = error instanceof Error ? error.message : String(error);
}

export function getDatabaseHealth(): DatabaseHealth {
  return { status: state.status, issues: [...state.issues], lastError: state.lastError };
}

/**
 * The adapter's `onSetUpError`. On native JSI this fires synchronously inside
 * the adapter constructor, i.e. before `database` exists, so recovery is only
 * scheduled here and runs once `registerRecovery` has supplied the database.
 */
export function noteSetUpError(error: unknown, platform: string): void {
  state.status = 'degraded';
  addIssue('setup-failed', error);
  reportError(error, { area: 'local-db', phase: 'setup', platform });
  recoveryPending = true;
  scheduleRecovery();
}

/** Web: the browser refused to grow IndexedDB. Loki keeps working in memory. */
export function noteQuotaExceeded(error: unknown): void {
  state.status = 'degraded';
  addIssue('quota-exceeded', error);
  reportError(error, { area: 'local-db', phase: 'quota' });
}

/**
 * Web: another connection deleted or upgraded our IndexedDB (site data cleared,
 * or another tab). The adapter closes its handle; later saves are lost until a
 * reload, but reads keep serving the in-memory copy.
 */
export function noteStorageClosed(): void {
  state.status = 'degraded';
  addIssue('storage-closed');
  reportError(new Error('IndexedDB closed by another connection'), { area: 'local-db', phase: 'versionchange' });
}

/**
 * Web: another tab of the app wrote the same database and this tab's save
 * overwrote it. Last writer wins; for a cache that is acceptable, so this is
 * recorded rather than escalated.
 */
export function noteOverwrittenByOtherTab(): void {
  addIssue('overwritten-by-other-tab');
}

/** Called once by src/database/index.ts with the real database. */
export function registerRecovery(run: () => Promise<unknown>): void {
  recovery = run;
  scheduleRecovery();
}

function scheduleRecovery(): void {
  if (!recoveryPending || !recovery || recoveryStarted) return;
  recoveryStarted = true;
  const run = recovery;
  // Next tick: never inside the adapter's own setup callback.
  setTimeout(() => {
    void run().catch(() => undefined);
  }, 0);
}

export type RecoveryOutcome = 'reset' | 'rate-limited' | 'previous-reset-crashed' | 'failed';

interface ResetStamp {
  at: number;
  /** false until the reset returned. Still false on the next launch = it crashed. */
  done: boolean;
}

async function readStamp(): Promise<ResetStamp | null> {
  const raw = await AsyncStorage.getItem(LAST_RESET_KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v.at === 'number' ? { at: v.at, done: v.done === true } : null;
  } catch {
    return null;
  }
}

/**
 * Wipe and recreate the database at the current schema.
 *
 * Two guards keep this from looping:
 * - A stamp is written BEFORE the reset with `done: false` and flipped after
 *   it returns. The native JSI reset `abort()`s the process if it fails
 *   halfway, so a stamp still at `done: false` on a later launch means the
 *   last reset killed the app, and it is never attempted again on this
 *   install. A dead cache is better than a crash on every launch.
 * - At most one reset per `RESET_COOLDOWN_MS`.
 */
export async function recoverFromSetUpError(db: Database, now: number = Date.now()): Promise<RecoveryOutcome> {
  try {
    const last = await readStamp();
    if (last && !last.done) {
      addIssue('reset-failed');
      return 'previous-reset-crashed';
    }
    if (last && now - last.at < RESET_COOLDOWN_MS) {
      addIssue('reset-rate-limited');
      return 'rate-limited';
    }
    await AsyncStorage.setItem(LAST_RESET_KEY, JSON.stringify({ at: now, done: false }));
  } catch {
    // Without the stamp neither guard can work, and a reset loop is worse than
    // a dead cache. Stay degraded.
    addIssue('reset-rate-limited');
    return 'rate-limited';
  }
  let outcome: RecoveryOutcome;
  try {
    await db.write(() => db.unsafeResetDatabase());
    state.status = 'recovered';
    reportError(new Error('Local database was reset after a setup failure'), { area: 'local-db', phase: 'reset' });
    outcome = 'reset';
  } catch (error) {
    state.status = 'degraded';
    addIssue('reset-failed', error);
    reportError(error, { area: 'local-db', phase: 'reset' });
    outcome = 'failed';
  }
  // The process survived: mark the attempt finished (whatever its result).
  await AsyncStorage.setItem(LAST_RESET_KEY, JSON.stringify({ at: now, done: true })).catch(() => undefined);
  return outcome;
}

/** Test hook. */
export function __resetDatabaseHealthForTests(): void {
  state.status = 'ok';
  state.issues = [];
  state.lastError = null;
  recovery = null;
  recoveryPending = false;
  recoveryStarted = false;
}
