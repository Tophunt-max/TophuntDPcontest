/**
 * The guards around the automatic database reset (src/database/health.ts).
 * The reset itself runs against real databases in test/localDbSqlite.test.ts;
 * these pin the decisions about WHETHER to run it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ kv: new Map<string, string>(), reported: [] as any[] }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => h.kv.get(k) ?? null,
    setItem: async (k: string, v: string) => void h.kv.set(k, v),
    removeItem: async (k: string) => void h.kv.delete(k),
  },
}));
vi.mock('@/src/lib/reportError', () => ({ reportError: (e: unknown, x?: unknown) => void h.reported.push([e, x]) }));

const health = await import('@/src/database/health');

function fakeDb(reset: () => Promise<void> = async () => undefined) {
  const calls = { resets: 0 };
  const db: any = {
    write: (fn: () => Promise<unknown>) => fn(),
    unsafeResetDatabase: async () => {
      calls.resets++;
      await reset();
    },
  };
  return { db, calls };
}

const HOUR = 3_600_000;

beforeEach(() => {
  h.kv.clear();
  h.reported.length = 0;
  health.__resetDatabaseHealthForTests();
});

describe('automatic database reset', () => {
  it('resets once and marks the attempt finished', async () => {
    const { db, calls } = fakeDb();
    expect(await health.recoverFromSetUpError(db, 10 * HOUR)).toBe('reset');
    expect(calls.resets).toBe(1);
    expect(JSON.parse(h.kv.get(health.LAST_RESET_KEY)!)).toEqual({ at: 10 * HOUR, done: true });
    expect(health.getDatabaseHealth().status).toBe('recovered');
  });

  it('does not reset again within 24 hours', async () => {
    const { db, calls } = fakeDb();
    await health.recoverFromSetUpError(db, 10 * HOUR);
    expect(await health.recoverFromSetUpError(db, 20 * HOUR)).toBe('rate-limited');
    expect(calls.resets).toBe(1);
    expect(await health.recoverFromSetUpError(db, 35 * HOUR)).toBe('reset');
    expect(calls.resets).toBe(2);
  });

  it('never retries after a reset that did not finish (the process died mid-reset)', async () => {
    h.kv.set(health.LAST_RESET_KEY, JSON.stringify({ at: 1, done: false }));
    const { db, calls } = fakeDb();
    expect(await health.recoverFromSetUpError(db, 1_000 * HOUR)).toBe('previous-reset-crashed');
    expect(calls.resets).toBe(0);
    expect(health.getDatabaseHealth().issues).toContain('reset-failed');
  });

  it('writes the unfinished stamp BEFORE resetting', async () => {
    let seenDuringReset: string | undefined;
    const { db } = fakeDb(async () => {
      seenDuringReset = h.kv.get(health.LAST_RESET_KEY);
    });
    await health.recoverFromSetUpError(db, 7);
    expect(JSON.parse(seenDuringReset!)).toEqual({ at: 7, done: false });
  });

  it('a failed reset is reported, leaves the app degraded, and is stamped finished', async () => {
    const { db } = fakeDb(async () => {
      throw new Error('disk I/O error');
    });
    expect(await health.recoverFromSetUpError(db, 5)).toBe('failed');
    expect(health.getDatabaseHealth()).toMatchObject({ status: 'degraded', lastError: 'disk I/O error' });
    expect(JSON.parse(h.kv.get(health.LAST_RESET_KEY)!).done).toBe(true);
    expect(h.reported.some(([, x]) => x?.phase === 'reset')).toBe(true);
  });

  it('a setup error before the database exists still triggers recovery once it registers', async () => {
    const run = vi.fn(async () => undefined);
    health.noteSetUpError(new Error('boom'), 'ios'); // JSI: fires inside the adapter constructor
    health.registerRecovery(run);
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(1);
    health.noteSetUpError(new Error('again'), 'ios');
    await new Promise((r) => setTimeout(r, 0));
    expect(run).toHaveBeenCalledTimes(1); // one attempt per launch
  });

  it('no setup error means no recovery', async () => {
    const run = vi.fn(async () => undefined);
    health.registerRecovery(run);
    await new Promise((r) => setTimeout(r, 0));
    expect(run).not.toHaveBeenCalled();
    expect(health.getDatabaseHealth()).toEqual({ status: 'ok', issues: [], lastError: null });
  });
});
