/**
 * WHO IS ALLOWED TO SEE WHAT ON A PROFILE.
 *
 * ---------------------------------------------------------------------------
 * The bug this file exists for
 * ---------------------------------------------------------------------------
 * `GET /read/users/:id` used to answer with the whole `users` row minus
 * `fcmTokens`. One line of code, and a large amount of personal data: `email`,
 * `phone`, `dob`, `gender`, `occupation`, `coordinates` (a location), `dpcoin` (a
 * wallet balance), `role`, `isBlocked`, `authProvider`, `referralCode`,
 * `notificationPrefs`, `streak`, `lastDailyClaim`.
 *
 * The endpoint is `optionalAuth`, so NO TOKEN was needed, and uids are enumerable
 * through `/read/users/search` and `/read/users/suggested`. It was reachable with a
 * single unauthenticated GET.
 *
 * ---------------------------------------------------------------------------
 * Why the assertions are shaped like this
 * ---------------------------------------------------------------------------
 * A leak of this kind is invisible in every ordinary test, because the response is
 * a SUPERSET of what the client needs — every screen keeps working, every existing
 * assertion keeps passing, and nothing fails. The only way to catch it is to assert
 * on ABSENCE, per viewer.
 *
 * The last test is the one that matters most over time: it fails when a NEW `users`
 * column is added without being classified as public or private. Without it, the
 * allow-list is correct exactly until the next migration, and the next person to add
 * a column would have to already know this file exists.
 */
import { vi, describe, it, expect } from 'vitest';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));
vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 1, votesB: 0, total: 1, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({ like: 1, comment: 1, share: 1 }),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { eq, getTableColumns } from 'drizzle-orm';
import { makeEnv, makeApp, fakeCtx, drizzleOf, installEdgeCache, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import { PUBLIC_PROFILE_FIELDS } from '../src/routes/read';

const app = makeApp();

/**
 * Every field that must NEVER reach anyone but the account holder.
 *
 * Spelled out rather than derived from the allow-list, deliberately. A derived list
 * ("everything not public") would be satisfied by an empty allow-list and would
 * silently absorb a new column, which is the failure mode this file is guarding. Two
 * independent lists that must together cover the table is what makes the final test
 * able to fail.
 */
const PRIVATE_USER_FIELDS = [
  // Contact details, and whether they were proven.
  'email',
  'phone',
  'emailVerified',
  'phoneVerified',
  'emailVerifiedAt',
  'phoneVerifiedAt',
  // Personal details collected at signup.
  'dob',
  'gender',
  'occupation',
  'coordinates',
  // Money and engagement state.
  'dpcoin',
  'streak',
  'lastDailyClaim',
  // Internal / operational.
  'role',
  'isBlocked',
  /**
   * The session-revocation cutoff (migration 0044).
   *
   * Private, and not merely by default. It is a precise timestamp of a SECURITY EVENT on
   * someone else's account — the moment they changed a password, recovered access, or
   * pressed "log out of all devices". Publishing that tells a stranger when an account
   * holder last felt the need to lock things down, and tells an attacker whether the
   * victim has noticed them yet. Nothing on any profile screen reads it.
   */
  'tokensValidAfter',
  'platform',
  'authProvider',
  'signupCompleted',
  'notificationPrefs',
  'updatedAt',
  // Referral ledger.
  'referralCode',
  'referredBy',
  // Push tokens. Stripped before the projection even runs, and must stay that way:
  // a device token is a handle for sending someone notifications.
  'fcmTokens',
  /**
   * The raw `extra` blob, as a KEY, is private — and this entry is not a formality.
   *
   * `updateProfile` writes any field it does not recognise into `extra`, so its
   * contents are caller-controlled and unbounded. The handler merges it to the top
   * level and the allow-list then names the individual keys it will pass on
   * (`website`, `facebook`, `twitter`, `instagram`). Emitting the blob itself would
   * hand back everything else in it and defeat that.
   *
   * Worth noting the classification guard below found this gap on its first run: the
   * column was in neither list, which is exactly the case it is built to catch.
   */
  'extra',
] as const;

async function seedAlice(env: TestEnv, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({
      uid: 'alice',
      username: 'alice',
      fullName: 'Alice Example',
      email: 'alice@example.com',
      phone: '+919812345678',
      dob: '1995-04-01',
      gender: 'female',
      occupation: 'Designer',
      coordinates: { lat: 19.0761234, lng: 72.8776543 },
      role: 'user',
      dpcoin: 4321,
      xp: 120,
      level: 3,
      bio: 'hello',
      streak: 7,
      lastDailyClaim: ts - 1000,
      referralCode: 'THALICE',
      referredBy: 'bob',
      followersCount: 2,
      verified: true,
      emailVerified: true,
      phoneVerified: true,
      notificationPrefs: { push: true },
      fcmTokens: ['device-token-1'],
      createdAt: ts,
      updatedAt: ts,
      ...extra,
    } as any);
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid: 'bob', username: 'bob', fullName: 'Bob', createdAt: ts, updatedAt: ts } as any);
}

const getProfile = async (env: TestEnv, viewer: string | null, id = 'alice') => {
  const res = await app.request(
    `/read/users/${id}`,
    { headers: viewer ? { Authorization: `Bearer ${viewer}` } : {} },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json()) as any, headers: res.headers };
};

describe('a stranger receives only public fields', () => {
  for (const field of PRIVATE_USER_FIELDS) {
    it(`withholds ${field}`, async () => {
      const { env } = makeEnv();
      await seedAlice(env);
      const { body } = await getProfile(env, 'bob');
      expect(body[field]).toBeUndefined();
    });
  }

  it('withholds them from an UNAUTHENTICATED caller too', async () => {
    // The case that made this a real incident rather than a theoretical one: no token
    // at all, and `optionalAuth` happily served the row.
    const { env } = makeEnv();
    await seedAlice(env);
    const { body } = await getProfile(env, null);
    for (const field of PRIVATE_USER_FIELDS) {
      expect(body[field], `${field} leaked to an anonymous caller`).toBeUndefined();
    }
  });

  it('still returns everything a profile screen renders', async () => {
    // The other half of the contract. A projection that withheld too much would be
    // just as much of a regression, and a silent one — the screen would render blanks.
    // These are the fields ProfileHeader / ProfileTabs / connections actually read.
    const { env } = makeEnv();
    await seedAlice(env);
    const { body } = await getProfile(env, 'bob');
    expect(body).toMatchObject({
      uid: 'alice',
      username: 'alice',
      fullName: 'Alice Example',
      bio: 'hello',
      verified: true,
      xp: 120,
      level: 3,
      followersCount: 2,
    });
    expect(body.profileImageUrlThumb).toBeDefined();
    expect(Array.isArray(body.following)).toBe(true);
  });

  it('passes through social links, which are user-authored public info', async () => {
    const { env } = makeEnv();
    await seedAlice(env, { extra: { facebook: 'fb.alice', instagram: 'ig.alice' } });
    const { body } = await getProfile(env, 'bob');
    expect(body.facebook).toBe('fb.alice');
    expect(body.instagram).toBe('ig.alice');
  });

  it('drops an unrecognised key a client shoved into `extra`', async () => {
    // `updateProfile` writes anything it does not recognise into `extra`, and `extra`
    // is merged to the top level. Naming the social keys individually is what stops
    // the rest of that blob reaching a stranger.
    const { env } = makeEnv();
    await seedAlice(env, { extra: { facebook: 'fb.alice', privateNote: 'my home address' } });
    const { body } = await getProfile(env, 'bob');
    expect(body.facebook).toBe('fb.alice');
    expect(body.privateNote).toBeUndefined();
  });
});

describe('the account holder receives their own full row', () => {
  it('returns every private field to the owner', async () => {
    // The wallet screens read `dpcoin` from here, the edit screen reads `email` and
    // `phone`, and the client turns `role` into `isAdmin`. Withholding these would
    // break the app, which is why the fix is a per-viewer projection and not a column
    // removal.
    const { env } = makeEnv();
    await seedAlice(env);
    const { body, headers } = await getProfile(env, 'alice');

    expect(body.email).toBe('alice@example.com');
    expect(body.phone).toBe('+919812345678');
    expect(body.dpcoin).toBe(4321);
    expect(body.role).toBe('user');
    expect(body.emailVerified).toBe(true);
    expect(body.referralCode).toBe('THALICE');
    expect(body.coordinates).toEqual({ lat: 19.0761234, lng: 72.8776543 });

    // Never storable by a shared cache or an intermediary.
    expect(headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('never returns push tokens, even to the owner', async () => {
    // `fcmTokens` is the one field stripped before either path sees it. The owner has
    // no use for it — the client sends tokens up, it never reads them back — and an
    // XSS or a leaked response would otherwise hand over the ability to push to their
    // devices.
    const { env } = makeEnv();
    await seedAlice(env);
    const { body } = await getProfile(env, 'alice');
    expect(body.fcmTokens).toBeUndefined();
  });

  it('serves the owner a FRESH balance, not a cached one', async () => {
    // The owner's read is deliberately uncached. None of the ~15 coin-mutating paths
    // invalidate this key, so while it was served from a shared cache a user who had
    // just paid an entry fee could see a stale balance for the whole TTL — which in a
    // coin app reads as a lost payment.
    const edge = installEdgeCache();
    try {
      const { env } = makeEnv();
      await seedAlice(env);
      expect((await getProfile(env, 'alice')).body.dpcoin).toBe(4321);

      await drizzleOf(env)
        .update(schema.users)
        .set({ dpcoin: 11 } as any)
        .where(eq(schema.users.uid, 'alice'));

      // Immediately correct, with no purge and no waiting.
      expect((await getProfile(env, 'alice')).body.dpcoin).toBe(11);
      // ...and the owner's read left nothing shareable behind.
      expect(edge.logicalKeys()).not.toContain('cache:user:alice');
    } finally {
      edge.restore();
    }
  });
});

describe('the shared cache entry never contains private fields', () => {
  it('holds only the public projection', async () => {
    // Belt and braces on the tier itself rather than the response. Even if a future
    // handler change re-exposed a field, this fails if the PRIVATE data was ever
    // written into a shared entry — which is what makes a missed invalidation a
    // cosmetic problem instead of a disclosure.
    const edge = installEdgeCache();
    try {
      const { env } = makeEnv();
      await seedAlice(env);
      await getProfile(env, 'bob');

      const entry = [...edge.store.entries()].find(([k]) => decodeURIComponent(k).includes('cache:user:alice'));
      expect(entry, 'the profile should have been cached for a stranger').toBeDefined();
      const cached = JSON.parse(entry![1].body);
      const payload = cached.profile ?? cached;
      for (const field of PRIVATE_USER_FIELDS) {
        expect(payload[field], `${field} was written into the shared cache`).toBeUndefined();
      }
    } finally {
      edge.restore();
    }
  });

  it('is not populated by the OWNER\u2019s request', async () => {
    // The owner's payload is the one that contains everything. If that request wrote
    // to the shared entry, the next stranger would read it — so the owner path must
    // not cache at all.
    const edge = installEdgeCache();
    try {
      const { env } = makeEnv();
      await seedAlice(env);
      await getProfile(env, 'alice');
      expect(edge.logicalKeys()).not.toContain('cache:user:alice');
    } finally {
      edge.restore();
    }
  });
});

describe('existing profile invariants still hold', () => {
  it('a hidden account reads as "does not exist" to a stranger but not to its owner', async () => {
    const { env } = makeEnv();
    await seedAlice(env, { status: 'pending_deletion' });

    expect((await getProfile(env, 'bob')).body).toBeNull();
    const owner = await getProfile(env, 'alice');
    expect(owner.body.uid).toBe('alice');
    expect(owner.headers.get('Cache-Control')).toBe('private, no-store');
  });

  it('a viewer who blocked someone still gets the unblock shell, and no private fields', async () => {
    const { env } = makeEnv();
    await seedAlice(env);
    await drizzleOf(env)
      .insert(schema.userBlocks)
      .values({ blockerId: 'bob', blockedId: 'alice', createdAt: Date.now() } as any);

    const { body } = await getProfile(env, 'bob');
    expect(body.isBlockedByMe).toBe(true);
    expect(body.username).toBe('alice');
    expect(body.email).toBeUndefined();
    expect(body.dpcoin).toBeUndefined();
  });
});

describe('/read/users/suggested does not disclose a home address', () => {
  it('coarsens coordinates to roughly a kilometre', async () => {
    // The client sorts suggestions by distance itself, and was handed each account's
    // EXACT stored coordinate to do it — up to 50 of them, with no token required.
    // Exact coordinates plus a username is a home address.
    const { env } = makeEnv();
    await seedAlice(env);
    const res = await app.request('/read/users/suggested', {}, env, fakeCtx());
    const rows = (await res.json()) as any[];
    const alice = rows.find((r) => r.id === 'alice');

    expect(alice.coordinates).toEqual({ lat: 19.08, lng: 72.88 });
    // Still ordered-by-distance-able, just no longer to the building.
    expect(alice.coordinates.lat).not.toBe(19.0761234);
  });

  it('returns null for a missing or malformed coordinate rather than throwing', async () => {
    // The client already sorts accounts with no coordinate to the end, so null is the
    // shape it expects — and a bad row must not break the whole suggestions list.
    const { env } = makeEnv();
    await seedAlice(env, { coordinates: null });
    await drizzleOf(env)
      .insert(schema.users)
      .values({
        uid: 'carol',
        username: 'carol',
        coordinates: { lat: 'nonsense' },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as any);

    const res = await app.request('/read/users/suggested', {}, env, fakeCtx());
    expect(res.status).toBe(200);
    const rows = (await res.json()) as any[];
    expect(rows.find((r) => r.id === 'alice').coordinates).toBeNull();
    expect(rows.find((r) => r.id === 'carol').coordinates).toBeNull();
  });
});

/**
 * The guard that keeps this correct after everyone has forgotten about it.
 *
 * An allow-list is right on the day it is written and wrong after the next migration,
 * unless something forces the question. This fails on any `users` column that is in
 * neither list, so adding a column makes the build ask whether it is public — which is
 * the only version of this that survives contact with a growing schema.
 */
describe('every users column is classified', () => {
  it('has no unclassified column', () => {
    const columns = Object.keys(getTableColumns(schema.users));
    const classified = new Set<string>([...PUBLIC_PROFILE_FIELDS, ...PRIVATE_USER_FIELDS]);
    const unclassified = columns.filter((col) => !classified.has(col));

    expect(
      unclassified,
      `New users column(s) ${unclassified.join(', ')} are neither in PUBLIC_PROFILE_FIELDS ` +
        `(src/routes/read.ts) nor PRIVATE_USER_FIELDS (this file). Decide which, then add it. ` +
        `Default to private: a field is only public if a screen renders it for someone else.`,
    ).toEqual([]);
  });

  it('does not classify the same field both ways', () => {
    // A field in both lists would make the test above pass while the projection leaked
    // it, since the allow-list is what the code actually reads.
    const publicSet = new Set<string>(PUBLIC_PROFILE_FIELDS);
    const both = PRIVATE_USER_FIELDS.filter((f) => publicSet.has(f));
    expect(both, `classified as both public and private: ${both.join(', ')}`).toEqual([]);
  });
});
