/**
 * /api — port of apps/functions/src/api/main.ts (the callable `api` router).
 * Same contract: POST { action, ...data } with `Authorization: Bearer <idToken>`.
 *
 * D1 has no interactive transactions, so money-critical mutations use
 * conditional UPDATEs (e.g. `WHERE dpcoin >= fee`) and check the affected row
 * count to prevent double-spend / races.
 */
import { Hono } from "hono";
import { eq, and, or, desc, sql, count, like, gte, lt, ne, isNull, inArray } from "drizzle-orm";
import type { Env, Variables } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "../lib/http";
import { requireAuth, isAdmin } from "../middleware/auth";
import { requireFullAdmin as requireFullAdminAction, writeAdminAudit } from "../lib/adminAuthz";
import { vsImageKeyFromPublicUrl, deleteVsImageByPublicUrl } from "../lib/r2";
import { deleteMediaByUrl } from "../lib/mediaDelete";

import { createNotification, sendPushNotification } from "../lib/notify";
import { enqueueBroadcast } from "../lib/broadcast";
import { setCustomClaims } from "../lib/firebaseAdmin";
import { publish, publishMany } from "../lib/publish";
import { castVote, bumpEngagement } from "../lib/voteCounter";
import { rateLimit } from "../lib/rateLimit";
import { assertIdentifiersAvailable, normalizePhone } from "../lib/userIdentifiers";
import { enforceIdempotency, releaseIdempotency } from "../lib/idempotency";
import {
  contestDetailCacheKey,
  contestListCacheKeys,
  commentsCacheKey,
  delCache,
  userCacheKey,
  followersCacheKey,
  followingCacheKey,
} from "../lib/cache";
import { createContestExtra, validateContestInput } from "../lib/contestAdmin";
import { parsePayoutDestination, readWithdrawalPolicy } from "../lib/payouts";
import {
  checkDeletionEligibility,
  deleteOwnAccount,
  purgeDeletedAccountMedia,
} from "../lib/accountDeletion";
import {
  adjustUserWallet,
  assertCoinAmount,
  matchPot,
  perPlayerEntryFee,
  roundFiat,
  WalletReplay,
} from "../lib/money";
import { verifyRazorpaySignature } from "../lib/payments";
import { getRazorpayCredentials } from "../lib/integrations";
import { creditPaymentOrder } from "../lib/coinOrders";
import { assertClean } from "../lib/moderation";
import { assertChatMember } from "../lib/chatAuth";
import { publishVsStories, storyMediaType } from "../lib/matchStories";
import {
  assertMatchInteractionAllowed,
  assertNotBlocked,
  assertNotBlockedAny,
  assertStoryInteractionAllowed,
  invalidateBlockCache,
  isBlockedBetween,
} from "../lib/blocks";
import { detachTokenFromOtherUsers } from "../lib/pushTokens";
import { resolvePrefs, serializePrefs } from "../lib/notificationPrefs";
import {
  bunnyConfigured,
  createVideo,
  bunnyPlaybackUrl,
  bunnyThumbnailUrl,
} from "../lib/bunny";
import { getAppConfig, getRewardedAdConfig } from "../lib/settings";
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

/** Max length of a single comment (server-enforced; UI mirrors this). */
const MAX_COMMENT_LEN = 500;

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
    //
    // `getPresignedUrl` and `getStoryUrl` are GONE, deliberately.
    //
    // They minted a signed S3 PUT URL and handed it to the client, which then
    // uploaded straight to R2. That has two properties we cannot live with now
    // that uploads are content-validated:
    //
    //   1. The bytes never pass through the Worker, so there is nothing to
    //      inspect. A signed URL is an unconditional write primitive for whatever
    //      key it names — the only check possible is on the declared type at
    //      minting time, which is the exact check that turned out to be worthless.
    //   2. `presignUpload` applied no size limit at all (the 80 MB cap lived in
    //      the `/upload` handler), so one credential could store an object of any
    //      size in our bucket.
    //
    // Keeping them as a "fallback" would have made the validation optional, and
    // an optional check on an endpoint every signed-in user can reach is not a
    // check. Nothing calls them: the app uploads exclusively via `POST /upload`
    // (apps/expo/src/lib/uploadToR2.ts) and has since the presigned path was
    // found to CORS-fail in the browser. An old build that still sent these gets
    // a clear `unimplemented` rather than a silent 500.
    case "getPresignedUrl":
    case "getStoryUrl":
      throw httpsError(
        "failed-precondition",
        "Direct-to-R2 uploads are no longer supported. Please update the app.",
      );

    // ================= VIDEO (Bunny Stream) =================
    /**
     * Mint credentials for a direct-to-Bunny resumable (TUS) video upload.
     *
     * Returns only { videoId, libraryId, expirationTime, signature } — the Bunny
     * API key stays server-side. The client uploads the bytes itself, then the
     * encoding webhook flips the row to 'ready'.
     *
     * Returns `configured: false` instead of throwing when Bunny is not set up,
     * so the client can fall back to the existing R2 upload path.
     */
    case "createVideoUpload": {
      if (!(await bunnyConfigured(env))) return c.json({ configured: false });

      // Without this, anyone can create unlimited video objects in our Bunny
      // account. 10/hour is far above real usage and far below abuse.
      await rateLimit(env, `vidup:${uid}`, 10, 3600);

      const { title, targetType } = body;
      if (targetType && !["story", "contest_entry"].includes(String(targetType)))
        throw httpsError("invalid-argument", "Invalid targetType.");

      const created = await createVideo(env, String(title || `upload-${uid}-${now()}`));
      const ts = now();
      await db.insert(schema.videos).values({
        id: created.guid,
        libraryId: created.libraryId,
        ownerUid: uid,
        provider: "bunny",
        status: "uploading",
        // target_id is filled in when the story / contest entry is created; a row
        // that stays null is an abandoned upload and can be swept later.
        targetType: targetType ? String(targetType) : null,
        createdAt: ts,
        updatedAt: ts,
      });

      return c.json({
        configured: true,
        videoId: created.guid,
        libraryId: created.libraryId,
        expirationTime: created.expirationTime,
        signature: created.signature,
        tusEndpoint: created.tusEndpoint,
        // The eventual playback URL, so the caller can store it as mediaUrl
        // without knowing how Bunny URLs are shaped.
        playbackUrl: await bunnyPlaybackUrl(env, created.guid),
        thumbnailUrl: await bunnyThumbnailUrl(env, created.guid),
      });
    }

    /**
     * Called by the client once the TUS upload finishes. Moves the row from
     * 'uploading' to 'processing' and records what the video is attached to.
     * The authoritative 'ready' transition comes from the Bunny webhook.
     */
    case "videoUploadComplete": {
      const { videoId, targetType, targetId } = body;
      if (!videoId) throw httpsError("invalid-argument", "videoId is required.");
      const ts = now();
      // Scoped to the owner so one user cannot mutate another's video row, and
      // only from 'uploading' so a webhook that already landed isn't regressed.
      const claim = await db
        .update(schema.videos)
        .set({
          status: "processing",
          targetType: targetType ? String(targetType) : undefined,
          targetId: targetId ? String(targetId) : undefined,
          updatedAt: ts,
        })
        .where(
          and(
            eq(schema.videos.id, String(videoId)),
            eq(schema.videos.ownerUid, uid),
            eq(schema.videos.status, "uploading"),
          ),
        )
        .run();
      return c.json({ success: true, updated: claim.meta.changes > 0 });
    }

    /**
     * Current processing state for a set of videos, so a client showing a
     * "Processing…" overlay can poll without hitting Bunny directly.
     */
    case "videoStatus": {
      const { videoIds } = body;
      const ids = (Array.isArray(videoIds) ? videoIds : [videoIds])
        .filter((v: any) => typeof v === "string" && v)
        .slice(0, 50);
      if (!ids.length) return c.json({ videos: [] });
      const rows = await db
        .select({
          id: schema.videos.id,
          status: schema.videos.status,
          thumbnailUrl: schema.videos.thumbnailUrl,
          durationSec: schema.videos.durationSec,
          playbackUrl: schema.videos.playbackUrl,
          mp4Url: schema.videos.mp4Url,
        })
        .from(schema.videos)
        .where(inArray(schema.videos.id, ids))
        .all();
      return c.json({ videos: rows });
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
      // Checked BEFORE the entry fee is debited. joinMatch refuses a blocked
      // invitee, so without this the creator pays to create a private match that
      // the only person allowed to join can never join — the coins would sit
      // locked until the auto-cancel refund swept them up.
      if (invitedUid) await assertNotBlockedAny(env, uid, [String(invitedUid)]);

      const totalFee = Number(contest.totalEntryFee || 0);
      // Whole coins only. `perPlayerEntryFee` floors, so a legacy odd entry fee
      // charges (and later refunds) an exact integer instead of x.5 coins.
      const fee = perPlayerEntryFee(totalFee);
      // Snapshot the prize now. Settlement pays the snapshot, so a later edit to
      // the contest template cannot change what this match pays out, and the
      // prize can never exceed the pot these two players fund.
      const prizeCoins = Math.min(Number(contest.rewardCoins || 0), matchPot(totalFee));

      const ts = now();
      const matchId = newId();
      // Deterministic, matching the joinMatch side of the same match, so a retry
      // resolves to the same ledger row instead of a second charge.
      const entryTransactionId = `contest_entry:${matchId}:${uid}`;
      const joinIdA = generateJoinId();
      const expiresAt = ts + (contest.autoCancelHours || 24) * 60 * 60 * 1000;
      const userASnapshot = {
        uid, joinId: joinIdA, username: user.username || "Anonymous",
        profilePic: user.profileImageUrl || "", mediaUrl, mediaType: mediaType || "photo",
        caption: caption || "", votes: 0, deviceId: deviceId || "",
      };

      // The entry-fee debit, its ledger row and the match itself are ONE D1
      // transaction, and all three are gated on the SAME pre-transaction solvency
      // snapshot — the two INSERTs run first and do not touch `users`, so the
      // UPDATE that follows evaluates an identical condition. Either all three
      // apply or none do.
      //
      // Previously the deduct was a standalone statement and the ledger + match
      // came afterwards in a separate batch, with a compensating refund in a
      // `catch`. That refund was itself unledgered and ungated, so the failure it
      // was meant to cover — the batch not applying — left the user charged with
      // no match; and if the refund also failed, the coins were simply gone with
      // no trace. Same pattern as joinMatch and lib/money.ts#adjustUserWallet.
      const solvent = `EXISTS (SELECT 1 FROM users WHERE uid = ? AND dpcoin >= ?)`;
      const createResults = await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, contest_id, description, created_at)
           SELECT ?, ?, ?, 'contest_entry_fee', ?, ?, ?
            WHERE ${solvent}`,
        ).bind(
          entryTransactionId,
          uid,
          -fee,
          contestId ?? null,
          `Entry fee (50% split) for ${contest.title || "contest"}`,
          ts,
          uid,
          fee,
        ),
        env.DB.prepare(
          `INSERT INTO contest_matches
             (id, contest_id, status, type, title, entry_fee, is_private, invited_uid,
              join_id_a, user_a, total_votes, min_votes_required, prize_coins, created_at, expires_at)
           SELECT ?, ?, 'waiting_for_opponent', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?
            WHERE ${solvent}`,
        ).bind(
          matchId,
          contestId ?? null,
          contest.type || "photo",
          contest.title || "Untitled Contest",
          totalFee,
          invitedUid ? 1 : 0,
          invitedUid || null,
          joinIdA,
          JSON.stringify(userASnapshot),
          Math.max(0, Number(contest.minVotes || 0)),
          prizeCoins,
          ts,
          expiresAt,
          uid,
          fee,
        ),
        env.DB.prepare(
          `UPDATE users
              SET dpcoin = dpcoin - ?, xp = xp + 10, updated_at = ?
            WHERE uid = ? AND dpcoin >= ?`,
        ).bind(fee, ts, uid, fee),
      ]);
      if (Number(createResults[2]?.meta?.changes || 0) === 0) {
        // Nothing was charged and no match was created — the two INSERTs share
        // this statement's gate.
        throw httpsError("failed-precondition", `Insufficient Dpcoin. Required: ${fee}, Current: ${user.dpcoin}`);
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

      // Solo "I've entered, come challenge me" story. Replaced by a head-to-head
      // story for both users once someone joins (see lib/matchStories.ts).
      // `storyMediaType` matters: this used to write "photo", which the story
      // viewer does not recognise as an image, so it rendered blank.
      await db.insert(schema.stories).values({
        id: newId(), userId: uid, username: user.username || "Anonymous", avatarUrl: user.profileImageUrl || "",
        mediaUrl, mediaType: storyMediaType(mediaType), type: "contest_announcement", matchId,
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
      // Refused BEFORE the entry fee is debited: a battle is a sustained,
      // notification-generating interaction, and being forced into one with
      // someone you blocked is exactly what the block is for.
      await assertNotBlockedAny(env, uid, [userA?.uid]);

      const user = await db.select().from(schema.users).where(eq(schema.users.uid, uid)).get();
      if (!user) throw httpsError("not-found", "User document not found.");
      const fee = perPlayerEntryFee(match.entryFee);
      // Voting window starts on activation and lasts the contest's configured
      // voteDurationDays — NOT the waiting-room autoCancelHours (which only
      // bounds how long a match may sit waiting for an opponent).
      const contestPolicy = match.contestId
        ? await db.select({
            voteDays: schema.contests.voteDurationDays,
            minVotes: schema.contests.minVotes,
            status: schema.contests.status,
            reward: schema.contests.rewardCoins,
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

      const ts = now();
      const joinIdB = generateJoinId();
      const entryLedgerId = `contest_entry:${matchId}:${uid}`;
      // Legacy matches created before prize_coins existed get their snapshot
      // here, at activation — the same treatment min_votes_required gets.
      const prizeSnapshot = match.prizeCoins == null
        ? Math.min(Number(contestPolicy?.reward ?? 0), matchPot(match.entryFee))
        : Number(match.prizeCoins);
      const userBSnapshot = {
        uid, joinId: joinIdB, username: user.username || "Anonymous",
        profilePic: user.profileImageUrl || "", mediaUrl, mediaType: mediaType || "photo",
        caption: caption || "", votes: 0, deviceId: deviceId || "",
      };

      // Slot claim, entry-fee ledger and balance deduct are ONE D1 transaction,
      // gated on the freshly generated `joinIdB` acting as a claim token — the
      // same pattern lib/contestSettlement.ts uses with settlement_id.
      //
      // Previously these were three separate writes: the deduct happened first,
      // a lost race was compensated by a bare refund that wrote NO ledger row,
      // and the ledger insert could fail after the slot was already claimed. Now
      // either all three apply or none do, so a player can never be charged for
      // a slot they did not get, and no balance moves without a ledger row.
      const claimGate = `EXISTS (SELECT 1 FROM contest_matches WHERE id = ? AND join_id_b = ?)`;
      const joinResults = await env.DB.batch([
        env.DB.prepare(
          `UPDATE contest_matches
              SET status = 'active', join_id_b = ?, activated_at = ?,
                  min_votes_required = ?, prize_coins = ?, expires_at = ?, user_b = ?
            WHERE id = ? AND status = 'waiting_for_opponent'
              AND EXISTS (SELECT 1 FROM users WHERE uid = ? AND dpcoin >= ?)`,
        ).bind(
          joinIdB,
          ts,
          minVotesRequired,
          prizeSnapshot,
          ts + Math.max(1, voteDays) * 24 * 60 * 60 * 1000,
          JSON.stringify(userBSnapshot),
          matchId,
          uid,
          fee,
        ),
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, contest_id, match_id, description, created_at)
           SELECT ?, ?, ?, 'contest_entry_fee', ?, ?, ?, ?
            WHERE ${claimGate}`,
        ).bind(
          entryLedgerId,
          uid,
          -fee,
          match.contestId ?? null,
          matchId,
          `Entry fee (50% split) for ${match.title || "contest"}`,
          ts,
          matchId,
          joinIdB,
        ),
        env.DB.prepare(
          `UPDATE users
              SET dpcoin = dpcoin - ?, xp = xp + 10, updated_at = ?
            WHERE uid = ? AND ${claimGate}`,
        ).bind(fee, ts, uid, matchId, joinIdB),
      ]);

      if (Number(joinResults[0]?.meta?.changes || 0) === 0) {
        // Nothing was charged and nothing was claimed. Tell the user which of
        // the two guards rejected them.
        const stillWaiting = await db
          .select({ status: schema.contestMatches.status })
          .from(schema.contestMatches)
          .where(eq(schema.contestMatches.id, matchId))
          .get();
        if (!stillWaiting || stillWaiting.status !== "waiting_for_opponent") {
          throw httpsError("failed-precondition", "Match unavailable.");
        }
        throw httpsError("failed-precondition", `Insufficient Dpcoin. Required: ${fee}, Current: ${user.dpcoin}`);
      }

      // The battle now has two sides, so both participants get a head-to-head
      // story and the creator's solo announcement is retired. Best-effort: the
      // entry fee is already taken and the match is already live, so a story
      // problem must not surface as a failed join. See lib/matchStories.ts.
      c.executionCtx.waitUntil(
        publishVsStories(env, {
          matchId,
          contestTitle: match.title || "Contest",
          userA: {
            uid: userA.uid,
            username: userA.username,
            profilePic: userA.profilePic,
            mediaUrl: userA.mediaUrl,
            mediaType: userA.mediaType,
          },
          userB: {
            uid,
            username: user.username,
            profilePic: user.profileImageUrl,
            mediaUrl,
            mediaType,
          },
          ts,
        }),
      );

      c.executionCtx.waitUntil(
        sendPushNotification(
          env, userA.uid, "Match Live! 🚀",
          `${user.username} has joined your battle "${match.title}". Voting is now open!`,
          "match_active", { matchId },
        ),
      );

      return c.json({ status: "active", joinId: joinIdB });
    }

    /**
     * Record the composite head-to-head image for a battle.
     *
     * The Worker cannot compose images (see migration 0033 and
     * lib/matchStories.ts), so a participant's client captures the rendered card,
     * uploads it to `vs-cards/`, and reports the url here. Both participants'
     * stories then DISPLAY that single image, because the story viewer loads the
     * match and prefers `vsImageUrl` over assembling the layout itself.
     *
     * ------------------------------------------------------------------------
     * The card is recorded on the MATCH ONLY — never copied into `stories`
     * ------------------------------------------------------------------------
     * An earlier version of this also rewrote both `contest_vs` rows' `media_url`
     * to the card. That was wrong twice over, and both are worth keeping written
     * down because copying the url looks obviously convenient:
     *
     *   - It defeated blocking. `/read/matches/:id` deliberately returns nothing
     *     when either participant is blocked by the viewer, which is what makes
     *     the story fall back to the single entry the row itself carries. Once
     *     that row carried the composite, the fallback showed the blocked user's
     *     photo anyway.
     *   - It gave one R2 object two owners. Account deletion collects
     *     `stories.media_url` for the departing user and deletes those objects, so
     *     one participant leaving would have deleted the image the other
     *     participant's live story was displaying.
     *
     * Keeping `media_url` as each user's own entry means the row is still
     * meaningful to anything that renders it directly, blocking still works, and
     * the card has exactly one owner: the match.
     *
     * Guards, because a participant is supplying a url that the OTHER
     * participant's story will render:
     *   1. the battle must be full — an unjoined match has nothing to depict, and
     *      without this its creator could claim the card before an opponent
     *      exists, permanently;
     *   2. only a participant may set it;
     *   3. the url must be an object in our own bucket under `vs-cards/images/`,
     *      so a story can never be pointed at an arbitrary remote image;
     *   4. first writer wins — never overwrite. Both clients plausibly try, and
     *      silently swapping the image under a story that is already being viewed
     *      is worse than keeping the first good one.
     *
     * What this does NOT establish is that the pixels are a real capture of the
     * battle; see `vsImageKeyFromPublicUrl` for why that residual risk is
     * accepted, and what it actually amounts to.
     */
    case "setMatchVsImage": {
      // Fail closed: this action writes a url that renders on another user's
      // story, so an outage of the counter store must not remove the ceiling.
      await rateLimit(env, `vsimage:${uid}`, 30, 3600, { failClosed: true });
      const matchId = requiredId(body.matchId, "matchId", 128);
      const imageUrl = requiredId(body.imageUrl, "imageUrl", 2048);
      if (!vsImageKeyFromPublicUrl(env, imageUrl)) {
        throw httpsError("invalid-argument", "imageUrl must be an uploaded battle card.");
      }

      const match = await db
        .select({
          userA: schema.contestMatches.userA,
          userB: schema.contestMatches.userB,
          vsImageUrl: schema.contestMatches.vsImageUrl,
        })
        .from(schema.contestMatches)
        .where(eq(schema.contestMatches.id, matchId))
        .get();
      // The caller uploaded before calling, so from here on every rejection
      // orphans that object unless we clean it up. R2 deletes are free and the
      // key is pinned to the `vs-cards/` prefix, so this is unconditional.
      if (!match) {
        await deleteVsImageByPublicUrl(env, imageUrl);
        throw httpsError("not-found", "Match not found.");
      }

      const uidA = (match.userA as any)?.uid;
      const uidB = (match.userB as any)?.uid;
      // A head-to-head card of a battle with one side is not a thing that can
      // exist. Checked before the participant test so a creator waiting for an
      // opponent gets the honest reason.
      if (!uidA || !uidB) {
        await deleteVsImageByPublicUrl(env, imageUrl);
        throw httpsError("failed-precondition", "This battle does not have two participants yet.");
      }
      if (uid !== uidA && uid !== uidB) {
        await deleteVsImageByPublicUrl(env, imageUrl);
        throw httpsError("permission-denied", "Only a participant can set the battle image.");
      }
      // Already recorded by whoever got there first. The card this caller just
      // uploaded is now unreferenced, so throw it away rather than paying to
      // store it forever — unless it IS the stored one (a retry of a call that
      // actually succeeded), in which case deleting it would break a live story.
      if (match.vsImageUrl) {
        if (match.vsImageUrl !== imageUrl) await deleteVsImageByPublicUrl(env, imageUrl);
        return c.json({ success: true, vsImageUrl: match.vsImageUrl, alreadySet: true });
      }

      // The `vs_image_url IS NULL` gate makes the first-writer-wins rule hold
      // against a genuine race, not just against the read above.
      const claimed = await db
        .update(schema.contestMatches)
        .set({ vsImageUrl: imageUrl })
        .where(and(eq(schema.contestMatches.id, matchId), isNull(schema.contestMatches.vsImageUrl)))
        .run();
      if (Number(claimed.meta?.changes || 0) === 0) {
        // Someone claimed it between the read and the update. Re-read to tell this
        // client which card actually won, and discard the one it uploaded.
        const current = await db
          .select({ vsImageUrl: schema.contestMatches.vsImageUrl })
          .from(schema.contestMatches)
          .where(eq(schema.contestMatches.id, matchId))
          .get();
        if (current?.vsImageUrl !== imageUrl) await deleteVsImageByPublicUrl(env, imageUrl);
        // A null here means the row was deleted underneath us, not that a card
        // exists — reporting `alreadySet` for that would have the client cache a
        // card that never existed.
        if (!current?.vsImageUrl) throw httpsError("not-found", "Match not found.");
        return c.json({ success: true, vsImageUrl: current.vsImageUrl, alreadySet: true });
      }

      return c.json({ success: true, vsImageUrl: imageUrl });
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
      // A vote decides who takes the prize pot, so someone the voter has blocked
      // (or who blocked them) must not be able to have their outcome influenced
      // either way. The match row is already loaded, so this is one extra query.
      await assertNotBlockedAny(env, uid, [userA?.uid, userB?.uid]);

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
        // Recorded so vote fraud can be investigated by network as well as by
        // device id. The per-IP throttle above already bounds bursts; this makes
        // clustering visible after the fact.
        ip: voteIp || null,
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
      await rateLimit(env, `post:${uid}`, 30, 3600);
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
      if (post.mediaUrl) await deleteMediaByUrl(env, post.mediaUrl).catch(() => {});
      return c.json({ success: true, message: "Post deleted successfully" });
    }

    // ================= STORIES =================
    // `getStoryUrl` is handled with `getPresignedUrl` above.
    case "createStory": {
      await rateLimit(env, `story:${uid}`, 40, 3600);
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
      // Provider-aware: a story's media is in R2 or in Bunny.
      if (story.mediaUrl) await deleteMediaByUrl(env, story.mediaUrl);
      await db.delete(schema.stories).where(eq(schema.stories.id, storyId));
      return c.json({ success: true });
    }

    // ================= USER & SOCIAL =================
    case "toggleFollow": {
      // Follow/unfollow churn is a notification-spam and scraping vector.
      await rateLimit(env, `follow:${uid}`, 120, 3600);
      const { targetUserId } = body;
      if (!targetUserId) throw httpsError("invalid-argument", "The function must be called with a 'targetUserId'.");
      if (targetUserId === uid) throw httpsError("invalid-argument", "You cannot follow yourself.");
      const existing = await db
        .select()
        .from(schema.follows)
        .where(and(eq(schema.follows.followerId, uid), eq(schema.follows.followingId, targetUserId)))
        .get();

      // The follow edge touches four cached surfaces: the follower's "following"
      // list, the target's "followers" list, and both users' profile (denormalized
      // follower/following counts). Invalidate all four so the next read is fresh.
      const invalidateFollowCaches = () =>
        delCache(
          env,
          followingCacheKey(uid),
          followersCacheKey(targetUserId),
          userCacheKey(uid),
          userCacheKey(targetUserId),
        );

      if (existing) {
        // Unfollow: one atomic round-trip instead of three sequential ones.
        await db.batch([
          db.delete(schema.follows).where(and(eq(schema.follows.followerId, uid), eq(schema.follows.followingId, targetUserId))),
          db.update(schema.users).set({ followingCount: sql`MAX(${schema.users.followingCount} - 1, 0)` }).where(eq(schema.users.uid, uid)),
          db.update(schema.users).set({ followersCount: sql`MAX(${schema.users.followersCount} - 1, 0)` }).where(eq(schema.users.uid, targetUserId)),
        ]);
        c.executionCtx.waitUntil(invalidateFollowCaches());
        return c.json({ success: true, isFollowing: false });
      }
      // Guarded on the FOLLOW branch only. Unfollowing must stay possible
      // whatever the relationship is — refusing it could strand an edge that
      // predates the block and leave the user unable to clean it up.
      await assertNotBlocked(env, uid, targetUserId);
      // Follow: insert edge + bump both counters atomically in a single batch.
      await db.batch([
        db.insert(schema.follows).values({ followerId: uid, followingId: targetUserId, createdAt: now() }),
        db.update(schema.users).set({ followingCount: sql`${schema.users.followingCount} + 1` }).where(eq(schema.users.uid, uid)),
        db.update(schema.users).set({ followersCount: sql`${schema.users.followersCount} + 1` }).where(eq(schema.users.uid, targetUserId)),
      ]);
      const me = await db.select({ username: schema.users.username, fullName: schema.users.fullName, avatar: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      c.executionCtx.waitUntil(
        Promise.all([
          invalidateFollowCaches(),
          createNotification(env, targetUserId, {
            title: "New Follower! 👤",
            body: `${me?.username || me?.fullName || "Someone"} started following you.`,
            type: "follow", targetId: uid, image: me?.avatar || undefined,
            // Enables grouping: "Asha and 3 others started following you".
            actor: { uid, username: me?.username || me?.fullName, avatarUrl: me?.avatar },
          }),
        ]),
      );
      return c.json({ success: true, isFollowing: true });
    }

    // ================= BLOCK / MUTE =================
    // Deliberately NOT toggles, unlike toggleFollow/toggleBookmark. These are
    // safety actions: a double-tap or a retried request must never quietly undo
    // a block, so each direction is its own explicit action and both are
    // idempotent (onConflictDoNothing / an unconditional delete).
    // See lib/blocks.ts for the enforcement rules.
    case "blockUser": {
      await rateLimit(env, `block:${uid}`, 60, 3600);
      const targetUserId = requiredId(body.targetUserId, "targetUserId", 128);
      if (targetUserId === uid) throw httpsError("invalid-argument", "You cannot block yourself.");
      const target = await db
        .select({ uid: schema.users.uid })
        .from(schema.users)
        .where(eq(schema.users.uid, targetUserId))
        .get();
      if (!target) throw httpsError("not-found", "User not found.");

      // A block tears down the follow relationship in BOTH directions. Leaving
      // the edges in place would keep feeding the blocked user's battles into
      // the blocker's "Following" tab and keep the blocker listed among the
      // blocked user's followers — i.e. the block would appear not to have
      // worked. Read the edges first so the counters are only decremented for
      // edges that actually existed: D1 batches run in order, so a conditional
      // `WHERE EXISTS (SELECT ... FROM follows ...)` would already see the
      // delete that precedes it.
      const [iFollowThem, theyFollowMe] = await Promise.all([
        db
          .select({ followerId: schema.follows.followerId })
          .from(schema.follows)
          .where(and(eq(schema.follows.followerId, uid), eq(schema.follows.followingId, targetUserId)))
          .get(),
        db
          .select({ followerId: schema.follows.followerId })
          .from(schema.follows)
          .where(and(eq(schema.follows.followerId, targetUserId), eq(schema.follows.followingId, uid)))
          .get(),
      ]);

      // Each decrement is gated on the edge still existing and is ordered BEFORE
      // the delete that removes it. That ordering is the point: D1 batches run
      // sequentially, so an `EXISTS` placed after its own delete would always be
      // false, while one placed before it sees the state at commit time. This is
      // what makes the counters safe against a concurrent unfollow — that request
      // has already decremented, so the row is gone and these become no-ops
      // instead of decrementing a second time.
      const edgeExists = (followerId: string, followingId: string) =>
        sql`EXISTS (SELECT 1 FROM follows WHERE follower_id = ${followerId} AND following_id = ${followingId})`;
      const stmts: any[] = [
        db
          .insert(schema.userBlocks)
          .values({ blockerId: uid, blockedId: targetUserId, createdAt: now() })
          .onConflictDoNothing(),
      ];
      if (iFollowThem) {
        stmts.push(
          db.update(schema.users).set({ followingCount: sql`MAX(${schema.users.followingCount} - 1, 0)` }).where(and(eq(schema.users.uid, uid), edgeExists(uid, targetUserId))),
          db.update(schema.users).set({ followersCount: sql`MAX(${schema.users.followersCount} - 1, 0)` }).where(and(eq(schema.users.uid, targetUserId), edgeExists(uid, targetUserId))),
          db.delete(schema.follows).where(and(eq(schema.follows.followerId, uid), eq(schema.follows.followingId, targetUserId))),
        );
      }
      if (theyFollowMe) {
        stmts.push(
          db.update(schema.users).set({ followingCount: sql`MAX(${schema.users.followingCount} - 1, 0)` }).where(and(eq(schema.users.uid, targetUserId), edgeExists(targetUserId, uid))),
          db.update(schema.users).set({ followersCount: sql`MAX(${schema.users.followersCount} - 1, 0)` }).where(and(eq(schema.users.uid, uid), edgeExists(targetUserId, uid))),
          db.delete(schema.follows).where(and(eq(schema.follows.followerId, targetUserId), eq(schema.follows.followingId, uid))),
        );
      }
      // Belt and braces against the opposite race: a `toggleFollow` that passed
      // its block check microseconds before the row above was inserted would
      // otherwise insert an edge AFTER these deletes and leave a follow that
      // outlives the block. Deleting again after the block row is committed closes
      // that window; it is a no-op in the normal case.
      stmts.push(
        db.delete(schema.follows).where(
          or(
            and(eq(schema.follows.followerId, uid), eq(schema.follows.followingId, targetUserId)),
            and(eq(schema.follows.followerId, targetUserId), eq(schema.follows.followingId, uid)),
          ),
        ),
      );
      await db.batch(stmts as any);

      // Nothing else is undone. Votes already cast, comments already written and
      // matches already settled stay exactly as they are — the coin ledger and
      // contest results reference them, and a prize that has been paid cannot be
      // retracted because of a later falling-out. Only visibility and the
      // ability to interact from here on change.
      c.executionCtx.waitUntil(
        Promise.all([
          // Mutual relation → both users' exclusion sets moved.
          invalidateBlockCache(env, uid, targetUserId),
          delCache(
            env,
            followingCacheKey(uid),
            followersCacheKey(uid),
            followingCacheKey(targetUserId),
            followersCacheKey(targetUserId),
            userCacheKey(uid),
            userCacheKey(targetUserId),
          ),
        ]),
      );
      // No notification, by design: telling someone they have been blocked is
      // the opposite of what the feature is for.
      return c.json({ success: true, blocked: true });
    }

    case "unblockUser": {
      await rateLimit(env, `block:${uid}`, 60, 3600);
      const targetUserId = requiredId(body.targetUserId, "targetUserId", 128);
      await db
        .delete(schema.userBlocks)
        .where(and(eq(schema.userBlocks.blockerId, uid), eq(schema.userBlocks.blockedId, targetUserId)));
      // Follows are NOT restored. They were a separate decision and the user has
      // to make it again deliberately.
      c.executionCtx.waitUntil(invalidateBlockCache(env, uid, targetUserId));
      return c.json({ success: true, blocked: false });
    }

    case "muteUser": {
      await rateLimit(env, `mute:${uid}`, 120, 3600);
      const targetUserId = requiredId(body.targetUserId, "targetUserId", 128);
      if (targetUserId === uid) throw httpsError("invalid-argument", "You cannot mute yourself.");
      // Same existence check as blockUser. Without it any string becomes a mute
      // row, and because the management screen resolves rows through the users
      // table, a row pointing at no account would be invisible there and could
      // never be undone.
      const muteTarget = await db
        .select({ uid: schema.users.uid })
        .from(schema.users)
        .where(eq(schema.users.uid, targetUserId))
        .get();
      if (!muteTarget) throw httpsError("not-found", "User not found.");
      await db
        .insert(schema.userMutes)
        .values({ muterId: uid, mutedId: targetUserId, createdAt: now() })
        .onConflictDoNothing();
      // One-way and silent: the muted user is never told, keeps following, and
      // can still message and comment. Only this viewer's feed changes.
      c.executionCtx.waitUntil(invalidateBlockCache(env, uid));
      return c.json({ success: true, muted: true });
    }

    case "unmuteUser": {
      await rateLimit(env, `mute:${uid}`, 120, 3600);
      const targetUserId = requiredId(body.targetUserId, "targetUserId", 128);
      await db
        .delete(schema.userMutes)
        .where(and(eq(schema.userMutes.muterId, uid), eq(schema.userMutes.mutedId, targetUserId)));
      c.executionCtx.waitUntil(invalidateBlockCache(env, uid));
      return c.json({ success: true, muted: false });
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
      //
      // The ledger row is written in the SAME transaction, gated on the same
      // pre-transaction snapshot (`last_daily_claim` before the update). It used
      // to be a separate statement, so a failure between the two credited coins
      // with no ledger entry.
      const eligible = `(last_daily_claim IS NULL OR last_daily_claim < ?)`;
      const dailyResults = await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, description, created_at)
           SELECT ?, ?, ?, 'daily_reward', ?, ?
            WHERE EXISTS (SELECT 1 FROM users WHERE uid = ? AND ${eligible})`,
        ).bind(
          `daily_reward:${uid}:${startOfToday}`,
          uid,
          coinReward,
          `Daily login reward (${streak} day streak)`,
          ts,
          uid,
          startOfToday,
        ),
        env.DB.prepare(
          `UPDATE users
              SET dpcoin = dpcoin + ?, xp = xp + ?, streak = ?, last_daily_claim = ?, updated_at = ?
            WHERE uid = ? AND ${eligible}`,
        ).bind(coinReward, xpReward, streak, ts, ts, uid, startOfToday),
      ]);
      if (Number(dailyResults[1]?.meta?.changes || 0) === 0)
        throw httpsError("already-exists", "Daily reward already claimed today.");
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
      await rateLimit(env, `ad:${uid}`, 20, 60);
      const ads = await getRewardedAdConfig(env);

      // Rewarded ads mint real, withdrawable currency on nothing but the
      // client's word that an ad was watched. That is only acceptable once the
      // ad network's Server-Side Verification callback is the thing that
      // credits, so the feature is OFF unless an admin explicitly turns it on.
      //
      // `trustClient: true` is the escape hatch for a non-SSV provider: it still
      // works, but it has to be a deliberate, visible decision rather than the
      // silent default it used to be.
      if (!ads.enabled) {
        throw httpsError(
          "failed-precondition",
          "Rewarded ads are not currently available.",
        );
      }
      if (!ads.trustClient) {
        throw httpsError(
          "failed-precondition",
          "Rewarded ads must be credited through the ad network's server-side verification callback.",
        );
      }

      const day = Math.floor(Date.now() / 86_400_000); // UTC day bucket
      const ts = now();
      const claimId = newId();
      // The cap is enforced by a COUNT(*) guard evaluated INSIDE the crediting
      // transaction, and the credit + ledger are gated on that claim row
      // existing. Concurrent requests are serialised by the transaction, so the
      // cap is exact rather than approximate.
      const claimGate = `EXISTS (SELECT 1 FROM ad_reward_claims WHERE id = ?)`;
      const adResults = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO ad_reward_claims (id, uid, day, provider, reward, created_at)
           SELECT ?, ?, ?, ?, ?, ?
            WHERE (SELECT COUNT(*) FROM ad_reward_claims WHERE uid = ? AND day = ?) < ?`,
        ).bind(claimId, uid, day, ads.provider, ads.reward, ts, uid, day, ads.dailyCap),
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, description, created_at)
           SELECT ?, ?, ?, 'ad_reward', ?, ?
            WHERE ${claimGate}`,
        ).bind(newId(), uid, ads.reward, "Rewarded ad view", ts, claimId),
        env.DB.prepare(
          `UPDATE users SET dpcoin = dpcoin + ?, updated_at = ? WHERE uid = ? AND ${claimGate}`,
        ).bind(ads.reward, ts, uid, claimId),
      ]);

      if (Number(adResults[0]?.meta?.changes || 0) === 0) {
        throw httpsError("resource-exhausted", "Daily ad reward limit reached. Come back tomorrow!");
      }
      const usedToday = await db
        .select({ n: count() })
        .from(schema.adRewardClaims)
        .where(and(eq(schema.adRewardClaims.uid, uid), eq(schema.adRewardClaims.day, day)))
        .get();
      return c.json({
        success: true,
        coinsEarned: ads.reward,
        remaining: Math.max(0, ads.dailyCap - Number(usedToday?.n ?? 0)),
      });
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
      const rzp = await getRazorpayCredentials(env);
      if (!rzp.keyId || !rzp.keySecret)
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
      const bonusCoins = Number(pkg.bonusCoins) || 0;
      const totalCoins = (Number(pkg.coins) || 0) + bonusCoins;
      if (totalCoins <= 0) throw httpsError("failed-precondition", "This package has no coins configured.");

      // Create the order at Razorpay (HTTP Basic auth = key_id:key_secret).
      const authHeader = btoa(`${rzp.keyId}:${rzp.keySecret}`);
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
            bonusCoins,
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
        keyId: rzp.keyId,
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
      if (!(await getRazorpayCredentials(env)).keySecret)
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
      const amt = assertCoinAmount(amount, "amount");
      // Anti-spam: max 5 withdrawal requests per hour per user.
      await rateLimit(env, `withdraw:${uid}`, 5, 3600, { failClosed: true });

      // Honor the admin App Control withdrawal config. `payoutsFrozen` is an
      // emergency kill-switch that blocks all new payout requests instantly
      // (e.g. during a suspected-fraud incident) without disabling the feature.
      const cfg = await getAppConfig(env);
      const policy = readWithdrawalPolicy(cfg);
      if (!policy.enabled || policy.payoutsFrozen)
        throw httpsError("failed-precondition", "Withdrawals are currently disabled.");
      if (amt < policy.minAmount)
        throw httpsError("failed-precondition", `Minimum withdrawal is ${policy.minAmount} coins.`);
      if (policy.maxAmount > 0 && amt > policy.maxAmount)
        throw httpsError("failed-precondition", `Maximum withdrawal is ${policy.maxAmount} coins per request.`);

      // Validate the destination BEFORE reserving coins: a typo'd UPI id or a
      // malformed IFSC used to reach the admin panel — and a real bank transfer
      // — completely unchecked.
      const destination = parsePayoutDestination(method, accountDetails);

      // Rolling 24h velocity cap. The 5-per-hour rate limit bounded the number
      // of requests but not their total, so a whole balance could still leave in
      // one go. Rejected requests don't count against the cap.
      if (policy.maxPerDay > 0) {
        const since = now() - 24 * 60 * 60 * 1000;
        const recent = await db
          .select({ total: sql<number>`COALESCE(SUM(${schema.withdrawals.amount}), 0)` })
          .from(schema.withdrawals)
          .where(and(
            eq(schema.withdrawals.userId, uid),
            gte(schema.withdrawals.createdAt, since),
            ne(schema.withdrawals.status, "rejected"),
          ))
          .get();
        const already = Number(recent?.total ?? 0);
        if (already + amt > policy.maxPerDay) {
          throw httpsError(
            "failed-precondition",
            `Daily payout limit is ${policy.maxPerDay} coins. You have already requested ${already} in the last 24 hours.`,
          );
        }
      }

      const ts = now();
      const id = newId();
      const cashAmount = roundFiat(amt * policy.conversionRate);

      // Escrow the coins, create the withdrawal row and write the hold ledger
      // entry in ONE transaction.
      //
      // Previously the deduct was its own statement followed by a separate
      // batch, with no compensating revert: if that batch failed, the user's
      // coins were simply gone — no withdrawal row, no ledger entry, nothing to
      // reconcile against. Both inserts are gated on the same pre-transaction
      // balance snapshot as the deduct, so all three apply or none do.
      const solvent = `EXISTS (SELECT 1 FROM users WHERE uid = ? AND dpcoin >= ?)`;
      const withdrawalResults = await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO withdrawals
             (id, user_id, amount, cash_amount, method, account_details, status, reserved, created_at, updated_at)
           SELECT ?, ?, ?, ?, ?, ?, 'pending', 1, ?, ?
            WHERE ${solvent}`,
        ).bind(
          id,
          uid,
          amt,
          cashAmount,
          destination.method,
          destination.accountDetails,
          ts,
          ts,
          uid,
          amt,
        ),
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, description, created_at)
           SELECT ?, ?, ?, 'withdrawal_hold', ?, ?
            WHERE ${solvent}`,
        ).bind(
          `withdrawal_hold:${id}`,
          uid,
          -amt,
          `Payout requested (${destination.method}) — coins reserved`,
          ts,
          uid,
          amt,
        ),
        env.DB.prepare(
          `UPDATE users SET dpcoin = dpcoin - ?, updated_at = ? WHERE uid = ? AND dpcoin >= ?`,
        ).bind(amt, ts, uid, amt),
      ]);
      if (Number(withdrawalResults[2]?.meta?.changes || 0) === 0) {
        throw httpsError("failed-precondition", "Insufficient balance.");
      }

      await db.insert(schema.adminNotifications).values({
        id: newId(), title: "New Withdrawal Request",
        message: `A user requested a payout of ${amt} coins to ${destination.masked}.`,
        link: "/withdrawals", isRead: false, createdAt: ts,
      });
      alertAdminEmail(c, cfg, "New Withdrawal Request",
        `<p>A user requested a payout of <b>${amt} coins</b> (₹${cashAmount.toFixed(2)}) via ${destination.method}.</p><p>Review it in the admin panel → Withdrawals.</p>`);
      return c.json({ success: true, withdrawalId: id, cashAmount });
    }

    // Manual QR/UPI deposit: user pays externally then submits the UTR here.
    // Admin approves/rejects in the panel; coins are credited on approval.
    case "requestDeposit": {
      const { packageId, utr, method, screenshotUrl } = body;
      if (!packageId) throw httpsError("invalid-argument", "Select a coin package to continue.");
      if (!utr || String(utr).trim().length < 4)
        throw httpsError("invalid-argument", "A valid UTR / transaction reference is required.");
      // Anti-spam: max 5 deposit submissions per hour per user.
      await rateLimit(env, `deposit:${uid}`, 5, 3600);

      const cfg = await getAppConfig(env);
      const gw = (cfg?.paymentGateway as any) || {};
      const mode = gw.mode || "auto";
      if (mode === "auto") throw httpsError("failed-precondition", "Manual deposits are currently disabled.");

      // Packages are the ONLY pricing authority. This used to read a
      // `coinRate` multiplier off the gateway settings, which disagreed with
      // coin_packages — a package selling 15 coins for Rs 10 priced the same 15
      // coins at Rs 15 through here. Never trust a client-sent amount either:
      // both the coins credited and the rupees expected come from the row.
      const pkg = await db
        .select()
        .from(schema.coinPackages)
        .where(and(eq(schema.coinPackages.id, String(packageId)), eq(schema.coinPackages.active, true)))
        .get();
      if (!pkg) throw httpsError("not-found", "Coin package not found.");

      const baseCoins = Number(pkg.coins) || 0;
      const bonusCoins = Number(pkg.bonusCoins) || 0;
      const amt = baseCoins + bonusCoins;
      const payAmount = Number(pkg.priceInr) || 0;
      if (amt <= 0 || payAmount <= 0)
        throw httpsError("failed-precondition", "This coin package is misconfigured.");

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
        payAmount,
        packageId: String(packageId),
        bonusCoins,
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
        `<p>A user submitted a <b>${amt}-coin</b> deposit (₹${payAmount.toFixed(2)}${pkg.name ? ` — ${pkg.name}` : ""}).</p><p>UTR: <b>${String(utr).trim()}</b></p><p>Verify & approve in the admin panel → Deposits.</p>`);
      return c.json({ success: true, depositId: id });
    }

    // ================= ADMIN =================
    case "setAdminRole": {
      // Privilege escalation must require full-admin authority and must be
      // audited. Previously any `admin` could grant `admin` to anyone here with
      // no audit row, while /admin/set-role required a full admin AND audited.
      await requireFullAdminAction(env, uid);
      const { userId, makeAdmin } = body;
      if (!userId || typeof userId !== "string") throw httpsError("invalid-argument", "userId is required.");
      // Never let an admin strip a superadmin through this path.
      const targetRole = await db
        .select({ role: schema.users.role })
        .from(schema.users)
        .where(eq(schema.users.uid, userId))
        .get();
      if (!targetRole) throw httpsError("not-found", "User not found.");
      if (targetRole.role === "superadmin") {
        throw httpsError("permission-denied", "A superadmin's role can only be changed by a superadmin via /admin/set-role.");
      }
      const role = makeAdmin === false ? "user" : "admin";
      await setCustomClaims(env, userId, { role });
      await db.update(schema.users).set({ role, updatedAt: now() }).where(eq(schema.users.uid, userId));
      await writeAdminAudit(env, c.get("user"), "user.set-role", "user", userId, {
        role,
        previousRole: targetRole.role ?? null,
        via: "/api",
      });
      return c.json({ success: true, role });
    }
    case "adminDeletePost": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { postId } = body;
      if (!postId) throw httpsError("invalid-argument", "postId is required.");
      await db.delete(schema.posts).where(eq(schema.posts.id, postId));
      return c.json({ success: true });
    }
    /**
     * Re-enable an account an ADMIN disabled (`users.isBlocked`).
     *
     * Renamed from `unblockUser` when user-level blocking arrived: that name now
     * belongs to the user-facing action, and having the two share it would have
     * meant one word covering both "let this account log in again" and "I no
     * longer want to hide this person". The rename is safe — this action had no
     * callers at all (the panel re-enables accounts via PATCH /admin/users/:id).
     */
    case "adminUnblockUser": {
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
      // Queued, not sent inline: fanning out to every user inside this request
      // blows the Worker's CPU/time budget once the user table is real. Cron
      // drains it a page at a time. `sentCount` is the ESTIMATED audience; the
      // delivered figure lands on broadcast_jobs.processed.
      const { jobId, estimatedRecipients } = await enqueueBroadcast(env, {
        title,
        body: msg,
        image: imageUrl,
        data: data || {},
        createdBy: uid,
      });
      return c.json({ success: true, jobId, sentCount: estimatedRecipients, queued: true });
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

    // Mark EVERY unread notification read in a single indexed UPDATE. Preferred
    // over markNotificationsRead when opening the screen: no large id array on
    // the wire, and one write bounded by the idx_notif_unread partial index
    // (SQLite also caps IN(...) params at ~999, which mark-all sidesteps).
    case "markAllNotificationsRead": {
      await db
        .update(schema.notifications)
        // Also marks them SEEN. Not redundant: the badge counts unseen rows, and
        // already-installed app builds only ever call this action — without
        // setting `seen` here their badge would never clear again.
        .set({ read: true, seen: true })
        .where(and(eq(schema.notifications.recipientId, uid), eq(schema.notifications.read, false)));
      return c.json({ success: true });
    }

    /**
     * Mark everything the user is looking at as SEEN — this is what clears the
     * bell badge, and it is what the notifications screen calls on open.
     *
     * Deliberately does NOT set `read`. Opening the list used to mark every row
     * read, including ones the user never looked at, which left `read` carrying
     * no real signal. Now:
     *   seen = it was in the list when you last opened it (badge + "new" highlight)
     *   read = you actually tapped through to the content
     *
     * Bounded by the idx_notif_unseen partial index, so this is one small
     * indexed UPDATE regardless of how much history the user has.
     */
    case "markAllNotificationsSeen": {
      await db
        .update(schema.notifications)
        .set({ seen: true })
        .where(and(eq(schema.notifications.recipientId, uid), eq(schema.notifications.seen, false)));
      return c.json({ success: true });
    }

    case "registerFcmToken": {
      const { token } = body;
      if (!token) throw httpsError("invalid-argument", "token is required.");
      // A device token can previously have belonged to a DIFFERENT account on
      // this same phone (shared, resold, or just a second login). Detach it from
      // every other user first, otherwise the previous owner keeps receiving
      // pushes on a device they no longer control.
      await detachTokenFromOtherUsers(env, token, uid);
      const user = await db.select({ fcmTokens: schema.users.fcmTokens }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      const tokens = new Set<string>(((user?.fcmTokens as string[]) || []));
      tokens.add(token);
      await db.update(schema.users).set({ fcmTokens: [...tokens], updatedAt: now() }).where(eq(schema.users.uid, uid));
      return c.json({ success: true });
    }

    /**
     * Current notification preferences, fully resolved (absent keys filled with
     * defaults) so the client never has to know the defaults itself.
     */
    case "getNotificationPrefs": {
      const row = await db
        .select({ prefs: schema.users.notificationPrefs })
        .from(schema.users)
        .where(eq(schema.users.uid, uid))
        .get();
      return c.json({ prefs: resolvePrefs(row?.prefs) });
    }

    /**
     * Merge a partial preferences patch. Only the keys present are changed, so
     * the client can PATCH a single toggle without re-sending everything.
     */
    case "updateNotificationPrefs": {
      const { prefs: patch } = body;
      if (!patch || typeof patch !== "object")
        throw httpsError("invalid-argument", "prefs object is required.");
      const row = await db
        .select({ prefs: schema.users.notificationPrefs })
        .from(schema.users)
        .where(eq(schema.users.uid, uid))
        .get();
      const merged = resolvePrefs({ ...(row?.prefs as object || {}), ...patch });
      await db
        .update(schema.users)
        // Only non-default keys are stored, so rows stay small.
        .set({ notificationPrefs: serializePrefs(merged), updatedAt: now() })
        .where(eq(schema.users.uid, uid));
      return c.json({ success: true, prefs: merged });
    }

    /**
     * Detach this device's push token on sign-out.
     *
     * Without this the token stayed on the user row forever, so after logout a
     * shared or resold phone kept receiving the previous account's
     * notifications — a privacy leak, not just clutter. The client calls this
     * BEFORE Firebase sign-out, while the token is still authorised.
     */
    case "unregisterFcmToken": {
      const { token } = body;
      if (!token) throw httpsError("invalid-argument", "token is required.");
      const user = await db.select({ fcmTokens: schema.users.fcmTokens }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      const tokens = ((user?.fcmTokens as string[]) || []).filter((t) => t !== token);
      await db.update(schema.users).set({ fcmTokens: tokens, updatedAt: now() }).where(eq(schema.users.uid, uid));
      return c.json({ success: true, remaining: tokens.length });
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
      // Creating a chat row writes a "Say hi!" preview into the other person's
      // inbox, so an unlimited loop here is a DM-bombing primitive. sendMessage
      // was rate limited; chat CREATION was not.
      await rateLimit(env, `startchat:${uid}`, 30, 3600);
      const { otherUserId, otherUserData } = body;
      if (!otherUserId) throw httpsError("invalid-argument", "otherUserId is required.");
      // Opening a DM is the single most direct way to reach someone, so this is
      // the guard that matters most.
      await assertNotBlocked(env, uid, otherUserId);
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
      // Only participants may post into a chat.
      await assertChatMember(env, chatId, uid);
      // Messages were the one social write with no velocity cap (likes are
      // 120/60s, comments 30/60s), which made this a free spam/abuse channel.
      await rateLimit(env, `msg:${uid}`, 60, 60);
      // Membership is not consent. An existing thread predates any later block,
      // so the recipients are resolved BEFORE the write (this read was already
      // happening further down for the realtime fan-out — it is just hoisted)
      // and the send is refused if a block has appeared since.
      const chat = await db.select({ users: schema.chats.users }).from(schema.chats).where(eq(schema.chats.id, chatId)).get();
      const members = ((chat?.users as string[]) || []).filter((u) => u !== uid);
      await assertNotBlockedAny(env, uid, members);
      const ts = now();
      const messageId = newId();
      await db.insert(schema.messages).values({ id: messageId, chatId, senderId: uid, text, read: false, createdAt: ts });
      await db.update(schema.chats).set({ lastMessage: { text, createdAt: ts, senderId: uid } as any, updatedAt: ts }).where(eq(schema.chats.id, chatId));
      // Instant push: to the chat room + each participant's user channel (chat-list bump).
      const msg = { id: messageId, chatId, senderId: uid, text, createdAt: ts };
      await publish(env, `chat:${chatId}`, { type: "message", message: msg });
      await publishMany(env, members.map((u) => `user:${u}`), { type: "chat_update", chatId, message: msg });
      return c.json({ success: true });
    }

    case "markChatRead": {
      const { chatId } = body;
      if (!chatId) throw httpsError("invalid-argument", "chatId is required.");
      await assertChatMember(env, chatId, uid);
      await env.DB.prepare(
        `UPDATE messages SET read = 1 WHERE chat_id = ? AND sender_id != ? AND read = 0`,
      ).bind(chatId, uid).run();
      return c.json({ success: true });
    }

    case "deleteChat": {
      const { chatId } = body;
      if (!chatId) throw httpsError("invalid-argument", "chatId is required.");
      // Destructive and irreversible — it drops the chat and every message in
      // it — so membership must be proven before anything is deleted.
      await assertChatMember(env, chatId, uid);
      await db.delete(schema.messages).where(eq(schema.messages.chatId, chatId));
      await db.delete(schema.chats).where(eq(schema.chats.id, chatId));
      return c.json({ success: true });
    }

    // ================= CONTEST-MATCH ENGAGEMENT =================
    case "likeContest": {
      const { matchId } = body;
      if (!matchId) throw httpsError("invalid-argument", "matchId is required.");
      await rateLimit(env, `like:${uid}`, 120, 60);
      await assertMatchInteractionAllowed(env, uid, matchId);
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
          const me = await db.select({ username: schema.users.username, avatar: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, uid)).get();
          for (const p of [match?.userA as any, match?.userB as any]) {
            if (p?.uid && p.uid !== uid) {
              // `actor` turns repeat likes on the same battle into one grouped
              // notification instead of one row + one push per liker.
              await createNotification(env, p.uid, { title: "New Like ❤️", body: `${me?.username || "Someone"} liked your battle "${match?.title}".`, type: "match_like", targetId: matchId, actor: { uid, username: me?.username, avatarUrl: me?.avatar } });
            }
          }
        })(),
      );
      return c.json({ success: true, liked: true });
    }

    case "commentContest": {
      const { matchId } = body;
      const raw = typeof body.text === "string" ? body.text.trim() : "";
      if (!matchId) throw httpsError("invalid-argument", "matchId is required.");
      if (!raw) throw httpsError("invalid-argument", "Comment cannot be empty.");
      if (raw.length > MAX_COMMENT_LEN) throw httpsError("invalid-argument", `Comment is too long (max ${MAX_COMMENT_LEN} characters).`);
      await assertClean(env, raw);
      await rateLimit(env, `comment:${uid}`, 30, 60);
      await assertMatchInteractionAllowed(env, uid, matchId);
      const commentId = newId();
      const ts = now();
      await db.insert(schema.matchComments).values({ id: commentId, matchId, userId: uid, text: raw, createdAt: ts });
      const commentCounters = await bumpEngagement(env, matchId, "comment", 1);
      await publish(env, `match:${matchId}`, { type: "comment", commentId, commentCount: commentCounters.comment ?? 0 });
      // Bust the cached comment list so the new comment is visible immediately.
      c.executionCtx.waitUntil(delCache(env, commentsCacheKey("matches", matchId)));
      c.executionCtx.waitUntil(
        (async () => {
          const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
          const me = await db.select({ username: schema.users.username, avatar: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, uid)).get();
          for (const p of [match?.userA as any, match?.userB as any]) {
            if (p?.uid && p.uid !== uid) {
              await createNotification(env, p.uid, { title: "New Comment 💬", body: `${me?.username || "Someone"} commented on "${match?.title}".`, type: "match_comment", targetId: matchId, actor: { uid, username: me?.username, avatarUrl: me?.avatar } });
            }
          }
        })(),
      );
      return c.json({ success: true, commentId });
    }

    case "shareContest": {
      const { matchId } = body;
      if (!matchId) throw httpsError("invalid-argument", "matchId is required.");
      await assertMatchInteractionAllowed(env, uid, matchId);
      await db.insert(schema.shares).values({ id: newId(), userId: uid, targetType: "match", targetId: matchId, createdAt: now() });
      const counters = await bumpEngagement(env, matchId, "share", 1);
      await publish(env, `match:${matchId}`, { type: "share", shareCount: counters.share ?? 0 });
      return c.json({ success: true });
    }

    case "reactToMatch": {
      const { matchId, type } = body;
      if (!matchId || !type) throw httpsError("invalid-argument", "matchId and type are required.");
      await assertMatchInteractionAllowed(env, uid, matchId);
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
      // Guarded on the ADD branch only, so a bookmark saved before a block can
      // always be removed afterwards.
      await assertMatchInteractionAllowed(env, uid, matchId);
      await db.insert(schema.bookmarks).values({ userId: uid, matchId, createdAt: now() });
      return c.json({ success: true, bookmarked: true });
    }

    // ============ GENERIC COMMENTS (posts, matches or blog articles) ============
    case "addComment": {
      const { targetType, targetId } = body;
      const raw = typeof body.text === "string" ? body.text.trim() : "";
      if (!targetId) throw httpsError("invalid-argument", "targetId is required.");
      if (!raw) throw httpsError("invalid-argument", "Comment cannot be empty.");
      if (raw.length > MAX_COMMENT_LEN) throw httpsError("invalid-argument", `Comment is too long (max ${MAX_COMMENT_LEN} characters).`);
      // Spam guard (parity with commentContest) + banned-word moderation.
      await rateLimit(env, `comment:${uid}`, 30, 60);
      await assertClean(env, raw);
      const isMatch = targetType === "matches" || targetType === "contestMatches";
      const isBlog = targetType === "blog";
      // Commenting reaches the owner's notification inbox, so it needs the same
      // guard as a DM. Both social branches resolve the owner(s) of the thing
      // being commented on and refuse if a block exists in either direction.
      if (isMatch) {
        await assertMatchInteractionAllowed(env, uid, targetId);
      } else if (isBlog) {
        // A blog article has no owner uid to block (`blog_posts.author` is free
        // text), so the guard here is about the TARGET instead: the article must
        // exist and be published. Without it any string could be used as a
        // targetId, producing comment rows attached to nothing — invisible on
        // every read path, so never moderated and never deleted — and a draft
        // could quietly collect public comments before anyone can see them.
        const article = await db
          .select({ id: schema.blogPosts.id, status: schema.blogPosts.status })
          .from(schema.blogPosts)
          .where(eq(schema.blogPosts.id, targetId))
          .get();
        if (!article || article.status !== "published") throw httpsError("not-found", "Post not found.");
      } else {
        const postOwner = await db
          .select({ userId: schema.posts.userId })
          .from(schema.posts)
          .where(eq(schema.posts.id, targetId))
          .get();
        await assertNotBlockedAny(env, uid, [postOwner?.userId]);
      }
      // Idempotency: the client may pass a stable clientId so a retried submit
      // (flaky network) never posts the same comment twice.
      const clientId = typeof body.clientId === "string" && body.clientId.trim() ? body.clientId.trim().slice(0, 64) : null;
      const commentId = clientId || newId();
      const ts = now();
      if (clientId) {
        const dupe = isMatch
          ? await db.select({ id: schema.matchComments.id }).from(schema.matchComments).where(eq(schema.matchComments.id, commentId)).get()
          : isBlog
            ? await db.select({ id: schema.blogComments.id }).from(schema.blogComments).where(eq(schema.blogComments.id, commentId)).get()
            : await db.select({ id: schema.postComments.id }).from(schema.postComments).where(eq(schema.postComments.id, commentId)).get();
        if (dupe) return c.json({ success: true, commentId, duplicate: true });
      }
      if (isBlog) {
        // No counter to bump and no notification to send: nothing renders a
        // per-article comment count, and `blog_posts.author` is a display string,
        // not a uid, so there is no inbox this could reach. The cache bust below
        // is what makes the new comment visible.
        await db.insert(schema.blogComments).values({ id: commentId, postId: targetId, userId: uid, text: raw, createdAt: ts }).onConflictDoNothing();
      } else if (isMatch) {
        await db.insert(schema.matchComments).values({ id: commentId, matchId: targetId, userId: uid, text: raw, createdAt: ts }).onConflictDoNothing();
        const cCounters = await bumpEngagement(env, targetId, "comment", 1);
        // Push so both the open comment sheet and the feed card update instantly.
        await publish(env, `match:${targetId}`, { type: "comment", commentId, commentCount: cCounters.comment ?? 0 });
        c.executionCtx.waitUntil(
          (async () => {
            const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, targetId)).get();
            const me = await db.select({ username: schema.users.username, avatar: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, uid)).get();
            for (const p of [match?.userA as any, match?.userB as any]) {
              if (p?.uid && p.uid !== uid) {
                await createNotification(env, p.uid, { title: "New Comment 💬", body: `${me?.username || "Someone"} commented on "${match?.title}".`, type: "match_comment", targetId, actor: { uid, username: me?.username, avatarUrl: me?.avatar } });
              }
            }
          })(),
        );
      } else {
        await db.insert(schema.postComments).values({ id: commentId, postId: targetId, userId: uid, text: raw, createdAt: ts }).onConflictDoNothing();
        await db.update(schema.posts).set({ commentCount: sql`${schema.posts.commentCount} + 1` }).where(eq(schema.posts.id, targetId));
        c.executionCtx.waitUntil(
          (async () => {
            const post = await db.select({ userId: schema.posts.userId }).from(schema.posts).where(eq(schema.posts.id, targetId)).get();
            const me = await db.select({ username: schema.users.username, avatar: schema.users.profileImageUrl }).from(schema.users).where(eq(schema.users.uid, uid)).get();
            if (post?.userId && post.userId !== uid) {
              await createNotification(env, post.userId, { title: "New Comment 💬", body: `${me?.username || "Someone"} commented on your post.`, type: "comment", targetId, actor: { uid, username: me?.username, avatarUrl: me?.avatar } });
            }
          })(),
        );
      }
      // Bust the cached comment list so the new comment shows immediately.
      c.executionCtx.waitUntil(delCache(env, commentsCacheKey(targetType, targetId)));
      return c.json({ success: true, commentId });
    }

    case "deleteComment": {
      const { targetType, targetId, commentId } = body;
      if (!commentId) throw httpsError("invalid-argument", "commentId is required.");
      if (targetType === "blog") {
        const row = await db.select().from(schema.blogComments).where(eq(schema.blogComments.id, commentId)).get();
        if (!row) throw httpsError("not-found", "Comment not found.");
        if (row.userId !== uid && !(await isAdmin(c as any))) throw httpsError("permission-denied", "Not allowed.");
        await db.delete(schema.blogComments).where(eq(schema.blogComments.id, commentId));
      } else if (targetType === "matches" || targetType === "contestMatches") {
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
      // Bust the cached comment list so the removal is reflected immediately.
      c.executionCtx.waitUntil(delCache(env, commentsCacheKey(targetType, targetId)));
      return c.json({ success: true });
    }

    case "likeComment": {
      // Toggle a like on a single comment (match, post or blog article). Returns
      // the new liked state + absolute like count so the client can reconcile
      // instantly.
      //
      // `blog` MUST be handled explicitly, not left to fall through to the post
      // branch: the shared client service passes targetType straight through, so
      // without this the `comment_likes` row would be written while the counter
      // UPDATE matched no row — a like that persists but always reads back as 0.
      const { commentId, targetType } = body;
      if (!commentId) throw httpsError("invalid-argument", "commentId is required.");
      await rateLimit(env, `clike:${uid}`, 120, 60);
      const isMatch = targetType === "matches" || targetType === "contestMatches";
      const isBlogComment = targetType === "blog";
      const existing = await db
        .select()
        .from(schema.commentLikes)
        .where(and(eq(schema.commentLikes.commentId, commentId), eq(schema.commentLikes.userId, uid)))
        .get();
      const liked = !existing;
      // The last engagement write without a block guard. Only the LIKE direction
      // is checked, so an existing like can always be withdrawn.
      if (liked) {
        const author = isMatch
          ? await db.select({ userId: schema.matchComments.userId }).from(schema.matchComments).where(eq(schema.matchComments.id, commentId)).get()
          : isBlogComment
            ? await db.select({ userId: schema.blogComments.userId }).from(schema.blogComments).where(eq(schema.blogComments.id, commentId)).get()
            : await db.select({ userId: schema.postComments.userId }).from(schema.postComments).where(eq(schema.postComments.id, commentId)).get();
        await assertNotBlockedAny(env, uid, [author?.userId]);
      }
      if (existing) {
        await db.delete(schema.commentLikes).where(and(eq(schema.commentLikes.commentId, commentId), eq(schema.commentLikes.userId, uid)));
      } else {
        await db.insert(schema.commentLikes).values({ commentId, userId: uid, createdAt: now() }).onConflictDoNothing().run();
      }
      const delta = liked ? 1 : -1;
      let likeCount = 0;
      if (isBlogComment) {
        await db.update(schema.blogComments)
          .set({ likeCount: sql`MAX(COALESCE(${schema.blogComments.likeCount}, 0) + ${delta}, 0)` })
          .where(eq(schema.blogComments.id, commentId));
        const row = await db.select({ likeCount: schema.blogComments.likeCount }).from(schema.blogComments).where(eq(schema.blogComments.id, commentId)).get();
        likeCount = row?.likeCount ?? 0;
      } else if (isMatch) {
        await db.update(schema.matchComments)
          .set({ likeCount: sql`MAX(COALESCE(${schema.matchComments.likeCount}, 0) + ${delta}, 0)` })
          .where(eq(schema.matchComments.id, commentId));
        const row = await db.select({ likeCount: schema.matchComments.likeCount }).from(schema.matchComments).where(eq(schema.matchComments.id, commentId)).get();
        likeCount = row?.likeCount ?? 0;
      } else {
        await db.update(schema.postComments)
          .set({ likeCount: sql`MAX(COALESCE(${schema.postComments.likeCount}, 0) + ${delta}, 0)` })
          .where(eq(schema.postComments.id, commentId));
        const row = await db.select({ likeCount: schema.postComments.likeCount }).from(schema.postComments).where(eq(schema.postComments.id, commentId)).get();
        likeCount = row?.likeCount ?? 0;
      }
      return c.json({ success: true, liked, likeCount });
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
        else if (k === "phone") set.phone = normalizePhone(v as string);
        else if (COLUMN_KEYS.has(k)) set[k] = v;
        else extraPatch[k] = v;
      }
      // Enforce identifier uniqueness on edits too (createUserProfile already
      // does this at signup). Without it, two users could take the same username
      // or phone via profile edit — a duplicate-account bug that would otherwise
      // only surface as a raw UNIQUE-constraint 500.
      if (set.username || set.phone) {
        await assertIdentifiersAvailable(env, uid, { username: set.username, phone: set.phone });
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
      // A view writes the viewer into the author's viewer list, which is a
      // notification of presence even though it sends no push.
      await assertStoryInteractionAllowed(env, uid, storyId);
      await db.insert(schema.storyViews).values({ storyId, viewerId: uid, createdAt: now() }).onConflictDoNothing();
      return c.json({ success: true });
    }
    case "reactToStory": {
      const { storyId, emoji } = body;
      if (!storyId) throw httpsError("invalid-argument", "storyId is required.");
      await assertStoryInteractionAllowed(env, uid, storyId);
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

    case "profileVisit": {
      // Record that `uid` viewed `targetId`'s profile — powers the feed's
      // visit-affinity signal. One row per (viewer, target); revisits refresh
      // the timestamp. Self-visits are ignored.
      const { targetId } = body;
      if (!targetId || targetId === uid) return c.json({ success: true });
      await rateLimit(env, `pvisit:${uid}`, 120, 60);
      // Silently dropped rather than refused. This is passive telemetry the
      // client fires on navigation, so an error would surface as a spurious
      // failure on a screen the user simply opened — and recording the visit
      // would feed a blocked account back into the feed's affinity signal.
      if (await isBlockedBetween(env, uid, targetId)) return c.json({ success: true });
      await db
        .insert(schema.profileVisits)
        .values({ userId: targetId, visitorId: uid, createdAt: now() })
        .onConflictDoUpdate({
          target: [schema.profileVisits.userId, schema.profileVisits.visitorId],
          set: { createdAt: now() },
        });
      return c.json({ success: true });
    }

    // ================= REPORTS / SUPPORT (also feed admin panel) =================
    case "createReport": {
      // Reports raise admin notifications; unbounded reporting is a way to bury
      // the moderation queue.
      await rateLimit(env, `report:${uid}`, 20, 3600);
      const { targetType, targetId, reason } = body;
      const id = newId();
      const ts = now();
      await db.insert(schema.reports).values({ id, reporterId: uid, targetType: targetType || null, targetId: targetId || null, reason: reason || null, status: "open", createdAt: ts });
      await db.insert(schema.adminNotifications).values({ id: newId(), title: "New Report", message: `A ${targetType || "content"} was reported.`, link: "/reports", scope: "moderation", isRead: false, createdAt: ts });
      return c.json({ success: true, reportId: id });
    }
    case "createSupportTicket": {
      await rateLimit(env, `support:${uid}`, 10, 3600);
      const { subject, message } = body;
      if (!subject) throw httpsError("invalid-argument", "subject is required.");
      const id = newId();
      const ts = now();
      const me = await db.select({ username: schema.users.username }).from(schema.users).where(eq(schema.users.uid, uid)).get();
      await db.insert(schema.supportTickets).values({ id, userId: uid, subject, message: message || null, status: "open", createdAt: ts, updatedAt: ts });
      await db.insert(schema.adminNotifications).values({ id: newId(), title: "New Support Ticket", message: `${me?.username || "A user"}: ${subject}`, link: "/support", scope: "moderation", isRead: false, createdAt: ts });
      return c.json({ success: true, ticketId: id });
    }

    // ================= ACCOUNT DELETION =================
    /**
     * What deleting the account would do right now: whether it is currently
     * allowed, why not if it isn't, and how many coins would be forfeited.
     *
     * The client shows this BEFORE asking for confirmation, so the user is never
     * surprised by a forfeited balance or an unexplained refusal.
     */
    case "accountDeletionStatus": {
      const eligibility = await checkDeletionEligibility(env, uid);
      return c.json(eligibility);
    }

    /**
     * Delete the signed-in user's own account. Required by both app stores.
     *
     * Anonymises the account, removes the user's content and media, and deletes
     * the Firebase login so the identity can never sign in again. Financial and
     * contest records are retained against an anonymous uid — see
     * lib/accountDeletion.ts for exactly what is kept and why.
     */
    case "deleteAccount": {
      // Deliberately strict: this is irreversible, so a runaway client or a
      // stolen token gets very few attempts.
      await rateLimit(env, `deleteaccount:${uid}`, 3, 3600, { failClosed: true });
      // Require an explicit confirmation flag so a mis-sent request cannot
      // destroy an account.
      if (body.confirm !== true) {
        throw httpsError("invalid-argument", "Account deletion must be confirmed.");
      }
      const result = await deleteOwnAccount(env, uid, body.reason);
      // Storage cleanup happens after the response: the account is already gone
      // as far as the user is concerned, and R2 deletes are slow and best-effort.
      c.executionCtx.waitUntil(purgeDeletedAccountMedia(env, result.mediaUrls));
      return c.json({
        success: true,
        deletedAt: result.deletedAt,
        forfeitedCoins: result.forfeitedCoins,
      });
    }

    // ================= WALLET (ADMIN) =================
    case "adminManageWallet": {
      // Full admins only. A plain `admin` used to be able to move any balance
      // here with no audit trail, while the equivalent /admin route required a
      // full admin — the two paths are now identical in authority and both are
      // audited.
      await requireFullAdminAction(env, uid);
      const { userId, amount, type } = body;
      if (!userId || typeof userId !== "string" || !["add", "subtract"].includes(type))
        throw httpsError("invalid-argument", "userId and a type of add or subtract are required.");
      const amt = assertCoinAmount(amount, "amount");
      // Same shared implementation the /admin route uses: validated amount,
      // balance + ledger in one transaction, loud failure instead of a silent
      // clamp, optional replay claim.
      try {
        const { newBalance } = await adjustUserWallet(env, {
          uid: userId,
          amount: amt,
          direction: type,
          type: "admin_adjustment",
          description: `Admin ${type} ${amt} Dpcoin`,
          claimKey: body.idempotencyKey ? `admin_wallet:${userId}:${body.idempotencyKey}` : undefined,
          ts: now(),
        });
        await writeAdminAudit(env, c.get("user"), "wallet.adjust", "user", userId, {
          amount: amt,
          type,
          newBalance,
          via: "/api",
        });
        return c.json({ success: true, message: "Wallet updated successfully", newBalance });
      } catch (e) {
        if (e instanceof WalletReplay) {
          const current = await db
            .select({ balance: schema.users.dpcoin })
            .from(schema.users)
            .where(eq(schema.users.uid, userId))
            .get();
          return c.json({
            success: true,
            replayed: true,
            message: "Wallet already updated for this request (no change applied).",
            newBalance: current?.balance ?? 0,
          });
        }
        throw e;
      }
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
