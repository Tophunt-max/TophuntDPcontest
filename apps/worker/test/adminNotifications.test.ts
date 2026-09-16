import { describe, it, expect, vi } from 'vitest';
import { eq } from 'drizzle-orm';

// captureError / logErrorToDb reach observability; stub Sentry-less no-ops are fine,
// but the cron path also calls them — keep them cheap and non-throwing.
vi.mock('../src/lib/observability', () => ({
  captureError: async () => undefined,
  logErrorToDb: async () => undefined,
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { runCronJob, pruneOpsTables } from '../src/lib/ops';
import { newId } from '../src/lib/ids';

const app = makeApp();

async function adminReq(env: TestEnv, method: string, path: string) {
  const res = await app.request(
    `/admin${path}`,
    { method, headers: { 'X-Admin-Secret': 'test-admin-secret' } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const allNotifs = (env: TestEnv) => drizzleOf(env).select().from(schema.adminNotifications).all();

async function seedNotif(env: TestEnv, over: Partial<typeof schema.adminNotifications.$inferInsert> = {}) {
  await drizzleOf(env)
    .insert(schema.adminNotifications)
    .values({ id: newId(), title: 't', message: 'm', scope: 'finance', createdAt: Date.now(), ...over } as any);
}

describe('admin notifications — dedup, prune, clear', () => {
  it('a job that keeps failing raises ONE alert per window, not one per tick', async () => {
    const { env } = makeEnv();
    const failing = async () => { throw new Error('D1_ERROR: over the daily limit'); };

    await runCronJob(env, 'resolveContests', failing);
    await runCronJob(env, 'resolveContests', failing);
    await runCronJob(env, 'resolveContests', failing);

    const notifs = (await allNotifs(env)).filter((n) => n.title === 'Cron failed: resolveContests');
    expect(notifs.length).toBe(1); // deduped by alertOnce, not 3
  });

  it('different failing jobs still each get their own alert', async () => {
    const { env } = makeEnv();
    const failing = async () => { throw new Error('boom'); };
    await runCronJob(env, 'resolveContests', failing);
    await runCronJob(env, 'reconcilePayments', failing);
    const titles = (await allNotifs(env)).map((n) => n.title).sort();
    expect(titles).toEqual(['Cron failed: reconcilePayments', 'Cron failed: resolveContests']);
  });

  it('pruneOpsTables deletes old + old-read admin notifications, keeps recent', async () => {
    const { env } = makeEnv();
    const DAY = 24 * 60 * 60 * 1000;
    await seedNotif(env, { id: 'old-unread', createdAt: Date.now() - 40 * DAY }); // > 30d -> gone
    await seedNotif(env, { id: 'old-read', isRead: true, createdAt: Date.now() - 10 * DAY }); // read > 7d -> gone
    await seedNotif(env, { id: 'recent-read', isRead: true, createdAt: Date.now() - 2 * DAY }); // read < 7d -> stays
    await seedNotif(env, { id: 'recent', createdAt: Date.now() - 1 * DAY }); // stays

    const res = await pruneOpsTables(env);
    expect(res.adminNotifications).toBe(2);

    const remaining = (await allNotifs(env)).map((n) => n.id).sort();
    expect(remaining).toEqual(['recent', 'recent-read']);
  });

  it('DELETE /admin/notifications clears all in the caller\'s scope', async () => {
    const { env } = makeEnv();
    await seedNotif(env, { scope: 'finance' });
    await seedNotif(env, { scope: 'finance', isRead: true });
    await seedNotif(env, { scope: 'moderation' });

    const res = await adminReq(env, 'DELETE', '/notifications');
    expect(res.status).toBe(200);
    expect((await allNotifs(env)).length).toBe(0); // superadmin scope covers finance + moderation
  });

  it('mark-all-read then list shows them read (badge would clear)', async () => {
    const { env } = makeEnv();
    await seedNotif(env, { scope: 'finance' });
    await seedNotif(env, { scope: 'finance' });

    await adminReq(env, 'POST', '/notifications/read');
    const list = await adminReq(env, 'GET', '/notifications');
    expect(list.body.every((n: any) => n.isRead === true)).toBe(true);
  });
});
