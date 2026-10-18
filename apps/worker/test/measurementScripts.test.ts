/**
 * The production measurement scripts parse what wrangler actually emits.
 * (They need Cloudflare access to RUN; their parsing and maths are checked here.)
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — plain .mjs script, no types
import { queryFamily, compareReport, aggregate } from '../scripts/d1-insights-compare.mjs';
// @ts-expect-error — plain .mjs script, no types
import { recordsFromLine, routeOf, summarise } from '../scripts/cache-hit-report.mjs';

describe('d1-insights-compare', () => {
  it('groups the same statement with different values into one family', () => {
    const a = queryFamily(`select * from "contest_matches" where "status" = 'active' and "created_at" < 1700000000000 limit 30`);
    const b = queryFamily(`select * from "contest_matches" where "status" = ? and "created_at" < ? limit ?`);
    expect(a).toBe(b);
    expect(queryFamily('select 1 from x where id in (?, ?, ?)')).toBe(queryFamily('select 1 from x where id in (?)'));
  });

  it('reports rows read per run for the watched families', () => {
    const before = [
      { query: 'select "id" from "contest_matches" where "contest_matches"."status" = ? order by "contest_matches"."created_at" desc limit ?', numberOfTimesRun: 100, totalRowsRead: 2_000_000, totalRowsWritten: 0 },
      { query: 'DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE created_at < ? LIMIT 500)', numberOfTimesRun: 24, totalRowsRead: 4_800_000, totalRowsWritten: 0 },
    ];
    const after = [
      { query: before[0].query, numberOfTimesRun: 120, totalRowsRead: 3_600, totalRowsWritten: 0 },
      { query: before[1].query, numberOfTimesRun: 24, totalRowsRead: 24, totalRowsWritten: 0 },
    ];
    const lines = compareReport(before, after).join('\n');
    expect(lines).toMatch(/\/read\/matches recent page\s+20,000\s+30/);
    expect(lines).toMatch(/notifications hard prune\s+200,000\s+1/);
    expect(aggregate(before).size).toBe(2);
  });
});

describe('cache-hit-report', () => {
  it('reads the request line out of a wrangler tail event and a raw line', () => {
    const req = { level: 'info', path: '/read/matches', status: 200, ms: 12, edgeCache: 'hit' };
    const tail = JSON.stringify({ outcome: 'ok', logs: [{ level: 'log', message: [JSON.stringify(req)] }] });
    expect(recordsFromLine(tail)).toEqual([req]);
    expect(recordsFromLine(JSON.stringify(req))).toEqual([req]);
    expect(recordsFromLine('not json')).toEqual([]);
  });

  it('groups ids out of routes', () => {
    expect(routeOf('/read/matches/Xy12abcd34?x=1')).toBe('/read/matches/:id');
    expect(routeOf('/read/matches')).toBe('/read/matches');
    expect(routeOf('/read/blog/how-to-win')).toBe('/read/blog/how-to-win');
  });

  it('computes hit ratio over hit+kv+miss and latency percentiles', () => {
    const rows = summarise([
      { path: '/read/contests', status: 200, ms: 5, edgeCache: 'hit' },
      { path: '/read/contests', status: 200, ms: 7, edgeCache: 'hit' },
      { path: '/read/contests', status: 200, ms: 40, edgeCache: 'miss' },
      { path: '/read/contests', status: 200, ms: 9, edgeCache: 'skip' },
      { path: '/read/notifications', status: 500, ms: 30 },
    ]);
    const contests = rows.find((r: any) => r.route === '/read/contests');
    expect(contests.hitRatio).toBeCloseTo(2 / 3);
    expect(contests.skip).toBe(1);
    const notif = rows.find((r: any) => r.route === '/read/notifications');
    expect(notif.hitRatio).toBeNull();
    expect(notif.errorRate).toBe(1);
  });
});
