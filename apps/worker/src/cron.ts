/**
 * Scheduled tasks — port of apps/functions/src/contests/cron.ts and
 * scheduled/index.ts. Wired to Cron Triggers in wrangler.toml:
 *   every 10 minutes -> resolveContests + expired story cleanup
 *   monthly (1st)    -> monthlyHallOfFame
 *
 * Firestore triggers had no equivalent here; the notification side effects that
 * used to fire from onDocument triggers are emitted explicitly via createNotification.
 */
import { and, eq, lte, gt, desc, sql } from "drizzle-orm";
import type { Env } from "./types";
import { getDb, schema } from "./db";
import { createNotification, sendSegmentedBroadcast } from "./lib/notify";
import { finalizeVotes } from "./lib/voteCounter";
import { deleteByPublicUrl } from "./lib/r2";
import { newId, now } from "./lib/ids";

type Match = typeof schema.contestMatches.$inferSelect;

async function resolveMatch(env: Env, match: Match): Promise<void> {
  const db = getDb(env);
  const userA = match.userA as any;
  const userB = match.userB as any;
  if (!userA || !userB) return;

  let rewardAmount = Number(match.entryFee || 0);
  if (match.contestId) {
    const contest = await db.select({ reward: schema.contests.rewardCoins }).from(schema.contests).where(eq(schema.contests.id, match.contestId)).get();
    if (contest?.reward) rewardAmount = Number(contest.reward);
  }

  // Ask the per-match VoteCounter DO for the authoritative tally (it also
  // flushes any in-flight votes to D1). Fall back to the last-flushed values
  // stored in the match JSON if the DO is unreachable.
  let votesA = Number(userA.votes || 0);
  let votesB = Number(userB.votes || 0);
  try {
    const t = await finalizeVotes(env, match.id, userA.uid, userB.uid);
    votesA = t.votesA;
    votesB = t.votesB;
  } catch (e) {
    console.error("[resolveMatch] vote finalize failed, using D1 snapshot", match.id, e);
  }

  // Anti-collusion: if BOTH participants entered from the same device, the
  // match is void — refund both entry fees and pay NO reward. This closes the
  // self-match exploit (create + join from one phone to farm rewardCoins).
  if (userA.deviceId && userB.deviceId && String(userA.deviceId) === String(userB.deviceId)) {
    const ts = now();
    const claim = await db.update(schema.contestMatches)
      .set({ status: "cancelled", completedAt: ts })
      .where(and(eq(schema.contestMatches.id, match.id), eq(schema.contestMatches.status, "active")))
      .run();
    if (claim.meta.changes === 0) return; // already resolved by another run
    const refund = Number(match.entryFee || 0) / 2;
    if (refund > 0) {
      await db.batch([
        db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${refund}` }).where(eq(schema.users.uid, userA.uid)),
        db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${refund}` }).where(eq(schema.users.uid, userB.uid)),
        db.insert(schema.coinTransactions).values({ id: newId(), uid: userA.uid, amount: refund, type: "contest_refund", matchId: match.id, contestId: match.contestId, description: "Match voided (same-device entries)", createdAt: ts }),
        db.insert(schema.coinTransactions).values({ id: newId(), uid: userB.uid, amount: refund, type: "contest_refund", matchId: match.id, contestId: match.contestId, description: "Match voided (same-device entries)", createdAt: ts }),
      ]);
    }
    console.warn("[resolveMatch] voided same-device match", match.id, userA.uid, userB.uid);
    return;
  }

  // Tie -> refund both. Atomically claim the match (active -> completed) FIRST
  // so an overlapping/duplicate cron run can't refund twice.
  if (votesA === votesB) {
    const ts = now();
    const claim = await db.update(schema.contestMatches)
      .set({ status: "completed", completedAt: ts })
      .where(and(eq(schema.contestMatches.id, match.id), eq(schema.contestMatches.status, "active")))
      .run();
    if (claim.meta.changes === 0) return; // already resolved by another run
    const refund = Number(match.entryFee || 0) / 2;
    if (refund > 0) {
      await db.batch([
        db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${refund}` }).where(eq(schema.users.uid, userA.uid)),
        db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${refund}` }).where(eq(schema.users.uid, userB.uid)),
      ]);
    }
    await createNotification(env, userA.uid, { title: "It's a Tie!", body: "The match ended in a tie. Entry fees refunded.", type: "contest-tie", targetId: "wallet" });
    await createNotification(env, userB.uid, { title: "It's a Tie!", body: "The match ended in a tie. Entry fees refunded.", type: "contest-tie", targetId: "wallet" });
    return;
  }

  const winnerUid = votesA > votesB ? userA.uid : userB.uid;
  const loserUid = votesA > votesB ? userB.uid : userA.uid;
  const ts = now();

  // Atomically claim the match before paying out. If another run already flipped
  // it out of "active", stop — prevents double-payout. The payout below is a
  // single batch so the reward + stats + ledger commit together.
  const claim = await db.update(schema.contestMatches)
    .set({ status: "completed", winnerUid, rewardAmount, completedAt: ts })
    .where(and(eq(schema.contestMatches.id, match.id), eq(schema.contestMatches.status, "active")))
    .run();
  if (claim.meta.changes === 0) return;

  await db.batch([
    db.update(schema.users).set({
      dpcoin: sql`${schema.users.dpcoin} + ${rewardAmount}`,
      xp: sql`${schema.users.xp} + 100`,
      wins: sql`${schema.users.wins} + 1`,
      monthlyWins: sql`${schema.users.monthlyWins} + 1`,
      updatedAt: ts,
    }).where(eq(schema.users.uid, winnerUid)),
    db.update(schema.users).set({ xp: sql`${schema.users.xp} + 20`, updatedAt: ts }).where(eq(schema.users.uid, loserUid)),
    db.insert(schema.coinTransactions).values({
      id: newId(), uid: winnerUid, amount: rewardAmount, type: "contest_win_reward",
      matchId: match.id, contestId: match.contestId, description: `Victory reward for "${match.title}"`, createdAt: ts,
    }),
  ]);

  await createNotification(env, winnerUid, { title: "You Won! 🏆", body: `Victory! You won the battle "${match.title}" and earned ${rewardAmount} Dpcoins!`, type: "contest-win", targetId: match.id });
  await createNotification(env, loserUid, { title: "Battle Ended", body: `The battle "${match.title}" has concluded. You played well!`, type: "contest-loss", targetId: match.id });
}

async function refundWaitingMatch(env: Env, match: Match): Promise<void> {
  const db = getDb(env);
  const userA = match.userA as any;
  // Atomically claim (waiting -> cancelled) so we can't refund the same
  // unmatched contest twice across overlapping cron runs.
  const claim = await db.update(schema.contestMatches)
    .set({ status: "cancelled", completedAt: now() })
    .where(and(eq(schema.contestMatches.id, match.id), eq(schema.contestMatches.status, "waiting_for_opponent")))
    .run();
  if (claim.meta.changes === 0) return;
  const refund = Number(match.entryFee || 0) / 2;
  if (refund > 0 && userA?.uid) {
    const ts = now();
    await db.batch([
      db.update(schema.users).set({ dpcoin: sql`${schema.users.dpcoin} + ${refund}` }).where(eq(schema.users.uid, userA.uid)),
      db.insert(schema.coinTransactions).values({ id: newId(), uid: userA.uid, amount: refund, type: "contest_refund", matchId: match.id, createdAt: ts }),
    ]);
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

  for (let i = 0; i < MAX_PAGES; i++) {
    const active = await db.select().from(schema.contestMatches)
      .where(and(eq(schema.contestMatches.status, "active"), lte(schema.contestMatches.expiresAt, nowMs)))
      .limit(PAGE).all();
    for (const m of active) await resolveMatch(env, m);
    if (active.length < PAGE) break;
  }

  for (let i = 0; i < MAX_PAGES; i++) {
    const waiting = await db.select().from(schema.contestMatches)
      .where(and(eq(schema.contestMatches.status, "waiting_for_opponent"), lte(schema.contestMatches.expiresAt, nowMs)))
      .limit(PAGE).all();
    for (const m of waiting) await refundWaitingMatch(env, m);
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
  // (contest_announcement / contest_match_live) reuse the match's media, so we
  // must NOT delete their objects here. R2 DELETE ops are free.
  const expiredUserStories = await db
    .select({ mediaUrl: schema.stories.mediaUrl })
    .from(schema.stories)
    .where(and(lte(schema.stories.expiresAt, nowMs), eq(schema.stories.type, "user")))
    .limit(500)
    .all();
  for (const s of expiredUserStories) {
    if (s.mediaUrl) await deleteByPublicUrl(env, s.mediaUrl).catch(() => {});
  }
  await db.delete(schema.stories).where(lte(schema.stories.expiresAt, nowMs));

  // due scheduled/segmented broadcasts
  await processScheduledNotifications(env);
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
      const recipients = await sendSegmentedBroadcast(env, n.title, n.body, n.image || undefined, (n.segment as any) || undefined);
      await db.update(schema.scheduledNotifications).set({ recipients }).where(eq(schema.scheduledNotifications.id, n.id));
    } catch (e) {
      console.error("[cron] scheduled notification failed", n.id, e);
    }
  }
}

/** Monthly cron: top-3 by monthlyWins get coins/xp/badge, then reset monthlyWins. */
export async function monthlyHallOfFame(env: Env): Promise<void> {
  const db = getDb(env);
  const top = await db.select().from(schema.users).orderBy(desc(schema.users.monthlyWins)).limit(3).all();
  const rewards = [1000, 500, 250];
  const badges = ["Gold Hall of Fame", "Silver Hall of Fame", "Bronze Hall of Fame"];

  for (let i = 0; i < top.length; i++) {
    const u = top[i];
    if (!u.monthlyWins || u.monthlyWins <= 0) continue;
    const reward = rewards[i];
    const ts = now();
    const currentBadges = ((u.badges as unknown as any[]) || []).slice();
    if (!currentBadges.includes(badges[i])) currentBadges.push(badges[i]);
    await db.update(schema.users).set({
      dpcoin: sql`${schema.users.dpcoin} + ${reward}`,
      xp: sql`${schema.users.xp} + 500`,
      badges: currentBadges as any,
      monthlyWins: 0,
      updatedAt: ts,
    }).where(eq(schema.users.uid, u.uid));
    await db.insert(schema.coinTransactions).values({ id: newId(), uid: u.uid, amount: reward, type: "monthly_hall_of_fame_reward", description: `Hall of Fame rank #${i + 1}`, createdAt: ts });
    await createNotification(env, u.uid, { title: "Monthly Hall of Fame! 🏆", body: `Congratulations! You ranked #${i + 1} this month. You've earned ${reward} Dpcoins and the ${badges[i]}!`, type: "hall-of-fame", targetId: "profile" });
  }

  // Reset the monthly leaderboard for EVERYONE (not just the top 3) so next
  // month starts clean — otherwise non-winners' monthlyWins accumulate forever
  // and the "monthly" ranking silently becomes an all-time cumulative one.
  await db.update(schema.users).set({ monthlyWins: 0, updatedAt: now() }).where(gt(schema.users.monthlyWins, 0));
}
