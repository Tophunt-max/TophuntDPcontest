/**
 * /api — port of apps/functions/src/api/main.ts (the callable `api` router).
 * Same contract: POST { action, ...data } with `Authorization: Bearer <idToken>`.
 *
 * D1 has no interactive transactions, so money-critical mutations use
 * conditional UPDATEs (e.g. `WHERE dpcoin >= fee`) and check the affected row
 * count to prevent double-spend / races.
 */
import { Hono } from "hono";
import { eq, and, or, desc, sql, count, like, gte, lt, isNull, inArray } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { requireAuth, isAdmin } from "../middleware/auth";
import { presignUpload } from "../lib/r2";
import { deleteByPublicUrl } from "../lib/r2";
import { awardReward } from "../lib/gamification";
import { createNotification, sendBroadcastToAllUsers, sendPushNotification } from "../lib/notify";
import { setCustomClaims } from "../lib/firebaseAdmin";
import { publish, publishMany } from "../lib/publish";
import { castVote, bumpEngagement } from "../lib/voteCounter";
import { rateLimit } from "../lib/rateLimit";
import { enforceIdempotency, releaseIdempotency } from "../lib/idempotency";
import {
  contestDetailCacheKey,
  contestListCacheKeys,
  delCache,
  userCacheKey,
} from "../lib/cache";
import { createContestExtra, validateContestInput } from "../lib/contestAdmin";
import { verifyRazorpaySignature } from "../lib/payments";
import { creditPaymentOrder } from "../lib/coinOrders";
import { assertClean } from "../lib/moderation";
import { getAppConfig } from "../lib/settings";
import { getSettings } from "../lib/gamification";
import { sendEmail } from "../lib/email";
import { newId, now, generateJoinId } from "../lib/ids";

/** Fire-and-forget admin email alert (only if an alert address is configured). */
function alertAdminEmail(c: any, cfg: any, subject: string, html: string): void {
  const to = (cfg?.adminAlertEmail as string) || "";
  if (!to) return;
  c.executionCtx.waitUntil(sendEmail(c.env, { to, subject, html }).catch(() => {}));
}

/** A short, URL-safe referral code. */
function makeReferralCode(): string {
  return "TH" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

/** Days since epoch in UTC (stable daily bucket key). */
function utcDay(ts: number = Date.now()): number {
  return Math.floor(ts / 86400000);
}

interface DailyTaskDef {
  id: string;
  title: string;
  reward: number;
  target: number;
  type: "vote" | "share" | "ad";
}
const DEFAULT_DAILY_TASKS: DailyTaskDef[] = [
  { id: "vote5", title: "Vote in 5 battles", reward: 15, target: 5, type: "vote" },
  { id: "share", title: "Share your profile", reward: 10, target: 1, type: "share" },
  { id: "watch_ad", title: "Watch a video ad", reward: 5, target: 1, type: "ad" },
];
/** Daily tasks from gamification settings (admin override) or defaults. */
function getDailyTaskDefs(settings: any): DailyTaskDef[] {
  const custom = settings?.dailyTasks;
  if (Array.isArray(custom) && custom.length) {
    return custom.map((t: any) => ({
      id: String(t.id),
      title: String(t.title || t.id),
      reward: Number(t.reward || 0),
      target: Number(t.target || 1),
      type: (["vote", "share", "ad"].includes(t.type) ? t.type : "ad") as DailyTaskDef["type"],
    }));
  }
  return DEFAULT_DAILY_TASKS;
}

export const apiRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

// All /api actions require a valid Firebase ID token (matches callable auth).
apiRoute.use("*", requireAuth);

const notPorted = (action: string, file: string): never => {
  throw httpsError(
    "internal",
    `Action '${action}' is not yet ported to the Worker. Original logic: apps/functions/src/${file}.`,
  );
};

/** Validate untrusted client identifiers before they reach D1 or a DO. */
function requiredId(value: unknown, name: string, maxLength = 256): string {
  if (typeof value !== "string") {
    throw httpsError("invalid-argument", `${name} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw httpsError("invalid-argument", `Invalid ${name}.`);
  }
  return normalized;
}

apiRoute.post("/", async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const action = body?.action;
  if (!action) throw httpsError("invalid-argument", "Action specify karna zaroori hai.");
  const env = c.env;
  const db = getDb(env);
  const uid = c.get("user").uid;

  // Idempotency guard — only enforced when the client opts in with a key
  // (safe for retries on critical writes like purchases/joins/claims).
  if (body.idempotencyKey) await enforceIdempotency(env, uid, String(body.idempotencyKey));

  try {
  switch (action) {
    // ================= STORAGE (R2) =================
    case "getPresignedUrl": {
      const { fileType, folder } = body;
      if (!fileType || !folder) throw httpsError("invalid-argument", "fileType and folder are required.");
      return c.json(await presignUpload(env, fileType, folder));
    }

    // ================= CONTEST MATCHES =================
    case "startMatch": {
      const { contestId, mediaUrl, mediaType, caption, deviceId, invitedUid } = body;
      // Idempotency fallback: if the client didn't send an explicit key, derive
      // a short-lived one so a double-tap / retry can't create two matches and
      // charge two entry fees. Released below if the action throws.
      const startIdemKey = body.idempotencyKey ? null : `startMatch:${contestId}:${mediaUrl || ""}`;
      if (startIdemKey) await enforceIdempotency(env, uid, startIdemKey, 60);
      try {
      const contest = await db.select().from(schema.contests).where(eq(schema.contests.id, contestId)).get();
      if (!contest) throw httpsError("not-found", "Contest template not found.");
      if (contest.status !== "live") {
        throw httpsError("failed-precondition", "This contest is not currently accepting new matches.");
      }
      const user = await db.select().from(schema.users).where(eq(schema.users.uid, uid)).get();
      if (!user) throw httpsError("not-found", "User document not found.");

      const totalFee = Number(contest.totalEntryFee || 0);
      const fee = totalFee / 2;

      // atomic conditional deduct
      const deduct = await db
        .update(schema.users)
        .set({ dpcoin: sql`${schema.users.dpcoin} - ${fee}`, xp: sql`${schema.users.xp} + 10`, updatedAt: now() })
        .where(and(eq(schema.users.uid, uid), gte(schema.users.dpcoin, fee)))
        .run();
      if (deduct.meta.changes === 0)
        throw httpsError("failed-precondition", `Insufficient Dpcoin. Required: ${fee}, Current: ${user.dpcoin}`);

      const ts = now();
      const matchId = newId();
      const entryTransactionId = newId();
      const joinIdA = generateJoinId();
      const expiresAt = ts + (contest.autoCancelHours || 24) * 60 * 60 * 1000;
      // Entry-fee ledger + match creation atomically. If this fails, refund the
      // deducted fee so the user never loses coins for a match that never existed.
      try {
        await db.batch([
          db.insert(schema.coinTransactions).values({
            id: entryTransactionId, uid, amount: -fee, type: "contest_entry_fee", contestId,
            description: `Entry fee (50% split) for ${contest.title || "contest"}`, createdAt: ts,
          }),
          db.insert(schema.contestMatches).values({
            id: matchId, contestId, status: "waiting_for_opponent", type: contest.type || "photo",
            title: contest.title || "Untitled Contest", entryFee: totalFee, isPrivate: !!invitedUid,
            invitedUid: invitedUid || null, joinIdA,
            userA: {
              uid, joinId: joinIdA, username: user.username || "Anonymous",
              profilePic: user.profileImageUrl || "", mediaUrl, mediaType: mediaType || "photo",
              caption: caption || "", votes: 0, deviceId: deviceId || "",
            } as any,
            totalVotes: 0,
            minVotesRequired: Math.max(0, Number(contest.minVotes || 0)),
            createdAt: ts,
            expiresAt,
          }),
        ]);
      } catch (e) {
        await db.update(schema.users)
          .set({ dpcoin: sql`${schema.users.dpcoin} + ${fee}`, xp: sql`${schema.users.xp} - 10`, updatedAt: now() })
          .where(eq(schema.users.uid, uid));
        console.error("[startMatch] match creation failed, refunded entry fee", uid, e);
        throw httpsError("internal", "Failed to create match. Your entry fee has been refunded.");
      }

      // Close the create-vs-pause race: the admin pause update refuses to run
      // while this waiting match exists. If the pause won just before the match
      // insert, remove the new match and ledger entry and atomically refund.
      let statusAfterCreate: { status: string | null } | undefined;
      try {
        statusAfterCreate = await db
          .select({ status: schema.contests.status })
          .from(schema.contests)
          .where(eq(schema.contests.id, contestId))
          .get();
      } catch (e) {
        // The match and charge are already committed. A failed reconciliation
        // read must not release idempotency and permit a duplicate charged
        // retry; return the committed match and let normal admin guards see it.
        console.error("[startMatch] post-create contest status check failed", matchId, e);
      }
      if (statusAfterCreate && statusAfterCreate.status !== "live") {
        try {
          // D1 batches are atomic and sequential. Gate every financial change
          // on the match still being waiting, then delete it last. If an
          // opponent already activated it, all three statements are no-ops.
          const stillWaiting = sql`EXISTS (
            SELECT 1 FROM ${schema.contestMatches}
            WHERE ${schema.contestMatches.id} = ${matchId}
              AND ${schema.contestMatches.status} = 'waiting_for_opponent'
          )`;
          const rollback = await db.batch([
            db.delete(schema.coinTransactions).where(and(
              eq(schema.coinTransactions.id, entryTransactionId),
              stillWaiting,
            )),
            db.update(schema.users)
              .set({
                dpcoin: sql`${schema.users.dpcoin} + ${fee}`,
                xp: sql`${schema.users.xp} - 10`,
                updatedAt: now(),
              })
              .where(and(eq(schema.users.uid, uid), stillWaiting)),
            db.delete(schema.contestMatches).where(and(
              eq(schema.contestMatches.id, matchId),
              eq(schema.contestMatches.status, "waiting_for_opponent"),
            )),
          ]);
          if (rollback[2].meta.changes > 0) {
            throw httpsError("failed-precondition", "This contest stopped accepting new matches. Your entry fee was refunded.");
          }
        } catch (e: any) {
          if (e?.status === "failed-precondition" || e?.code === "failed-precondition") throw e;
          // Atomic rollback failure leaves the committed match and charge
          // intact. Preserve the idempotency claim and return that match.
          console.error("[startMatch] post-create rollback failed; keeping committed match", matchId, e);
        }
      }

      // auto-story
      await db.insert(schema.stories).values({
        id: newId(), userId: uid, username: user.username || "Anonymous", avatarUrl: user.profileImageUrl || "",
        mediaUrl, mediaType: mediaType || "photo", type: "contest_announcement", matchId,
        contestTitle: contest.title || "Contest", createdAt: ts, expiresAt: ts + 24 * 60 * 60 * 1000,
      }).catch(() => {});

      return c.json({ matchId, joinId: joinIdA });
      } catch (e) {
        if (startIdemKey) await releaseIdempotency(env, uid, startIdemKey);
        throw e;
      }
    }

    case "joinMatch": {
      const { matchId, mediaUrl, mediaType, caption, deviceId } = body;
      const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
      if (!match) throw httpsError("not-found", "Match not found.");
      if (match.status !== "waiting_for_opponent") throw httpsError("failed-precondition", "Match unavailable.");
      const userA = match.userA as any;
      if (userA?.uid === uid) throw httpsError("failed-precondition", "You cannot join your own match.");
      // Invite-only matches: only the invited user may join.
      if (match.isPrivate && match.invitedUid && match.invitedUid !== uid)
        throw httpsError("permission-denied", "This is a private match — you weren't invited.");
      // Anti-collusion: block joining from the same device as the creator
      // (multi-account self-matching to farm rewards).
      if (userA?.deviceId && deviceId && String(userA.deviceId) === String(deviceId))
        throw httpsError("failed-precondition", "You cannot join a match from the same device as the creator.");

      const user = await db.select().from(schema.users).where(eq(schema.users.uid, uid)).get();
      if (!user) throw httpsError("not-found", "User document not found.");
      const fee = Number(match.entryFee || 0) / 2;
      // Voting window starts on activation and lasts the contest's configured
      // voteDurationDays — NOT the waiting-room autoCancelHours (which only
      // bounds how long a match may sit waiting for an opponent).
      const contestPolicy = match.contestId
        ? await db.select({
            voteDays: schema.contests.voteDurationDays,
            minVotes: schema.contests.minVotes,
            status: schema.contests.status,
          }).from(schema.contests).where(eq(schema.contests.id, match.contestId)).get()
        : null;
      if (match.contestId && !contestPolicy) {
        throw httpsError("failed-precondition", "The contest template for this match no longer exists.");
      }
      if (contestPolicy && contestPolicy.status !== "live") {
        throw httpsError("failed-precondition", "This contest is not currently accepting opponents.");
      }
      const voteDays = Number(contestPolicy?.voteDays || 1);
      const minVotesRequired = Math.max(
        0,
        Number(match.minVotesRequired ?? contestPolicy?.minVotes ?? 0),
      );

      const deduct = await db
        .update(schema.users)
        .set({ dpcoin: sql`${schema.users.dpcoin} - ${fee}`, xp: sql`${schema.users.xp} + 10`, updatedAt: now() })
        .where(and(eq(schema.users.uid, uid), gte(schema.users.dpcoin, fee)))
        .run();
      if (deduct.meta.changes === 0)
        throw httpsError("failed-precondition", `Insufficient Dpcoin. Required: ${fee}, Current: ${user.dpcoin}`);

      const ts = now();
      const joinIdB = generateJoinId();
      // claim the slot atomically
      const claim = await db
        .update(schema.contestMatches)
        .set({
          status: "active", joinIdB, activatedAt: ts,
          minVotesRequired,
          expiresAt: ts + Math.max(1, voteDays) * 24 * 60 * 60 * 1000,
          userB: {
            uid, joinId: joinIdB, username: user.username || "Anonymous",
            profilePic: user.profileImageUrl || "", mediaUrl, mediaType: mediaType || "photo",
            caption: caption || "", votes: 0, deviceId: deviceId || "",
          } as any,
        })
        .where(and(eq(schema.contestMatches.id, matchId), eq(schema.contestMatches.status, "waiting_for_opponent")))
        .run();
      if (claim.meta.changes === 0) {
        // someone else took it — refund
        await db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${fee}` }).where(eq(schema.users.uid, uid));
        throw httpsError("failed-precondition", "Match unavailable.");
      }

      await db.insert(schema.coinTransactions).values({
        id: newId(), uid, amount: -fee, type: "contest_entry_fee", matchId, contestId: match.contestId,
        description: `Entry fee (50% split) for ${match.title || "contest"}`, createdAt: ts,
      });

      await db.insert(schema.stories).values({
        id: newId(), userId: uid, username: user.username || "Anonymous", avatarUrl: user.profileImageUrl || "",
        mediaUrl, mediaType: mediaType || "photo", type: "contest_match_live", matchId,
        contestTitle: match.title || "Contest", createdAt: ts, expiresAt: ts + 24 * 60 * 60 * 1000,
      }).catch(() => {});

      c.executionCtx.waitUntil(
        sendPushNotification(
          env, userA.uid, "Match Live! 🚀",
          `${user.username} has joined your battle "${match.title}". Voting is now open!`,
          "match_active", { matchId },
        ),
      );

      return c.json({ status: "active", joinId: joinIdB });
    }

    case "submitVote": {
      const matchId = requiredId(body.matchId, "matchId", 128);
      const votedForUid = requiredId(body.votedForUid, "votedForUid", 128);
      const deviceId = requiredId(body.deviceId, "deviceId", 256);
      const voterAccount = await db.select({
        uid: schema.users.uid,
        status: schema.users.status,
        isBlocked: schema.users.isBlocked,
      }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      if (!voterAccount) throw httpsError("failed-precondition", "Complete your profile before voting.");
      if (voterAccount.isBlocked || voterAccount.status !== "active") {
        throw httpsError("permission-denied", "This account is not eligible to vote.");
      }
      // Throttle abusive vote bursts (per user): max 60 / minute.
      await rateLimit(env, `vote:${uid}`, 60, 60);
      // Per-IP velocity cap — slows multi-account vote stuffing from one network
      // beyond the per-user and per-match-device guards (max 40 / minute / IP).
      const voteIp = c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || "";
      if (voteIp) await rateLimit(env, `vote:ip:${voteIp}`, 40, 60);
      const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
      if (!match) throw httpsError("not-found", "Match not found.");
      if (match.status !== "active") throw httpsError("failed-precondition", "Battle is not active.");
      const expiresAt = Number(match.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
        throw httpsError("failed-precondition", "This battle has no valid voting deadline.");
      }
      // Voting closes exactly at expiry — don't accept votes in the gap before
      // the resolver cron runs (which can lag up to its 10-min interval).
      if (expiresAt <= now())
        throw httpsError("failed-precondition", "Voting has closed for this battle.");
      const userA = match.userA as any;
      const userB = match.userB as any;
      if (uid === userA?.uid || (userB && uid === userB.uid))
        throw httpsError("failed-precondition", "Participants cannot vote in their own match.");

      // validate the vote target is a participant
      if (votedForUid !== userA?.uid && !(userB && votedForUid === userB.uid))
        throw httpsError("invalid-argument", "Invalid participant UID for this match.");

      // Dedup + tally happen inside the per-match VoteCounter Durable Object,
      // which batch-flushes counts to D1 — this keeps the hot vote path off
      // D1's single writer even under viral load.
      const tally = await castVote(env, matchId, {
        voterUid: uid,
        votedForUid,
        deviceId,
        uidA: userA?.uid,
        uidB: userB?.uid ?? userA?.uid,
        expiresAt,
      });
      if (tally.votingClosed) throw httpsError("failed-precondition", "Voting has closed for this battle.");
      if (tally.alreadyVoted) throw httpsError("already-exists", "You have already voted in this match.");
      if (tally.deviceUsed) throw httpsError("failed-precondition", "This device has already voted in this match.");

      // The vote is already durably committed in the per-match actor. Realtime
      // fan-out must never turn that success into a client-visible failure, so
      // publish out-of-band and return the authoritative tally immediately.
      c.executionCtx.waitUntil(publish(env, `match:${matchId}`, {
        type: "vote",
        votedForUid,
        votesA: tally.votesA,
        votesB: tally.votesB,
        totalVotes: tally.total,
      }));
      return c.json({
        success: true,
        hasVoted: true,
        votedForUid,
        votesA: tally.votesA,
        votesB: tally.votesB,
        totalVotes: tally.total,
      });
    }

    // ================= POSTS =================
    case "createPost": {
      const { mediaUrl, mediaType, caption, location } = body;
      if (!mediaUrl || !mediaType) throw httpsError("invalid-argument", "Media URL and type are required.");
      await assertClean(env, caption, location);
      const postId = newId();
      const ts = now();
      await db.insert(schema.posts).values({
        id: postId, userId: uid, mediaUrl, mediaType, caption: caption || "", location: location || "",
        likeCount: 0, commentCount: 0, createdAt: ts,
      });
      await db.update(schema.users).set({ postsCount: sql`${schema.users.postsCount} + 1` }).where(eq(schema.users.uid, uid));
      return c.json({ success: true, postId });
    }

    case "deletePost": {
      const { postId } = body;
      if (!postId) throw httpsError("invalid-argument", "Post ID is required.");
      const post = await db.select().from(schema.posts).where(eq(schema.posts.id, postId)).get();
      if (!post) throw httpsError("not-found", "Post not found.");
      if (post.userId !== uid && !(await isAdmin(c as any)))
        throw httpsError("permission-denied", "You don't have permission to delete this post.");
      await db.delete(schema.posts).where(eq(schema.posts.id, postId));
      await db.update(schema.users).set({ postsCount: sql`MAX(${schema.users.postsCount} - 1, 0)` }).where(eq(schema.users.uid, post.userId));
      // Free the R2 object so storage doesn't leak (DELETE is free in R2).
      if (post.mediaUrl) await deleteByPublicUrl(env, post.mediaUrl).catch(() => {});
      return c.json({ success: true, message: "Post deleted successfully" });
    }

    // ================= STORIES =================
    case "getStoryUrl": {
      const { fileType } = body;
      if (!fileType) throw httpsError("invalid-argument", "fileType is required.");
      return c.json(await presignUpload(env, fileType, "stories"));
    }
    case "createStory": {
      const { mediaUrl, mediaType, overlayText, textPosition, mentions, visibility } = body;
      if (!mediaUrl) throw httpsError("invalid-argument", "mediaUrl is required.");
      await assertClean(env, overlayText);
      const user = await db.select({ username: schema.users.username, avatar: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      const ts = now();
      const storyId = newId();
      await db.insert(schema.stories).values({
        id: storyId, userId: uid, username: user?.username, avatarUrl: user?.avatar,
        mediaUrl, mediaType: mediaType || "photo", visibility: visibility || "public",
        overlayText: overlayText || null, textPosition: textPosition || null, mentions: mentions || null,
        type: "user", createdAt: ts, expiresAt: ts + 24 * 60 * 60 * 1000,
      });
      return c.json({ success: true, storyId });
    }
    case "deleteStory": {
      const { storyId } = body;
      if (!storyId) throw httpsError("invalid-argument", "storyId is required.");
      const story = await db.select().from(schema.stories).where(eq(schema.stories.id, storyId)).get();
      if (!story) throw httpsError("not-found", "Story not found.");
      if (story.userId !== uid && !(await isAdmin(c as any)))
        throw httpsError("permission-denied", "Not allowed.");
      if (story.mediaUrl) await deleteByPublicUrl(env, story.mediaUrl);
      await db.delete(schema.stories).where(eq(schema.stories.id, storyId));
      return c.json({ success: true });
    }

    // ================= USER & SOCIAL =================
    case "toggleFollow": {
      const { targetUserId } = body;
      if (!targetUserId) throw httpsError("invalid-argument", "The function must be called with a 'targetUserId'.");
      if (targetUserId === uid) throw httpsError("invalid-argument", "You cannot follow yourself.");
      const existing = await db
        .select()
        .from(schema.follows)
        .where(and(eq(schema.follows.followerId, uid), eq(schema.follows.followingId, targetUserId)))
        .get();

      if (existing) {
        await db.delete(schema.follows).where(and(eq(schema.follows.followerId, uid), eq(schema.follows.followingId, targetUserId)));
        await db.update(schema.users).set({ followingCount: sql`MAX(${schema.users.followingCount} - 1, 0)` }).where(eq(schema.users.uid, uid));
        await db.update(schema.users).set({ followersCount: sql`MAX(${schema.users.followersCount} - 1, 0)` }).where(eq(schema.users.uid, targetUserId));
        return c.json({ success: true, isFollowing: false });
      }
      await db.insert(schema.follows).values({ followerId: uid, followingId: targetUserId, createdAt: now() });
      await db.update(schema.users).set({ followingCount: sql`${schema.users.followingCount} + 1` }).where(eq(schema.users.uid, uid));
      await db.update(schema.users).set({ followersCount: sql`${schema.users.followersCount} + 1` }).where(eq(schema.users.uid, targetUserId));
      const me = await db.select({ username: schema.users.username, fullName: schema.users.fullName, avatar: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      c.executionCtx.waitUntil(
        createNotification(env, targetUserId, {
          title: "New Follower! 👤",
          body: `${me?.username || me?.fullName || "Someone"} started following you.`,
          type: "follow", targetId: uid, image: me?.avatar || undefined,
        }),
      );
      return c.json({ success: true, isFollowing: true });
    }

    case "claimDailyReward": {
      const settings = await import("../lib/gamification").then((m) => m.getSettings(env));
      const user = await db.select().from(schema.users).where(eq(schema.users.uid, uid)).get();
      if (!user) throw httpsError("not-found", "User not found.");
      const nowDate = new Date();
      // Use explicit UTC day boundaries (server runs in UTC) instead of
      // toDateString(), which is ambiguous and made streak/eligibility wrong.
      const startOfToday = Date.UTC(nowDate.getUTCFullYear(), nowDate.getUTCMonth(), nowDate.getUTCDate());
      const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
      const lastMs = user.lastDailyClaim ? Number(user.lastDailyClaim) : 0;
      if (lastMs >= startOfToday)
        throw httpsError("already-exists", "Daily reward already claimed today.");
      // Streak continues only if the previous claim happened during "yesterday".
      let streak = user.streak || 0;
      streak = lastMs >= startOfYesterday && lastMs < startOfToday ? streak + 1 : 1;
      const coinReward = settings.dailyLoginReward + streak * settings.dailyStreakBonus;
      const xpReward = 50;
      const ts = now();
      // Atomic guard: the conditional WHERE + affected-row check guarantees only
      // ONE claim per UTC day even if two requests race.
      const upd = await db.update(schema.users).set({
        dpcoin: sql`${schema.users.dpcoin} + ${coinReward}`,
        xp: sql`${schema.users.xp} + ${xpReward}`,
        streak, lastDailyClaim: ts, updatedAt: ts,
      }).where(and(
        eq(schema.users.uid, uid),
        or(isNull(schema.users.lastDailyClaim), lt(schema.users.lastDailyClaim, startOfToday)),
      )).run();
      if (upd.meta.changes === 0)
        throw httpsError("already-exists", "Daily reward already claimed today.");
      await db.insert(schema.coinTransactions).values({
        id: newId(), uid, amount: coinReward, type: "daily_reward",
        description: `Daily login reward (${streak} day streak)`, createdAt: ts,
      });
      return c.json({ success: true, coinsEarned: coinReward, xpEarned: xpReward, streak });
    }

    // Credit a rewarded-ad view. Guarded by a per-minute rate limit AND a
    // per-UTC-day cap so a client can't mint unlimited coins by replaying this.
    //
    // ⚠️ SECURITY: this trusts the client that an ad was actually watched. For
    // real money value it MUST be gated by the ad network's Server-Side
    // Verification (SSV) callback (e.g. AdMob SSV) before crediting. The cap +
    // rate limit bound the abuse until SSV is wired in. See PRODUCTION_TODO.md.
    case "claimAdReward": {
      const AD_REWARD = 5;
      const DAILY_CAP = 10;
      await rateLimit(env, `ad:${uid}`, 20, 60);

      const day = Math.floor(Date.now() / 86_400_000); // UTC day bucket
      const capKey = `adreward:${uid}:${day}`;
      let used = 0;
      try {
        used = Number((await env.CACHE_KV.get(capKey)) || 0);
      } catch {
        /* KV blip — treat as 0 (fail-open on the counter, cap still applies next reads) */
      }
      if (used >= DAILY_CAP)
        throw httpsError("resource-exhausted", "Daily ad reward limit reached. Come back tomorrow!");

      const ts = now();
      await db.batch([
        db.update(schema.users)
          .set({ dpcoin: sql`${schema.users.dpcoin} + ${AD_REWARD}`, updatedAt: ts })
          .where(eq(schema.users.uid, uid)),
        db.insert(schema.coinTransactions).values({
          id: newId(), uid, amount: AD_REWARD, type: "ad_reward",
          description: "Rewarded ad view", createdAt: ts,
        }),
      ]);
      // Bump the daily counter (TTL ~25h so it clears after the day rolls over).
      try {
        await env.CACHE_KV.put(capKey, String(used + 1), { expirationTtl: 90_000 });
      } catch {
        /* best-effort */
      }
      return c.json({ success: true, coinsEarned: AD_REWARD, remaining: DAILY_CAP - used - 1 });
    }

    // ================= DAILY TASKS =================
    case "getDailyTasks": {
      const settings: any = await getSettings(env);
      const tasks = getDailyTaskDefs(settings);
      const day = utcDay();
      const startOfDay = day * 86400000;
      const votesToday =
        (await db.select({ v: count() }).from(schema.votes).where(and(eq(schema.votes.voterUid, uid), gte(schema.votes.createdAt, startOfDay))).get())?.v ?? 0;
      const sharesToday =
        (await db.select({ v: count() }).from(schema.shares).where(and(eq(schema.shares.userId, uid), gte(schema.shares.createdAt, startOfDay))).get())?.v ?? 0;
      const claimed = await db
        .select({ taskId: schema.dailyTaskClaims.taskId })
        .from(schema.dailyTaskClaims)
        .where(and(eq(schema.dailyTaskClaims.uid, uid), eq(schema.dailyTaskClaims.day, day)))
        .all();
      const claimedSet = new Set(claimed.map((r) => r.taskId));
      const out = tasks.map((t) => {
        const progress = t.type === "vote" ? votesToday : t.type === "share" ? sharesToday : 0;
        const isClaimed = claimedSet.has(t.id);
        // "ad" tasks are credited via the separate claimAdReward flow (watch an
        // ad), so they're never "claimable" through the generic task claim.
        const eligible = t.type === "ad" ? false : progress >= t.target;
        return { id: t.id, title: t.title, reward: t.reward, target: t.target, type: t.type, progress: Math.min(progress, t.target), claimed: isClaimed, claimable: eligible && !isClaimed };
      });
      return c.json({ tasks: out });
    }

    case "claimDailyTask": {
      const { taskId } = body;
      if (!taskId) throw httpsError("invalid-argument", "taskId is required.");
      const settings: any = await getSettings(env);
      const task = getDailyTaskDefs(settings).find((t) => t.id === taskId);
      if (!task) throw httpsError("not-found", "Unknown task.");
      if (task.type === "ad") throw httpsError("failed-precondition", "Ad rewards are claimed by watching an ad.");
      const day = utcDay();
      const startOfDay = day * 86400000;

      // Verify progress for verifiable tasks.
      if (task.type === "vote") {
        const v = (await db.select({ v: count() }).from(schema.votes).where(and(eq(schema.votes.voterUid, uid), gte(schema.votes.createdAt, startOfDay))).get())?.v ?? 0;
        if (v < task.target) throw httpsError("failed-precondition", "Task not completed yet.");
      } else if (task.type === "share") {
        const s = (await db.select({ v: count() }).from(schema.shares).where(and(eq(schema.shares.userId, uid), gte(schema.shares.createdAt, startOfDay))).get())?.v ?? 0;
        if (s < task.target) throw httpsError("failed-precondition", "Task not completed yet.");
      }

      const ts = now();
      // PK (uid, task_id, day) dedups — first claim wins.
      const ins = await db
        .insert(schema.dailyTaskClaims)
        .values({ uid, taskId, day, reward: task.reward, createdAt: ts })
        .onConflictDoNothing()
        .run();
      if (ins.meta.changes === 0) throw httpsError("already-exists", "Task already claimed today.");

      await db.batch([
        db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${task.reward}`, updatedAt: ts }).where(eq(schema.users.uid, uid)),
        db.insert(schema.coinTransactions).values({ id: newId(), uid, amount: task.reward, type: "daily_task", description: `Task reward: ${task.title}`, createdAt: ts }),
      ]);
      return c.json({ success: true, reward: task.reward });
    }

    // ================= WALLET =================
    // Step 1 of the purchase flow: create a Razorpay order priced SERVER-SIDE
    // from the coin package. The client never dictates the price or the number
    // of coins — that is derived here and stashed so `topup` can trust it.
    case "createOrder": {
      const { packageId } = body;
      if (!packageId) throw httpsError("invalid-argument", "packageId is required.");
      if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET)
        throw httpsError("failed-precondition", "Payments are not configured on the server.");

      const pkg = await db
        .select()
        .from(schema.coinPackages)
        .where(and(eq(schema.coinPackages.id, String(packageId)), eq(schema.coinPackages.active, true)))
        .get();
      if (!pkg) throw httpsError("not-found", "Coin package not found.");

      const priceInr = Number(pkg.priceInr) || 0;
      if (priceInr <= 0) throw httpsError("failed-precondition", "This package is not purchasable.");
      const amountPaise = Math.round(priceInr * 100);
      const totalCoins = (Number(pkg.coins) || 0) + (Number(pkg.bonusCoins) || 0);
      if (totalCoins <= 0) throw httpsError("failed-precondition", "This package has no coins configured.");

      // Create the order at Razorpay (HTTP Basic auth = key_id:key_secret).
      const authHeader = btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`);
      const rzpRes = await fetch("https://api.razorpay.com/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Basic ${authHeader}` },
        body: JSON.stringify({
          amount: amountPaise,
          currency: "INR",
          receipt: `rcpt_${uid.slice(0, 8)}_${Date.now()}`,
          notes: { uid, packageId: String(packageId), coins: totalCoins },
        }),
      });
      if (!rzpRes.ok) {
        const errTxt = await rzpRes.text().catch(() => "");
        console.error("[createOrder] Razorpay error", rzpRes.status, errTxt);
        throw httpsError("internal", "Could not create payment order. Please try again.");
      }
      const order = (await rzpRes.json()) as any;

      // Persist the server-authoritative intent DURABLY in D1 so a webhook (or a
      // late client callback) can reconcile and credit the order even if the
      // client never returns. This is the authoritative record going forward.
      const orderTs = now();
      try {
        await db
          .insert(schema.paymentOrders)
          .values({
            orderId: String(order.id),
            userId: uid,
            packageId: String(packageId),
            coins: totalCoins,
            amountPaise,
            currency: "INR",
            status: "created",
            createdAt: orderTs,
            updatedAt: orderTs,
          })
          .onConflictDoNothing()
          .run();
      } catch (e) {
        console.error("[createOrder] payment_orders insert failed", e);
        throw httpsError("internal", "Could not initialize payment. Please try again.");
      }

      // Also keep the short-lived KV intent as a fast-path fallback (and for
      // orders still in flight across a deploy). Best-effort — the DB row above
      // is the source of truth.
      try {
        await env.CACHE_KV.put(
          `rzp_order:${order.id}`,
          JSON.stringify({ uid, coins: totalCoins, priceInr, packageId: String(packageId) }),
          { expirationTtl: 3600 },
        );
      } catch (e) {
        console.warn("[createOrder] KV put failed (non-fatal)", e);
      }

      return c.json({
        orderId: order.id,
        amount: amountPaise,
        currency: "INR",
        keyId: env.RAZORPAY_KEY_ID,
        coins: totalCoins,
        name: pkg.name || `${totalCoins} Dpcoins`,
      });
    }

    // Step 2: verify the checkout result and credit coins. The coin count comes
    // from the order record created above — NOT from the client — so a client
    // can never mint arbitrary coins by calling this directly.
    case "topup": {
      const { paymentId, orderId, signature } = body;
      if (!paymentId || !orderId || !signature)
        throw httpsError("invalid-argument", "paymentId, orderId and signature are required.");

      // SECURITY: verify the payment server-side. Fail closed if the gateway is
      // not configured — never credit coins without a verified payment.
      if (!env.RAZORPAY_KEY_SECRET)
        throw httpsError("failed-precondition", "Payments are not configured on the server.");
      const verified = await verifyRazorpaySignature(env, { orderId, paymentId, signature });
      if (!verified) throw httpsError("permission-denied", "Payment verification failed.");

      // Primary path: credit the persisted order (shared with the webhook so we
      // never double-credit regardless of which arrives first).
      const res = await creditPaymentOrder(env, db, {
        orderId: String(orderId),
        paymentId: String(paymentId),
        source: "callback",
        expectedFromUid: uid,
      });
      if (res.reason === "owner_mismatch")
        throw httpsError("permission-denied", "Order does not belong to this user.");
      if (res.reason === "invalid_amount")
        throw httpsError("failed-precondition", "Invalid order amount.");
      if (res.reason === "already")
        throw httpsError("already-exists", "Payment already processed.");
      if (res.credited) {
        try { await env.CACHE_KV.delete(`rzp_order:${orderId}`); } catch { /* ignore */ }
        return c.json({ success: true, message: "Coins added successfully!", coins: res.coins });
      }

      // Fallback (only for orders with no DB row — e.g. created before this
      // deploy): use the legacy short-lived KV intent.
      let record: { uid: string; coins: number } | null = null;
      try {
        record = (await env.CACHE_KV.get(`rzp_order:${orderId}`, "json")) as any;
      } catch (e) {
        console.error("[topup] KV get failed", e);
        throw httpsError("internal", "Could not verify the order. Please contact support.");
      }
      if (!record) throw httpsError("not-found", "Payment order not found or expired.");
      if (record.uid !== uid) throw httpsError("permission-denied", "Order does not belong to this user.");
      const coins = Number(record.coins);
      if (!Number.isFinite(coins) || coins <= 0 || coins > 1_000_000)
        throw httpsError("failed-precondition", "Invalid order amount.");

      const ts = now();
      // Idempotency guard: the first insert of this paymentId wins; replays are
      // rejected so the same payment can't be credited twice.
      const pay = await db
        .insert(schema.payments)
        .values({ id: paymentId, userId: uid, amount: coins, status: "success", createdAt: ts })
        .onConflictDoNothing()
        .run();
      if (pay.meta.changes === 0) throw httpsError("already-exists", "Payment already processed.");

      // Credit + ledger atomically so we can't mark a payment success without
      // recording the matching coin grant.
      await db.batch([
        db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${coins}` }).where(eq(schema.users.uid, uid)),
        db.insert(schema.coinTransactions).values({
          id: newId(), uid, amount: coins, type: "purchase", description: `Purchased ${coins} Dpcoins`, createdAt: ts,
        }),
      ]);
      // Best-effort cleanup so the same order can't be reused.
      try { await env.CACHE_KV.delete(`rzp_order:${orderId}`); } catch { /* ignore */ }
      return c.json({ success: true, message: "Coins added successfully!", coins });
    }

    case "requestWithdrawal": {
      const { amount, method, accountDetails } = body;
      const amt = Number(amount);
      if (!Number.isInteger(amt) || amt <= 0) throw httpsError("invalid-argument", "Invalid amount.");
      if (!method) throw httpsError("invalid-argument", "Payout method is required.");
      // Anti-spam: max 5 withdrawal requests per hour per user.
      await rateLimit(env, `withdraw:${uid}`, 5, 3600);

      // Honor the admin App Control withdrawal config. `payoutsFrozen` is an
      // emergency kill-switch that blocks all new payout requests instantly
      // (e.g. during a suspected-fraud incident) without disabling the feature.
      const cfg = await getAppConfig(env);
      const wcfg = (cfg?.withdrawal as any) || {};
      if (wcfg.enabled === false || wcfg.payoutsFrozen === true)
        throw httpsError("failed-precondition", "Withdrawals are currently disabled.");
      const minAmount = Number(wcfg.minAmount ?? 0);
      if (amt < minAmount) throw httpsError("failed-precondition", `Minimum withdrawal is ${minAmount} coins.`);
      const rate = Number(wcfg.conversionRate ?? 1);

      const ts = now();
      const id = newId();

      // Escrow the coins NOW with a single atomic conditional deduct. This
      // removes the race where a user could request a payout and then spend the
      // same coins elsewhere before an admin approved it. The `WHERE dpcoin >=
      // amt` guard + affected-row check makes concurrent requests safe.
      const reserve = await db
        .update(schema.users)
        .set({ dpcoin: sql`${schema.users.dpcoin} - ${amt}`, updatedAt: ts })
        .where(and(eq(schema.users.uid, uid), sql`${schema.users.dpcoin} >= ${amt}`))
        .run();
      if (reserve.meta.changes === 0) throw httpsError("failed-precondition", "Insufficient balance.");

      await db.batch([
        db.insert(schema.withdrawals).values({
          id,
          userId: uid,
          amount: amt,
          cashAmount: amt * rate,
          method: String(method),
          accountDetails: accountDetails ? String(accountDetails) : null,
          status: "pending",
          reserved: true,
          createdAt: ts,
          updatedAt: ts,
        }),
        db.insert(schema.coinTransactions).values({
          id: newId(),
          uid,
          amount: -amt,
          type: "withdrawal_hold",
          description: `Payout requested (${method}) — coins reserved`,
          createdAt: ts,
        }),
      ]);
      await db.insert(schema.adminNotifications).values({
        id: newId(), title: "New Withdrawal Request",
        message: `A user requested a payout of ${amt} coins.`, link: "/withdrawals", isRead: false, createdAt: ts,
      });
      alertAdminEmail(c, cfg, "New Withdrawal Request",
        `<p>A user requested a payout of <b>${amt} coins</b> (₹${(amt * rate).toFixed(2)}) via ${method}.</p><p>Review it in the admin panel → Withdrawals.</p>`);
      return c.json({ success: true, withdrawalId: id, cashAmount: amt * rate });
    }

    // Manual QR/UPI deposit: user pays externally then submits the UTR here.
    // Admin approves/rejects in the panel; coins are credited on approval.
    case "requestDeposit": {
      const { amount, utr, method, screenshotUrl } = body;
      const amt = Number(amount);
      if (!Number.isInteger(amt) || amt <= 0 || amt > 1_000_000)
        throw httpsError("invalid-argument", "Invalid amount.");
      if (!utr || String(utr).trim().length < 4)
        throw httpsError("invalid-argument", "A valid UTR / transaction reference is required.");
      // Anti-spam: max 5 deposit submissions per hour per user.
      await rateLimit(env, `deposit:${uid}`, 5, 3600);

      const cfg = await getAppConfig(env);
      const gw = (cfg?.paymentGateway as any) || {};
      const mode = gw.mode || "auto";
      if (mode === "auto") throw httpsError("failed-precondition", "Manual deposits are currently disabled.");
      const coinRate = Number(gw.coinRate ?? 1);

      // Hard-block reused UTRs: a bank reference can only fund one deposit. Reject
      // at submit time if a non-rejected deposit already carries this UTR (any
      // user) — stops replaying one payment reference across multiple requests.
      const utrClean = String(utr).trim();
      const utrDupe = await db
        .select({ id: schema.deposits.id })
        .from(schema.deposits)
        .where(and(sql`lower(${schema.deposits.utr}) = ${utrClean.toLowerCase()}`, sql`${schema.deposits.status} != 'rejected'`))
        .get();
      if (utrDupe) throw httpsError("already-exists", "This UTR / transaction reference has already been submitted.");

      const ts = now();
      const id = newId();
      await db.insert(schema.deposits).values({
        id,
        userId: uid,
        amount: amt,
        payAmount: amt * coinRate,
        method: method || "qr",
        utr: String(utr).trim(),
        screenshotUrl: screenshotUrl ? String(screenshotUrl) : null,
        status: "pending",
        createdAt: ts,
        updatedAt: ts,
      });
      await db.insert(schema.adminNotifications).values({
        id: newId(), title: "New Deposit Request",
        message: `A user submitted a ${amt}-coin deposit (UTR ${String(utr).trim()}).`, link: "/deposits", isRead: false, createdAt: ts,
      });
      alertAdminEmail(c, cfg, "New Deposit Request",
        `<p>A user submitted a <b>${amt}-coin</b> deposit (₹${(amt * coinRate).toFixed(2)}).</p><p>UTR: <b>${String(utr).trim()}</b></p><p>Verify & approve in the admin panel → Deposits.</p>`);
      return c.json({ success: true, depositId: id });
    }

    // ================= ADMIN =================
    case "setAdminRole": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { userId, makeAdmin } = body;
      if (!userId) throw httpsError("invalid-argument", "userId is required.");
      const role = makeAdmin === false ? "user" : "admin";
      await setCustomClaims(env, userId, { role });
      await db.update(schema.users).set({ role, updatedAt: now() }).where(eq(schema.users.uid, userId));
      return c.json({ success: true, role });
    }
    case "adminDeletePost": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { postId } = body;
      if (!postId) throw httpsError("invalid-argument", "postId is required.");
      await db.delete(schema.posts).where(eq(schema.posts.id, postId));
      return c.json({ success: true });
    }
    case "unblockUser": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { userId } = body;
      if (!userId) throw httpsError("invalid-argument", "userId is required.");
      const { updateAuthUser } = await import("../lib/firebaseAdmin");
      await updateAuthUser(env, userId, { disabled: false });
      await db.update(schema.users).set({ isBlocked: false, status: "active", updatedAt: now() }).where(eq(schema.users.uid, userId));
      return c.json({ success: true });
    }
    case "sendBroadcastNotification": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { title, body: msg, imageUrl, data } = body;
      const sentCount = await sendBroadcastToAllUsers(env, title, msg, imageUrl, data || {});
      return c.json({ success: true, sentCount });
    }
    case "sendIndividualNotification": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { userId, title, body: msg, imageUrl, data } = body;
      if (!userId) throw httpsError("invalid-argument", "User ID is required");
      await createNotification(env, userId, {
        title, body: msg, type: "admin", targetId: "individual_msg", image: imageUrl, data: data || {},
      });
      return c.json({ success: true });
    }
    case "createContestTemplate": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { values } = validateContestInput(body, true);
      if (!values.bannerUrl) throw httpsError("failed-precondition", "A banner is required for a new contest.");
      const id = newId();
      const createdAt = now();
      await db.insert(schema.contests).values({
        id,
        title: values.title,
        type: values.type,
        status: values.status,
        totalEntryFee: values.totalEntryFee,
        rewardCoins: values.rewardCoins,
        voteDurationDays: values.voteDurationDays,
        autoCancelHours: values.autoCancelHours,
        minVotes: values.minVotes,
        bannerUrl: values.bannerUrl,
        extra: createContestExtra(body, values),
        createdBy: uid,
        createdAt,
      });
      await delCache(env, ...contestListCacheKeys(), contestDetailCacheKey(id));
      try {
        await db.insert(schema.adminAuditLog).values({
          id: newId(),
          adminUid: uid,
          adminEmail: c.get("user")?.email ?? null,
          action: "contest.create",
          targetType: "contest",
          targetId: id,
          detail: { ...values, createdBy: uid, createdAt },
          createdAt: now(),
        });
      } catch (e) {
        console.error("[audit] failed to record contest.create", e);
      }
      return c.json({ success: true, contestId: id, id });
    }
    case "getAdminStats": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const usersCount = (await db.select({ v: count() }).from(schema.users).get())?.v ?? 0;
      const activeMatches = (await db.select({ v: count() }).from(schema.contestMatches).where(eq(schema.contestMatches.status, "active")).get())?.v ?? 0;
      const waitingMatches = (await db.select({ v: count() }).from(schema.contestMatches).where(eq(schema.contestMatches.status, "waiting_for_opponent")).get())?.v ?? 0;
      const latestTransactions = await db.select().from(schema.coinTransactions).orderBy(desc(schema.coinTransactions.createdAt)).limit(10).all();
      return c.json({ stats: { usersCount, activeMatches, waitingMatches }, latestTransactions });
    }
    case "searchUsers": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { query } = body;
      if (!query || query.length < 2) return c.json({ users: [] });
      const term = query.toLowerCase();
      const rows = await db
        .select({ id: schema.users.uid, username: schema.users.username, email: schema.users.email, avatar: schema.users.profileImageUrl })
        .from(schema.users)
        .where(like(schema.users.username, `${term}%`))
        .limit(10)
        .all();
      return c.json({ users: rows });
    }

    // ================= NOTIFICATIONS / TOKENS / BADGE =================
    case "markNotificationsRead": {
      const ids: string[] = body.notificationIds || [];
      if (!ids.length) return c.json({ success: true });
      await db
        .update(schema.notifications)
        .set({ read: true })
        .where(and(eq(schema.notifications.recipientId, uid), inArray(schema.notifications.id, ids)));
      return c.json({ success: true });
    }

    case "registerFcmToken": {
      const { token } = body;
      if (!token) throw httpsError("invalid-argument", "token is required.");
      const user = await db.select({ fcmTokens: schema.users.fcmTokens }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      const tokens = new Set<string>(((user?.fcmTokens as string[]) || []));
      tokens.add(token);
      await db.update(schema.users).set({ fcmTokens: [...tokens], updatedAt: now() }).where(eq(schema.users.uid, uid));
      return c.json({ success: true });
    }

    case "equipBadge": {
      // badge can be an object or null (unequip)
      await db.update(schema.users).set({ equippedBadge: body.badge ?? null, updatedAt: now() }).where(eq(schema.users.uid, uid));
      // Reflect the equipped badge on the user's public profile right away.
      c.executionCtx.waitUntil(delCache(env, userCacheKey(uid)));
      return c.json({ success: true });
    }

    // ================= CHAT =================
    case "startChat": {
      const { otherUserId, otherUserData } = body;
      if (!otherUserId) throw httpsError("invalid-argument", "otherUserId is required.");
      // find an existing chat containing both users
      const existing = await env.DB.prepare(
        `SELECT id FROM chats
          WHERE EXISTS (SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?)
            AND EXISTS (SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?)
          LIMIT 1`,
      ).bind(uid, otherUserId).first<{ id: string }>();
      if (existing?.id) return c.json({ chatId: existing.id });

      const me = await db.select({ username: schema.users.username, avatar: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      const ts = now();
      const chatId = newId();
      await db.insert(schema.chats).values({
        id: chatId,
        users: [uid, otherUserId],
        usersData: [
          { uid, displayName: me?.username || null, photoURL: me?.avatar || null },
          { uid: otherUserId, ...(otherUserData || {}) },
        ] as any,
        lastMessage: { text: "Say hi!", createdAt: ts } as any,
        createdAt: ts,
        updatedAt: ts,
      });
      return c.json({ chatId });
    }

    case "sendMessage": {
      const { chatId, text } = body;
      if (!chatId || !text) throw httpsError("invalid-argument", "chatId and text are required.");
      const ts = now();
      const messageId = newId();
      await db.insert(schema.messages).values({ id: messageId, chatId, senderId: uid, text, read: false, createdAt: ts });
      await db.update(schema.chats).set({ lastMessage: { text, createdAt: ts, senderId: uid } as any, updatedAt: ts }).where(eq(schema.chats.id, chatId));
      // Instant push: to the chat room + each participant's user channel (chat-list bump).
      const chat = await db.select({ users: schema.chats.users }).from(schema.chats).where(eq(schema.chats.id, chatId)).get();
      const msg = { id: messageId, chatId, senderId: uid, text, createdAt: ts };
      await publish(env, `chat:${chatId}`, { type: "message", message: msg });
      const members = ((chat?.users as string[]) || []).filter((u) => u !== uid);
      await publishMany(env, members.map((u) => `user:${u}`), { type: "chat_update", chatId, message: msg });
      return c.json({ success: true });
    }

    case "markChatRead": {
      const { chatId } = body;
      if (!chatId) throw httpsError("invalid-argument", "chatId is required.");
      await env.DB.prepare(
        `UPDATE messages SET read = 1 WHERE chat_id = ? AND sender_id != ? AND read = 0`,
      ).bind(chatId, uid).run();
      return c.json({ success: true });
    }

    case "deleteChat": {
      const { chatId } = body;
      if (!chatId) throw httpsError("invalid-argument", "chatId is required.");
      await db.delete(schema.messages).where(eq(schema.messages.chatId, chatId));
      await db.delete(schema.chats).where(eq(schema.chats.id, chatId));
      return c.json({ success: true });
    }

    // ================= CONTEST-MATCH ENGAGEMENT =================
    case "likeContest": {
      const { matchId } = body;
      if (!matchId) throw httpsError("invalid-argument", "matchId is required.");
      await rateLimit(env, `like:${uid}`, 120, 60);
      const existing = await db
        .select()
        .from(schema.matchLikes)
        .where(and(eq(schema.matchLikes.matchId, matchId), eq(schema.matchLikes.userId, uid)))
        .get();
      if (existing) {
        await db.delete(schema.matchLikes).where(and(eq(schema.matchLikes.matchId, matchId), eq(schema.matchLikes.userId, uid)));
        // Counter update goes through the per-match DO (batched to D1).
        const counters = await bumpEngagement(env, matchId, "like", -1);
        await publish(env, `match:${matchId}`, { type: "like", liked: false, likeCount: counters.like ?? 0 });
        return c.json({ success: true, liked: false });
      }
      await db.insert(schema.matchLikes).values({ matchId, userId: uid, createdAt: now() });
      const counters = await bumpEngagement(env, matchId, "like", 1);
      await publish(env, `match:${matchId}`, { type: "like", liked: true, likeCount: counters.like ?? 0 });
      // Notify participants off the request path (fire-and-forget).
      c.executionCtx.waitUntil(
        (async () => {
          const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
          const me = await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.uid, uid)).get();
          for (const p of [match?.userA as any, match?.userB as any]) {
            if (p?.uid && p.uid !== uid) {
              await createNotification(env, p.uid, { title: "New Like ❤️", body: `${me?.username || "Someone"} liked your battle "${match?.title}".`, type: "match_like", targetId: matchId });
            }
          }
        })(),
      );
      return c.json({ success: true, liked: true });
    }

    case "commentContest": {
      const { matchId, text } = body;
      if (!matchId || !text) throw httpsError("invalid-argument", "matchId and text are required.");
      await assertClean(env, text);
      await rateLimit(env, `comment:${uid}`, 30, 60);
      const commentId = newId();
      const ts = now();
      await db.insert(schema.matchComments).values({ id: commentId, matchId, userId: uid, text, createdAt: ts });
      await bumpEngagement(env, matchId, "comment", 1);
      await publish(env, `match:${matchId}`, { type: "comment", commentId });
      c.executionCtx.waitUntil(
        (async () => {
          const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
          const me = await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.uid, uid)).get();
          for (const p of [match?.userA as any, match?.userB as any]) {
            if (p?.uid && p.uid !== uid) {
              await createNotification(env, p.uid, { title: "New Comment 💬", body: `${me?.username || "Someone"} commented on "${match?.title}".`, type: "match_comment", targetId: matchId });
            }
          }
        })(),
      );
      return c.json({ success: true, commentId });
    }

    case "shareContest": {
      const { matchId } = body;
      if (!matchId) throw httpsError("invalid-argument", "matchId is required.");
      await db.insert(schema.shares).values({ id: newId(), userId: uid, targetType: "match", targetId: matchId, createdAt: now() });
      const counters = await bumpEngagement(env, matchId, "share", 1);
      await publish(env, `match:${matchId}`, { type: "share", shareCount: counters.share ?? 0 });
      return c.json({ success: true });
    }

    case "reactToMatch": {
      const { matchId, type } = body;
      if (!matchId || !type) throw httpsError("invalid-argument", "matchId and type are required.");
      const ins = await db
        .insert(schema.matchReactions)
        .values({ matchId, userId: uid, type, createdAt: now() })
        .onConflictDoNothing()
        .run();
      if (ins.meta.changes === 0) return c.json({ success: true, alreadyReacted: true });
      // Reaction counter goes through the per-match DO (batched to D1 reactions JSON).
      const counters = await bumpEngagement(env, matchId, `react:${type}`, 1);
      await publish(env, `match:${matchId}`, { type: "reaction", reactionType: type, count: counters[`react:${type}`] ?? 0 });
      return c.json({ success: true });
    }

    case "toggleBookmark": {
      const { matchId } = body;
      if (!matchId) throw httpsError("invalid-argument", "matchId is required.");
      const existing = await db
        .select()
        .from(schema.bookmarks)
        .where(and(eq(schema.bookmarks.userId, uid), eq(schema.bookmarks.matchId, matchId)))
        .get();
      if (existing) {
        await db.delete(schema.bookmarks).where(and(eq(schema.bookmarks.userId, uid), eq(schema.bookmarks.matchId, matchId)));
        return c.json({ success: true, bookmarked: false });
      }
      await db.insert(schema.bookmarks).values({ userId: uid, matchId, createdAt: now() });
      return c.json({ success: true, bookmarked: true });
    }

    // ================= GENERIC COMMENTS (posts or matches) =================
    case "addComment": {
      const { targetType, targetId, text } = body;
      if (!targetId || !text) throw httpsError("invalid-argument", "targetId and text are required.");
      await assertClean(env, text);
      const commentId = newId();
      const ts = now();
      if (targetType === "matches" || targetType === "contestMatches") {
        await db.insert(schema.matchComments).values({ id: commentId, matchId: targetId, userId: uid, text, createdAt: ts });
        await bumpEngagement(env, targetId, "comment", 1);
      } else {
        await db.insert(schema.postComments).values({ id: commentId, postId: targetId, userId: uid, text, createdAt: ts });
        await db.update(schema.posts).set({ commentCount: sql`${schema.posts.commentCount} + 1` }).where(eq(schema.posts.id, targetId));
        c.executionCtx.waitUntil(
          (async () => {
            const post = await db.select({ userId: schema.posts.userId }).from(schema.posts).where(eq(schema.posts.id, targetId)).get();
            const me = await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.uid, uid)).get();
            if (post?.userId && post.userId !== uid) {
              await createNotification(env, post.userId, { title: "New Comment 💬", body: `${me?.username || "Someone"} commented on your post.`, type: "comment", targetId });
            }
          })(),
        );
      }
      return c.json({ success: true, commentId });
    }

    case "deleteComment": {
      const { targetType, targetId, commentId } = body;
      if (!commentId) throw httpsError("invalid-argument", "commentId is required.");
      if (targetType === "matches" || targetType === "contestMatches") {
        const row = await db.select().from(schema.matchComments).where(eq(schema.matchComments.id, commentId)).get();
        if (!row) throw httpsError("not-found", "Comment not found.");
        if (row.userId !== uid && !(await isAdmin(c as any))) throw httpsError("permission-denied", "Not allowed.");
        await db.delete(schema.matchComments).where(eq(schema.matchComments.id, commentId));
        await bumpEngagement(env, row.matchId, "comment", -1);
      } else {
        const row = await db.select().from(schema.postComments).where(eq(schema.postComments.id, commentId)).get();
        if (!row) throw httpsError("not-found", "Comment not found.");
        if (row.userId !== uid && !(await isAdmin(c as any))) throw httpsError("permission-denied", "Not allowed.");
        await db.delete(schema.postComments).where(eq(schema.postComments.id, commentId));
        await db.update(schema.posts).set({ commentCount: sql`MAX(${schema.posts.commentCount} - 1, 0)` }).where(eq(schema.posts.id, row.postId));
      }
      return c.json({ success: true });
    }

    // ================= PROFILE =================
    case "updateProfile":
    case "completeSignup": {
      // Block banned words in user-visible profile fields.
      if (action === "updateProfile") await assertClean(env, body.username, body.fullName, body.bio);
      const fields = action === "completeSignup" ? { signupCompleted: true } : body;
      const set: Record<string, any> = { updatedAt: now() };
      const extraPatch: Record<string, any> = {};
      const COLUMN_KEYS = new Set([
        "fullName", "username", "dob", "phone", "occupation", "gender", "coordinates",
        "bio", "isPrivate", "authProvider", "platform", "equippedBadge", "signupCompleted",
      ]);
      for (const [k, v] of Object.entries(fields)) {
        if (k === "action" || k === "uid" || v === undefined) continue;
        if (k === "avatarUrl" || k === "profileImageUrl") set.profileImageUrl = v;
        else if (k === "username") set.username = String(v).toLowerCase();
        else if (COLUMN_KEYS.has(k)) set[k] = v;
        else extraPatch[k] = v;
      }
      if (Object.keys(extraPatch).length) {
        const cur = await db.select({ extra: schema.users.extra }).from(schema.users).where(eq(schema.users.uid, uid)).get();
        set.extra = { ...((cur?.extra as any) || {}), ...extraPatch };
      }
      const upd = await db.update(schema.users).set(set).where(eq(schema.users.uid, uid)).run();
      if (upd.meta.changes === 0) {
        // profile row doesn't exist yet — create it
        await db.insert(schema.users).values({
          uid,
          email: c.get("user").email ?? null,
          createdAt: now(),
          updatedAt: now(),
          ...set,
        } as any).onConflictDoUpdate({ target: schema.users.uid, set });
      }

      // Ensure a referral code + apply an inbound referral (once) at signup.
      const meRow = await db
        .select({ referralCode: schema.users.referralCode, referredBy: schema.users.referredBy })
        .from(schema.users)
        .where(eq(schema.users.uid, uid))
        .get();
      if (meRow && !meRow.referralCode) {
        await db.update(schema.users).set({ referralCode: makeReferralCode() }).where(eq(schema.users.uid, uid));
      }
      const refCode = String(body.referralCode || body.referredByCode || "").trim().toUpperCase();
      if (action === "completeSignup" && refCode && meRow && !meRow.referredBy) {
        const referrer = await db
          .select({ uid: schema.users.uid })
          .from(schema.users)
          .where(eq(schema.users.referralCode, refCode))
          .get();
        if (referrer && referrer.uid !== uid) {
          const settings = await getSettings(env);
          const bonus = Number(settings.referralBonus || 0);
          const ts2 = now();
          // referred_uid is UNIQUE → dedups if this runs twice.
          const ins = await db
            .insert(schema.referrals)
            .values({ id: newId(), referrerUid: referrer.uid, referredUid: uid, bonus, createdAt: ts2 })
            .onConflictDoNothing()
            .run();
          if (ins.meta.changes > 0) {
            await db.update(schema.users).set({ referredBy: referrer.uid, updatedAt: ts2 }).where(eq(schema.users.uid, uid));
            if (bonus > 0) {
              await db.batch([
                db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${bonus}` }).where(eq(schema.users.uid, referrer.uid)),
                db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${bonus}` }).where(eq(schema.users.uid, uid)),
                db.insert(schema.coinTransactions).values({ id: newId(), uid: referrer.uid, amount: bonus, type: "referral_bonus", description: "Referral bonus — invited a friend", createdAt: ts2 }),
                db.insert(schema.coinTransactions).values({ id: newId(), uid, amount: bonus, type: "referral_bonus", description: "Referral welcome bonus", createdAt: ts2 }),
              ]);
              await createNotification(env, referrer.uid, { title: "Referral Bonus! 🎉", body: `You earned ${bonus} coins — a friend joined with your code!`, type: "referral", targetId: "wallet" });
            }
          }
        }
      }
      // Invalidate the cached public profile so the user sees their edits
      // immediately (GET /users/:id serves a short-lived KV copy).
      c.executionCtx.waitUntil(delCache(env, userCacheKey(uid)));
      return c.json({ success: true });
    }

    // ================= STORIES (views / reactions / highlights) =================
    case "viewStory": {
      const { storyId } = body;
      if (!storyId) throw httpsError("invalid-argument", "storyId is required.");
      await db.insert(schema.storyViews).values({ storyId, viewerId: uid, createdAt: now() }).onConflictDoNothing();
      return c.json({ success: true });
    }
    case "reactToStory": {
      const { storyId, emoji } = body;
      if (!storyId) throw httpsError("invalid-argument", "storyId is required.");
      await db
        .insert(schema.storyViews)
        .values({ storyId, viewerId: uid, reaction: emoji, createdAt: now() })
        .onConflictDoUpdate({ target: [schema.storyViews.storyId, schema.storyViews.viewerId], set: { reaction: emoji } });
      return c.json({ success: true });
    }
    case "createHighlight": {
      const { name, coverImageUrl, storyIds } = body;
      const id = newId();
      await db.insert(schema.highlights).values({ id, userId: uid, name, coverImageUrl, storyIds: storyIds || [], createdAt: now() });
      return c.json({ success: true, highlightId: id });
    }
    case "addStoryToHighlight": {
      const { highlightId, storyId } = body;
      if (!highlightId || !storyId) throw httpsError("invalid-argument", "highlightId and storyId are required.");
      const h = await db.select().from(schema.highlights).where(eq(schema.highlights.id, highlightId)).get();
      if (!h) throw httpsError("not-found", "Highlight not found.");
      if (h.userId !== uid) throw httpsError("permission-denied", "Not allowed.");
      const ids = new Set<string>((h.storyIds as string[]) || []);
      ids.add(storyId);
      await db.update(schema.highlights).set({ storyIds: [...ids] }).where(eq(schema.highlights.id, highlightId));
      return c.json({ success: true });
    }

    // ================= REPORTS / SUPPORT (also feed admin panel) =================
    case "createReport": {
      const { targetType, targetId, reason } = body;
      const id = newId();
      const ts = now();
      await db.insert(schema.reports).values({ id, reporterId: uid, targetType: targetType || null, targetId: targetId || null, reason: reason || null, status: "open", createdAt: ts });
      await db.insert(schema.adminNotifications).values({ id: newId(), title: "New Report", message: `A ${targetType || "content"} was reported.`, link: "/reports", isRead: false, createdAt: ts });
      return c.json({ success: true, reportId: id });
    }
    case "createSupportTicket": {
      const { subject, message } = body;
      if (!subject) throw httpsError("invalid-argument", "subject is required.");
      const id = newId();
      const ts = now();
      const me = await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      await db.insert(schema.supportTickets).values({ id, userId: uid, subject, message: message || null, status: "open", createdAt: ts, updatedAt: ts });
      await db.insert(schema.adminNotifications).values({ id: newId(), title: "New Support Ticket", message: `${me?.username || "A user"}: ${subject}`, link: "/support", isRead: false, createdAt: ts });
      return c.json({ success: true, ticketId: id });
    }

    // ================= WALLET (ADMIN) =================
    case "adminManageWallet": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { userId, amount, type } = body;
      const amt = Number(amount);
      // Amount must be a positive integer; direction is decided by `type`.
      if (!userId || !Number.isInteger(amt) || amt <= 0 || !["add", "subtract"].includes(type))
        throw httpsError("invalid-argument", "Invalid request parameters.");
      const target = await db
        .select({ balance: schema.users.dpcoin })
        .from(schema.users)
        .where(eq(schema.users.uid, userId))
        .get();
      if (!target) throw httpsError("not-found", "User not found.");
      const oldBal = Number(target.balance || 0);
      const newBal = type === "add" ? oldBal + amt : Math.max(oldBal - amt, 0);
      // Record the ACTUAL applied change (after clamping at 0) so the ledger
      // always reconciles with the balance — previously it logged the full
      // requested delta even when the balance was clamped.
      const applied = newBal - oldBal;
      const ts = now();
      await db.batch([
        db.update(schema.users).set({ dpcoin: newBal, updatedAt: ts }).where(eq(schema.users.uid, userId)),
        db.insert(schema.coinTransactions).values({
          id: newId(), uid: userId, amount: applied, type: "admin_adjustment",
          description: `Admin ${type} ${amt} Dpcoin`, createdAt: ts,
        }),
      ]);
      return c.json({ success: true, message: "Wallet updated successfully", newBalance: newBal });
    }
    case "join":
    case "vote":
      return notPorted(action, "contests/contestHandler.ts (legacy entries/battles matchmaking)");

    default:
      throw httpsError("invalid-argument", `Action '${action}' nahi mila.`);
  }
  } catch (e) {
    // The guarded action failed and committed nothing — free the idempotency
    // key so a legitimate retry isn't rejected for the next 24h.
    if (body.idempotencyKey) await releaseIdempotency(env, uid, String(body.idempotencyKey));
    throw e;
  }
});
