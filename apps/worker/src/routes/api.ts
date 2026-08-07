/**
 * /api — port of apps/functions/src/api/main.ts (the callable `api` router).
 * Same contract: POST { action, ...data } with `Authorization: Bearer <idToken>`.
 *
 * D1 has no interactive transactions, so money-critical mutations use
 * conditional UPDATEs (e.g. `WHERE dpcoin >= fee`) and check the affected row
 * count to prevent double-spend / races.
 */
import { Hono } from "hono";
import { eq, and, desc, sql, count, like, gte, inArray } from "drizzle-orm";
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
import { newId, now, generateJoinId } from "../lib/ids";

export const apiRoute = new Hono<{ Bindings: Env; Variables: Variables }>();

// All /api actions require a valid Firebase ID token (matches callable auth).
apiRoute.use("*", requireAuth);

const notPorted = (action: string, file: string): never => {
  throw httpsError(
    "internal",
    `Action '${action}' is not yet ported to the Worker. Original logic: apps/functions/src/${file}.`,
  );
};

apiRoute.post("/", async (c) => {
  const body = await c.req.json<any>().catch(() => ({}));
  const action = body?.action;
  if (!action) throw httpsError("invalid-argument", "Action specify karna zaroori hai.");
  const env = c.env;
  const db = getDb(env);
  const uid = c.get("user").uid;

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
      const contest = await db.select().from(schema.contests).where(eq(schema.contests.id, contestId)).get();
      if (!contest) throw httpsError("not-found", "Contest template not found.");
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
      await db.insert(schema.coinTransactions).values({
        id: newId(), uid, amount: -fee, type: "contest_entry_fee", contestId,
        description: `Entry fee (50% split) for ${contest.title || "contest"}`, createdAt: ts,
      });

      const matchId = newId();
      const joinIdA = generateJoinId();
      const expiresAt = ts + (contest.autoCancelHours || 24) * 60 * 60 * 1000;
      await db.insert(schema.contestMatches).values({
        id: matchId, contestId, status: "waiting_for_opponent", type: contest.type || "photo",
        title: contest.title || "Untitled Contest", entryFee: totalFee, isPrivate: !!invitedUid,
        invitedUid: invitedUid || null, joinIdA,
        userA: {
          uid, joinId: joinIdA, username: user.username || "Anonymous",
          profilePic: user.profileImageUrl || "", mediaUrl, mediaType: mediaType || "photo",
          caption: caption || "", votes: 0, deviceId: deviceId || "",
        } as any,
        totalVotes: 0, createdAt: ts, expiresAt,
      });

      // auto-story
      await db.insert(schema.stories).values({
        id: newId(), userId: uid, username: user.username || "Anonymous", avatarUrl: user.profileImageUrl || "",
        mediaUrl, mediaType: mediaType || "photo", type: "contest_announcement", matchId,
        contestTitle: contest.title || "Contest", createdAt: ts, expiresAt: ts + 24 * 60 * 60 * 1000,
      }).catch(() => {});

      return c.json({ matchId, joinId: joinIdA });
    }

    case "joinMatch": {
      const { matchId, mediaUrl, mediaType, caption, deviceId } = body;
      const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
      if (!match) throw httpsError("not-found", "Match not found.");
      if (match.status !== "waiting_for_opponent") throw httpsError("failed-precondition", "Match unavailable.");
      const userA = match.userA as any;
      if (userA?.uid === uid) throw httpsError("failed-precondition", "You cannot join your own match.");

      const user = await db.select().from(schema.users).where(eq(schema.users.uid, uid)).get();
      if (!user) throw httpsError("not-found", "User document not found.");
      const fee = Number(match.entryFee || 0) / 2;

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
      const { matchId, votedForUid, deviceId } = body;
      if (!matchId || !votedForUid || !deviceId)
        throw httpsError("invalid-argument", "Missing matchId, votedForUid, or deviceId.");
      // Throttle abusive vote bursts (per user): max 60 / minute.
      await rateLimit(env, `vote:${uid}`, 60, 60);
      const match = await db.select().from(schema.contestMatches).where(eq(schema.contestMatches.id, matchId)).get();
      if (!match) throw httpsError("not-found", "Match not found.");
      if (match.status !== "active") throw httpsError("failed-precondition", "Battle is not active.");
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
      });
      if (tally.alreadyVoted) throw httpsError("already-exists", "You have already voted in this match.");

      // Vote XP (+5) is batched into the DO's flush — no per-vote users write.
      await publish(env, `match:${matchId}`, {
        type: "vote",
        votedForUid,
        votesA: tally.votesA,
        votesB: tally.votesB,
        totalVotes: tally.total,
      });
      return c.json({ success: true });
    }

    // ================= POSTS =================
    case "createPost": {
      const { mediaUrl, mediaType, caption, location } = body;
      if (!mediaUrl || !mediaType) throw httpsError("invalid-argument", "Media URL and type are required.");
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
      const last = user.lastDailyClaim ? new Date(user.lastDailyClaim) : null;
      if (last && last.toDateString() === nowDate.toDateString())
        throw httpsError("already-exists", "Daily reward already claimed today.");
      const yesterday = new Date();
      yesterday.setDate(nowDate.getDate() - 1);
      let streak = user.streak || 0;
      streak = !last || last.toDateString() !== yesterday.toDateString() ? 1 : streak + 1;
      const coinReward = settings.dailyLoginReward + streak * settings.dailyStreakBonus;
      const xpReward = 50;
      const ts = now();
      await db.update(schema.users).set({
        dpcoin: sql`${schema.users.dpcoin} + ${coinReward}`,
        xp: sql`${schema.users.xp} + ${xpReward}`,
        streak, lastDailyClaim: ts, updatedAt: ts,
      }).where(eq(schema.users.uid, uid));
      await db.insert(schema.coinTransactions).values({
        id: newId(), uid, amount: coinReward, type: "daily_reward",
        description: `Daily login reward (${streak} day streak)`, createdAt: ts,
      });
      return c.json({ success: true, coinsEarned: coinReward, xpEarned: xpReward, streak });
    }

    // ================= WALLET =================
    case "topup": {
      const { amount, paymentId } = body;
      if (!amount || amount <= 0) throw httpsError("invalid-argument", "Invalid amount.");
      if (!paymentId) throw httpsError("invalid-argument", "paymentId is required.");
      const ts = now();
      const pay = await db
        .insert(schema.payments)
        .values({ id: paymentId, userId: uid, amount, status: "success", createdAt: ts })
        .onConflictDoNothing()
        .run();
      if (pay.meta.changes === 0) throw httpsError("already-exists", "Payment already processed.");
      await db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${amount}` }).where(eq(schema.users.uid, uid));
      await db.insert(schema.coinTransactions).values({
        id: newId(), uid, amount, type: "purchase", description: `Purchased ${amount} Dpcoins`, createdAt: ts,
      });
      return c.json({ success: true, message: "Coins added successfully!" });
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
      const id = newId();
      await db.insert(schema.contests).values({
        id, title: body.title || body.name || null, type: body.type || "photo", status: "live",
        totalEntryFee: Number(body.totalEntryFee || body.entryDpcoin || 0),
        rewardCoins: Number(body.rewardCoins || body.winningCoins || 0),
        voteDurationDays: Number(body.voteDurationDays || 1),
        autoCancelHours: Number(body.autoCancelHours || 24),
        minVotes: Number(body.minVotes || 0),
        extra: body, createdBy: uid, createdAt: now(),
      });
      return c.json({ success: true, contestId: id });
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

    // ================= NOT YET PORTED =================
    case "adminManageWallet": {
      if (!(await isAdmin(c as any))) throw httpsError("permission-denied", "Admin only.");
      const { userId, amount, type } = body;
      if (!userId || typeof amount !== "number" || !["add", "subtract"].includes(type))
        throw httpsError("invalid-argument", "Invalid request parameters.");
      const delta = type === "add" ? amount : -amount;
      const upd = await db
        .update(schema.users)
        .set({ dpcoin: sql`MAX(${schema.users.dpcoin} + ${delta}, 0)`, updatedAt: now() })
        .where(eq(schema.users.uid, userId))
        .run();
      if (upd.meta.changes === 0) throw httpsError("not-found", "User not found.");
      await db.insert(schema.coinTransactions).values({
        id: newId(), uid: userId, amount: delta, type: "admin_adjustment",
        description: `Admin ${type} ${amount} Dpcoin`, createdAt: now(),
      });
      const u = await db.select({ balance: schema.users.dpcoin }).from(schema.users).where(eq(schema.users.uid, userId)).get();
      return c.json({ success: true, message: "Wallet updated successfully", newBalance: u?.balance ?? 0 });
    }
    case "join":
    case "vote":
      return notPorted(action, "contests/contestHandler.ts (legacy entries/battles matchmaking)");

    default:
      throw httpsError("invalid-argument", `Action '${action}' nahi mila.`);
  }
});
