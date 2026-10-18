/**
 * Query-plan regression guards for the hot and growing read paths.
 *
 * Runs EXPLAIN QUERY PLAN against the fully-migrated schema (makeEnv applies every
 * migrations/*.sql), so a dropped index, a renamed column or a query rewrite that
 * stops matching its index fails here instead of showing up later as a D1 rows_read
 * spike. Node's bundled SQLite is not byte-identical to D1's, but both use the same
 * planner for these shapes, so it is a reliable guard for the cases below. The
 * statements mirror the SQL drizzle emits from routes/read.ts, lib/notify.ts and
 * cron.ts.
 *
 * "USE TEMP B-TREE FOR ORDER BY" means every row matching the WHERE was read and
 * sorted to return one page. "SCAN <table>" without an index means the whole table
 * was read.
 */
import { describe, it, expect } from 'vitest';
import { makeEnv } from './helpers/harness';

function plan(sql: string, ...params: unknown[]): string[] {
  const { db } = makeEnv();
  return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...(params as any[])) as any[]).map((r) => String(r.detail));
}

function expectIndexedNoSort(details: string[], index: string) {
  const joined = details.join(' | ');
  expect(joined, joined).toContain(`INDEX ${index}`);
  expect(joined, joined).not.toContain('TEMP B-TREE');
}

describe('hot read paths use an index for both filter and order', () => {
  it('/read/matches keyset page (sort=recent), first page', () => {
    expectIndexedNoSort(
      plan('SELECT * FROM contest_matches WHERE status = ? ORDER BY created_at DESC LIMIT 30', 'active'),
      'idx_matches_status_created',
    );
  });

  it('/read/matches keyset page (sort=recent), with cursor', () => {
    expectIndexedNoSort(
      plan(
        'SELECT * FROM contest_matches WHERE status = ? AND created_at < ? ORDER BY created_at DESC LIMIT 30',
        'completed',
        Date.now(),
      ),
      'idx_matches_status_created',
    );
  });

  it('feed pool: recently completed battles by expiry', () => {
    expectIndexedNoSort(
      plan(
        "SELECT * FROM contest_matches WHERE status = 'completed' AND expires_at > ? ORDER BY expires_at DESC LIMIT 40",
        Date.now(),
      ),
      'idx_matches_status_expires',
    );
  });

  it('match comment thread page', () => {
    expectIndexedNoSort(
      plan(
        'SELECT * FROM match_comments WHERE match_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 21',
        'm1',
        1,
        1,
        'x',
      ),
      'idx_match_comments_match_created',
    );
  });

  it('post comment thread page', () => {
    expectIndexedNoSort(
      plan('SELECT * FROM post_comments WHERE post_id = ? ORDER BY created_at DESC, id DESC LIMIT 21', 'p1'),
      'idx_post_comments_post_created',
    );
  });

  it('notifications list (per recipient, newest first)', () => {
    expectIndexedNoSort(
      plan(
        'SELECT id FROM notifications WHERE recipient_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT 51',
        'u1',
        Date.now(),
      ),
      'idx_notif_recipient',
    );
  });

  it('notification badge count is index-only', () => {
    const joined = plan('SELECT count(*) FROM notifications WHERE recipient_id = ? AND seen = 0', 'u1').join(' | ');
    expect(joined).toContain('COVERING INDEX idx_notif_unseen');
  });

  it('feed affinity reads seek by voter / visitor', () => {
    expect(plan('SELECT match_id FROM votes WHERE voter_uid = ? LIMIT 500', 'u1').join(' | ')).toContain(
      'INDEX idx_votes_voter_created',
    );
    expect(plan('SELECT user_id FROM profile_visits WHERE visitor_id = ? LIMIT 500', 'u1').join(' | ')).toContain(
      'INDEX idx_profile_visits_visitor',
    );
  });
});

describe('retention sweeps are index ranges, not table scans', () => {
  const noFullScan = (details: string[], table: string) => {
    for (const d of details) {
      // "SCAN t USING INDEX x" is an ordered index walk and fine; a bare SCAN is not.
      if (d.startsWith(`SCAN ${table}`)) expect(d, d).toContain('INDEX');
    }
  };

  it('notifications hard-retention prune (no read predicate)', () => {
    const details = plan(
      'DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE created_at < ? LIMIT 500)',
      Date.now(),
    );
    noFullScan(details, 'notifications');
    expect(details.join(' | ')).toContain('idx_notifications_created');
  });

  it('notifications read-retention prune', () => {
    const details = plan(
      'DELETE FROM notifications WHERE id IN (SELECT id FROM notifications WHERE read = 1 AND created_at < ? LIMIT 500)',
      Date.now(),
    );
    noFullScan(details, 'notifications');
  });

  it('cron_runs, error_logs and expired-story sweeps', () => {
    noFullScan(plan('DELETE FROM cron_runs WHERE created_at < ?', Date.now()), 'cron_runs');
    noFullScan(plan('DELETE FROM error_logs WHERE created_at < ?', Date.now()), 'error_logs');
    noFullScan(plan('DELETE FROM stories WHERE expires_at <= ?', Date.now()), 'stories');
  });
});
