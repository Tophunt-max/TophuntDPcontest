/**
 * `/@handle` — the public profile url that replaced `/profile?userId=<firebase-uid>`.
 *
 * ---------------------------------------------------------------------------
 * What is actually being protected here
 * ---------------------------------------------------------------------------
 * Two separate things, and they pull in opposite directions.
 *
 * 1. A HANDLE IS MUTABLE, A UID IS NOT. Putting a mutable name in the canonical url
 *    means links rot the moment someone renames. `resolveUsername` answers that with
 *    a history fallback, so an old link still finds the person — but the fallback is
 *    only ever a FALLBACK. If a history row could outrank a live owner, this table
 *    would be a way to hijack a name that has since been legitimately re-registered.
 *    The "current owner beats history" test is the one pinning that ordering.
 *
 * 2. A RELEASED HANDLE INHERITS ITS OLD TRAFFIC. Links to it are already in chats,
 *    bios, QR codes and screenshots. Whoever claims it next receives all of that,
 *    through a link that still works and still looks right — which is worse than a
 *    dead link, and in an app that moves entry fees and payouts it has a direct
 *    financial path. Hence the 30-day hold, and hence the tests that a DIFFERENT
 *    account is refused while the ORIGINAL owner can always take their name back.
 *
 * ---------------------------------------------------------------------------
 * The one that would be easiest to lose
 * ---------------------------------------------------------------------------
 * `/read/users/by-username/:username` is a SECOND ENTRY POINT into the same profile
 * data that `/read/users/:id` serves. The whole point of routing it through
 * `serveUserProfile` is that the privacy projection (see userProfilePrivacy.test.ts)
 * applies to both. A future refactor that inlines a query here would reintroduce the
 * exact leak that file documents, and every other test in this file would still pass.
 * That is what the "public projection" describe block is for.
 *
 * The vote counter lives in a Durable Object that cannot start in this harness, so it
 * is mocked like the other /api tests; none of these paths touch it.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => ({ uid: token, role: 'user' }),
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 0, votesB: 0, total: 0, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));
vi.mock('../src/lib/firebaseAdmin', () => ({
  // Session revocation calls this; without it the mock throws on property access.
  revokeRefreshTokens: async () => undefined,
  deleteAuthUser: async () => undefined,
  updateAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  getUserByEmail: async () => null,
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, installEdgeCache, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { USERNAME_HOLD_MS, resolveUsername } from '../src/lib/userIdentifiers';
import { executeAccountDeletion } from '../src/lib/accountDeletion';

const app = makeApp();

async function seedUser(env: TestEnv, uid: string, username: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({
      uid,
      username,
      fullName: uid,
      status: 'active',
      dpcoin: 0,
      createdAt: ts,
      updatedAt: ts,
      ...extra,
    } as any);
}

/** Put a row in the history table directly, `ageMs` ago. */
async function seedRelease(env: TestEnv, username: string, uid: string, ageMs = 0) {
  await drizzleOf(env)
    .insert(schema.usernameHistory)
    .values({ usernameLower: username.toLowerCase(), uid, releasedAt: Date.now() - ageMs })
    .onConflictDoUpdate({
      target: schema.usernameHistory.usernameLower,
      set: { uid, releasedAt: Date.now() - ageMs },
    })
    .run();
}

const byHandle = async (env: TestEnv, handle: string, viewer: string | null = null) => {
  const res = await app.request(
    `/read/users/by-username/${encodeURIComponent(handle)}`,
    { headers: viewer ? { Authorization: `Bearer ${viewer}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
};

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

const historyRows = async (env: TestEnv) =>
  await drizzleOf(env).select().from(schema.usernameHistory).all();

const usernameOf = async (env: TestEnv, uid: string) =>
  (await drizzleOf(env).select({ u: schema.users.username }).from(schema.users).where(eq(schema.users.uid, uid)).get())?.u;

/** `blocker` blocks `blocked`. */
async function block(env: TestEnv, blocker: string, blocked: string) {
  await drizzleOf(env)
    .insert(schema.userBlocks)
    .values({ blockerId: blocker, blockedId: blocked, createdAt: Date.now() } as any)
    .run();
}

// ---------------------------------------------------------------------------

describe('resolving a live handle', () => {
  it('serves the profile of whoever holds the handle', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'Alice', { bio: 'hello' });
    const { status, body } = await byHandle(env, 'Alice');
    expect(status).toBe(200);
    expect(body.uid).toBe('uid-alice');
    expect(body.bio).toBe('hello');
  });

  it('matches case-insensitively, so /@ALICE and /@alice are one profile', async () => {
    // The url is lowercased before it is shared, but a hand-typed or auto-capitalised
    // link must not 404. The unique index is COLLATE NOCASE, so the lookup has to be
    // too or the two disagree about whether a handle exists.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'Alice');
    for (const variant of ['alice', 'ALICE', 'aLiCe']) {
      const { status, body } = await byHandle(env, variant);
      expect(status, variant).toBe(200);
      expect(body.uid, variant).toBe('uid-alice');
    }
  });

  it('tolerates a leading @, so `/@alice` can be forwarded verbatim', async () => {
    // The web Worker strips the '@' itself, but the app and any future caller should
    // not have to know that. Accepting both shapes means one fewer contract to break.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice');
    expect((await byHandle(env, '@alice')).body.uid).toBe('uid-alice');
    expect((await byHandle(env, '@@alice')).body.uid).toBe('uid-alice');
  });

  it('answers null for an unknown handle — the same shape as an unknown uid', async () => {
    // Deliberately not a 404. `/read/users/:id` answers `null` for a missing user, and
    // one not-found shape across both entry points is one branch in every caller.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice');
    const { status, body } = await byHandle(env, 'nobody');
    expect(status).toBe(200);
    expect(body).toBeNull();
  });

  it('answers null for an empty handle rather than falling through to a uid lookup', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice');
    expect((await byHandle(env, '@')).body).toBeNull();
  });

  it('is not shadowed by the /users/:id route', async () => {
    // `/read/users/by-username/alice` must not be read as a uid literally called
    // "by-username". Registration order is the only thing making that true.
    const { env } = makeEnv();
    await seedUser(env, 'by-username', 'trap');
    await seedUser(env, 'uid-alice', 'alice');
    expect((await byHandle(env, 'alice')).body.uid).toBe('uid-alice');
  });
});

describe('a handle that has moved', () => {
  it('points an old link at the account`s current handle', async () => {
    // The property Instagram's scheme does not have: they 404 a released handle. Here
    // the link still lands on the right person, one redirect later.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice');
    const { status, body, headers } = await byHandle(env, 'alice_old');
    expect(status).toBe(200);
    expect(body).toEqual({ movedTo: 'alice_new' });
    // A pointer that changes the moment the account renames again — never cacheable.
    expect(headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('keeps redirecting after the hold window has expired', async () => {
    // The hold governs who may CLAIM the name. It does not govern how long old links
    // keep working — as long as nobody else holds it, the redirect is still correct.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice', USERNAME_HOLD_MS * 2);
    expect((await byHandle(env, 'alice_old')).body).toEqual({ movedTo: 'alice_new' });
  });

  it('CURRENT OWNER WINS over a history row for the same handle', async () => {
    // The load-bearing test in this file. `alice_old` is in history under uid-alice AND
    // held live by uid-bob. If history could outrank the live row, publishing a history
    // entry would be a way to steal a legitimately re-registered name.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedUser(env, 'uid-bob', 'alice_old');
    await seedRelease(env, 'alice_old', 'uid-alice');

    const { body } = await byHandle(env, 'alice_old');
    expect(body.movedTo).toBeUndefined();
    expect(body.uid).toBe('uid-bob');
  });

  it('answers null when the releasing account no longer has a handle to point at', async () => {
    // A history row that outlived its usefulness. Redirecting to nothing, or to the
    // uid, would put the internal identifier back in the url this work removed it from.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', null as any);
    await seedRelease(env, 'alice_old', 'uid-alice');
    expect((await byHandle(env, 'alice_old')).body).toBeNull();
  });

  it('answers null when the releasing account is gone entirely', async () => {
    const { env } = makeEnv();
    await seedRelease(env, 'ghost', 'uid-vanished');
    expect((await byHandle(env, 'ghost')).body).toBeNull();
  });
});

describe('the 30-day hold on a released handle', () => {
  it('refuses a DIFFERENT account the handle inside the window', async () => {
    // The takeover this exists to stop: watch for a rename, claim the freed handle,
    // and every link already in circulation now opens your profile.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedUser(env, 'uid-bob', 'bob');
    await seedRelease(env, 'alice_old', 'uid-alice', 1000);

    const r = await call(env, 'uid-bob', 'updateProfile', { fullName: 'Bob', username: 'alice_old' });
    expect(r.status).toBe(409);
    // Says nothing about who held it or when it frees up: a message that did would
    // turn this into a monitor for handles about to become available.
    expect(JSON.stringify(r.body)).not.toContain('alice');
    expect(
      (await drizzleOf(env).select({ u: schema.users.username }).from(schema.users).where(eq(schema.users.uid, 'uid-bob')).get())?.u,
    ).toBe('bob');
  });

  it('lets the ORIGINAL owner take their own handle back', async () => {
    // The most common reason to want a just-released handle is that the rename was a
    // mistake. `assertUsernameNotOnHold` compares uids for exactly this.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice', 1000);

    const r = await call(env, 'uid-alice', 'updateProfile', { fullName: 'Alice', username: 'alice_old' });
    expect(r.status).toBe(200);
    expect(
      (await drizzleOf(env).select({ u: schema.users.username }).from(schema.users).where(eq(schema.users.uid, 'uid-alice')).get())?.u,
    ).toBe('alice_old');
  });

  it('releases the handle to anyone once the window has passed', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedUser(env, 'uid-bob', 'bob');
    await seedRelease(env, 'alice_old', 'uid-alice', USERNAME_HOLD_MS + 1000);

    const r = await call(env, 'uid-bob', 'updateProfile', { fullName: 'Bob', username: 'alice_old' });
    expect(r.status).toBe(200);
  });

  it('applies case-insensitively — releasing `Alice_Old` holds `alice_old`', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedUser(env, 'uid-bob', 'bob');
    await seedRelease(env, 'Alice_Old', 'uid-alice', 1000);

    expect((await call(env, 'uid-bob', 'updateProfile', { fullName: 'Bob', username: 'ALICE_OLD' })).status).toBe(409);
  });

  it('gates SIGNUP too, not just the rename path', async () => {
    // The hold lives INSIDE `assertIdentifiersAvailable`, which signup already calls,
    // rather than as a separate guard a new write path could forget to invoke. If it
    // ever moves out, this fails.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice', 1000);

    const res = await app.request(
      '/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer uid-newcomer' },
        body: JSON.stringify({ action: 'createProfile', username: 'alice_old', fullName: 'Newcomer' }),
      },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(409);
  });
});

describe('recording a release', () => {
  it('writes a history row when a user renames', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_old');
    expect(await call(env, 'uid-alice', 'updateProfile', { fullName: 'Alice', username: 'alice_new' })).toMatchObject({ status: 200 });

    const rows = await historyRows(env);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ usernameLower: 'alice_old', uid: 'uid-alice' });
    // And the old url immediately resolves forward.
    expect((await byHandle(env, 'alice_old')).body).toEqual({ movedTo: 'alice_new' });
  });

  it('does NOT record a release for a case-only change (alice -> Alice)', async () => {
    // Same handle, different display case. Recording it would hold the user's own name
    // against them in history for no reason and make `/@alice` a redirect to itself.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice');
    expect((await call(env, 'uid-alice', 'updateProfile', { fullName: 'Alice', username: 'Alice' })).status).toBe(200);
    expect(await historyRows(env)).toHaveLength(0);
  });

  it('does NOT record anything when the edit leaves the username alone', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice');
    expect((await call(env, 'uid-alice', 'updateProfile', { fullName: 'Alice Renamed' })).status).toBe(200);
    expect(await historyRows(env)).toHaveLength(0);
  });

  it('keeps only the MOST RECENT owner of a handle', async () => {
    // Upsert, not append. Keeping every past owner would let an ancient one win over a
    // recent one — the opposite of what a reader of an old link expects.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'shared_name');
    expect((await call(env, 'uid-alice', 'updateProfile', { fullName: 'Alice', username: 'alice_final' })).status).toBe(200);

    // Time-travel the hold open so bob may take it, then have bob release it too.
    await seedRelease(env, 'shared_name', 'uid-alice', USERNAME_HOLD_MS + 1000);
    await seedUser(env, 'uid-bob', 'bob');
    expect((await call(env, 'uid-bob', 'updateProfile', { fullName: 'Bob', username: 'shared_name' })).status).toBe(200);
    expect((await call(env, 'uid-bob', 'updateProfile', { fullName: 'Bob', username: 'bob_final' })).status).toBe(200);

    const rows = (await historyRows(env)).filter((r) => r.usernameLower === 'shared_name');
    expect(rows).toHaveLength(1);
    expect(rows[0].uid).toBe('uid-bob');
    expect((await byHandle(env, 'shared_name')).body).toEqual({ movedTo: 'bob_final' });
  });
});

describe('account deletion and released handles', () => {
  it('purges the deleted account`s history so old handles stop leading to it', async () => {
    // A link that resolves to a deleted person is worse than one that 404s, and
    // deletion is meant to make them unreachable.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice');
    await seedRelease(env, 'alice_older', 'uid-alice');
    await seedUser(env, 'uid-bob', 'bob');
    await seedRelease(env, 'bob_old', 'uid-bob');

    await executeAccountDeletion(env as any, 'uid-alice');

    const rows = await historyRows(env);
    expect(rows.map((r) => r.usernameLower)).toEqual(['bob_old']);
    expect((await byHandle(env, 'alice_old')).body).toBeNull();
  });

  it('frees the deleted account`s held handles for reuse', async () => {
    // The hold protects links to a living account. Once the account is gone there is
    // nothing left to impersonate, so continuing to reserve the name is pure cost.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice', 1000);
    await seedUser(env, 'uid-bob', 'bob');

    await executeAccountDeletion(env as any, 'uid-alice');

    expect((await call(env, 'uid-bob', 'updateProfile', { fullName: 'Bob', username: 'alice_old' })).status).toBe(200);
  });
});

describe('a movedTo pointer is a disclosure, and is gated like one', () => {
  /**
   * The `movedTo` branch answers BEFORE `serveUserProfile`, so none of that function's
   * guards run on it. Every test here is a case where the pointer said something the
   * direct lookup correctly refuses to say — i.e. the handle route leaking what the uid
   * route hides, which is the exact failure this whole feature was meant to avoid.
   */
  it('is withheld from a viewer the account has BLOCKED', async () => {
    // `serveUserProfile` answers `null` to a blocked viewer specifically so that a block
    // cannot be detected. A pointer would hand that viewer their blocker's CURRENT
    // handle — and renaming to get away from someone is a common reason the block exists
    // in the first place.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedUser(env, 'uid-bob', 'bob');
    await seedRelease(env, 'alice_old', 'uid-alice');
    await block(env, 'uid-alice', 'uid-bob');

    // The direct handle already answers null; the pointer must match it exactly.
    expect((await byHandle(env, 'alice_new', 'uid-bob')).body).toBeNull();
    expect((await byHandle(env, 'alice_old', 'uid-bob')).body).toBeNull();
  });

  it('is still given to a viewer who blocked THEM', async () => {
    // The reverse direction discloses nothing: this viewer chose the block and already
    // knows who it is. Following the redirect lands on the "You blocked @name — Unblock"
    // shell, which is what lets them undo it.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedUser(env, 'uid-bob', 'bob');
    await seedRelease(env, 'alice_old', 'uid-alice');
    await block(env, 'uid-bob', 'uid-alice');

    expect((await byHandle(env, 'alice_old', 'uid-bob')).body).toEqual({ movedTo: 'alice_new' });
  });

  it('is withheld for an account PENDING DELETION', async () => {
    // Otherwise `/@alice_old` confirms the account exists and names its live handle,
    // while `/@alice_new` 404s — the pair is more informative than either alone.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new', { status: 'pending_deletion' });
    await seedRelease(env, 'alice_old', 'uid-alice');
    expect((await byHandle(env, 'alice_new')).body).toBeNull();
    expect((await byHandle(env, 'alice_old')).body).toBeNull();
  });

  it('never redirects to an ANONYMISED handle', async () => {
    // Deletion writes `username: "deleted_…"` rather than clearing it, and the purge that
    // should have removed this row swallows its own errors by design. Without the status
    // check that leaves a 301 into a 404, carrying an internal handle in the url.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'deleted_a1b2c3', { status: 'deleted' });
    await seedRelease(env, 'alice_old', 'uid-alice');
    expect((await byHandle(env, 'alice_old')).body).toBeNull();
  });

  it('still lets a hidden account`s LIVE handle outrank history', async () => {
    // The status check belongs on the history fallback only. A hidden account still HOLDS
    // its handle, so if it were treated as unheld the handle would fall through to a
    // history row and redirect somewhere else entirely.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'contested', { status: 'pending_deletion' });
    await seedUser(env, 'uid-bob', 'bob_now');
    await seedRelease(env, 'contested', 'uid-bob');
    // Answers null (hidden), NOT a redirect to bob.
    expect((await byHandle(env, 'contested')).body).toBeNull();
  });
});

describe('a claim clears the handle`s history', () => {
  /**
   * The invariant: A ROW EXISTS ONLY FOR A HANDLE THAT NOBODY HAS HELD SINCE IT WAS
   * RELEASED. Without it a superseded row sits dormant — the live owner always wins — and
   * then becomes authoritative again the moment that owner stops holding the name.
   */
  it('does not resurrect the PREVIOUS owner after the new owner is deleted', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_now');
    await seedUser(env, 'uid-bob', 'bob');
    // alice released `contested` long ago, so the hold has lapsed.
    await seedRelease(env, 'contested', 'uid-alice', USERNAME_HOLD_MS + 1000);

    // bob legitimately claims it.
    expect((await call(env, 'uid-bob', 'updateProfile', { fullName: 'Bob', username: 'contested' })).status).toBe(200);
    // The claim removed alice's row, so nothing is left pointing at her.
    expect((await historyRows(env)).filter((r) => r.usernameLower === 'contested')).toHaveLength(0);

    // Now delete bob. `purgeUsernameHistory` deletes WHERE uid = bob; before the fix,
    // alice's row survived that and `/@contested` redirected to HER profile — inheriting
    // every link shared while bob held the handle.
    await executeAccountDeletion(env as any, 'uid-bob');
    expect((await byHandle(env, 'contested')).body).toBeNull();
  });

  it('clears a stale row when the handle is claimed at SIGNUP', async () => {
    // Signup is a claim too, and it is the path most likely to be overlooked because it
    // creates a row rather than updating one.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_now');
    await seedRelease(env, 'freebie', 'uid-alice', USERNAME_HOLD_MS + 1000);

    const res = await app.request(
      '/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer uid-newcomer' },
        body: JSON.stringify({ action: 'createProfile', username: 'freebie', fullName: 'Newcomer' }),
      },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);
    expect((await historyRows(env)).filter((r) => r.usernameLower === 'freebie')).toHaveLength(0);
  });

  it('lets the original owner reclaim without leaving their own row behind', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice', 1000);

    expect((await call(env, 'uid-alice', 'updateProfile', { fullName: 'A', username: 'alice_old' })).status).toBe(200);
    // `alice_old` is claimed (row gone) and `alice_new` is now the released one.
    const rows = await historyRows(env);
    expect(rows.map((r) => r.usernameLower)).toEqual(['alice_new']);
  });
});

describe('the release is written before the rename, not after', () => {
  it('does not record anything when the rename is REJECTED', async () => {
    // Validation and the uniqueness check both run before the transition, so a refused
    // rename must leave the table untouched — otherwise a user could put a handle on
    // hold by repeatedly attempting a rename that cannot succeed.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice');
    await seedUser(env, 'uid-bob', 'bob');

    expect((await call(env, 'uid-alice', 'updateProfile', { fullName: 'A', username: 'bob' })).status).toBe(409);
    expect((await call(env, 'uid-alice', 'updateProfile', { fullName: 'A', username: 'support' })).status).toBe(400);
    expect((await call(env, 'uid-alice', 'updateProfile', { fullName: 'A', username: 'ab' })).status).toBe(400);
    expect(await historyRows(env)).toHaveLength(0);
    expect(await usernameOf(env, 'uid-alice')).toBe('alice');
  });
});

describe('an ADMIN rename releases the handle too', () => {
  it('records the release, so the old handle redirects and is held', async () => {
    // This endpoint is how support renames the accounts most worth impersonating. Before
    // the fix it freed the handle with no hold and no redirect at all.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_old');
    await seedUser(env, 'uid-bob', 'bob');

    const res = await app.request(
      '/admin/users/uid-alice/profile',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
        body: JSON.stringify({ username: 'alice_new' }),
      },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);

    expect(await usernameOf(env, 'uid-alice')).toBe('alice_new');
    expect((await byHandle(env, 'alice_old')).body).toEqual({ movedTo: 'alice_new' });
    // And the freed handle is held against everyone else.
    expect((await call(env, 'uid-bob', 'updateProfile', { fullName: 'Bob', username: 'alice_old' })).status).toBe(409);
  });
});

describe('the availability check agrees with the claim path', () => {
  const check = async (env: TestEnv, value: string, viewer?: string) => {
    const res = await app.request(
      '/auth',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(viewer ? { Authorization: `Bearer ${viewer}` } : {}),
        },
        body: JSON.stringify({ action: 'check', type: 'username', value }),
      },
      env,
      fakeCtx(),
    );
    return (await res.json()) as { exists: boolean };
  };

  it('reports a HELD handle as taken', async () => {
    // It used to answer `{exists:false}` and the write then refused with "already in
    // use" — the client promises the name is free and the last step contradicts it.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice', 1000);
    expect(await check(env, 'alice_old')).toEqual({ exists: true });
  });

  it('reports it as AVAILABLE to the owner who released it', async () => {
    // The owner exemption has to survive into the check, or someone fixing a rename
    // mistake is told their own name is unavailable.
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice', 1000);
    expect(await check(env, 'alice_old', 'uid-alice')).toEqual({ exists: false });
  });

  it('reports a handle whose hold has lapsed as available', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice_new');
    await seedRelease(env, 'alice_old', 'uid-alice', USERNAME_HOLD_MS + 1000);
    expect(await check(env, 'alice_old')).toEqual({ exists: false });
  });

  it('still reports a live handle as taken', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice');
    expect(await check(env, 'alice')).toEqual({ exists: true });
    expect(await check(env, 'ALICE')).toEqual({ exists: true });
  });
});

describe('the handle route serves the PUBLIC projection', () => {
  /**
   * `/read/users/by-username/:username` and `/read/users/:id` are two doors into the
   * same data. These assertions are the ones that fail if the handle route ever grows
   * its own query instead of delegating to `serveUserProfile`.
   */
  async function seedAliceWithPii(env: TestEnv) {
    await seedUser(env, 'uid-alice', 'alice', {
      email: 'alice@example.com',
      phone: '+919812345678',
      dob: '1995-04-01',
      coordinates: { lat: 19.0761234, lng: 72.8776543 },
      dpcoin: 4321,
      role: 'user',
      referralCode: 'THALICE',
      fcmTokens: ['device-token-1'],
      extra: { instagram: 'ig.alice', privateNote: 'my home address' },
    });
  }

  it('withholds PII from an unauthenticated caller', async () => {
    const { env } = makeEnv();
    await seedAliceWithPii(env);
    const { body } = await byHandle(env, 'alice');
    for (const field of ['email', 'phone', 'dob', 'coordinates', 'dpcoin', 'role', 'referralCode', 'fcmTokens', 'extra', 'privateNote']) {
      expect(body[field], `${field} leaked through the handle route`).toBeUndefined();
    }
    expect(body.instagram).toBe('ig.alice');
  });

  it('withholds PII from a signed-in stranger', async () => {
    const { env } = makeEnv();
    await seedAliceWithPii(env);
    await seedUser(env, 'uid-bob', 'bob');
    const { body } = await byHandle(env, 'alice', 'uid-bob');
    expect(body.email).toBeUndefined();
    expect(body.dpcoin).toBeUndefined();
  });

  it('gives the OWNER their full row, uncached, when they arrive by their own handle', async () => {
    // Same viewer split as the uid route: the profile screen reads the balance and the
    // contact details from here when it is your own profile.
    const { env } = makeEnv();
    await seedAliceWithPii(env);
    const { body, headers } = await byHandle(env, 'alice', 'uid-alice');
    expect(body.email).toBe('alice@example.com');
    expect(body.dpcoin).toBe(4321);
    expect(headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('hides an account pending deletion', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'alice', { status: 'pending_deletion' });
    expect((await byHandle(env, 'alice')).body).toBeNull();
  });

  it('shares ONE cache entry with the uid route, so a profile edit purges both', async () => {
    // The entry is keyed by uid, not by the handle used to reach it. If the handle
    // route cached under its own key, `updateProfile`'s invalidation — which only
    // knows the uid — would purge one door and leave the other serving stale data,
    // including a stale handle in the payload.
    const edge = installEdgeCache();
    try {
      const { env } = makeEnv();
      await seedUser(env, 'uid-alice', 'alice');

      await byHandle(env, 'alice');
      const afterHandle = edge.logicalKeys();
      expect(afterHandle).toHaveLength(1);

      const res = await app.request('/read/users/uid-alice', {}, env, fakeCtx());
      expect(res.status).toBe(200);
      expect(edge.logicalKeys()).toEqual(afterHandle);
    } finally {
      edge.restore();
    }
  });

  it('never caches a `movedTo` pointer', async () => {
    const edge = installEdgeCache();
    try {
      const { env } = makeEnv();
      await seedUser(env, 'uid-alice', 'alice_new');
      await seedRelease(env, 'alice_old', 'uid-alice');
      expect((await byHandle(env, 'alice_old')).body).toEqual({ movedTo: 'alice_new' });
      expect(edge.keys()).toHaveLength(0);
    } finally {
      edge.restore();
    }
  });
});

describe('resolveUsername, directly', () => {
  it('normalises whitespace and case before looking up', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-alice', 'Alice');
    expect(await resolveUsername(env as any, '  ALICE  ')).toEqual({
      uid: 'uid-alice',
      currentUsername: 'Alice',
      moved: false,
    });
  });

  it('returns null for blank input instead of matching a row with no username', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'uid-nameless', null as any);
    expect(await resolveUsername(env as any, '')).toBeNull();
    expect(await resolveUsername(env as any, '   ')).toBeNull();
  });
});
