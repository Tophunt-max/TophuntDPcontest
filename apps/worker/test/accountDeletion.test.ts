/**
 * Account deletion, end to end.
 *
 * Every `describe` below is a defect found auditing the original implementation,
 * so these are regression tests first and documentation second. The through-line:
 * "delete my account" is the single most consequential promise the product makes.
 * A deletion flow that refuses, that hides its own button, or that leaves a name
 * and a face behind in a JSON column is not a partial feature — it is a false
 * statement, and in this domain a false statement is a compliance failure.
 *
 * The most valuable test in this file is the LAST one: it walks the drizzle schema
 * and asserts that every uid-bearing table is either purged or on an explicit
 * retention list. That is the only check here that catches a defect nobody has
 * written yet — a table added next year whose author never thought about erasure.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

// Bypass Firebase token verification: the bearer token is the uid.
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const { authDeletes } = vi.hoisted(() => ({ authDeletes: [] as string[] }));

vi.mock('../src/lib/firebaseAdmin', () => ({
  deleteAuthUser: async (_env: unknown, uid: string) => {
    authDeletes.push(uid);
  },
  updateAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  getUserByEmail: async () => null,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import {
  cancelAccountDeletion,
  checkDeletionEligibility,
  executeAccountDeletion,
  purgeScheduledDeletions,
  requestAccountDeletion,
} from '../src/lib/accountDeletion';
import {
  DEFAULT_DELETION_GRACE_DAYS,
  DELETED_STATUS,
  PENDING_DELETION_STATUS,
  parseGraceDays,
} from '../src/lib/accountStatus';

const app = makeApp();
const DAY = 24 * 60 * 60 * 1000;

async function call(env: TestEnv, uid: string, action: string, data: any = {}) {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${uid}` },
      body: JSON.stringify({ action, ...data }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

async function read(env: TestEnv, uid: string | null, path: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: uid ? { Authorization: `Bearer ${uid}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({
      uid,
      username: uid,
      fullName: uid,
      email: `${uid}@example.com`,
      status: 'active',
      dpcoin: 0,
      createdAt: ts,
      updatedAt: ts,
      ...extra,
    } as any);
}

// ---------------------------------------------------------------------------
// 1. The deletion path must always be reachable.
// ---------------------------------------------------------------------------

describe('reachability: the deletion path is never withheld', () => {
  /**
   * The bug that started this: `requireAuth` rejected every request from a
   * blocked account with a 403 before the router saw which action was being
   * called. The client's eligibility check failed, and the screen rendered a bare
   * error line and skipped its whole body — including the delete button.
   *
   * So the one flow both app stores mandate was unavailable to exactly the people
   * most likely to want it. Being blocked is a reason to leave, not a reason to be
   * trapped.
   */
  it('lets a BLOCKED account check its deletion status and request deletion', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { isBlocked: true, status: 'blocked' });

    const status = await call(env, 'alice', 'accountDeletionStatus');
    expect(status.status).toBe(200);
    expect(status.body.deletable).toBe(true);

    const req = await call(env, 'alice', 'requestAccountDeletion', { confirm: true });
    expect(req.status).toBe(200);
    expect(req.body.success).toBe(true);
  });

  it('still blocks a blocked account from everything else', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { isBlocked: true, status: 'blocked' });
    await seedUser(env, 'bob');

    const res = await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob' });
    expect(res.status).toBe(403);
  });

  /**
   * `deletable` is a legacy field. Shipped builds gate their button on it, so it
   * must never be false again — a build that reads false renders a dead end.
   */
  it('reports deletable=true even when something is in flight', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { dpcoin: 50 });
    await drizzleOf(env)
      .insert(schema.withdrawals)
      .values({
        id: 'w1',
        userId: 'alice',
        amount: 50,
        status: 'pending',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const eligibility = await checkDeletionEligibility(env as any, 'alice');
    expect(eligibility.deletable).toBe(true);
    expect(eligibility.deferrals.map((d) => d.code)).toContain('pending_payout');
    // Old clients read `blockers`; it must stay populated with the same list.
    expect(eligibility.blockers).toEqual(eligibility.deferrals);
  });

  it('refuses a request that was not explicitly confirmed', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const res = await call(env, 'alice', 'requestAccountDeletion', {});
    expect(res.status).toBe(400);
  });

  /**
   * An anonymised account is terminal. Without this check a stale but
   * still-unexpired ID token could re-enter the self-service actions and restart
   * a purge that had already completed.
   */
  it('locks out an already-deleted account entirely', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await executeAccountDeletion(env as any, 'alice');

    const res = await call(env, 'alice', 'accountDeletionStatus');
    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 2. Eligibility: the status strings must keep matching reality.
// ---------------------------------------------------------------------------

describe('eligibility deferrals', () => {
  /**
   * These two queries compare against literal status strings
   * ('pending'/'approved', 'waiting_for_opponent'/'active'). Nothing else in the
   * codebase forces those literals to stay in sync, so a rename elsewhere would
   * silently stop the deferral firing — and a user could then delete their way out
   * of a live match, abandoning an opponent who paid to enter it.
   */
  it('defers on a pending payout', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await drizzleOf(env)
      .insert(schema.withdrawals)
      .values({ id: 'w1', userId: 'alice', amount: 10, status: 'pending', createdAt: Date.now(), updatedAt: Date.now() } as any);

    const e = await checkDeletionEligibility(env as any, 'alice');
    expect(e.deferrals.map((d) => d.code)).toEqual(['pending_payout']);
  });

  it('ignores a payout that has reached a terminal state', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const db = drizzleOf(env);
    await db
      .insert(schema.withdrawals)
      .values({ id: 'w1', userId: 'alice', amount: 10, status: 'paid', createdAt: Date.now(), updatedAt: Date.now() } as any);
    await db
      .insert(schema.withdrawals)
      .values({ id: 'w2', userId: 'alice', amount: 10, status: 'rejected', createdAt: Date.now(), updatedAt: Date.now() } as any);

    const e = await checkDeletionEligibility(env as any, 'alice');
    expect(e.deferrals).toEqual([]);
  });

  /**
   * Participants live in the userA/userB JSON snapshots, so this is a
   * `json_extract` match. If the column names or the '$.uid' path ever drift, the
   * query returns zero rows and the deferral silently stops existing.
   */
  it('defers on an unfinished contest, matched through the JSON snapshot', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await drizzleOf(env)
      .insert(schema.contestMatches)
      .values({
        id: 'm1',
        status: 'active',
        userA: { uid: 'alice', username: 'alice' },
        userB: { uid: 'bob', username: 'bob' },
        createdAt: Date.now(),
      } as any);

    const e = await checkDeletionEligibility(env as any, 'alice');
    expect(e.deferrals.map((d) => d.code)).toEqual(['active_contest']);
  });

  it('does not defer on a finished contest', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await drizzleOf(env)
      .insert(schema.contestMatches)
      .values({
        id: 'm1',
        status: 'completed',
        userA: { uid: 'alice', username: 'alice' },
        createdAt: Date.now(),
      } as any);

    const e = await checkDeletionEligibility(env as any, 'alice');
    expect(e.deferrals).toEqual([]);
  });

  it('treats a positive balance as a warning, not a deferral', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { dpcoin: 250 });
    const e = await checkDeletionEligibility(env as any, 'alice');
    expect(e.deferrals).toEqual([]);
    expect(e.warnings.map((w) => w.code)).toEqual(['positive_balance']);
    expect(e.balance).toBe(250);
  });
});

// ---------------------------------------------------------------------------
// 3. The grace period, and getting back out of it.
// ---------------------------------------------------------------------------

describe('grace period configuration', () => {
  /**
   * `Number(null)` is `0`, and `0` is a VALID grace period here meaning "purge on
   * the next cron tick". So a setting that had been explicitly nulled — or set to
   * an empty string by a form that submits one — would have been read as "erase
   * immediately, no grace period, no way back". The most destructive possible
   * reading of a missing value.
   */
  it('treats null, empty and non-numeric settings as unset, not as zero', () => {
    for (const junk of [null, undefined, '', '  ', [], {}, 'soon', NaN, true]) {
      expect(parseGraceDays(junk), `${JSON.stringify(junk)} should fall back`).toBe(
        DEFAULT_DELETION_GRACE_DAYS,
      );
    }
  });

  it('honours a real number, including a deliberate zero', () => {
    expect(parseGraceDays(0)).toBe(0);
    expect(parseGraceDays(7)).toBe(7);
    expect(parseGraceDays('14')).toBe(14);
    expect(parseGraceDays(3.9)).toBe(3);
  });

  it('clamps out-of-range values instead of trusting them', () => {
    expect(parseGraceDays(-5)).toBe(0);
    expect(parseGraceDays(9999)).toBe(90);
  });

  it('purges on the next tick when the grace period is configured to zero', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await db.insert(schema.settings).values({
      id: 'appConfig',
      data: { accountDeletionGraceDays: 0 } as any,
      updatedAt: Date.now(),
    } as any);
    await seedUser(env, 'alice');

    await requestAccountDeletion(env as any, 'alice');
    const result = await purgeScheduledDeletions(env as any);

    expect(result.purged).toBe(1);
    const user = await db.select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(user?.status).toBe(DELETED_STATUS);
  });
});

describe('grace period', () => {
  it('takes the account out of service immediately without erasing anything', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { dpcoin: 40 });
    const db = drizzleOf(env);
    await db
      .insert(schema.posts)
      .values({ id: 'p1', userId: 'alice', mediaUrl: 'https://cdn/x.jpg', createdAt: Date.now() } as any);

    const result = await requestAccountDeletion(env as any, 'alice', { reason: 'too noisy' });

    const user = await db.select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(user?.status).toBe(PENDING_DELETION_STATUS);
    // Out of service, but NOT anonymised: the data is what cancellation restores.
    expect(user?.email).toBe('alice@example.com');
    expect(user?.dpcoin).toBe(40);
    expect((await db.select().from(schema.posts).all()).length).toBe(1);
    expect(result.scheduledFor).toBeGreaterThan(Date.now());
  });

  it('is idempotent — asking twice does not push the date further out', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    const first = await requestAccountDeletion(env as any, 'alice');
    const second = await requestAccountDeletion(env as any, 'alice');

    expect(second.alreadyRequested).toBe(true);
    expect(second.scheduledFor).toBe(first.scheduledFor);
  });

  it('restores the account on cancellation', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const db = drizzleOf(env);

    await requestAccountDeletion(env as any, 'alice');
    const cancelled = await cancelAccountDeletion(env as any, 'alice');

    expect(cancelled.cancelled).toBe(true);
    const user = await db.select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(user?.status).toBe('active');
    const request = await db
      .select()
      .from(schema.deletionRequests)
      .where(eq(schema.deletionRequests.uid, 'alice'))
      .get();
    expect(request?.status).toBe('cancelled');
  });

  it('lets a user change their mind twice', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');

    await requestAccountDeletion(env as any, 'alice');
    await cancelAccountDeletion(env as any, 'alice');
    const again = await requestAccountDeletion(env as any, 'alice');

    expect(again.alreadyRequested).toBe(false);
    const user = await drizzleOf(env)
      .select()
      .from(schema.users)
      .where(eq(schema.users.uid, 'alice'))
      .get();
    expect(user?.status).toBe(PENDING_DELETION_STATUS);
  });

  /**
   * An account described to its owner as deleted must not still be able to act.
   * Otherwise the grace period becomes a window in which a "deleted" account
   * posts, votes and spends — creating data the purge was never told about.
   */
  it('refuses ordinary actions while a deletion is pending, but allows cancelling', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await requestAccountDeletion(env as any, 'alice');

    const follow = await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob' });
    expect(follow.status).toBe(412);

    const cancel = await call(env, 'alice', 'cancelAccountDeletion');
    expect(cancel.status).toBe(200);

    const followAgain = await call(env, 'alice', 'toggleFollow', { targetUserId: 'bob' });
    expect(followAgain.status).toBe(200);
  });

  it('refuses to cancel once the purge has actually started', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await requestAccountDeletion(env as any, 'alice');
    await drizzleOf(env)
      .update(schema.deletionRequests)
      .set({ status: 'processing', phase: 'content' })
      .where(eq(schema.deletionRequests.uid, 'alice'));

    await expect(cancelAccountDeletion(env as any, 'alice')).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. The cron sweep.
// ---------------------------------------------------------------------------

describe('scheduled purge', () => {
  it('leaves a request alone until its date arrives', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await requestAccountDeletion(env as any, 'alice');

    const result = await purgeScheduledDeletions(env as any);
    expect(result.purged).toBe(0);

    const user = await drizzleOf(env)
      .select()
      .from(schema.users)
      .where(eq(schema.users.uid, 'alice'))
      .get();
    expect(user?.status).toBe(PENDING_DELETION_STATUS);
  });

  it('purges once the grace period has lapsed', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const db = drizzleOf(env);
    await requestAccountDeletion(env as any, 'alice');
    await db
      .update(schema.deletionRequests)
      .set({ scheduledFor: Date.now() - 1000 })
      .where(eq(schema.deletionRequests.uid, 'alice'));

    const result = await purgeScheduledDeletions(env as any);
    expect(result.purged).toBe(1);

    const user = await db.select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(user?.status).toBe(DELETED_STATUS);
    expect(user?.email).toBeNull();
  });

  /**
   * The behaviour this whole rewrite turns on. The old code REFUSED while a
   * contest was live. Now the request stands and the purge waits, so the user
   * never has to come back and guess when they are allowed to leave.
   */
  it('defers a due purge while a contest is still live, then completes it', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const db = drizzleOf(env);
    await db
      .insert(schema.contestMatches)
      .values({
        id: 'm1',
        status: 'active',
        userA: { uid: 'alice', username: 'alice' },
        createdAt: Date.now(),
      } as any);

    await requestAccountDeletion(env as any, 'alice');
    await db
      .update(schema.deletionRequests)
      .set({ scheduledFor: Date.now() - 1000 })
      .where(eq(schema.deletionRequests.uid, 'alice'));

    const deferredRun = await purgeScheduledDeletions(env as any);
    expect(deferredRun.deferred).toBe(1);
    expect(deferredRun.purged).toBe(0);

    const request = await db
      .select()
      .from(schema.deletionRequests)
      .where(eq(schema.deletionRequests.uid, 'alice'))
      .get();
    expect(request?.deferredReason).toBe('active_contest');
    expect(request?.scheduledFor).toBeGreaterThan(Date.now());

    // Contest resolves; the purge is now free to run.
    await db
      .update(schema.contestMatches)
      .set({ status: 'completed' })
      .where(eq(schema.contestMatches.id, 'm1'));
    await db
      .update(schema.deletionRequests)
      .set({ scheduledFor: Date.now() - 1000 })
      .where(eq(schema.deletionRequests.uid, 'alice'));

    const finalRun = await purgeScheduledDeletions(env as any);
    expect(finalRun.purged).toBe(1);
  });

  it('resumes a purge from the phase it stopped at', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const db = drizzleOf(env);
    await db
      .insert(schema.posts)
      .values({ id: 'p1', userId: 'alice', createdAt: Date.now() } as any);

    // Simulate a crash after the identity was anonymised but before content went.
    await executeAccountDeletion(env as any, 'alice');
    await db
      .update(schema.deletionRequests)
      .set({ status: 'pending', phase: 'content', scheduledFor: Date.now() - 1000 })
      .where(eq(schema.deletionRequests.uid, 'alice'));
    await db.insert(schema.posts).values({ id: 'p2', userId: 'alice', createdAt: Date.now() } as any);

    const result = await purgeScheduledDeletions(env as any);
    expect(result.purged).toBe(1);
    expect((await db.select().from(schema.posts).all()).length).toBe(0);
  });

  it('records the phase and error when a purge fails, instead of losing it', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const db = drizzleOf(env);
    await requestAccountDeletion(env as any, 'alice');
    await db
      .update(schema.deletionRequests)
      .set({ scheduledFor: Date.now() - 1000 })
      .where(eq(schema.deletionRequests.uid, 'alice'));

    // Break the very first phase. The chats scan always runs during `snapshots`,
    // which makes it a reliable injection point regardless of what the user owns.
    const original = env.DB.prepare;
    let broken = true;
    (env as any).DB.prepare = (sql: string) => {
      if (broken && /json_each\(chats\.users\)/i.test(sql)) throw new Error('d1 exploded');
      return original.call(env.DB, sql);
    };

    const failed = await purgeScheduledDeletions(env as any);
    expect(failed.failed).toBe(1);

    const request = await db
      .select()
      .from(schema.deletionRequests)
      .where(eq(schema.deletionRequests.uid, 'alice'))
      .get();
    expect(request?.lastError).toContain('d1 exploded');
    expect(request?.status).toBe('pending');

    // And it recovers on the next tick once the fault clears.
    broken = false;
    await db
      .update(schema.deletionRequests)
      .set({ scheduledFor: Date.now() - 1000 })
      .where(eq(schema.deletionRequests.uid, 'alice'));
    const recovered = await purgeScheduledDeletions(env as any);
    expect(recovered.purged).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Identity must not survive inside JSON snapshots.
// ---------------------------------------------------------------------------

describe('anonymisation reaches JSON snapshots, not just the users row', () => {
  /**
   * `chats.users_data` caches each member's display name and photo at the time the
   * conversation was created. Messages were deleted but the thread survives (the
   * other participant is entitled to their side of it), so the deleted user's real
   * name and avatar sat in the counterparty's inbox forever. Anonymising the
   * `users` row does not reach a JSON blob.
   */
  it('rewrites the deleted user inside chats.users_data', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.chats).values({
      id: 'c1',
      users: ['alice', 'bob'],
      usersData: [
        { uid: 'alice', displayName: 'Alice Real', photoURL: 'https://cdn/alice.jpg' },
        { uid: 'bob', displayName: 'Bob Real', photoURL: 'https://cdn/bob.jpg' },
      ],
      lastMessage: { text: 'see you tomorrow', createdAt: ts, senderId: 'alice' },
      createdAt: ts,
      updatedAt: ts,
    } as any);

    await executeAccountDeletion(env as any, 'alice');

    const chat = await db.select().from(schema.chats).where(eq(schema.chats.id, 'c1')).get();
    const members = chat?.usersData as any[];
    const alice = members.find((m) => m.uid === 'alice');
    expect(alice.displayName).toBe('Deleted user');
    expect(alice.photoURL).toBeNull();
    // Bob is untouched — his data is his.
    expect(members.find((m) => m.uid === 'bob').displayName).toBe('Bob Real');
    // And Alice's words are gone from the preview.
    expect((chat?.lastMessage as any).text).toBe('Message deleted');
  });

  it('leaves the preview alone when the last message was the other person\'s', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.chats).values({
      id: 'c1',
      users: ['alice', 'bob'],
      usersData: [{ uid: 'alice', displayName: 'Alice Real', photoURL: null }],
      lastMessage: { text: 'bob said this', createdAt: ts, senderId: 'bob' },
      createdAt: ts,
      updatedAt: ts,
    } as any);

    await executeAccountDeletion(env as any, 'alice');

    const chat = await db.select().from(schema.chats).where(eq(schema.chats.id, 'c1')).get();
    expect((chat?.lastMessage as any).text).toBe('bob said this');
  });

  /**
   * The contest match is RETAINED on purpose — other people entered it, voted in
   * it and were paid out of it. But its participant snapshot carries a username, a
   * profile picture and the entry media, and a photograph of a face does not stop
   * being personal data because it props up someone else's win record.
   */
  it('strips identity and entry media from contest_matches snapshots', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const db = drizzleOf(env);
    await db.insert(schema.contestMatches).values({
      id: 'm1',
      status: 'completed',
      userA: {
        uid: 'alice',
        username: 'alice',
        profilePic: 'https://cdn/alice.jpg',
        mediaUrl: 'https://cdn/entry.jpg',
        caption: 'my best shot',
        votes: 12,
      },
      userB: { uid: 'bob', username: 'bob', profilePic: 'https://cdn/bob.jpg', votes: 9 },
      totalVotes: 21,
      createdAt: Date.now(),
    } as any);

    await executeAccountDeletion(env as any, 'alice');

    const match = await db
      .select()
      .from(schema.contestMatches)
      .where(eq(schema.contestMatches.id, 'm1'))
      .get();
    const a = match?.userA as any;
    expect(a.username).toBe('Deleted user');
    expect(a.profilePic).toBeNull();
    expect(a.mediaUrl).toBeNull();
    expect(a.caption).toBeNull();
    // The result itself survives — that is the whole reason the row is kept.
    expect(a.votes).toBe(12);
    expect(match?.totalVotes).toBe(21);
    // Bob's side is untouched.
    expect((match?.userB as any).username).toBe('bob');
  });

  it('purges Bunny videos the user owns, including ones never attached to a post', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const db = drizzleOf(env);
    const ts = Date.now();
    await db.insert(schema.videos).values({
      id: 'guid-abandoned',
      ownerUid: 'alice',
      provider: 'bunny',
      status: 'uploading',
      createdAt: ts,
      updatedAt: ts,
    } as any);
    await db.insert(schema.videos).values({
      id: 'guid-ready',
      ownerUid: 'alice',
      provider: 'bunny',
      status: 'ready',
      playbackUrl: 'https://vz.b-cdn.net/guid-ready/playlist.m3u8',
      createdAt: ts,
      updatedAt: ts,
    } as any);

    await executeAccountDeletion(env as any, 'alice');

    expect((await db.select().from(schema.videos).all()).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Public visibility.
// ---------------------------------------------------------------------------

describe('a deleted account disappears from public surfaces', () => {
  it('drops out of search and suggestions the moment deletion is requested', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { username: 'alicecooper' });
    await seedUser(env, 'bob');

    const before = await read(env, 'bob', '/users/search?q=alice');
    expect(before.body.map((u: any) => u.id)).toContain('alice');

    await requestAccountDeletion(env as any, 'alice');

    const after = await read(env, 'bob', '/users/search?q=alice');
    expect(after.body.map((u: any) => u.id)).not.toContain('alice');

    const suggested = await read(env, 'bob', '/users/suggested');
    expect(suggested.body.map((u: any) => u.id)).not.toContain('alice');
  });

  it('reads as nonexistent to others, but stays visible to its owner', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await requestAccountDeletion(env as any, 'alice');

    const asBob = await read(env, 'bob', '/users/alice');
    expect(asBob.body).toBeNull();

    // The owner must still be able to load their own profile — that screen is the
    // only route back from a deletion they did not mean to start.
    const asSelf = await read(env, 'alice', '/users/alice');
    expect(asSelf.body?.uid).toBe('alice');
  });

  it('does not leave the real profile in the shared cache', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { bio: 'my private bio' });
    await seedUser(env, 'bob');

    // Warm the shared KV entry with the live profile.
    await read(env, 'bob', '/users/alice');
    await requestAccountDeletion(env as any, 'alice');

    // The owner's own fetch must not re-publish it for everyone else either.
    await read(env, 'alice', '/users/alice');
    const asBob = await read(env, 'bob', '/users/alice');
    expect(asBob.body).toBeNull();
  });

  it('leaves the leaderboard and follower lists', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { wins: 99 });
    await seedUser(env, 'bob');
    await drizzleOf(env)
      .insert(schema.follows)
      .values({ followerId: 'alice', followingId: 'bob', createdAt: Date.now() } as any);

    await requestAccountDeletion(env as any, 'alice');

    const board = await read(env, 'bob', '/leaderboard');
    expect(board.body.map((r: any) => r.uid)).not.toContain('alice');

    const followers = await read(env, 'bob', '/users/bob/followers');
    expect(followers.body.map((r: any) => r.id)).not.toContain('alice');
  });

  it('restores visibility when the deletion is cancelled', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { username: 'alicecooper' });
    await seedUser(env, 'bob');

    await requestAccountDeletion(env as any, 'alice');
    await cancelAccountDeletion(env as any, 'alice');

    const search = await read(env, 'bob', '/users/search?q=alice');
    expect(search.body.map((u: any) => u.id)).toContain('alice');
    const profile = await read(env, 'bob', '/users/alice');
    expect(profile.body?.uid).toBe('alice');
  });
});

// ---------------------------------------------------------------------------
// 7. Money and compliance records.
// ---------------------------------------------------------------------------

describe('ledger and compliance records', () => {
  it('records the forfeiture as a ledger row so the balance still reconciles', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { dpcoin: 120 });
    const db = drizzleOf(env);

    await executeAccountDeletion(env as any, 'alice');

    const ledger = await db
      .select()
      .from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.id, 'account_deletion:alice'))
      .get();
    expect(ledger?.amount).toBe(-120);
    expect(ledger?.type).toBe('account_deletion_forfeit');

    const user = await db.select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(user?.dpcoin).toBe(0);
  });

  it('writes the compliance record with the amount actually forfeited', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { dpcoin: 75 });

    await executeAccountDeletion(env as any, 'alice', 'leaving for good');

    const record = await drizzleOf(env)
      .select()
      .from(schema.accountDeletions)
      .where(eq(schema.accountDeletions.uid, 'alice'))
      .get();
    expect(record?.forfeitedCoins).toBe(75);
    expect(record?.reason).toBe('leaving for good');
  });

  it('does not double-record the forfeiture on a repeated purge', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { dpcoin: 60 });
    const db = drizzleOf(env);

    await executeAccountDeletion(env as any, 'alice');
    await db
      .update(schema.deletionRequests)
      .set({ status: 'pending', phase: 'snapshots' })
      .where(eq(schema.deletionRequests.uid, 'alice'));
    await executeAccountDeletion(env as any, 'alice');

    const rows = await db
      .select()
      .from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.uid, 'alice'))
      .all();
    expect(rows.filter((r) => r.type === 'account_deletion_forfeit').length).toBe(1);
  });

  it('deletes the Firebase login', async () => {
    const { env } = makeEnv();
    authDeletes.length = 0;
    await seedUser(env, 'alice');
    await executeAccountDeletion(env as any, 'alice');
    expect(authDeletes).toContain('alice');
  });
});

// ---------------------------------------------------------------------------
// 8. Data export.
// ---------------------------------------------------------------------------

describe('data export', () => {
  it('returns the user\'s own data and omits device credentials', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice', { fcmTokens: ['device-token-abc'], bio: 'hello' });
    await drizzleOf(env)
      .insert(schema.posts)
      .values({ id: 'p1', userId: 'alice', caption: 'my post', createdAt: Date.now() } as any);

    const res = await call(env, 'alice', 'exportMyData');
    expect(res.status).toBe(200);
    expect(res.body.profile.uid).toBe('alice');
    expect(res.body.profile.bio).toBe('hello');
    // A push token is a device credential, not personal data — handing it back
    // would let anyone holding the export address the account.
    expect(res.body.profile.fcmTokens).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain('device-token-abc');
    expect(res.body.posts.items.length).toBe(1);
  });

  it('stays available to an account that is pending deletion', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await requestAccountDeletion(env as any, 'alice');

    const res = await call(env, 'alice', 'exportMyData');
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 9. The test that catches defects nobody has written yet.
// ---------------------------------------------------------------------------

describe('deletion completeness across the whole schema', () => {
  /**
   * Every table keyed by a uid is either PURGED by deletion or on an explicit
   * retention list with a documented reason. Nothing is allowed to be neither.
   *
   * This is the only test here that catches a bug that does not exist yet. The
   * original implementation missed `chats`, `videos` and `blog_comments` not
   * because anyone decided to keep them, but because a deletion routine is a list
   * that has to be updated by hand every time the schema grows — and lists like
   * that are always out of date. Adding a table with a `user_id` column and
   * forgetting erasure is the single most likely way this feature regresses, and
   * it would regress silently and invisibly.
   *
   * If this fails, the fix is one of two things: purge the table in
   * lib/accountDeletion.ts, or add it below WITH the reason it is retained — and
   * then mirror that reason in the privacy policy (content/legal.ts).
   */
  const RETAINED: Record<string, string> = {
    // Financial records: retained for the period Indian tax and accounting law
    // requires, keyed by a uid that no longer resolves to a person.
    coin_transactions: 'financial record',
    payments: 'financial record',
    payment_orders: 'financial record',
    deposits: 'financial record',
    withdrawals: 'financial record',
    // Other people's contests depend on these. The participant SNAPSHOT inside
    // contest_matches is anonymised and its media destroyed (tested above).
    votes: "other users' contest integrity",
    vote_xp_awards: "other users' contest integrity",
    contest_matches: "other users' contest integrity (snapshot anonymised)",
    // The other side of the referral earned a bonus from it.
    referrals: 'counterparty bonus ledger',
    // Must not be editable by the subject of the actions it records.
    admin_audit_log: 'admin accountability',
    // The compliance record of the deletion itself. No personal data.
    account_deletions: 'deletion compliance record',
    deletion_requests: 'deletion state machine',
    // A moderation report is evidence about someone else's behaviour.
    reports: 'moderation evidence',
    // Low-sensitivity, and swept by the retention cron.
    daily_task_claims: 'pruned by retention cron',
    ad_reward_claims: 'pruned by retention cron',
    idempotency_keys: 'pruned by retention cron',
    error_logs: 'pruned by retention cron',
    // The users row itself is anonymised in place, not deleted.
    users: 'anonymised in place',
    // Threads survive for the other participant; the member snapshot is
    // anonymised and the messages are deleted (tested above).
    chats: 'counterparty conversation (snapshot anonymised)',
  };

  /** Column names that identify a person in this schema. */
  const UID_COLUMNS = [
    'uid',
    'user_id',
    'voter_uid',
    'owner_uid',
    'sender_id',
    'recipient_id',
    'viewer_id',
    'visitor_id',
    'follower_id',
    'following_id',
    'blocker_id',
    'blocked_id',
    'muter_id',
    'muted_id',
    'reporter_id',
    'referrer_uid',
    'referred_uid',
  ];

  interface ColumnInfo {
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }

  it('purges or explicitly retains every uid-bearing table', async () => {
    const { env, db: sqlite } = makeEnv();
    const db = drizzleOf(env);

    // Discover the tables from the live schema rather than a hand-written list,
    // so a table added next year is picked up without anyone remembering to.
    const tableNames = (
      sqlite
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all() as { name: string }[]
    ).map((r) => r.name);

    const columnsOf = (table: string): ColumnInfo[] =>
      sqlite.prepare(`SELECT name, type, "notnull", dflt_value FROM pragma_table_info(?)`).all(
        table,
      ) as unknown as ColumnInfo[];

    const uidTables = tableNames
      .map((name) => ({ name, cols: columnsOf(name) }))
      .filter((t) => t.cols.some((c) => UID_COLUMNS.includes(c.name)));

    // Sanity: if this finds nothing the discovery query is broken, not the schema,
    // and a green test would then be meaningless.
    expect(uidTables.length).toBeGreaterThan(15);

    await seedUser(env, 'alice', { dpcoin: 10 });

    /**
     * Fill EVERY required column, not just the uid.
     *
     * The first version of this test only supplied the uid plus id/created_at, so
     * any table with another NOT NULL column failed to insert and was quietly
     * skipped — which meant the test passed while checking almost nothing. It was
     * verified against a deliberately introduced leak (removing the `post_likes`
     * delete) and did not catch it. A completeness test that cannot fail is worse
     * than no test, because it reads as coverage.
     */
    const seeded: string[] = [];
    const skipped: string[] = [];
    for (const t of uidTables) {
      if (t.name === 'users') continue;
      const uidCol = t.cols.find((c) => UID_COLUMNS.includes(c.name))!.name;
      const values: Record<string, unknown> = {};
      for (const col of t.cols) {
        if (UID_COLUMNS.includes(col.name)) {
          values[col.name] = 'alice';
          continue;
        }
        const required = col.notnull === 1 && col.dflt_value === null;
        const useful = col.name === 'id' || col.name.endsWith('_at');
        if (!required && !useful) continue;
        const type = (col.type || 'TEXT').toUpperCase();
        if (col.name.endsWith('_at')) values[col.name] = Date.now();
        else if (type.includes('INT') || type.includes('REAL') || type.includes('NUM'))
          values[col.name] = 1;
        else values[col.name] = `seed-${t.name}-${col.name}`;
      }
      const names = Object.keys(values);
      try {
        sqlite
          .prepare(
            `INSERT OR REPLACE INTO ${t.name} (${names.map((n) => `"${n}"`).join(',')})
             VALUES (${names.map(() => '?').join(',')})`,
          )
          .run(...names.map((n) => values[n] as any));
        seeded.push(t.name);
      } catch (e) {
        skipped.push(`${t.name}: ${(e as Error).message}`);
      }
    }

    // Every uid-bearing table must be exercised. A table this cannot seed is a
    // table this cannot vouch for, and silently excusing it is how the previous
    // version of this test ended up asserting nothing.
    expect(skipped, 'Could not seed these tables, so their erasure is unverified').toEqual([]);

    await executeAccountDeletion(env as any, 'alice');

    const leaks: string[] = [];
    for (const t of uidTables) {
      if (!seeded.includes(t.name)) continue;
      if (RETAINED[t.name]) continue;
      const uidCol = t.cols.find((c) => UID_COLUMNS.includes(c.name))!.name;
      const row = sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE "${uidCol}" = 'alice'`)
        .get() as { n: number };
      if (Number(row.n) > 0) leaks.push(`${t.name}.${uidCol}`);
    }

    expect(
      leaks,
      `These tables still hold data for a deleted account. Either purge them in ` +
        `lib/accountDeletion.ts, or add them to RETAINED with the reason — and mirror ` +
        `that reason in the privacy policy (content/legal.ts).`,
    ).toEqual([]);

    // The users row is anonymised, not deleted: the ledger and other people's
    // contest results reference it.
    const user = await db.select().from(schema.users).where(eq(schema.users.uid, 'alice')).get();
    expect(user).toBeTruthy();
    expect(user?.status).toBe(DELETED_STATUS);
    expect(user?.email).toBeNull();
    expect(user?.phone).toBeNull();
    expect(user?.fullName).toBe('Deleted user');
    expect(user?.profileImageUrl).toBeNull();
    expect(user?.bio).toBeNull();
    expect(user?.isBlocked).toBe(true);
  });

  it('keeps the RETAINED list honest — no entries for tables that no longer exist', async () => {
    const { db: sqlite } = makeEnv();
    const names = new Set(
      (
        sqlite
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    const stale = Object.keys(RETAINED).filter((t) => !names.has(t));
    expect(stale, 'RETAINED names tables that no longer exist').toEqual([]);
  });
});
