/**
 * Phase H privacy and input bounds: data export completeness, what account
 * deletion removes, the telemetry body cap and literal blog search.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/firebaseAdmin', async (orig) => ({
  ...(await orig<any>()),
  deleteAuthUser: async () => undefined,
  revokeRefreshTokens: async () => undefined,
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { exportUserData } from '../src/lib/accountExport';
import { executeAccountDeletion } from '../src/lib/accountDeletion';
import { TELEMETRY_MAX_BYTES } from '../src/routes/telemetry';

const app = makeApp();

async function user(env: TestEnv, uid: string) {
  const ts = Date.now();
  await drizzleOf(env).insert(schema.users).values({ signupCompleted: true, uid, username: uid, fullName: uid, createdAt: ts, updatedAt: ts } as any);
}
async function seedActivity(env: TestEnv) {
  await user(env, 'me');
  await user(env, 'other');
  const run = (q: string, ...b: unknown[]) => env.DB.prepare(q).bind(...b).run();
  await run('INSERT INTO user_blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, 1)', 'me', 'other');
  await run('INSERT INTO user_mutes (muter_id, muted_id, created_at) VALUES (?, ?, 1)', 'me', 'other');
  await run("INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES ('r1', 'me', 'user', 'other', 'spam', 'open', 1)");
  await run("INSERT INTO story_views (story_id, viewer_id, created_at) VALUES ('s1', 'me', 1)");
  await run("INSERT INTO profile_visits (user_id, visitor_id, created_at) VALUES ('other', 'me', 1)");
  await run("INSERT INTO feed_dismissals (viewer_uid, match_id, created_at) VALUES ('me', 'm1', 1)");
  await run(
    "INSERT INTO notifications (id, recipient_id, title, body, type, target_id, actor_id, created_at) VALUES ('n1', 'other', 'Like', 'me liked', 'like', 'x', 'me', 1)",
  );
}

describe('data export', () => {
  it('includes blocks, mutes, reports, story views, profile visits and "Not interested"', async () => {
    const { env } = makeEnv();
    await seedActivity(env);
    const dump: any = await exportUserData(env as any, 'me');
    expect(dump.safety.blocked.items.map((r: any) => r.uid)).toEqual(['other']);
    expect(dump.safety.muted.items.map((r: any) => r.uid)).toEqual(['other']);
    expect(dump.safety.reportsMade.items[0]).toMatchObject({ targetType: 'user', reason: 'spam' });
    expect(dump.activity.storiesViewed.items).toHaveLength(1);
    expect(dump.activity.profilesVisited.items).toHaveLength(1);
    expect(dump.activity.notInterested.items[0].matchId).toBe('m1');
  });
});

describe('account deletion', () => {
  it('removes notifications naming them in other inboxes, and keeps their reports as evidence', async () => {
    const { env } = makeEnv();
    await seedActivity(env);
    await drizzleOf(env).update(schema.users).set({ status: 'pending_deletion' } as any);
    await executeAccountDeletion(env as any, 'me').catch(() => {});
    const reports = await env.DB.prepare("SELECT COUNT(*) n FROM reports WHERE reporter_id = 'me'").first<any>();
    const notes = await env.DB.prepare("SELECT COUNT(*) n FROM notifications WHERE actor_id = 'me'").first<any>();
    expect(reports.n).toBe(1);
    expect(notes.n).toBe(0);
  });
});

describe('telemetry', () => {
  it('refuses an oversized body before parsing it, and still accepts a normal one', async () => {
    const { env } = makeEnv();
    const big = JSON.stringify({ event: 'shown', platform: 'ios', pad: 'x'.repeat(TELEMETRY_MAX_BYTES) });
    const r1 = await app.request('/telemetry/onboarding', { method: 'POST', body: big }, env, fakeCtx());
    expect(r1.status).toBe(400);
    const r2 = await app.request('/telemetry/onboarding', { method: 'POST', body: JSON.stringify({ event: 'shown', platform: 'ios' }) }, env, fakeCtx());
    expect(r2.status).toBe(204);
  });
});

describe('blog search', () => {
  it('treats % and _ literally', async () => {
    const { env } = makeEnv();
    const ts = Date.now();
    for (const [id, title] of [['b1', '50% off tips'], ['b2', 'Dance tips']]) {
      await drizzleOf(env).insert(schema.blogPosts).values({ id, slug: id, title, status: 'published', publishedAt: ts, createdAt: ts, updatedAt: ts } as any);
    }
    const res = await app.request('/read/blog?q=%25%25', {}, env, fakeCtx());
    const body: any = await res.json();
    const titles = (body.posts ?? body.items ?? body).map((p: any) => p.title);
    expect(titles).toEqual([]);
    const res2 = await app.request('/read/blog?q=50%25', {}, env, fakeCtx());
    const body2: any = await res2.json();
    expect((body2.posts ?? body2.items ?? body2).map((p: any) => p.title)).toEqual(['50% off tips']);
  });
});
