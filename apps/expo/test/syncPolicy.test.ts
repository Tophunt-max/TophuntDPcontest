/**
 * Sync triggers (debounce, offline → online only) and the query retry policy.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@/src/services/api', () => {
  class ApiCallError extends Error {
    code: string;
    status?: number;
    constructor(code: string, message: string, status?: number) {
      super(message);
      this.code = code;
      this.status = status;
    }
  }
  return {
    ApiCallError,
    isCancelledError: (e: any) => e instanceof ApiCallError && e.code === 'functions/cancelled',
  };
});

const { startSyncTriggers, SYNC_DEBOUNCE_MS } = await import('@/src/sync/syncTriggers');
const { shouldRetryQuery, shouldReportQueryError } = await import('@/src/sync/queryPolicy');
const { classifyFailure, isNetworkFailure } = await import('@/src/sync/failure');
const { ApiCallError } = await import('@/src/services/api');

function harness() {
  let conn: (o: boolean) => void = () => undefined;
  let fg: () => void = () => undefined;
  const timers: Array<{ fn: () => void; at: number; dead?: boolean }> = [];
  let clock = 0;
  const run = vi.fn();
  const t = startSyncTriggers(run, {
    onConnectivity: (fn) => ((conn = fn), () => undefined),
    onForeground: (fn) => ((fg = fn), () => undefined),
    setTimer: (fn, ms) => {
      const e = { fn, at: clock + ms };
      timers.push(e);
      return e;
    },
    clearTimer: (e: any) => void (e.dead = true),
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const e of timers) if (!e.dead && e.at <= clock) {
      e.dead = true;
      e.fn();
    }
  };
  return { run, t, conn: (o: boolean) => conn(o), fg: () => fg(), advance };
}

describe('sync triggers', () => {
  it('runs once at launch and once per offline → online transition', () => {
    const h = harness();
    h.conn(true); // launch state
    h.advance(SYNC_DEBOUNCE_MS);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.conn(true); // Wi-Fi → cellular handover: still online
    h.conn(true);
    h.advance(SYNC_DEBOUNCE_MS);
    expect(h.run).toHaveBeenCalledTimes(1);
    h.conn(false);
    h.conn(true);
    h.advance(SYNC_DEBOUNCE_MS);
    expect(h.run).toHaveBeenCalledTimes(2);
  });

  it('collapses a burst (foreground + reconnect + account change) into one run', () => {
    const h = harness();
    h.conn(false);
    h.fg();
    h.conn(true);
    h.t.request();
    h.advance(SYNC_DEBOUNCE_MS - 1);
    expect(h.run).not.toHaveBeenCalled();
    h.advance(1);
    expect(h.run).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels a pending run', () => {
    const h = harness();
    h.fg();
    h.t.stop();
    h.advance(SYNC_DEBOUNCE_MS * 2);
    expect(h.run).not.toHaveBeenCalled();
  });
});

describe('query retry policy', () => {
  it('does not stack on the request core retries', () => {
    expect(shouldRetryQuery(0, new ApiCallError('functions/unavailable', 'x'))).toBe(false);
    expect(shouldRetryQuery(0, new ApiCallError('functions/internal', 'x', 503))).toBe(false);
  });
  it('still retries errors from outside the request core, at most twice', () => {
    expect(shouldRetryQuery(0, new TypeError('bad shape'))).toBe(true);
    expect(shouldRetryQuery(1, new TypeError('bad shape'))).toBe(true);
    expect(shouldRetryQuery(2, new TypeError('bad shape'))).toBe(false);
  });
  it('does not report cancellations', () => {
    expect(shouldReportQueryError(new ApiCallError('functions/cancelled', 'x'))).toBe(false);
    expect(shouldReportQueryError(new ApiCallError('functions/internal', 'x', 500))).toBe(true);
  });
});

describe('failure classification', () => {
  const e = (status?: number) => new ApiCallError('functions/x', 'x', status);
  it('maps statuses to what a resend should do', () => {
    expect(classifyFailure(e())).toBe('retry');
    expect(classifyFailure(e(429))).toBe('retry');
    expect(classifyFailure(e(503))).toBe('retry');
    expect(classifyFailure(e(401))).toBe('auth');
    expect(classifyFailure(e(409))).toBe('duplicate');
    for (const s of [400, 403, 404, 412]) expect(classifyFailure(e(s))).toBe('permanent');
  });
  it('only a request with no answer counts as a network failure', () => {
    expect(isNetworkFailure(e())).toBe(true);
    expect(isNetworkFailure(e(500))).toBe(false);
    expect(isNetworkFailure(new Error('x'))).toBe(false);
  });
});
