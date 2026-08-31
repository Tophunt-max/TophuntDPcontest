import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { deleteAuthUser } from "./firebaseAdmin";
import { deleteMediaByUrl } from "./mediaDelete";
import { deleteVideo } from "./bunny";
import { newId, now } from "./ids";
import { invalidateBlockCache } from "./blocks";
import {
  delCache,
  feedSeenKey,
  followersCacheKey,
  followingCacheKey,
  userCacheKey,
} from "./cache";
import { getAppConfig } from "./settings";
import { publish } from "./publish";
import { DELETED_STATUS, PENDING_DELETION_STATUS, parseGraceDays } from "./accountStatus";

/**
 * Self-service account deletion.
 *
 * Both app stores require an in-app way to delete an account. The first version
 * of this file did the whole thing inside a single request, and three properties
 * of that turned out to be wrong in ways worth spelling out, because the shape
 * of the current code is a direct response to each.
 *
 * 1. IT REFUSED. A pending payout or an unfinished contest made the request throw
 *    `failed-precondition`, and the client hid its own delete button while that
 *    was true. So the one flow the stores mandate could be unavailable for days
 *    with no recourse. A deletion request is now always ACCEPTED; a genuine
 *    in-flight obligation moves `scheduled_for` instead of rejecting the user.
 *
 * 2. IT WAS INSTANT AND UNRECOVERABLE. One mistap, one stolen phone, one bad
 *    evening, and the account was gone. There is now a grace period, and an
 *    explicit cancellation path during it. The account is unusable and invisible
 *    from the moment it is requested, so "deleted" is honest from the user's
 *    point of view, but the data still exists until the grace period lapses.
 *
 * 3. IT WAS NOT RESUMABLE. The work spans two D1 batches plus R2, Bunny, KV and
 *    Firebase. A failure part-way left an account half-deleted, and nothing
 *    recorded how far it had got — so nothing could finish it and nobody could
 *    tell it had stalled. The purge is now a phase machine persisted on
 *    `deletion_requests.phase`, driven by cron, and each phase is idempotent.
 *
 * What is NOT deleted, and why. This list is load-bearing: it is mirrored in the
 * privacy policy (content/legal.ts) and asserted by test/accountDeletion.test.ts.
 *
 *  - `coin_transactions`, `payments`, `payment_orders`, `deposits`, `withdrawals`
 *    — financial records, retained for the period Indian tax and accounting law
 *    requires, keyed by a uid that no longer resolves to a person.
 *  - `votes`, `vote_xp_awards`, `contest_matches` — other people entered those
 *    contests and their results depend on these rows. The match SURVIVES, but its
 *    participant snapshot is anonymised and the entry media is destroyed (see
 *    `anonymiseMatchSnapshots`), because a photograph of a face is personal data
 *    no matter whose leaderboard it props up.
 *  - `referrals` — the bonus ledger for the OTHER side of the referral.
 *  - `admin_audit_log` — the record of admin actions, which must not be editable
 *    by the subject of those actions.
 *  - `account_deletions` — the compliance record of the deletion itself. Holds no
 *    personal data.
 *
 * Everything else belonging to the user is destroyed.
 */

export { PENDING_DELETION_STATUS, DELETED_STATUS } from "./accountStatus";

/** How long a deferral (live contest, pending payout) pushes the purge out by. */
const DEFERRAL_RECHECK_MS = 24 * 60 * 60 * 1000;
/** Give up automated retries after this many failed purge attempts. */
const MAX_PURGE_ATTEMPTS = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Something in flight that must settle before the data can be erased.
 *
 * Deliberately called a DEFERRAL and not a blocker. It delays the purge; it does
 * not refuse the request. The distinction is the whole point of this rewrite —
 * see note 1 in the file header.
 */
export type DeferralCode = "pending_payout" | "active_contest";

export interface DeletionDeferral {
  code: DeferralCode;
  message: string;
  detail?: Record<string, unknown>;
}

export interface DeletionWarning {
  code: "positive_balance";
  message: string;
  detail?: Record<string, unknown>;
}

export interface DeletionRequestView {
  status: "pending" | "processing" | "completed" | "cancelled";
  reason: string | null;
  requestedAt: number;
  scheduledFor: number;
  deferredReason: string | null;
  deferredUntil: number | null;
  balanceAtRequest: number;
}

export interface DeletionEligibility {
  /**
   * Always true. Retained ONLY because shipped app builds gate their delete
   * button on this field, and a build that reads `false` renders a screen with
   * no way forward — the exact bug this rewrite exists to fix. A deletion
   * request is never refused, so nothing may set this to false again.
   */
  deletable: true;
  /**
   * Backwards-compatible alias for `deferrals`. Old builds render these as the
   * reasons they cannot proceed; new builds render them as "when", not "whether".
   */
  blockers: DeletionDeferral[];
  deferrals: DeletionDeferral[];
  warnings: DeletionWarning[];
  /** Coins that will be forfeited if the user proceeds. */
  balance: number;
  gracePeriodDays: number;
  /** When the purge would run if the user requested deletion right now. */
  wouldPurgeAt: number;
  /** The user's existing request, if they already asked. */
  request: DeletionRequestView | null;
}

/**
 * Admin-configurable grace period, clamped.
 *
 * Parsing lives in lib/accountStatus.ts because content/legal.ts needs the same
 * number to state it in the privacy policy, and two copies would drift.
 */
export async function gracePeriodDays(env: Env): Promise<number> {
  const cfg = await getAppConfig(env).catch(() => null);
  return parseGraceDays((cfg as any)?.accountDeletionGraceDays);
}

/**
 * What stands between this account and erasure right now.
 *
 * A positive balance is a WARNING: the user is entitled to delete their account,
 * they just need to be told the coins go with it. Money and contests actually in
 * flight are DEFERRALS: the request is accepted and the purge waits.
 */
export async function checkDeletionEligibility(env: Env, uid: string): Promise<DeletionEligibility> {
  const db = getDb(env);

  const user = await db
    .select({ balance: schema.users.dpcoin, status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (!user) throw httpsError("not-found", "Account not found.");
  if (user.status === DELETED_STATUS) {
    throw httpsError("failed-precondition", "This account has already been deleted.");
  }

  const [deferrals, existing, graceDays] = await Promise.all([
    findDeferrals(env, uid),
    db.select().from(schema.deletionRequests).where(eq(schema.deletionRequests.uid, uid)).get(),
    gracePeriodDays(env),
  ]);

  const balance = Number(user.balance || 0);
  const warnings: DeletionWarning[] = [];
  if (balance > 0) {
    warnings.push({
      code: "positive_balance",
      message: `Your remaining ${balance} coins will be forfeited and cannot be recovered.`,
      detail: { balance },
    });
  }

  const ts = now();
  const graceEnd = ts + graceDays * DAY_MS;
  const deferredTo = deferrals.length ? ts + DEFERRAL_RECHECK_MS : 0;

  const active =
    existing && (existing.status === "pending" || existing.status === "processing") ? existing : null;

  return {
    deletable: true,
    blockers: deferrals,
    deferrals,
    warnings,
    balance,
    gracePeriodDays: graceDays,
    wouldPurgeAt: Math.max(graceEnd, deferredTo),
    request: active
      ? {
          status: active.status as DeletionRequestView["status"],
          reason: active.reason ?? null,
          requestedAt: active.requestedAt,
          scheduledFor: active.scheduledFor,
          deferredReason: active.deferredReason ?? null,
          deferredUntil: active.deferredUntil ?? null,
          balanceAtRequest: Number(active.balanceAtRequest || 0),
        }
      : null,
  };
}

/** In-flight obligations that must settle before the data can be erased. */
async function findDeferrals(env: Env, uid: string): Promise<DeletionDeferral[]> {
  const db = getDb(env);
  const deferrals: DeletionDeferral[] = [];

  const pendingPayouts = await db
    .select({ id: schema.withdrawals.id })
    .from(schema.withdrawals)
    .where(
      and(
        eq(schema.withdrawals.userId, uid),
        inArray(schema.withdrawals.status, ["pending", "approved"]),
      ),
    )
    .all();
  if (pendingPayouts.length > 0) {
    deferrals.push({
      code: "pending_payout",
      message:
        "Your payout is still being processed. Your account will be deleted once it has been paid or rejected.",
      detail: { withdrawals: pendingPayouts.length },
    });
  }

  // A match this user is in has an opponent who paid to enter it. Participants
  // live in the userA/userB JSON snapshots, so this is a JSON match rather than a
  // column comparison.
  const liveForUser = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM contest_matches
      WHERE status IN ('waiting_for_opponent','active')
        AND (json_extract(user_a, '$.uid') = ? OR json_extract(user_b, '$.uid') = ?)`,
  )
    .bind(uid, uid)
    .first<{ n: number }>();
  const liveCount = Number(liveForUser?.n || 0);
  if (liveCount > 0) {
    deferrals.push({
      code: "active_contest",
      message:
        "You are in a contest that has not finished yet. Your account will be deleted once it is resolved.",
      detail: { matches: liveCount },
    });
  }

  return deferrals;
}

// ---------------------------------------------------------------------------
// Request / cancel
// ---------------------------------------------------------------------------

export interface RequestDeletionResult {
  scheduledFor: number;
  gracePeriodDays: number;
  deferrals: DeletionDeferral[];
  forfeitedCoins: number;
  /** True when the request already existed — this call was a no-op refresh. */
  alreadyRequested: boolean;
}

/**
 * Accept a deletion request and start the clock.
 *
 * The account is taken out of service IMMEDIATELY — `status` flips to
 * `pending_deletion`, which hides it from every public read path and rejects
 * every mutating action except cancelling. That is what makes it honest to tell
 * the user their account is gone while the data still exists for the grace
 * period. `isBlocked` is deliberately NOT set: the user must still be able to
 * sign in, because signing in is how they cancel.
 */
export async function requestAccountDeletion(
  env: Env,
  uid: string,
  opts: { reason?: string; source?: "app" | "web" | "admin" } = {},
): Promise<RequestDeletionResult> {
  const db = getDb(env);
  const eligibility = await checkDeletionEligibility(env, uid);
  const ts = now();
  const graceDays = eligibility.gracePeriodDays;

  const existing = await db
    .select()
    .from(schema.deletionRequests)
    .where(eq(schema.deletionRequests.uid, uid))
    .get();

  if (existing && (existing.status === "pending" || existing.status === "processing")) {
    // Idempotent: asking twice must not extend the wait, which would let a
    // confused user push their own deletion out indefinitely.
    return {
      scheduledFor: existing.scheduledFor,
      gracePeriodDays: graceDays,
      deferrals: eligibility.deferrals,
      forfeitedCoins: Number(existing.balanceAtRequest || 0),
      alreadyRequested: true,
    };
  }

  const scheduledFor = eligibility.wouldPurgeAt;
  const reason = opts.reason ? String(opts.reason).slice(0, 500) : null;
  const deferral = eligibility.deferrals[0] || null;

  const row = {
    uid,
    status: "pending" as const,
    reason,
    requestedAt: ts,
    scheduledFor,
    deferredReason: deferral?.code ?? null,
    deferredUntil: deferral ? scheduledFor : null,
    phase: null,
    mediaUrls: null,
    attempts: 0,
    lastError: null,
    balanceAtRequest: eligibility.balance,
    source: opts.source || "app",
    cancelledAt: null,
    completedAt: null,
    createdAt: ts,
    updatedAt: ts,
  };

  await db.batch([
    // `onConflictDoUpdate` rather than insert: a previously CANCELLED request
    // leaves a row behind, and a user is allowed to change their mind twice.
    db
      .insert(schema.deletionRequests)
      .values(row)
      .onConflictDoUpdate({ target: schema.deletionRequests.uid, set: row }),
    db
      .update(schema.users)
      .set({ status: PENDING_DELETION_STATUS, isPrivate: true, fcmTokens: [], updatedAt: ts })
      .where(eq(schema.users.uid, uid)),
  ]);

  // Out of every public listing and cached profile from this moment on.
  await invalidateUserCaches(env, uid);

  return {
    scheduledFor,
    gracePeriodDays: graceDays,
    deferrals: eligibility.deferrals,
    forfeitedCoins: eligibility.balance,
    alreadyRequested: false,
  };
}

/**
 * Stop a pending deletion and put the account back into service.
 *
 * Only valid while nothing has been destroyed yet. Once the purge has started
 * touching data (`status = 'processing'`) there is nothing left to restore, and
 * pretending otherwise would be the worst possible answer.
 */
export async function cancelAccountDeletion(env: Env, uid: string): Promise<{ cancelled: boolean }> {
  const db = getDb(env);
  const existing = await db
    .select()
    .from(schema.deletionRequests)
    .where(eq(schema.deletionRequests.uid, uid))
    .get();

  if (!existing || existing.status === "cancelled") {
    // Idempotent: a double tap, or a client retrying, is not an error.
    return { cancelled: false };
  }
  if (existing.status === "completed") {
    throw httpsError("failed-precondition", "This account has already been deleted.");
  }
  if (existing.status === "processing") {
    throw httpsError(
      "failed-precondition",
      "Your account is already being deleted and can no longer be restored.",
    );
  }

  const ts = now();
  await db.batch([
    db
      .update(schema.deletionRequests)
      .set({ status: "cancelled", cancelledAt: ts, updatedAt: ts })
      .where(eq(schema.deletionRequests.uid, uid)),
    // Back to `active`. `isPrivate` is deliberately NOT restored: it was forced
    // on at request time and we cannot know what it was before, so leaving it on
    // is the choice that cannot leak anything. The user can turn it off.
    db
      .update(schema.users)
      .set({ status: "active", updatedAt: ts })
      .where(eq(schema.users.uid, uid)),
  ]);

  await invalidateUserCaches(env, uid);
  return { cancelled: true };
}

// ---------------------------------------------------------------------------
// The purge
// ---------------------------------------------------------------------------

/** Ordered phases. Each is idempotent so a retry can safely re-run the current one. */
const PHASES = ["snapshots", "media", "content", "social", "auth", "done"] as const;
export type DeletionPhase = (typeof PHASES)[number];

export interface DeletionResult {
  uid: string;
  deletedAt: number;
  /** Media objects removed (or attempted). */
  mediaUrls: string[];
  forfeitedCoins: number;
}

/**
 * Run the purge for one account, from wherever it last got to.
 *
 * Ordering is not arbitrary. `snapshots` runs first because it is the phase that
 * makes the identity disappear — every later phase is cleanup that can be
 * retried without the user's name being visible in the meantime. Media URLs are
 * captured in that same first phase and persisted on the request row, because
 * the rows holding them are deleted two phases later.
 */
export async function executeAccountDeletion(
  env: Env,
  uid: string,
  reason?: string,
): Promise<DeletionResult> {
  const db = getDb(env);

  let request = await db
    .select()
    .from(schema.deletionRequests)
    .where(eq(schema.deletionRequests.uid, uid))
    .get();

  const startTs = now();

  // A direct purge (admin action, or a legacy client calling `deleteAccount`
  // with the grace period configured to zero) has no request row yet.
  if (!request) {
    const balance =
      Number(
        (
          await db
            .select({ balance: schema.users.dpcoin })
            .from(schema.users)
            .where(eq(schema.users.uid, uid))
            .get()
        )?.balance || 0,
      ) || 0;
    const row = {
      uid,
      status: "processing" as const,
      reason: reason ? String(reason).slice(0, 500) : null,
      requestedAt: startTs,
      scheduledFor: startTs,
      deferredReason: null,
      deferredUntil: null,
      phase: null,
      mediaUrls: null,
      attempts: 0,
      lastError: null,
      balanceAtRequest: balance,
      source: "app" as const,
      cancelledAt: null,
      completedAt: null,
      createdAt: startTs,
      updatedAt: startTs,
    };
    await db
      .insert(schema.deletionRequests)
      .values(row)
      .onConflictDoUpdate({ target: schema.deletionRequests.uid, set: row });
    request = await db
      .select()
      .from(schema.deletionRequests)
      .where(eq(schema.deletionRequests.uid, uid))
      .get();
  }
  if (!request) throw httpsError("not-found", "Account not found.");

  if (request.status === "completed") {
    return {
      uid,
      deletedAt: request.completedAt || request.updatedAt,
      mediaUrls: request.mediaUrls || [],
      forfeitedCoins: Number(request.balanceAtRequest || 0),
    };
  }

  await db
    .update(schema.deletionRequests)
    .set({
      status: "processing",
      attempts: (request.attempts || 0) + 1,
      updatedAt: startTs,
    })
    .where(eq(schema.deletionRequests.uid, uid));

  const effectiveReason = reason ?? request.reason ?? undefined;
  let phase = (request.phase as DeletionPhase | null) ?? PHASES[0];
  let mediaUrls: string[] = request.mediaUrls || [];

  try {
    while (phase !== "done") {
      switch (phase) {
        case "snapshots":
          mediaUrls = await phaseSnapshots(env, uid);
          break;
        case "media":
          await phaseMedia(env, uid, mediaUrls);
          break;
        case "content":
          await phaseContent(env, uid);
          break;
        case "social":
          await phaseSocial(env, uid);
          break;
        case "auth":
          await phaseAuth(env, uid, effectiveReason);
          break;
      }
      phase = PHASES[PHASES.indexOf(phase) + 1];
      await db
        .update(schema.deletionRequests)
        .set({
          phase,
          // Persisted here rather than inside the phase so the write happens once
          // per phase transition instead of once per collected URL.
          mediaUrls: phase === "media" ? mediaUrls : undefined,
          updatedAt: now(),
        })
        .where(eq(schema.deletionRequests.uid, uid));
    }
  } catch (e: any) {
    // Record where it stopped, so the next cron tick resumes instead of
    // restarting, and so a stalled deletion is visible to an admin rather than
    // living only in a log line.
    const message = String(e?.message || e).slice(0, 1000);
    await db
      .update(schema.deletionRequests)
      .set({ status: "pending", phase, lastError: message, updatedAt: now() })
      .where(eq(schema.deletionRequests.uid, uid))
      .catch(() => {});
    console.error("[accountDeletion] purge failed", uid, phase, e);
    throw e;
  }

  const completedAt = now();
  await db
    .update(schema.deletionRequests)
    .set({ status: "completed", phase: "done", completedAt, lastError: null, updatedAt: completedAt })
    .where(eq(schema.deletionRequests.uid, uid));

  return {
    uid,
    deletedAt: completedAt,
    mediaUrls,
    forfeitedCoins: await readForfeitedCoins(env, uid),
  };
}

/**
 * What was ACTUALLY forfeited, read back from the ledger.
 *
 * Not `balance_at_request`: that is the figure quoted to the user when they
 * asked, and a contest can settle in their favour during the grace period. The
 * ledger row is the only value that matches the balance the purge actually
 * zeroed, and it is also the one that survives a resumed purge — a local
 * variable would not.
 */
async function readForfeitedCoins(env: Env, uid: string): Promise<number> {
  const row = await getDb(env)
    .select({ amount: schema.coinTransactions.amount })
    .from(schema.coinTransactions)
    .where(eq(schema.coinTransactions.id, `account_deletion:${uid}`))
    .get();
  return Math.abs(Number(row?.amount || 0));
}

/**
 * Legacy name, kept because callers and tests reference it.
 *
 * Semantics are unchanged from the original implementation: purge NOW, all the
 * way through, and throw if something in flight makes that unsafe. The grace
 * period lives in `requestAccountDeletion`, not here.
 */
export async function deleteOwnAccount(
  env: Env,
  uid: string,
  reason?: string,
): Promise<DeletionResult> {
  const deferrals = await findDeferrals(env, uid);
  if (deferrals.length > 0) {
    throw httpsError("failed-precondition", deferrals.map((d) => d.message).join(" "));
  }
  return executeAccountDeletion(env, uid, reason);
}

/**
 * Phase 1 — make the identity disappear, and capture what to purge later.
 *
 * Everything that renders a name or a face is rewritten here: the `users` row,
 * the participant snapshots inside `contest_matches`, and the cached member list
 * inside `chats`. The last two are JSON blobs rather than foreign keys, so no
 * amount of anonymising the `users` row reaches them — which is exactly how the
 * original implementation left a deleted user's real name and photo sitting in
 * every conversation and every battle they had ever been in.
 */
async function phaseSnapshots(env: Env, uid: string): Promise<string[]> {
  const db = getDb(env);
  const ts = now();

  const media = new Set<string>();
  const user = await db
    .select({ avatar: schema.users.profileImageUrl, balance: schema.users.dpcoin })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (user?.avatar) media.add(user.avatar);
  for (const row of await db
    .select({ url: schema.posts.mediaUrl })
    .from(schema.posts)
    .where(eq(schema.posts.userId, uid))
    .all()) {
    if (row.url) media.add(row.url);
  }
  for (const row of await db
    .select({ url: schema.stories.mediaUrl })
    .from(schema.stories)
    .where(eq(schema.stories.userId, uid))
    .all()) {
    if (row.url) media.add(row.url);
  }

  const balance = Number(user?.balance || 0);
  const suffix = uid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "") || newId().slice(0, 6);
  const anonUsername = `deleted_${suffix}`;

  // Forfeiting the balance is a balance change, so it needs a ledger row like
  // every other one. Without it a per-user replay of `coin_transactions` would
  // not sum to the stored balance, and that reconciliation is what the
  // platform-liability figure depends on. Deterministic id, so a resumed or
  // retried purge cannot record the forfeiture twice.
  const forfeitLedger =
    balance > 0
      ? db
          .insert(schema.coinTransactions)
          .values({
            id: `account_deletion:${uid}`,
            uid,
            amount: -balance,
            type: "account_deletion_forfeit",
            description: "Coins forfeited on account deletion",
            createdAt: ts,
          })
          .onConflictDoNothing()
      : null;

  await db.batch([
    ...(forfeitLedger ? [forfeitLedger] : []),
    // Every personal field cleared. `isBlocked` + `status` also make any
    // still-valid Firebase ID token useless immediately, because requireAuth
    // re-checks D1 on every request.
    db
      .update(schema.users)
      .set({
        email: null,
        phone: null,
        username: anonUsername,
        fullName: "Deleted user",
        profileImageUrl: null,
        bio: null,
        dob: null,
        gender: null,
        occupation: null,
        coordinates: null,
        extra: null,
        fcmTokens: [],
        notificationPrefs: null,
        referralCode: null,
        referredBy: null,
        equippedBadge: null,
        isBlocked: true,
        status: DELETED_STATUS,
        isPrivate: true,
        dpcoin: 0,
        updatedAt: ts,
      })
      .where(eq(schema.users.uid, uid)),
  ] as any);

  await anonymiseMatchSnapshots(env, uid, media);
  await anonymiseChatSnapshots(env, uid);

  // Any Bunny video this user owns, including contest-entry videos and abandoned
  // uploads that never got attached to anything — neither is reachable from
  // `posts` or `stories`, so collecting only those two left paid-for footage of
  // a deleted user's face in the library indefinitely.
  for (const row of await db
    .select({
      id: schema.videos.id,
      playbackUrl: schema.videos.playbackUrl,
      mp4Url: schema.videos.mp4Url,
    })
    .from(schema.videos)
    .where(eq(schema.videos.ownerUid, uid))
    .all()) {
    if (row.playbackUrl) media.add(row.playbackUrl);
    else if (row.mp4Url) media.add(row.mp4Url);
    // A row that never reached `ready` has no URL at all; the guid is the only
    // handle on it, so it is purged directly in the media phase.
  }

  return [...media];
}

/**
 * Anonymise this user's participant snapshots inside `contest_matches`.
 *
 * The match row itself is retained: other people entered these contests, voted
 * in them and were paid out of them, and deleting the row would orphan all of
 * that. But the snapshot carries `username`, `profilePic`, `caption` and
 * `mediaUrl`, and those are personal data — a photograph of a face does not stop
 * being personal data because it is propping up someone else's win record. So
 * the row survives with the identity stripped and the entry media destroyed.
 *
 * `json_set` rather than a read-modify-write: the update has to be atomic
 * against the settlement path, which rewrites the same column.
 */
async function anonymiseMatchSnapshots(env: Env, uid: string, media: Set<string>): Promise<void> {
  for (const side of ["user_a", "user_b"] as const) {
    const rows = await env.DB.prepare(
      `SELECT id, json_extract(${side}, '$.mediaUrl') AS media_url
         FROM contest_matches
        WHERE json_extract(${side}, '$.uid') = ?`,
    )
      .bind(uid)
      .all<{ id: string; media_url: string | null }>();

    for (const row of rows.results || []) {
      if (row.media_url) media.add(row.media_url);
    }
    if (!(rows.results || []).length) continue;

    await env.DB.prepare(
      `UPDATE contest_matches
          SET ${side} = json_set(
                ${side},
                '$.username',   'Deleted user',
                '$.profilePic', json('null'),
                '$.mediaUrl',   json('null'),
                '$.caption',    json('null')
              )
        WHERE json_extract(${side}, '$.uid') = ?`,
    )
      .bind(uid)
      .run();
  }
}

/**
 * Anonymise this user's entry in every conversation's cached member list, and
 * scrub their words from the thread preview.
 *
 * `messages` are deleted in the content phase, but the THREAD survives — the
 * other participant is entitled to their side of it. `chats.users_data` caches
 * each member's display name and photo at the time the chat was created, so
 * without this the counterparty's inbox kept showing the deleted user's real
 * name and avatar forever, and `last_message` kept showing a sentence they had
 * asked to have erased.
 *
 * Done in JS rather than SQL because `users_data` is a JSON ARRAY and rewriting
 * one element needs its index; the number of conversations per user is small and
 * bounded by how many people they have actually talked to.
 */
async function anonymiseChatSnapshots(env: Env, uid: string): Promise<void> {
  const db = getDb(env);
  const rows = await env.DB.prepare(
    `SELECT id, users_data, last_message FROM chats
      WHERE EXISTS (SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?)`,
  )
    .bind(uid)
    .all<{ id: string; users_data: string | null; last_message: string | null }>();

  const ts = now();
  const updates: any[] = [];

  for (const row of rows.results || []) {
    let usersData: any = null;
    let lastMessage: any = null;
    try {
      usersData = row.users_data ? JSON.parse(row.users_data) : null;
    } catch {
      usersData = null;
    }
    try {
      lastMessage = row.last_message ? JSON.parse(row.last_message) : null;
    } catch {
      lastMessage = null;
    }

    let changed = false;
    if (Array.isArray(usersData)) {
      usersData = usersData.map((entry: any) => {
        if (!entry || entry.uid !== uid) return entry;
        changed = true;
        return { uid, displayName: "Deleted user", photoURL: null };
      });
    }
    // The preview only needs scrubbing when the last word in the thread was
    // theirs. Someone else's message is someone else's data.
    if (lastMessage && lastMessage.senderId === uid) {
      lastMessage = { ...lastMessage, text: "Message deleted", senderId: uid };
      changed = true;
    }
    if (!changed) continue;

    updates.push(
      db
        .update(schema.chats)
        .set({ usersData, lastMessage, updatedAt: ts })
        .where(eq(schema.chats.id, row.id)),
    );
  }

  // Chunked: D1 caps how many statements one batch may carry, and a heavy user
  // can be in more conversations than that.
  for (let i = 0; i < updates.length; i += 50) {
    await db.batch(updates.slice(i, i + 50) as any);
  }
}

/** Phase 2 — destroy the storage objects. Best-effort per object, never fatal. */
async function phaseMedia(env: Env, uid: string, urls: string[]): Promise<void> {
  await purgeDeletedAccountMedia(env, urls);

  // Rows that never produced a URL (upload abandoned before Bunny finished)
  // are only reachable by guid.
  const db = getDb(env);
  const orphans = await db
    .select({ id: schema.videos.id })
    .from(schema.videos)
    .where(eq(schema.videos.ownerUid, uid))
    .all();
  for (const row of orphans) {
    await deleteVideo(env, row.id).catch((e) =>
      console.error("[accountDeletion] bunny delete failed", row.id, e),
    );
  }
  await db
    .delete(schema.videos)
    .where(eq(schema.videos.ownerUid, uid))
    .catch((e) => console.error("[accountDeletion] videos row cleanup failed", uid, e));
}

/** Phase 3 — the user's own content. */
async function phaseContent(env: Env, uid: string): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db.delete(schema.posts).where(eq(schema.posts.userId, uid)),
    db.delete(schema.stories).where(eq(schema.stories.userId, uid)),
    db.delete(schema.postComments).where(eq(schema.postComments.userId, uid)),
    db.delete(schema.matchComments).where(eq(schema.matchComments.userId, uid)),
    // Blog comments are the only content the user leaves on a PUBLIC,
    // search-indexed page, so missing them here would be the most visible
    // possible failure of "delete my account".
    db.delete(schema.blogComments).where(eq(schema.blogComments.userId, uid)),
    db.delete(schema.postLikes).where(eq(schema.postLikes.userId, uid)),
    db.delete(schema.commentLikes).where(eq(schema.commentLikes.userId, uid)),
    db.delete(schema.matchLikes).where(eq(schema.matchLikes.userId, uid)),
    db.delete(schema.matchReactions).where(eq(schema.matchReactions.userId, uid)),
    db.delete(schema.bookmarks).where(eq(schema.bookmarks.userId, uid)),
    db.delete(schema.highlights).where(eq(schema.highlights.userId, uid)),
    db.delete(schema.storyViews).where(eq(schema.storyViews.viewerId, uid)),
    db.delete(schema.messages).where(eq(schema.messages.senderId, uid)),
  ]);
}

/** Phase 4 — social graph, activity trail, and the relations other users cache. */
async function phaseSocial(env: Env, uid: string): Promise<void> {
  const db = getDb(env);

  // Read the counterparties BEFORE the rows go: each of them holds a KV-cached
  // relations blob that still lists this uid, and that cache outlives the rows.
  // Without invalidating it, a deleted account keeps being filtered out of their
  // feed — or keeps appearing in their blocked list — until the TTL expires.
  //
  // Outgoing mutes are deliberately absent: a mute is one-way and only the
  // muter's own cache records it, so the people THIS user muted have nothing
  // cached about them.
  const [blockedByThisUser, blockersOfThisUser, mutersOfThisUser, followers, following] =
    await Promise.all([
      db
        .select({ uid: schema.userBlocks.blockedId })
        .from(schema.userBlocks)
        .where(eq(schema.userBlocks.blockerId, uid))
        .all(),
      db
        .select({ uid: schema.userBlocks.blockerId })
        .from(schema.userBlocks)
        .where(eq(schema.userBlocks.blockedId, uid))
        .all(),
      db
        .select({ uid: schema.userMutes.muterId })
        .from(schema.userMutes)
        .where(eq(schema.userMutes.mutedId, uid))
        .all(),
      db
        .select({ uid: schema.follows.followerId })
        .from(schema.follows)
        .where(eq(schema.follows.followingId, uid))
        .all(),
      db
        .select({ uid: schema.follows.followingId })
        .from(schema.follows)
        .where(eq(schema.follows.followerId, uid))
        .all(),
    ]);

  const staleRelationCaches = new Set<string>(
    [...blockedByThisUser, ...blockersOfThisUser, ...mutersOfThisUser].map((r) => r.uid),
  );

  await db.batch([
    db.delete(schema.follows).where(eq(schema.follows.followerId, uid)),
    db.delete(schema.follows).where(eq(schema.follows.followingId, uid)),
    db.delete(schema.profileVisits).where(eq(schema.profileVisits.userId, uid)),
    db.delete(schema.profileVisits).where(eq(schema.profileVisits.visitorId, uid)),
    db.delete(schema.notifications).where(eq(schema.notifications.recipientId, uid)),
    db.delete(schema.shares).where(eq(schema.shares.userId, uid)),
    db.delete(schema.supportTickets).where(eq(schema.supportTickets.userId, uid)),
    // Blocks and mutes in BOTH directions. Because the `users` row survives
    // anonymisation these do not fall out of anyone's list on their own: another
    // user's Blocked & Muted screen kept showing a permanent, un-actionable
    // "Deleted user" entry, and unblocking it was the only way to clear it.
    db.delete(schema.userBlocks).where(eq(schema.userBlocks.blockerId, uid)),
    db.delete(schema.userBlocks).where(eq(schema.userBlocks.blockedId, uid)),
    db.delete(schema.userMutes).where(eq(schema.userMutes.muterId, uid)),
    db.delete(schema.userMutes).where(eq(schema.userMutes.mutedId, uid)),
  ]);

  // Denormalised counters on the people who followed (or were followed by) this
  // account now overcount by one. Left un-repaired, every profile this user
  // touched advertises a follower who cannot be listed.
  const counterFixes: any[] = [];
  for (const row of followers) {
    counterFixes.push(
      db
        .update(schema.users)
        .set({ followingCount: sql`MAX(COALESCE(following_count, 0) - 1, 0)` })
        .where(eq(schema.users.uid, row.uid)),
    );
  }
  for (const row of following) {
    counterFixes.push(
      db
        .update(schema.users)
        .set({ followersCount: sql`MAX(COALESCE(followers_count, 0) - 1, 0)` })
        .where(eq(schema.users.uid, row.uid)),
    );
  }
  for (let i = 0; i < counterFixes.length; i += 50) {
    await db.batch(counterFixes.slice(i, i + 50) as any).catch((e) =>
      console.error("[accountDeletion] follower counter repair failed", uid, e),
    );
  }

  // Best-effort: a stale cache expires on its own TTL, so a KV hiccup must not
  // fail a deletion whose D1 work has already committed.
  const counterparties = [
    ...staleRelationCaches,
    ...followers.map((r) => r.uid),
    ...following.map((r) => r.uid),
  ];
  await invalidateBlockCache(env, uid, ...staleRelationCaches).catch((e) =>
    console.error("[accountDeletion] block cache invalidation failed", uid, e),
  );
  await invalidateUserCaches(env, uid, ...counterparties).catch((e) =>
    console.error("[accountDeletion] profile cache invalidation failed", uid, e),
  );
}

/**
 * Phase 5 — remove the login, write the compliance record, drop live connections.
 *
 * The Firebase delete is what makes the deletion real to the user: until it
 * happens the identity can still obtain an ID token, and only the D1 `isBlocked`
 * check stands between that token and the API.
 */
async function phaseAuth(env: Env, uid: string, reason: string | undefined): Promise<void> {
  const db = getDb(env);
  const ts = now();

  await db
    .insert(schema.accountDeletions)
    .values({
      uid,
      reason: reason ? String(reason).slice(0, 500) : null,
      forfeitedCoins: await readForfeitedCoins(env, uid),
      createdAt: ts,
    })
    .onConflictDoNothing();

  // Tell any open socket to go away, so a session that is mid-poll does not keep
  // rendering a signed-in shell for an account that no longer exists.
  await publish(env, `user:${uid}`, { type: "account_deleted" }).catch(() => {});
  await delCache(env, feedSeenKey(uid)).catch(() => {});

  try {
    await deleteAuthUser(env, uid);
  } catch (e) {
    // Deliberately NOT fatal: the D1 account is already anonymised and blocked,
    // so the user cannot use the app either way, and failing here would roll the
    // phase machine back over work that has committed.
    //
    // But it MUST be visible. A lingering Firebase identity is a real loose end,
    // and `app.onError` does not log anything for a request that succeeded, so
    // without this row the only trace would be a console line nobody reads.
    console.error("[accountDeletion] Firebase auth delete failed", uid, e);
    await db
      .insert(schema.errorLogs)
      .values({
        id: newId(),
        level: "error",
        message: `Firebase auth delete failed for deleted account ${uid}`,
        stack: String((e as any)?.stack || (e as any)?.message || e).slice(0, 4000),
        path: "cron:purgeScheduledDeletions",
        createdAt: ts,
      })
      .catch(() => {});
  }
}

/** Delete the R2/Bunny objects collected during the purge. Best-effort. */
export async function purgeDeletedAccountMedia(env: Env, urls: string[]): Promise<void> {
  for (const url of urls) {
    try {
      await deleteMediaByUrl(env, url);
    } catch (e) {
      console.error("[accountDeletion] media delete failed", url, e);
    }
  }
}

/**
 * Drop every cached view of a user's profile and connection lists.
 *
 * The public profile is served from a shared KV entry, so anonymising the D1 row
 * is not enough on its own — the cache kept serving the real name, photo and bio
 * until its TTL lapsed. Counterparties are included because their follower and
 * following pages cache a page that named this account.
 */
export async function invalidateUserCaches(env: Env, ...uids: string[]): Promise<void> {
  const unique = [...new Set(uids.filter(Boolean))];
  if (!unique.length) return;
  await delCache(
    env,
    ...unique.flatMap((u) => [userCacheKey(u), followersCacheKey(u), followingCacheKey(u)]),
  );
}

// ---------------------------------------------------------------------------
// Cron sweep
// ---------------------------------------------------------------------------

export interface DueDeletionsResult {
  purged: number;
  deferred: number;
  failed: number;
  abandoned: number;
}

/**
 * Purge every request whose grace period has lapsed.
 *
 * Deliberately capped per tick. A purge touches D1, R2, Bunny, KV and Firebase,
 * and a Worker invocation has a subrequest budget — draining an unbounded queue
 * in one tick would fail the whole batch rather than the one account that did
 * not fit, and cron would then retry that same failing batch forever.
 */
export async function purgeScheduledDeletions(env: Env, limit = 5): Promise<DueDeletionsResult> {
  const db = getDb(env);
  const ts = now();
  const result: DueDeletionsResult = { purged: 0, deferred: 0, failed: 0, abandoned: 0 };

  const due = await db
    .select()
    .from(schema.deletionRequests)
    .where(
      and(
        inArray(schema.deletionRequests.status, ["pending", "processing"]),
        lte(schema.deletionRequests.scheduledFor, ts),
      ),
    )
    .orderBy(schema.deletionRequests.scheduledFor)
    .limit(limit)
    .all();

  for (const request of due) {
    // A purge that has already started must finish, even if a deferral appeared
    // afterwards: the data it would have protected is already gone.
    if (!request.phase) {
      if ((request.attempts || 0) >= MAX_PURGE_ATTEMPTS) {
        // Stop burning cron budget on something that needs a human. The row keeps
        // its `last_error`, and the admin deletions view surfaces it.
        result.abandoned++;
        continue;
      }
      const deferrals = await findDeferrals(env, request.uid).catch(() => []);
      if (deferrals.length > 0) {
        await db
          .update(schema.deletionRequests)
          .set({
            scheduledFor: ts + DEFERRAL_RECHECK_MS,
            deferredReason: deferrals[0].code,
            deferredUntil: ts + DEFERRAL_RECHECK_MS,
            updatedAt: ts,
          })
          .where(eq(schema.deletionRequests.uid, request.uid));
        result.deferred++;
        continue;
      }
    }

    try {
      // Media is purged inside the phase machine, not here, so a retry resumes
      // from the persisted URL list rather than re-deriving it from rows that no
      // longer exist.
      await executeAccountDeletion(env, request.uid, request.reason ?? undefined);
      result.purged++;
    } catch (e) {
      // `executeAccountDeletion` has already recorded the phase and the error on
      // the row, so this tick just moves on to the next account.
      result.failed++;
    }
  }

  return result;
}
