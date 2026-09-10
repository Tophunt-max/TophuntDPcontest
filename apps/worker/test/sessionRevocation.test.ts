/**
 * ENDING A SESSION THAT IS ALREADY SIGNED IN.
 *
 * ---------------------------------------------------------------------------
 * What was missing, and why it is not obvious
 * ---------------------------------------------------------------------------
 * Authentication here is stateless. `verifyIdToken` checks a signature against locally
 * cached JWKS — no network call to Firebase, so no revocation check — and nothing in the
 * codebase called `revokeRefreshTokens` either. Every screen worked, every test passed,
 * and the account had no off switch:
 *
 *   * a password change signed out nobody;
 *   * a stolen refresh token was good forever;
 *   * a phone-OTP recovery let the owner back in without evicting the intruder;
 *   * and "log out of all devices" did not exist.
 *
 * None of that shows up as a failure anywhere, which is why these tests are written as
 * assertions about what a token can STILL do after an event, rather than about the event
 * itself.
 *
 * ---------------------------------------------------------------------------
 * How the harness models a session
 * ---------------------------------------------------------------------------
 * The `verifyIdToken` mock reads the bearer token as `<uid>` (signed in now) or
 * `<uid>#at:<epochSeconds>` (signed in at that instant). That second form is the whole
 * point of these tests: `auth_time` is what the cutoff is compared against, so two
 * devices are two tokens for the same uid with different `auth_time` values.
 *
 * `#noauthtime` produces a token with the claim absent — not the same thing as an old
 * one, and it has its own test.
 */
import { vi, describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';

vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    if (token.endsWith('#noauthtime')) {
      return { uid: token.slice(0, -'#noauthtime'.length), role: 'user' };
    }
    const at = token.match(/^(.*)#at:(\d+)$/);
    if (at) return { uid: at[1], role: 'user', authTime: Number(at[2]) };
    return { uid: token, role: 'user', authTime: Math.floor(Date.now() / 1000) };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

const { refreshRevokes } = vi.hoisted(() => ({
  refreshRevokes: [] as Array<{ uid: string; validSince: number }>,
}));

vi.mock('../src/lib/firebaseAdmin', () => ({
  revokeRefreshTokens: async (_env: unknown, uid: string, validSince: number) => {
    refreshRevokes.push({ uid, validSince });
  },
  updateAuthUser: async () => undefined,
  deleteAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  getUserByEmail: async () => null,
  createAuthUser: async () => 'uid',
  createCustomToken: async () => 't',
  sendFcmToToken: async () => ({ ok: true, retryable: false, invalid: false, status: 200 }),
}));

vi.mock('../src/lib/voteCounter', () => ({
  castVote: async () => ({ votesA: 0, votesB: 0, total: 0, alreadyVoted: false, deviceUsed: false, votingClosed: false }),
  bumpEngagement: async () => ({}),
  getLiveTally: async () => ({ votesA: 0, votesB: 0, total: 0 }),
  getViewerVote: async () => ({ hasVoted: false, votedForUid: null }),
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import {
  SESSION_REVOKED_CODE,
  assertSessionNotRevoked,
  revokeAllSessions,
  revokeOtherSessions,
} from '../src/lib/sessionRevocation';

const app = makeApp();
const NOW = () => Math.floor(Date.now() / 1000);

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

/** Any authenticated read. Returns the HTTP status, which is what the gate controls. */
async function callAs(env: TestEnv, token: string, action = 'markNotificationsRead') {
  const res = await app.request(
    '/api',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action }),
    },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
}

const cutoffOf = async (env: TestEnv, uid: string) =>
  (
    await drizzleOf(env)
      .select({ t: schema.users.tokensValidAfter })
      .from(schema.users)
      .where(eq(schema.users.uid, uid))
      .get()
  )?.t ?? null;

const tokensOf = async (env: TestEnv, uid: string) =>
  (
    await drizzleOf(env)
      .select({ t: schema.users.fcmTokens })
      .from(schema.users)
      .where(eq(schema.users.uid, uid))
      .get()
  )?.t;

// ---------------------------------------------------------------------------

describe('the cutoff refuses old sessions and admits new ones', () => {
  it('lets a session through when nothing has been revoked', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    expect((await callAs(env, 'alice')).status).toBe(200);
  });

  it('refuses a session that authenticated BEFORE the cutoff', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    // A device that signed in an hour ago.
    const old = await callAs(env, `alice#at:${NOW() - 3600}`);
    expect(old.status).toBe(401);
    // Carries the marker, so the client can say "signed out for security" rather than
    // "your session expired" — see SESSION_REVOKED_CODE.
    expect(String(old.body?.error?.message)).toContain(SESSION_REVOKED_CODE);
  });

  it('admits a session that authenticates AFTER the cutoff', async () => {
    // The property that makes this usable: revoking must not lock the user out
    // permanently, only until they sign in again.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    expect((await callAs(env, `alice#at:${NOW() + 5}`)).status).toBe(200);
  });

  it('admits a session that authenticated in the SAME second as the cutoff', async () => {
    /**
     * The off-by-one-second bug the seconds-based column exists to avoid.
     *
     * `auth_time` is a whole-second claim. With a millisecond cutoff, revoking at
     * `…000500ms` and signing back in at `…000.8s` gives a claim that truncates to
     * `…000` — earlier than the cutoff — so the brand-new session is refused, and the
     * user cannot get back in until the next second ticks. Storing the cutoff in the
     * same unit as the claim removes the comparison entirely.
     */
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    const cutoff = await cutoffOf(env, 'alice');
    expect((await callAs(env, `alice#at:${cutoff}`)).status).toBe(200);
  });

  it('treats a MISSING auth_time as revoked, not as exempt', async () => {
    // Fail-closed, matching `hasFreshSession`: the claim is standard on Firebase ID
    // tokens, so absence means something unusual — and unusual must not be the case that
    // slips past the check. If we cannot prove a session started after the cutoff, we
    // cannot honour the revocation.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    expect((await callAs(env, 'alice#noauthtime')).status).toBe(401);
  });

  it('leaves a missing auth_time alone when nothing has been revoked', async () => {
    // The fail-closed rule must not become a blanket requirement for the claim — that
    // would reject sessions on accounts that have never revoked anything.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    expect((await callAs(env, 'alice#noauthtime')).status).toBe(200);
  });

  it('does not affect anyone else', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    expect((await callAs(env, `alice#at:${NOW() - 3600}`)).status).toBe(401);
    expect((await callAs(env, `bob#at:${NOW() - 3600}`)).status).toBe(200);
  });
});

describe('the cutoff only ever moves forward', () => {
  it('is not lowered by a later revocation with an earlier timestamp', async () => {
    /**
     * `revokeOtherSessions` writes the CALLER's `auth_time`, which is in the past. Run
     * after a full revocation, a plain assignment would move the cutoff backwards and
     * quietly readmit every session the earlier call had ended. `MAX()` in SQL is what
     * makes the write monotonic without a read-modify-write to race on.
     */
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');
    const after = await cutoffOf(env, 'alice');

    await revokeOtherSessions(
      env as any,
      { uid: 'alice', authTime: NOW() - 3600 } as any,
      'password_changed',
    );

    expect(await cutoffOf(env, 'alice')).toBe(after);
    expect((await callAs(env, `alice#at:${NOW() - 60}`)).status).toBe(401);
  });
});

describe('revokeAllSessions', () => {
  it('ends the CALLER`s session too', async () => {
    // The whole value of the control: a user who does not know who else is signed in
    // cannot be given a guarantee that spares one unidentified session.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const mine = `alice#at:${NOW() - 10}`;
    expect((await callAs(env, mine)).status).toBe(200);

    await revokeAllSessions(env as any, 'alice', 'user_logout_all');
    expect((await callAs(env, mine)).status).toBe(401);
  });

  it('invalidates the Firebase REFRESH tokens as well', async () => {
    /**
     * The D1 cutoff refuses tokens at our API; it does not stop the client minting new
     * ones. Both halves are needed — see the module header — and this is the one that is
     * easy to drop, because everything still looks revoked without it.
     */
    refreshRevokes.length = 0;
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    expect(refreshRevokes).toHaveLength(1);
    expect(refreshRevokes[0].uid).toBe('alice');
    // Same instant as the D1 cutoff, and in seconds, which is what `validSince` takes.
    expect(refreshRevokes[0].validSince).toBe(await cutoffOf(env, 'alice'));
  });

  it('clears every push token', async () => {
    // A signed-out device must stop receiving the account's notifications, and it cannot
    // detach its own token — that call is authenticated and its session is gone.
    const { env } = makeEnv();
    await seedUser(env, 'alice', { fcmTokens: ['device-a', 'device-b'] });
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');
    expect(await tokensOf(env, 'alice')).toEqual([]);
  });

  it('still writes the cutoff when the Firebase call fails', async () => {
    // Best-effort, and ordered so it cannot matter: D1 is what this API enforces, so a
    // Firebase blip must not leave the user thinking they are signed out when they are
    // not. Uses a synchronous throw, which is the case a bare `.catch()` would miss.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const admin = await import('../src/lib/firebaseAdmin');
    const spy = vi.spyOn(admin, 'revokeRefreshTokens').mockImplementation(() => {
      throw new Error('identity toolkit down');
    });
    try {
      await expect(revokeAllSessions(env as any, 'alice', 'user_logout_all')).resolves.toBeUndefined();
      expect(await cutoffOf(env, 'alice')).toBeGreaterThan(0);
      expect((await callAs(env, `alice#at:${NOW() - 60}`)).status).toBe(401);
    } finally {
      spy.mockRestore();
    }
  });

  it('does nothing for a uid that does not exist', async () => {
    refreshRevokes.length = 0;
    const { env } = makeEnv();
    await expect(revokeAllSessions(env as any, 'ghost', 'admin_forced')).resolves.toBeUndefined();
    expect(refreshRevokes).toHaveLength(0);
  });
});

describe('revokeOtherSessions', () => {
  it('keeps the caller signed in and ends the older sessions', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const caller = NOW() - 60;

    await revokeOtherSessions(env as any, { uid: 'alice', authTime: caller } as any, 'password_changed');

    expect((await callAs(env, `alice#at:${caller}`)).status).toBe(200);
    expect((await callAs(env, `alice#at:${caller - 1}`)).status).toBe(401);
  });

  it('does NOT touch the Firebase refresh tokens', async () => {
    // `validSince` is account-wide, so setting it would invalidate the caller's own
    // refresh token and sign out the very device this function exists to keep.
    refreshRevokes.length = 0;
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeOtherSessions(env as any, { uid: 'alice', authTime: NOW() } as any, 'password_changed');
    expect(refreshRevokes).toHaveLength(0);
  });

  it('does NOT clear push tokens', async () => {
    // The column is not per-device, so clearing it would silence the notifications of
    // the one device that is meant to survive.
    const { env } = makeEnv();
    await seedUser(env, 'alice', { fcmTokens: ['device-a'] });
    await revokeOtherSessions(env as any, { uid: 'alice', authTime: NOW() } as any, 'password_changed');
    expect(await tokensOf(env, 'alice')).toEqual(['device-a']);
  });

  it('CLAMPS a future-dated auth_time to now', async () => {
    /**
     * An unclamped value would be durable, not transient: `setCutoff` is monotonic and
     * nothing in the codebase can lower a cutoff, so a token whose `auth_time` is ahead of
     * our clock would lock the account out of its own API until real time caught up, with
     * hand-written production SQL as the only repair. `hasFreshSession` already clamps
     * future-dated claims; the same caution belongs here, where the effect persists.
     */
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const wayAhead = NOW() + 86_400;

    await revokeOtherSessions(env as any, { uid: 'alice', authTime: wayAhead } as any, 'password_changed');

    const cutoff = (await cutoffOf(env, 'alice'))!;
    expect(cutoff).toBeLessThanOrEqual(NOW() + 1);
    // And a session signing in right now is still admitted.
    expect((await callAs(env, `alice#at:${NOW() + 2}`)).status).toBe(200);
  });

  it('ends EVERY session when the caller`s auth_time is unknown', async () => {
    // Fail-closed. Without an `auth_time` there is no way to identify which session to
    // keep, and guessing permissively would mean a credential change that revoked
    // nothing at all.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeOtherSessions(env as any, { uid: 'alice' } as any, 'password_changed');

    expect(await cutoffOf(env, 'alice')).toBeGreaterThan(0);
    expect((await callAs(env, 'alice#noauthtime')).status).toBe(401);
  });
});

describe('assertSessionNotRevoked, directly', () => {
  it('passes when no cutoff is set, whatever the token looks like', () => {
    for (const cutoff of [null, undefined, 0]) {
      expect(() => assertSessionNotRevoked({ authTime: 1 }, cutoff as any)).not.toThrow();
      expect(() => assertSessionNotRevoked({}, cutoff as any)).not.toThrow();
    }
  });

  it('rejects a non-finite auth_time rather than comparing it', () => {
    // `NaN >= cutoff` is false, so this would fail closed anyway — asserted so that a
    // refactor to a different comparison cannot silently change it.
    expect(() => assertSessionNotRevoked({ authTime: NaN }, 1000)).toThrow();
    expect(() => assertSessionNotRevoked({ authTime: Infinity }, 1000)).toThrow();
  });

  it('is inclusive at the boundary', () => {
    expect(() => assertSessionNotRevoked({ authTime: 1000 }, 1000)).not.toThrow();
    expect(() => assertSessionNotRevoked({ authTime: 999 }, 1000)).toThrow();
  });
});

describe('what a revoked session can no longer reach', () => {
  it('cannot open a realtime socket', async () => {
    // `/ws` verifies the token itself rather than going through the middleware, so it is
    // its own enforcement point — and the one where a missed check would leave an
    // evicted device receiving live updates.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    const { assertSessionUsable } = await import('../src/middleware/auth');
    await expect(
      assertSessionUsable(env as any, { uid: 'alice', authTime: NOW() - 60 } as any),
    ).rejects.toThrow();
  });

  it('cannot delete the account, even though deletion is a self-service action', async () => {
    /**
     * `SELF_SERVICE_ACTIONS` exists so a BLOCKED user can still delete their own account
     * — a store-compliance requirement. It must not extend to a revoked session: that
     * user is not holding a session they are entitled to, and handing the one
     * irreversible action to precisely the session the owner shut out would turn the
     * exemption into a hole.
     */
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    const res = await callAs(env, `alice#at:${NOW() - 60}`, 'deleteAccount');
    expect(res.status).toBe(401);
    expect(String(res.body?.error?.message)).toContain(SESSION_REVOKED_CODE);
  });

  it('CAN still delete the account when the revocation came from a BLOCK', async () => {
    /**
     * The app-store carve-out, and the reason it is not a convenience.
     *
     * `SELF_SERVICE_ACTIONS` exists because "both app stores require an in-app way to
     * delete an account, and the auth middleware rejected every request from a blocked
     * account before the router ever saw the action name". Blocking now revokes sessions
     * too — correctly, so unblocking does not restore an intruder — but without this
     * carve-out that would close the deletion path again by a longer route, reintroducing
     * the exact compliance hole the exemption was written for.
     *
     * The test above is the counterpart: an unblocked account whose sessions the USER
     * revoked gets no exemption at all.
     */
    const { env } = makeEnv();
    await seedUser(env, 'alice', { isBlocked: true, status: 'blocked' });
    await revokeAllSessions(env as any, 'alice', 'admin_blocked');

    const res = await callAs(env, `alice#at:${NOW() - 60}`, 'accountDeletionStatus');
    expect(res.status).toBe(200);
  });

  it('is still refused a NON self-service action when blocked', async () => {
    // The carve-out must not become a general exemption for blocked accounts.
    const { env } = makeEnv();
    await seedUser(env, 'alice', { isBlocked: true, status: 'blocked' });
    await revokeAllSessions(env as any, 'alice', 'admin_blocked');

    expect((await callAs(env, `alice#at:${NOW() - 60}`, 'updateProfile')).status).toBe(403);
  });

  it('reports a BLOCK as a block, not as a security sign-out', async () => {
    // Both refusals are correct, but only one is true about the account rather than the
    // session — and a moderated user told "you were signed out for security" is handed a
    // security scare in place of a moderation decision.
    const { env } = makeEnv();
    await seedUser(env, 'alice', { isBlocked: true, status: 'blocked' });
    await revokeAllSessions(env as any, 'alice', 'admin_blocked');

    const { assertSessionUsable } = await import('../src/middleware/auth');
    await expect(
      assertSessionUsable(env as any, { uid: 'alice', authTime: NOW() - 60 } as any),
    ).rejects.toThrow(/blocked/i);
  });

  it('reads as a GUEST on a public route rather than erroring', async () => {
    // `optionalAuth` swallows the refusal, which is the right outcome: the caller still
    // gets the public answer, they simply stop being recognised. That is what being
    // signed out means, and it also stops a revoked token retaining viewer-specific
    // treatment.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await revokeAllSessions(env as any, 'alice', 'user_logout_all');

    const res = await app.request(
      '/read/users/alice',
      { headers: { Authorization: `Bearer alice#at:${NOW() - 60}` } },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // The PUBLIC projection, not the owner's own row — the token no longer identifies them.
    expect(body.uid).toBe('alice');
    expect(body.email).toBeUndefined();
  });
});

describe('the events that end sessions', () => {
  it('a password change ends the other sessions but not this one', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const mine = NOW() - 30;

    const res = await callAs(env, `alice#at:${mine}`, 'notifyPasswordChanged');
    expect(res.status).toBe(200);

    expect((await callAs(env, `alice#at:${mine}`)).status).toBe(200);
    expect((await callAs(env, `alice#at:${mine - 1}`)).status).toBe(401);
  });

  it('logoutAllDevices ends this session too', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const mine = NOW() - 30;

    expect((await callAs(env, `alice#at:${mine}`, 'logoutAllDevices')).status).toBe(200);
    expect((await callAs(env, `alice#at:${mine}`)).status).toBe(401);
  });

  it('logoutAllDevices stays reachable while a deletion is pending', async () => {
    /**
     * `cancelAccountDeletion` is on the pending-deletion allow-list, so anyone holding a
     * live session can undo a deletion. If the reason for the deletion is that someone
     * else got in, the owner needs a way to remove them — so this action has to be
     * reachable in that state too.
     */
    const { env } = makeEnv();
    await seedUser(env, 'alice', { status: 'pending_deletion' });
    const mine = NOW() - 30;

    // A normal action is refused in this state (`markNotificationsRead` would not do —
    // it is on the allow-list, because reading notifications is part of winding down).
    expect((await callAs(env, `alice#at:${mine}`, 'updateProfile')).status).toBe(412);
    // ...but ending every session is not.
    expect((await callAs(env, `alice#at:${mine}`, 'logoutAllDevices')).status).toBe(200);
  });

  it('a phone-OTP password reset ends every session', async () => {
    /**
     * The clearest case: the caller is SIGNED OUT, so there is no session here worth
     * keeping, and every session that exists predates the reset — including whoever the
     * reset is a response to. This flow used to restore the owner's access while leaving
     * the intruder exactly where they were.
     */
    const { env } = makeEnv();
    await seedUser(env, 'alice', { phone: '+919812345678' });
    const intruder = `alice#at:${NOW() - 600}`;
    expect((await callAs(env, intruder)).status).toBe(200);

    await env.OTP_KV.put('pwverified:+919812345678', '1');
    const res = await app.request(
      '/auth',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'updatePasswordWithPhone',
          phone: '+919812345678',
          newPassword: 'Str0ng!Pass9',
        }),
      },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);
    expect((await callAs(env, intruder)).status).toBe(401);
  });

  it('an admin block ends every session, so unblocking does not restore the intruder', async () => {
    /**
     * A block used to close open WebSockets and nothing else. `isBlocked` meant the
     * session could not DO anything, but the refresh token stayed valid — so the moment a
     * block was lifted, every previously-signed-in device resumed, including any the
     * account was blocked because of. Unblocking is meant to restore the USER's access.
     */
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const device = `alice#at:${NOW() - 600}`;

    const blocked = await app.request(
      '/admin/users/alice',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
        body: JSON.stringify({ isBlocked: true }),
      },
      env,
      fakeCtx(),
    );
    expect(blocked.status).toBe(200);

    // Unblock again, so the only thing standing between the old token and the API is the
    // revocation cutoff.
    await app.request(
      '/admin/users/alice',
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': 'test-admin-secret' },
        body: JSON.stringify({ isBlocked: false }),
      },
      env,
      fakeCtx(),
    );

    expect((await callAs(env, device)).status).toBe(401);
  });

  it('an admin can end sessions WITHOUT blocking the account', async () => {
    // The support case that had no answer: a user reports their account is compromised.
    // Blocking evicts the intruder and also locks out the victim, who has done nothing
    // wrong and now cannot reach their balance.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    const device = `alice#at:${NOW() - 600}`;

    const res = await app.request(
      '/admin/users/alice/logout-all',
      { method: 'POST', headers: { 'X-Admin-Secret': 'test-admin-secret' } },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(200);

    // Old session gone, account NOT blocked, and a fresh sign-in works.
    expect((await callAs(env, device)).status).toBe(401);
    expect((await callAs(env, `alice#at:${NOW() + 5}`)).status).toBe(200);
  });

  it('404s an admin force-logout for a user who does not exist', async () => {
    const { env } = makeEnv();
    const res = await app.request(
      '/admin/users/ghost/logout-all',
      { method: 'POST', headers: { 'X-Admin-Secret': 'test-admin-secret' } },
      env,
      fakeCtx(),
    );
    expect(res.status).toBe(404);
  });
});
