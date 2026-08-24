/**
 * Scheduled tasks — port of apps/functions/src/contests/cron.ts and
 * scheduled/index.ts. Wired to Cron Triggers in wrangler.toml:
 *   every 10 minutes -> resolveContests + expired story cleanup
 *   monthly (1st)    -> monthlyHallOfFame
 *
 * Firestore triggers had no equivalent here; the notification side effects that
 * used to fire from onDocument triggers are emitted explicitly via createNotification.
 */
import { and, eq, lte, gt, desc, sql, asc, isNull } from "drizzle-orm";
import type { Env } from "./types";
import { getDb, schema } from "./db";
import { createNotification } from "./lib/notify";
import { drainBroadcastJobs, enqueueBroadcast } from "./lib/broadcast";
import { finalizeVotes } from "./lib/voteCounter";
import { settleRefund, settleWinner } from "./lib/contestSettlement";
import { matchPot, perPlayerEntryFee } from "./lib/money";
import { deleteMediaByUrl } from "./lib/mediaDelete";
import { newId, now } from "./lib/ids";
import { publish } from "./lib/publish";

type Match = typeof schema.contestMatches.$inferSelect;

async function publishMatchStatus(
  env: Env,
  matchId: string,
  status: "completed" | "cancelled",
  votesA: number,
  votesB: number,
  winnerUid: string | null = null,
): Promise<void> {
  await publish(env, `match:${matchId}`, {
    type: "match_status",
    status,
    votesA,
    votesB,
    totalVotes: votesA + votesB,
    // Lets a live feed card flip to its winner/result view without a refetch.
    winnerUid,
  });
}

async function resolveMatch(env: Env, match: Match): Promise<void> {
  const db = getDb(env);
  const userA = match.userA as any;
  const userB = match.userB as any;
  if (!userA || !userB) return;

  // The prize is whatever was SNAPSHOTTED on the match when it was created.
  // Re-reading the live contest template here is what let an admin edit change
  // the payout of a match that was already in flight.
  //
  // `matchPot` is a hard ceiling regardless of source: a prize can never exceed
  // the coins the two players actually funded, so settlement cannot mint coins
  // even if a legacy template row still holds an over-funded reward.
  const pot = matchPot(match.entryFee);
  let rewardAmount = match.prizeCoins == null ? null : Math.min(Number(match.prizeCoins), pot);
  let minVotes = match.minVotesRequired == null
    ? null
    : Math.max(0, Number(match.minVotesRequired));
  if (match.contestId && (rewardAmount == null || minVotes == null)) {
    const contest = await db
      .select({ reward: schema.contests.rewardCoins, minVotes: schema.contests.minVotes })
      .from(schema.contests)
      .where(eq(schema.contests.id, match.contestId))
      .get();
    if (rewardAmount == null) {
      // Legacy match with no snapshot: derive it once, clamp it to the pot, and
      // persist it so this match settles deterministically from now on.
      rewardAmount = Math.min(Number(contest?.reward ?? pot), pot);
      await db.update(schema.contestMatches)
        .set({ prizeCoins: rewardAmount })
        .where(and(
          eq(schema.contestMatches.id, match.id),
          isNull(schema.contestMatches.prizeCoins),
        ));
    }
    if (minVotes == null) {
      if (!contest) {
        throw new Error(`Match ${match.id} has no min-vote snapshot and its template is missing.`);
      }
      minVotes = Math.max(0, Number(contest.minVotes || 0));
      await db.update(schema.contestMatches)
        .set({ minVotesRequired: minVotes })
        .where(and(
          eq(schema.contestMatches.id, match.id),
          isNull(schema.contestMatches.minVotesRequired),
        ));
    }
  }
  if (minVotes == null) {
    throw new Error(`Match ${match.id} has no immutable minimum-vote policy snapshot.`);
  }
  if (rewardAmount == null) {
    // No snapshot and no template (standalone match): the pot is the prize.
    rewardAmount = pot;
  }

  // Finalization is deliberately fail-closed. The per-match actor closes first,
  // flushes every accepted vote, and only then returns the authoritative tally.
  // If that fails, throw so this match remains active and is retried next cron;
  // never make an irreversible payout from a stale D1 snapshot.
  const expiresAt = Number(match.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
    throw new Error(`Match ${match.id} has no valid voting deadline.`);
  }
  const finalTally = await finalizeVotes(env, match.id, userA.uid, userB.uid, expiresAt);
  const votesA = finalTally.votesA;
  const votesB = finalTally.votesB;
  const totalVotes = finalTally.total;

  // Anti-collusion: if BOTH participants entered from the same device, the
  // match is void — refund both entry fees and pay NO reward. This closes the
  // self-match exploit (create + join from one phone to farm rewardCoins).
  if (userA.deviceId && userB.deviceId && String(userA.deviceId) === String(userB.deviceId)) {
    const ts = now();
    const settled = await settleRefund(env, {
      matchId: match.id,
      contestId: match.contestId,
      expectedStatus: "active",
      finalStatus: "cancelled",
      participantUids: [userA.uid, userB.uid],
      refundPerUser: perPlayerEntryFee(match.entryFee),
      description: "Match voided (same-device entries)",
      completedAt: ts,
    });
    if (!settled) return;
    await publishMatchStatus(env, match.id, "cancelled", votesA, votesB);
    console.warn("[resolveMatch] voided same-device match", match.id, userA.uid, userB.uid);
    return;
  }

  // A contest is only eligible for a winner when its configured participation
  // threshold is reached. Insufficient-vote matches are void and both entrants
  // get their entry fee back; no winner reward or win stats are awarded.
  if (totalVotes < minVotes) {
    const ts = now();
    const settled = await settleRefund(env, {
      matchId: match.id,
      contestId: match.contestId,
      expectedStatus: "active",
      finalStatus: "cancelled",
      participantUids: [userA.uid, userB.uid],
      refundPerUser: perPlayerEntryFee(match.entryFee),
      description: `Refund: minimum ${minVotes} votes not reached`,
      completedAt: ts,
    });
    if (!settled) return;
    await publishMatchStatus(env, match.id, "cancelled", votesA, votesB);
    const message = `The battle ended with ${totalVotes} of ${minVotes} required votes. Entry fees were refunded.`;
    await createNotification(env, userA.uid, { title: "Battle Voided", body: message, type: "contest-refund", targetId: "wallet" });
    await createNotification(env, userB.uid, { title: "Battle Voided", body: message, type: "contest-refund", targetId: "wallet" });
    return;
  }

  // Tie -> refund both. Atomically claim the match (active -> completed) FIRST
  // so an overlapping/duplicate cron run can't refund twice.
  if (votesA === votesB) {
    const ts = now();
    const settled = await settleRefund(env, {
      matchId: match.id,
      contestId: match.contestId,
      expectedStatus: "active",
      finalStatus: "completed",
      participantUids: [userA.uid, userB.uid],
      refundPerUser: perPlayerEntryFee(match.entryFee),
      description: "Match tied; entry fee refunded",
      completedAt: ts,
    });
    if (!settled) return;
    await publishMatchStatus(env, match.id, "completed", votesA, votesB);
    await createNotification(env, userA.uid, { title: "It's a Tie!", body: "The match ended in a tie. Entry fees refunded.", type: "contest-tie", targetId: "wallet" });
    await createNotification(env, userB.uid, { title: "It's a Tie!", body: "The match ended in a tie. Entry fees refunded.", type: "contest-tie", targetId: "wallet" });
    return;
  }

  const winnerUid = votesA > votesB ? userA.uid : userB.uid;
  const loserUid = votesA > votesB ? userB.uid : userA.uid;
  const ts = now();

  const settled = await settleWinner(env, {
    matchId: match.id,
    contestId: match.contestId,
    expectedStatus: "active",
    winnerUid,
    loserUid,
    rewardAmount,
    description: `Victory reward for "${match.title}"`,
    completedAt: ts,
  });
  if (!settled) return;

  await publishMatchStatus(env, match.id, "completed", votesA, votesB, winnerUid);
  await createNotification(env, winnerUid, { title: "You Won! 🏆", body: `Victory! You won the battle "${match.title}" and earned ${rewardAmount} Dpcoins!`, type: "contest-win", targetId: match.id });
  await createNotification(env, loserUid, { title: "Battle Ended", body: `The battle "${match.title}" has concluded. You played well!`, type: "contest-loss", targetId: match.id });
}

async function refundWaitingMatch(env: Env, match: Match): Promise<void> {
  const userA = match.userA as any;
  const refund = perPlayerEntryFee(match.entryFee);
  const ts = now();
  const settled = await settleRefund(env, {
    matchId: match.id,
    contestId: match.contestId,
    expectedStatus: "waiting_for_opponent",
    finalStatus: "cancelled",
    participantUids: userA?.uid ? [userA.uid] : [],
    refundPerUser: refund,
    description: "No opponent joined before the waiting deadline",
    completedAt: ts,
  });
  if (!settled) return;
  if (refund > 0 && userA?.uid) {
    await createNotification(env, userA.uid, { title: "Contest Refunded", body: `No opponent joined your "${match.title}" contest. ${refund} Dpcoins have been returned.`, type: "contest-refund", targetId: "wallet" });
  }
}

/** Every-10-min cron: resolve expired matches, refund unmatched, notify ending-soon, cleanup stories. */
export async function resolveContests(env: Env): Promise<void> {
  const db = getDb(env);
  const nowMs = now();

  // Drain the backlog in pages so a burst of matches expiring at once is fully
  // resolved in this run instead of trickling 50 per 10-min tick (which would
  // delay payouts/refunds for hours). resolveMatch/refund flip the row out of
  // its status, so each page naturally advances without an offset. A safety cap
  // bounds worst-case cron time.
  const PAGE = 50;
  const MAX_PAGES = 20; // up to 1000 matches per category per run

  let lastActiveId: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const activeConditions = [
      eq(schema.contestMatches.status, "active"),
      lte(schema.contestMatches.expiresAt, nowMs),
    ];
    if (lastActiveId) activeConditions.push(gt(schema.contestMatches.id, lastActiveId));
    const active = await db.select().from(schema.contestMatches)
      .where(and(...activeConditions))
      .orderBy(asc(schema.contestMatches.id))
      .limit(PAGE).all();
    for (const m of active) {
      try {
        await resolveMatch(env, m);
      } catch (e) {
        // Keep this row active for the next cron retry, but do not let one
        // temporarily unavailable actor block settlement of every other match.
        console.error("[resolveContests] match settlement deferred", m.id, e);
      }
    }
    if (active.length > 0) lastActiveId = active[active.length - 1].id;
    if (active.length < PAGE) break;
  }

  for (let i = 0; i < MAX_PAGES; i++) {
    const waiting = await db.select().from(schema.contestMatches)
      .where(and(eq(schema.contestMatches.status, "waiting_for_opponent"), lte(schema.contestMatches.expiresAt, nowMs)))
      .limit(PAGE).all();
    for (const m of waiting) {
      try {
        await refundWaitingMatch(env, m);
      } catch (e) {
        // One bad row must not abort the whole waiting-match refund sweep — the
        // active loop above already had this guard; this one did not.
        console.error("[resolveContests] waiting-match refund deferred", m.id, e);
      }
    }
    if (waiting.length < PAGE) break;
  }

  // ending soon (< 60 min), not yet notified
  const soon = await db.select().from(schema.contestMatches)
    .where(and(
      eq(schema.contestMatches.status, "active"),
      gt(schema.contestMatches.expiresAt, nowMs),
      lte(schema.contestMatches.expiresAt, nowMs + 60 * 60 * 1000),
      eq(schema.contestMatches.endingSoonNotified, false),
    ))
    .limit(50).all();
  for (const m of soon) {
    const userA = m.userA as any;
    const userB = m.userB as any;
    const msg = `⏳ Hurry! The battle "${m.title || "Match"}" ends in less than an hour. Get more votes!`;
    if (userA?.uid) await createNotification(env, userA.uid, { title: "Battle Ending Soon!", body: msg, type: "contest-ending", targetId: m.id });
    if (userB?.uid) await createNotification(env, userB.uid, { title: "Battle Ending Soon!", body: msg, type: "contest-ending", targetId: m.id });
    await db.update(schema.contestMatches).set({ endingSoonNotified: true }).where(eq(schema.contestMatches.id, m.id));
  }

  // expired story cleanup — also delete the R2 media of expired PERSONAL
  // ("user") stories so R2 storage doesn't grow forever. Contest stories
  // (contest_announcement / contest_vs) reuse the match's media, so we must NOT
  // delete their objects here — doing so would blank out the battle itself. This
  // is also why the head-to-head story composes its layout on the client instead
  // of generating an image: a generated object would have no owner in this sweep.
  // R2 DELETE ops are free.
  const expiredUserStories = await db
    .select({ mediaUrl: schema.stories.mediaUrl })
    .from(schema.stories)
    .where(and(lte(schema.stories.expiresAt, nowMs), eq(schema.stories.type, "user")))
    .limit(500)
    .all();
  for (const s of expiredUserStories) {
    // Provider-aware: story videos now live in Bunny, and stories expire every
    // 24h, so an R2-only delete here would leak a video object per story.
    if (s.mediaUrl) await deleteMediaByUrl(env, s.mediaUrl).catch(() => {});
  }
  await db.delete(schema.stories).where(lte(schema.stories.expiresAt, nowMs));

  // due scheduled/segmented broadcasts
  await processScheduledNotifications(env);

  // Advance any in-flight broadcast by one page. Deliberately last, and one page
  // per tick, so a large broadcast can never starve the rest of this schedule.
  await drainBroadcastJobs(env).catch((e) =>
    console.error("[cron] broadcast drain failed", e),
  );
}

/** Send any pending scheduled notifications whose send_at has passed. */
export async function processScheduledNotifications(env: Env): Promise<void> {
  const db = getDb(env);
  const due = await db
    .select()
    .from(schema.scheduledNotifications)
    .where(and(eq(schema.scheduledNotifications.status, "pending"), lte(schema.scheduledNotifications.sendAt, now())))
    .limit(20)
    .all();
  for (const n of due) {
    // Claim atomically so overlapping cron runs don't double-send.
    const claim = await db
      .update(schema.scheduledNotifications)
      .set({ status: "sent", sentAt: now() })
      .where(and(eq(schema.scheduledNotifications.id, n.id), eq(schema.scheduledNotifications.status, "pending")))
      .run();
    if (claim.meta.changes === 0) continue;
    try {
      // Hand off to the resumable broadcast job rather than fanning out here:
      // this cron has other work to do and cannot afford a full table walk.
      const { estimatedRecipients } = await enqueueBroadcast(env, {
        title: n.title,
        body: n.body,
        image: n.image || undefined,
        segment: (n.segment as any) || undefined,
      });
      await db
        .update(schema.scheduledNotifications)
        .set({ recipients: estimatedRecipients })
        .where(eq(schema.scheduledNotifications.id, n.id));
    } catch (e) {
      console.error("[cron] scheduled notification failed", n.id, e);
    }
  }
}

/** `YYYY-MM` of the month that has just ended (the one being settled). */
export function previousMonthPeriod(at: number = Date.now()): string {
  const d = new Date(at);
  // Day 0 of the current month is the last day of the previous month.
  const prev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Monthly cron: top-3 by monthlyWins get coins/xp/badge, then reset monthlyWins.
 *
 * Exactly-once per (period, rank). Each winner's payout is claimed in
 * `idempotency_keys` inside the SAME transaction as the credit, the ledger row
 * and the XP/badge grant, so:
 *
 *  - a double-clicked `/admin/ops/hall-of-fame` pays nobody twice
 *  - a mid-loop failure does not re-pay the winners already settled on retry
 *  - `monthly_wins` is only reset when every winner has actually been paid,
 *    so a failure cannot silently erase the leaderboard it was settling
 */
export async function monthlyHallOfFame(env: Env, period = previousMonthPeriod()): Promise<{
  period: string;
  paid: number;
  skipped: number;
  reset: boolean;
}> {
  const db = getDb(env);
  const top = await db.select().from(schema.users).orderBy(desc(schema.users.monthlyWins)).limit(3).all();
  const rewards = [1000, 500, 250];
  const badges = ["Gold Hall of Fame", "Silver Hall of Fame", "Bronze Hall of Fame"];

  let paid = 0;
  let skipped = 0;
  const failures: string[] = [];

  for (let i = 0; i < top.length; i++) {
    const u = top[i];
    if (!u.monthlyWins || u.monthlyWins <= 0) continue;
    const reward = rewards[i];
    const ts = now();
    const claimKey = `hall_of_fame:${period}:${i + 1}:${u.uid}`;
    const nonce = crypto.randomUUID();
    const currentBadges = ((u.badges as unknown as any[]) || []).slice();
    if (!currentBadges.includes(badges[i])) currentBadges.push(badges[i]);

    try {
      // The claim row is written first; every money/XP statement after it is
      // gated on OUR nonce having won that claim. On a replay the pre-existing
      // row keeps its original nonce, so all three statements no-op.
      const claimGate = `EXISTS (SELECT 1 FROM idempotency_keys WHERE key = ? AND nonce = ?)`;
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO idempotency_keys (key, nonce, scope, created_at) VALUES (?, ?, ?, ?)`,
        ).bind(claimKey, nonce, "hall_of_fame", ts),
        env.DB.prepare(
          `INSERT OR IGNORE INTO coin_transactions
             (id, uid, amount, type, description, created_at)
           SELECT ?, ?, ?, 'monthly_hall_of_fame_reward', ?, ?
            WHERE ${claimGate}`,
        ).bind(
          `hall_of_fame:${period}:${u.uid}`,
          u.uid,
          reward,
          `Hall of Fame rank #${i + 1} (${period})`,
          ts,
          claimKey,
          nonce,
        ),
        env.DB.prepare(
          `UPDATE users
              SET dpcoin = dpcoin + ?, xp = xp + 500, badges = ?, monthly_wins = 0, updated_at = ?
            WHERE uid = ? AND ${claimGate}`,
        ).bind(reward, JSON.stringify(currentBadges), ts, u.uid, claimKey, nonce),
      ]);

      if (Number(results[2]?.meta?.changes || 0) > 0) {
        paid++;
        await createNotification(env, u.uid, {
          title: "Monthly Hall of Fame! 🏆",
          body: `Congratulations! You ranked #${i + 1} this month. You've earned ${reward} Dpcoins and the ${badges[i]}!`,
          type: "hall-of-fame",
          targetId: "profile",
        });
      } else {
        // Already settled for this period — expected on a manual re-trigger.
        skipped++;
      }
    } catch (e) {
      console.error("[monthlyHallOfFame] payout failed", period, u.uid, e);
      failures.push(u.uid);
    }
  }

  if (failures.length > 0) {
    // Do NOT reset the leaderboard: the unpaid winners' monthly_wins are the
    // only record of who is still owed. Throwing surfaces this in the cron
    // failure alert so it can be re-run (which is now safe).
    throw new Error(
      `Hall of Fame ${period}: ${failures.length} payout(s) failed (${failures.join(", ")}); monthly wins left intact for retry.`,
    );
  }

  // Reset the monthly leaderboard for EVERYONE (not just the top 3) so next
  // month starts clean — otherwise non-winners' monthlyWins accumulate forever
  // and the "monthly" ranking silently becomes an all-time cumulative one.
  await db.update(schema.users).set({ monthlyWins: 0, updatedAt: now() }).where(gt(schema.users.monthlyWins, 0));
  return { period, paid, skipped, reset: true };
}
