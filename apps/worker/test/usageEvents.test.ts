/**
 * Anonymous usage counters (lib/usageEvents.ts, POST /telemetry/events,
 * GET /admin/usage-events): closed vocabulary, no identifiers, bounded input,
 * no-op without the binding, and full-admin-only reads.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { memoReset } from '../src/lib/memo';
import { parseUsageBatch, usageSummarySql, USAGE_MAX_BYTES, USAGE_MAX_EVENTS } from '../src/lib/usageEvents';

const app = makeApp();
beforeEach(() => memoReset());
afterEach(() => vi.unstubAllGlobals());

function withAnalytics(env: TestEnv, limiterOk = true) {
  const points: any[] = [];
  (env as any).ANALYTICS = { writeDataPoint: (p: any) => points.push(p) };
  (env as any).USAGE_LIMITER = { limit: async () => ({ success: limiterOk }) };
  return points;
}
const post = (env: TestEnv, body: unknown) =>
  app.request('/telemetry/events', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }, env, fakeCtx());

describe('parseUsageBatch', () => {
  it('keeps only known event/dimension pairs and merges duplicates', () => {
    const b = parseUsageBatch({
      platform: 'android',
      v: '1.4.2',
      events: [
        { n: 'story', d: 'complete', c: 3 },
        { n: 'story', d: 'complete', c: 2 },
        { n: 'video', d: 'first_frame', c: 2, ms: 900 },
        { n: 'story', d: 'uid:abc' },
        { n: 'login', d: 'x' },
        null,
      ],
    });
    expect(b).toEqual({
      platform: 'android',
      version: '1.4.2',
      points: [
        { name: 'story', dim: 'complete', count: 5, ms: 0 },
        { name: 'video', dim: 'first_frame', count: 2, ms: 900 },
      ],
    });
  });
  it('clamps counts and durations, and does not trust free-text platform or version', () => {
    const b = parseUsageBatch({ platform: 'my-phone-uid', v: 'user@example.com', events: [{ n: 'upload', d: 'ok', c: 1e9, ms: 1e12 }] });
    expect(b.platform).toBe('other');
    expect(b.version).toBe('unknown');
    expect(b.points[0].count).toBe(1000);
    expect(b.points[0].ms).toBe(1000 * 600_000);
  });
  it('reads at most USAGE_MAX_EVENTS entries', () => {
    const events = Array.from({ length: USAGE_MAX_EVENTS + 10 }, (_, i) => ({ n: 'feed_impression', d: 'home', c: 1, i }));
    expect(parseUsageBatch({ events }).points[0].count).toBe(USAGE_MAX_EVENTS);
  });
});

describe('POST /telemetry/events', () => {
  it('writes one data point per counter, with no identifiers', async () => {
    const { env } = makeEnv();
    const points = withAnalytics(env);
    const r = await post(env, { platform: 'ios', v: '2.0.0', events: [{ n: 'search', d: 'empty', c: 4 }, { n: 'sync', d: 'sent', c: 7 }] });
    expect(r.status).toBe(204);
    expect(points).toEqual([
      { indexes: ['search'], blobs: ['search', 'empty', 'ios', '2.0.0'], doubles: [4, 0] },
      { indexes: ['sync'], blobs: ['sync', 'sent', 'ios', '2.0.0'], doubles: [7, 0] },
    ]);
  });
  it('refuses an oversized or non-JSON body, and drops silently when over the IP budget', async () => {
    const { env } = makeEnv();
    const points = withAnalytics(env, false);
    expect((await post(env, 'x'.repeat(USAGE_MAX_BYTES + 1))).status).toBe(400);
    expect((await post(env, 'not json')).status).toBe(400);
    expect((await post(env, { events: [{ n: 'story', d: 'skip' }] })).status).toBe(204);
    expect(points).toHaveLength(0);
  });
  it('accepts and discards when the ANALYTICS binding is absent', async () => {
    const { env } = makeEnv();
    expect((await post(env, { events: [{ n: 'story', d: 'skip' }] })).status).toBe(204);
  });
});

describe('GET /admin/usage-events', () => {
  it('validates what goes into the SQL', () => {
    expect(usageSummarySql('tophunt_events', 999)).toContain("INTERVAL '90' DAY");
    expect(() => usageSummarySql('x; DROP', 7)).toThrow();
  });
  it('is full-admin only, says when it is not configured, and averages durations', async () => {
    const { env } = makeEnv();
    const ts = Date.now();
    await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid: 'mod', username: 'mod', fullName: 'mod', role: 'moderator', createdAt: ts, updatedAt: ts } as any);
    const call = (headers: Record<string, string>) => app.request('/admin/usage-events?days=7', { headers }, env, fakeCtx());
    expect((await call({ Authorization: 'Bearer mod:moderator' })).status).toBe(403);

    const off: any = await (await call({ 'X-Admin-Secret': 'test-admin-secret' })).json();
    expect(off).toEqual({ configured: false, days: 7, rows: [] });

    (env as any).CF_ANALYTICS_TOKEN = 'tok';
    (env as any).CF_ACCOUNT_ID = 'acct';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ name: 'video', dim: 'first_frame', platform: 'ios', count: '4', ms: '2000' }] })));
    vi.stubGlobal('fetch', fetchMock);
    const on: any = await (await call({ 'X-Admin-Secret': 'test-admin-secret' })).json();
    expect(on.rows).toEqual([{ name: 'video', dim: 'first_frame', platform: 'ios', count: 4, avgMs: 500 }]);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/acct/analytics_engine/sql');
    expect(String(init.body)).toContain('FROM tophunt_events');
    // Memoised: a second look within 5 minutes is not another read query.
    await call({ 'X-Admin-Secret': 'test-admin-secret' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
