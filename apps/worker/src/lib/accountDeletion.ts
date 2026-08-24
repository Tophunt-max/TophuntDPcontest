import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { deleteAuthUser } from "./firebaseAdmin";
import { deleteMediaByUrl } from "./mediaDelete";
import { newId, now } from "./ids";

/**
 * Self-service account deletion.
 *
 * Both app stores require an in-app way to delete an account, and there was no
 * code path for it anywhere — not in the client, not in the API.
 *
 * The shape of this matters as much as its existence:
 *
 * 1. It is NOT a hard `DELETE FROM users`. The financial ledger, contest history
 *    and vote records reference the uid, and those must survive for accounting
 *    and for the integrity of contests other people took part in. Deleting the
 *    row would orphan all of it.
 *
 * 2. Instead the account is ANONYMISED: every piece of personal data is cleared
 *    or replaced, the Firebase login is deleted so the identity can never sign in
 *    again, and the uid remains only as an opaque key in records that must be
 *    retained. That satisfies erasure of personal data while keeping the books
 *    intact — retention of transaction records is a legitimate/legal obligation.
 *
 * 3. Deletion is REFUSED while money or a contest is in flight, with an
 *    explanation. Otherwise a user could delete their way out of a live match
 *    (abandoning an opponent who paid an entry fee) or orphan a pending payout.
 */

export interface DeletionBlocker {
  code: "pending_payout" | "active_contest" | "positive_balance";
  message: string;
  detail?: Record<string, unknown>;
}

export interface DeletionEligibility {
  deletable: boolean;
  blockers: DeletionBlocker[];
  /** Coins that will be forfeited if the user proceeds. */
  balance: number;
}

/**
 * Can this account be deleted right now?
 *
 * A positive balance is a WARNING, not a blocker: the user is entitled to delete
 * their account, but they must be told the coins are forfeited so the choice is
 * informed. Money and contests actually in flight are hard blockers.
 */
export async function checkDeletionEligibility(env: Env, uid: string): Promise<DeletionEligibility> {
  const db = getDb(env);
  const blockers: DeletionBlocker[] = [];

  const user = await db
    .select({ balance: schema.users.dpcoin, status: schema.users.status })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (!user) throw httpsError("not-found", "Account not found.");

  const pendingPayouts = await db
    .select({ id: schema.withdrawals.id, amount: schema.withdrawals.amount, status: schema.withdrawals.status })
    .from(schema.withdrawals)
    .where(and(
      eq(schema.withdrawals.userId, uid),
      inArray(schema.withdrawals.status, ["pending", "approved"]),
    ))
    .all();
  if (pendingPayouts.length > 0) {
    blockers.push({
      code: "pending_payout",
      message:
        "You have a payout still being processed. Once it is paid or rejected you can delete your account.",
      detail: { withdrawals: pendingPayouts.length },
    });
  }

  // A match the user is currently in has an opponent who paid to enter it.
  // Participants live in the userA/userB JSON snapshots, so this is a JSON match
  // rather than a column comparison.
  const liveForUser = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM contest_matches
      WHERE status IN ('waiting_for_opponent','active')
        AND (json_extract(user_a, '$.uid') = ? OR json_extract(user_b, '$.uid') = ?)`,
  )
    .bind(uid, uid)
    .first<{ n: number }>();
  if (Number(liveForUser?.n || 0) > 0) {
    blockers.push({
      code: "active_contest",
      message:
        "You are in a contest that has not finished yet. You can delete your account once it is resolved.",
      detail: { matches: Number(liveForUser?.n || 0) },
    });
  }

  const balance = Number(user.balance || 0);
  return { deletable: blockers.length === 0, blockers, balance };
}

export interface DeletionResult {
  uid: string;
  deletedAt: number;
  /** Media objects to remove from storage — purge these after responding. */
  mediaUrls: string[];
  forfeitedCoins: number;
}

/**
 * Anonymise and disable the account, and delete the user's own content.
 *
 * Retained on purpose (documented for the privacy policy):
 *  - `coin_transactions`, `payments`, `payment_orders`, `deposits`,
 *    `withdrawals` — financial records, keyed by an now-anonymous uid.
 *  - `votes` and `contest_matches` — the integrity of other people's contests.
 *  - `admin_audit_log` — the record of admin actions.
 */
export async function deleteOwnAccount(
  env: Env,
  uid: string,
  reason?: string,
): Promise<DeletionResult> {
  const db = getDb(env);
  const eligibility = await checkDeletionEligibility(env, uid);
  if (!eligibility.deletable) {
    throw httpsError(
      "failed-precondition",
      eligibility.blockers.map((b) => b.message).join(" "),
    );
  }

  const ts = now();
  // Collect media URLs BEFORE the rows are deleted, so the objects can be removed
  // from R2 afterwards. Orphaned media is a privacy problem, not just a cost one.
  const mediaUrls = new Set<string>();
  const user = await db
    .select({ avatar: schema.users.profileImageUrl })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  if (user?.avatar) mediaUrls.add(user.avatar);
  for (const row of await db.select({ url: schema.posts.mediaUrl }).from(schema.posts).where(eq(schema.posts.userId, uid)).all()) {
    if (row.url) mediaUrls.add(row.url);
  }
  for (const row of await db.select({ url: schema.stories.mediaUrl }).from(schema.stories).where(eq(schema.stories.userId, uid)).all()) {
    if (row.url) mediaUrls.add(row.url);
  }

  // A short, stable pseudonym so remaining references render sensibly and the
  // unique index on `username` is still satisfied.
  const suffix = uid.slice(-6).toLowerCase().replace(/[^a-z0-9]/g, "") || newId().slice(0, 6);
  const anonUsername = `deleted_${suffix}`;

  // Forfeiting the balance is a balance change, so it needs a ledger row like
  // every other one. `account_deletions.forfeited_coins` below is the compliance
  // record of the deletion; it is not part of the coin ledger, so without this
  // the ledger could not explain why the balance went to zero and a
  // per-user replay of `coin_transactions` would not sum to the stored balance.
  // That reconciliation is what the platform-liability figure and any future
  // per-bucket balance derivation depend on.
  //
  // Deterministic id, so a retried deletion cannot record the forfeiture twice.
  const forfeitLedger =
    eligibility.balance > 0
      ? db
          .insert(schema.coinTransactions)
          .values({
            id: `account_deletion:${uid}`,
            uid,
            amount: -eligibility.balance,
            type: "account_deletion_forfeit",
            description: "Coins forfeited on account deletion",
            createdAt: ts,
          })
          .onConflictDoNothing()
      : null;

  await db.batch([
    // 0) Record the forfeiture BEFORE the balance is zeroed, in the same
    //    transaction, so the two can never disagree.
    ...(forfeitLedger ? [forfeitLedger] : []),
    // 1) Wipe every personal field. `status` + `is_blocked` also make any
    //    still-valid ID token useless immediately (requireAuth checks D1).
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
        isBlocked: true,
        status: "deleted",
        isPrivate: true,
        // Coins are forfeited on deletion; zero the balance so the anonymised row
        // cannot be confused for a live wallet.
        dpcoin: 0,
        updatedAt: ts,
      })
      .where(eq(schema.users.uid, uid)),

    // 2) The user's own content.
    db.delete(schema.posts).where(eq(schema.posts.userId, uid)),
    db.delete(schema.stories).where(eq(schema.stories.userId, uid)),
    db.delete(schema.postComments).where(eq(schema.postComments.userId, uid)),
    db.delete(schema.matchComments).where(eq(schema.matchComments.userId, uid)),
    db.delete(schema.postLikes).where(eq(schema.postLikes.userId, uid)),
    db.delete(schema.commentLikes).where(eq(schema.commentLikes.userId, uid)),
    db.delete(schema.matchLikes).where(eq(schema.matchLikes.userId, uid)),
    db.delete(schema.matchReactions).where(eq(schema.matchReactions.userId, uid)),
    db.delete(schema.bookmarks).where(eq(schema.bookmarks.userId, uid)),
    db.delete(schema.highlights).where(eq(schema.highlights.userId, uid)),
    db.delete(schema.storyViews).where(eq(schema.storyViews.viewerId, uid)),
    db.delete(schema.messages).where(eq(schema.messages.senderId, uid)),
    // `as any` because the forfeiture row above is conditionally spread in, which
    // defeats drizzle's non-empty-tuple inference for batch().
  ] as any);

  await db.batch([
    // 3) Social graph and activity trail.
    db.delete(schema.follows).where(eq(schema.follows.followerId, uid)),
    db.delete(schema.follows).where(eq(schema.follows.followingId, uid)),
    db.delete(schema.profileVisits).where(eq(schema.profileVisits.userId, uid)),
    db.delete(schema.profileVisits).where(eq(schema.profileVisits.visitorId, uid)),
    db.delete(schema.notifications).where(eq(schema.notifications.recipientId, uid)),
    db.delete(schema.shares).where(eq(schema.shares.userId, uid)),
    db.delete(schema.supportTickets).where(eq(schema.supportTickets.userId, uid)),
    // 4) Compliance record of the deletion itself.
    db.insert(schema.accountDeletions).values({
      uid,
      reason: reason ? String(reason).slice(0, 500) : null,
      forfeitedCoins: eligibility.balance,
      createdAt: ts,
    }),
  ]);

  // 5) Remove the login so the identity can never authenticate again. This is
  //    the step that actually makes the deletion real to the user.
  await deleteAuthUser(env, uid).catch((e) => {
    // Do not fail the whole deletion: the D1 account is already anonymised and
    // blocked, so the user cannot use the app either way. But this MUST be
    // visible, because a lingering Firebase identity is a real loose end.
    console.error("[deleteOwnAccount] Firebase auth delete failed", uid, e);
  });

  return {
    uid,
    deletedAt: ts,
    mediaUrls: [...mediaUrls],
    forfeitedCoins: eligibility.balance,
  };
}

/** Delete the R2/Bunny objects collected during deletion. Best-effort. */
export async function purgeDeletedAccountMedia(env: Env, urls: string[]): Promise<void> {
  for (const url of urls) {
    try {
      await deleteMediaByUrl(env, url);
    } catch (e) {
      console.error("[deleteOwnAccount] media delete failed", url, e);
    }
  }
}
