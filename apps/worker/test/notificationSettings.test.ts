/**
 * Settings: notification preferences, push gating and deletion cleanup.
 *
 * Every `describe` below corresponds to a real defect found auditing the Expo
 * `/setting` screens against this backend, so these are regression tests first
 * and documentation second.
 *
 * The through-line: a settings screen is a PROMISE. If a toggle can be flipped
 * but the send path ignores it, or a preset can be selected but does not persist,
 * the screen is actively lying — which is worse than not shipping it.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { and, eq } from 'drizzle-orm';

// Bypass Firebase token verification: the bearer token is "uid" or "uid:role".
vi.mock('../src/lib/firebaseAuth', () => ({
  verifyIdToken: async (token: string) => {
    const [uid, role] = token.split(':');
    return { uid, role: role || 'user' };
  },
  bearerToken: (h?: string | null) => (h && h.startsWith('Bearer ') ? h.slice(7) : null),
}));

// Every FCM delivery, captured. Push suppression is otherwise invisible to a
// test: notify.ts deliberately swallows its own failures, so "gated correctly"
// and "blew up and was ignored" produce identical observable behaviour without
// asserting on the send list itself.
// `vi.hoisted` because vi.mock factories are hoisted above these declarations.
const { fcmSends } = vi.hoisted(() => ({
  fcmSends: [] as Array<{
    token: string;
    notification: { title: string; body: string };
    data: Record<string, string>;
    options: any;
  }>,
}));

vi.mock('../src/lib/firebaseAdmin', () => ({
  deleteAuthUser: async () => undefined,
  updateAuthUser: async () => undefined,
  setCustomClaims: async () => undefined,
  getUserByEmail: async () => null,
  sendFcmToToken: async (
    _env: unknown,
    token: string,
    notification: { title: string; body: string },
    data: Record<string, string>,
    options: any,
  ) => {
    fcmSends.push({ token, notification, data, options });
    return { ok: true, retryable: false, invalid: false, status: 200 };
  },
}));

import { makeEnv, makeApp, fakeCtx, drizzleOf, type TestEnv } from './helpers/harness';
import * as schema from '../src/db/schema';
import {
  DEFAULT_PREFS,
  categoryForType,
  isInQuietHours,
  resolvePrefs,
  serializePrefs,
  shouldSendPush,
} from '../src/lib/notificationPrefs';
import { sendPushNotification } from '../src/lib/notify';
import { deleteOwnAccount } from '../src/lib/accountDeletion';

const app = makeApp();

beforeEach(() => {
  fcmSends.length = 0;
});

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

async function read(env: TestEnv, uid: string, path: string) {
  const res = await app.request(
    `/read${path}`,
    { headers: { Authorization: `Bearer ${uid}` } },
    env,
    fakeCtx(),
  );
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function seedUser(env: TestEnv, uid: string, extra: Record<string, any> = {}) {
  const ts = Date.now();
  await drizzleOf(env)
    .insert(schema.users)
    .values({ uid, username: uid, fullName: uid, dpcoin: 0, createdAt: ts, updatedAt: ts, ...extra } as any);
}

// ---------------------------------------------------------------------------

describe('quiet hours: turning them OFF actually turns them off', () => {
  /**
   * The bug: `hour()` did `Number(value)` before range-checking, and
   * `Number(null) === 0` — a valid hour. So the settings screen's "Off" preset,
   * which sends `{quietStart: null, quietEnd: null}`, persisted as midnight-to-
   * midnight. Push gating happened to stay correct (a zero-length window is
   * never "inside"), so this presented purely as a UI lie: the Off row never
   * showed as selected and the screen reported "Currently quiet from 12am to
   * 12am". Tapping Off looked like it did nothing.
   */
  it('keeps null bounds null instead of coercing them to midnight', () => {
    const prefs = resolvePrefs({ quietStart: null, quietEnd: null });
    expect(prefs.quietStart).toBeNull();
    expect(prefs.quietEnd).toBeNull();
  });

  it('does not treat other falsy junk as hour 0 either', () => {
    // Each of these is `0` under `Number()`.
    for (const junk of ['', false, [], undefined]) {
      expect(resolvePrefs({ quietStart: junk, quietEnd: junk }).quietStart).toBeNull();
    }
  });

  it('heals rows already written by the coercion bug ({0,0} means off)', () => {
    // Users who tapped "Off" before the fix have this persisted. Without
    // normalising, the parsing fix alone would leave them stuck.
    const prefs = resolvePrefs({ quietStart: 0, quietEnd: 0 });
    expect(prefs.quietStart).toBeNull();
    expect(prefs.quietEnd).toBeNull();
  });

  it('preserves a genuine window, including one that wraps midnight', () => {
    const prefs = resolvePrefs({ quietStart: 22, quietEnd: 7 });
    expect(prefs.quietStart).toBe(22);
    expect(prefs.quietEnd).toBe(7);
  });

  it('preserves a genuine window that starts at midnight', () => {
    // Proves the {0,0} healing above is about the ZERO-LENGTH window, not about
    // distrusting hour 0 — "Midnight – 6am" is a real preset on the screen.
    const prefs = resolvePrefs({ quietStart: 0, quietEnd: 6 });
    expect(prefs.quietStart).toBe(0);
    expect(prefs.quietEnd).toBe(6);
  });

  it('treats a half-specified window as off rather than inventing a bound', () => {
    expect(resolvePrefs({ quietStart: 22, quietEnd: null }).quietStart).toBeNull();
    expect(resolvePrefs({ quietStart: null, quietEnd: 7 }).quietEnd).toBeNull();
  });

  it('rejects out-of-range and non-integer hours', () => {
    expect(resolvePrefs({ quietStart: 24, quietEnd: 7 }).quietStart).toBeNull();
    expect(resolvePrefs({ quietStart: -1, quietEnd: 7 }).quietStart).toBeNull();
    expect(resolvePrefs({ quietStart: 22.5, quietEnd: 7 }).quietStart).toBeNull();
  });

  it('serializes "off" by omitting the keys entirely', () => {
    const out = serializePrefs(resolvePrefs({ quietStart: null, quietEnd: null }));
    expect(out).not.toHaveProperty('quietStart');
    expect(out).not.toHaveProperty('quietEnd');
  });

  it('survives a serialize → resolve round trip in both states', () => {
    const off = resolvePrefs(serializePrefs(resolvePrefs({ quietStart: null, quietEnd: null })));
    expect(off.quietStart).toBeNull();

    const on = resolvePrefs(serializePrefs(resolvePrefs({ quietStart: 23, quietEnd: 8 })));
    expect([on.quietStart, on.quietEnd]).toEqual([23, 8]);
  });
});

describe('quiet hours: the gate itself', () => {
  const at = (hour: number) => Date.UTC(2026, 0, 1, hour, 30);

  it('suppresses inside a window that wraps midnight, allows outside it', () => {
    const prefs = { ...DEFAULT_PREFS, quietStart: 22, quietEnd: 7 };
    expect(isInQuietHours(prefs, at(23))).toBe(true);
    expect(isInQuietHours(prefs, at(3))).toBe(true);
    expect(isInQuietHours(prefs, at(12))).toBe(false);
    // Boundaries: start inclusive, end exclusive.
    expect(isInQuietHours({ ...prefs, quietStart: 22, quietEnd: 7 }, Date.UTC(2026, 0, 1, 7, 0))).toBe(false);
  });

  it('applies the local offset rather than UTC', () => {
    // 22:30 UTC is 04:00 IST the next day, which is inside a 22->7 window.
    const ist = { ...DEFAULT_PREFS, quietStart: 22, quietEnd: 7, utcOffsetMinutes: 330 };
    expect(isInQuietHours(ist, Date.UTC(2026, 0, 1, 22, 30))).toBe(true);
    // 14:00 UTC is 19:30 IST — outside it.
    expect(isInQuietHours(ist, Date.UTC(2026, 0, 1, 14, 0))).toBe(false);
  });

  it('never suppresses when quiet hours are off', () => {
    expect(isInQuietHours(DEFAULT_PREFS, at(3))).toBe(false);
  });
});

describe('notification categories', () => {
  /**
   * Both of these types were unmapped and fell through to the `social` default.
   * For `match_active` that was actively wrong in two ways: muting "likes,
   * comments & follows" also muted the notification telling you your own battle
   * had gone live, and the push was posted to the `social` Android channel — so
   * the OS-level per-channel controls were wrong too.
   */
  it('files "your battle is live" under contest, not social', () => {
    expect(categoryForType('match_active')).toBe('contest');
  });

  it('files level-ups under social deliberately, not wallet', () => {
    // A level-up awards a badge, never coins. Putting it in `wallet` would mean a
    // user muting XP spam also muted payout confirmations.
    expect(categoryForType('level_up')).toBe('social');
  });

  it('still falls back to social for genuinely unknown types', () => {
    expect(categoryForType('some_future_type')).toBe('social');
  });
});

describe('shouldSendPush honours every control', () => {
  it('blocks everything when the master switch is off', () => {
    expect(shouldSendPush({ ...DEFAULT_PREFS, push: false }, 'follow')).toBe(false);
  });

  it('blocks only the muted category', () => {
    const prefs = { ...DEFAULT_PREFS, contest: false };
    expect(shouldSendPush(prefs, 'match_active')).toBe(false);
    expect(shouldSendPush(prefs, 'withdrawal')).toBe(true);
  });

  it('blocks during quiet hours', () => {
    const prefs = { ...DEFAULT_PREFS, quietStart: 22, quietEnd: 7 };
    expect(shouldSendPush(prefs, 'follow', Date.UTC(2026, 0, 1, 23, 0))).toBe(false);
    expect(shouldSendPush(prefs, 'follow', Date.UTC(2026, 0, 1, 12, 0))).toBe(true);
  });

  it('allows by default', () => {
    expect(shouldSendPush(DEFAULT_PREFS, 'follow')).toBe(true);
  });
});

describe('preferences round trip through the API the settings screen calls', () => {
  it('persists a quiet window and then clears it', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');

    // Pick "10pm – 7am".
    const set = await call(env, 'u1', 'updateNotificationPrefs', {
      prefs: { quietStart: 22, quietEnd: 7, utcOffsetMinutes: 330 },
    });
    expect(set.status).toBe(200);
    expect(set.body.prefs.quietStart).toBe(22);

    let got = await call(env, 'u1', 'getNotificationPrefs');
    expect([got.body.prefs.quietStart, got.body.prefs.quietEnd]).toEqual([22, 7]);
    expect(got.body.prefs.utcOffsetMinutes).toBe(330);

    // Now pick "Off" — this is the exact payload notifications.tsx sends.
    const off = await call(env, 'u1', 'updateNotificationPrefs', {
      prefs: { quietStart: null, quietEnd: null, utcOffsetMinutes: 330 },
    });
    expect(off.status).toBe(200);
    expect(off.body.prefs.quietStart).toBeNull();

    // The read-back is what the screen renders on next open. Before the fix this
    // came back as 0/0, so the Off row appeared unselected.
    got = await call(env, 'u1', 'getNotificationPrefs');
    expect(got.body.prefs.quietStart).toBeNull();
    expect(got.body.prefs.quietEnd).toBeNull();
  });

  it('patches one key without clobbering the others', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');

    await call(env, 'u1', 'updateNotificationPrefs', { prefs: { social: false, quietStart: 23, quietEnd: 8 } });
    const res = await call(env, 'u1', 'updateNotificationPrefs', { prefs: { wallet: false } });

    expect(res.body.prefs.social).toBe(false);
    expect(res.body.prefs.wallet).toBe(false);
    expect(res.body.prefs.contest).toBe(true);
    expect(res.body.prefs.quietStart).toBe(23);
  });

  it('defaults to everything enabled for a user who never opened settings', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1');
    const got = await call(env, 'u1', 'getNotificationPrefs');
    expect(got.body.prefs).toMatchObject({
      social: true, contest: true, wallet: true, admin: true, push: true,
      quietStart: null, quietEnd: null,
    });
  });
});

describe('sendPushNotification respects preferences', () => {
  /**
   * `sendPushNotification` is the "push, no in-app row" path. It read only
   * `fcm_tokens` and went straight to delivery, so the two features using it —
   * "Match Live!" and "Level Up!" — ignored the master switch, the category
   * toggle and quiet hours completely. Turning notifications off in the app did
   * not stop them.
   */
  const withPrefs = async (prefs: Record<string, unknown>) => {
    const { env } = makeEnv();
    await seedUser(env, 'u1', { fcmTokens: ['tok-1'], notificationPrefs: prefs });
    return env;
  };

  it('sends when nothing is muted', async () => {
    const env = await withPrefs({});
    await sendPushNotification(env as any, 'u1', 'Match Live! 🚀', 'body', 'match_active');
    expect(fcmSends).toHaveLength(1);
  });

  it('sends nothing when the master push switch is off', async () => {
    const env = await withPrefs({ push: false });
    await sendPushNotification(env as any, 'u1', 'Match Live! 🚀', 'body', 'match_active');
    expect(fcmSends).toHaveLength(0);
  });

  it('sends nothing when the notification\'s own category is muted', async () => {
    const env = await withPrefs({ contest: false });
    await sendPushNotification(env as any, 'u1', 'Match Live! 🚀', 'body', 'match_active');
    expect(fcmSends).toHaveLength(0);
  });

  it('still sends when a DIFFERENT category is muted', async () => {
    const env = await withPrefs({ social: false });
    await sendPushNotification(env as any, 'u1', 'Match Live! 🚀', 'body', 'match_active');
    expect(fcmSends).toHaveLength(1);
  });

  it('sends nothing during quiet hours', async () => {
    const env = await withPrefs({ quietStart: 0, quietEnd: 23, utcOffsetMinutes: 0 });
    // A 0->23 window covers all but one hour of the day; assert against a time
    // inside it explicitly rather than depending on when the suite runs.
    vi.setSystemTime(Date.UTC(2026, 0, 1, 5, 0));
    try {
      await sendPushNotification(env as any, 'u1', 'Level Up! 🌟', 'body', 'level_up');
      expect(fcmSends).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('routes the push to the Android channel for its real category', async () => {
    const env = await withPrefs({});
    await sendPushNotification(env as any, 'u1', 'Match Live! 🚀', 'body', 'match_active');
    // Was `social` while the type was unmapped.
    expect(fcmSends[0].options.androidChannelId).toBe('contest');
  });

  it('is a no-op for a user with no registered devices', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'u1', { fcmTokens: [] });
    await sendPushNotification(env as any, 'u1', 'x', 'y', 'match_active');
    expect(fcmSends).toHaveLength(0);
  });
});

describe('account deletion clears block and mute relations', () => {
  /**
   * Deletion ANONYMISES the users row rather than removing it, so nothing made
   * these rows fall out of anyone's list on their own: the other user's
   * "Blocked & Muted" screen kept showing a permanent "Deleted user" entry whose
   * only escape was to unblock a ghost.
   */
  it('removes rows in both directions and drops the entry from the other user\'s list', async () => {
    const { env } = makeEnv();
    const db = drizzleOf(env);
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');

    // alice blocks bob; bob blocks and mutes alice.
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });
    await call(env, 'bob', 'blockUser', { targetUserId: 'alice' });
    await call(env, 'bob', 'muteUser', { targetUserId: 'alice' });

    const before = await read(env, 'alice', '/blocked');
    expect(before.body.blocked.map((u: any) => u.uid)).toContain('bob');

    await deleteOwnAccount(env as any, 'bob');

    // No row in either table mentions bob, in either column.
    const blocks = await db.select().from(schema.userBlocks).all();
    const mutes = await db.select().from(schema.userMutes).all();
    expect(blocks.some((r: any) => r.blockerId === 'bob' || r.blockedId === 'bob')).toBe(false);
    expect(mutes.some((r: any) => r.muterId === 'bob' || r.mutedId === 'bob')).toBe(false);

    // And alice's management screen is clean — this is the user-visible part.
    const after = await read(env, 'alice', '/blocked');
    expect(after.body.blocked.map((u: any) => u.uid)).not.toContain('bob');
    expect(after.body.muted.map((u: any) => u.uid)).not.toContain('bob');
  });

  it('leaves unrelated relations untouched', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await seedUser(env, 'carol');

    await call(env, 'alice', 'blockUser', { targetUserId: 'carol' });
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    await deleteOwnAccount(env as any, 'bob');

    const after = await read(env, 'alice', '/blocked');
    expect(after.body.blocked.map((u: any) => u.uid)).toEqual(['carol']);
  });

  it('hides relations orphaned by deletions that happened BEFORE this fix', async () => {
    // No backfill migration ships with the fix, so the read path has to tolerate
    // rows left behind by older deletions. Simulates that exact state: an
    // anonymised account with a surviving block row.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'ghost', {
      username: 'deleted_ghost',
      fullName: 'Deleted user',
      status: 'deleted',
    });
    await drizzleOf(env)
      .insert(schema.userBlocks)
      .values({ blockerId: 'alice', blockedId: 'ghost', createdAt: Date.now() } as any);

    const res = await read(env, 'alice', '/blocked');
    expect(res.status).toBe(200);
    expect(res.body.blocked).toEqual([]);
  });

  it('does not leak the internal status field to the client', async () => {
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    const res = await read(env, 'alice', '/blocked');
    expect(res.body.blocked).toHaveLength(1);
    expect(res.body.blocked[0]).not.toHaveProperty('status');
    // The shape app/setting/blocked.tsx actually renders.
    expect(res.body.blocked[0]).toMatchObject({ uid: 'bob', username: 'bob' });
  });

  it('invalidates the counterparty\'s cached relations', async () => {
    // getRelations is KV-cached and the cache outlives the rows, so a stale entry
    // would keep filtering the deleted account out of alice's feed.
    const { env } = makeEnv();
    await seedUser(env, 'alice');
    await seedUser(env, 'bob');
    await call(env, 'alice', 'blockUser', { targetUserId: 'bob' });

    // Warm alice's cache.
    await read(env, 'alice', '/blocked');
    expect(env.CACHE_KV._map.has('cache:blocks:alice')).toBe(true);

    await deleteOwnAccount(env as any, 'bob');

    expect(env.CACHE_KV._map.has('cache:blocks:alice')).toBe(false);
    // The deleted user's own entry goes too.
    expect(env.CACHE_KV._map.has('cache:blocks:bob')).toBe(false);
  });
});
