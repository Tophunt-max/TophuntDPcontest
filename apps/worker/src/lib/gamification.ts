/**
 * XP / level / reward logic ported from utils/gamification.ts.
 * Settings come from the `gamification` settings row (KV-cached).
 */
import { eq, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { getGamificationSettings as loadGamification } from "./settings";
import { sendPushNotification } from "./notify";

interface Badge {
  level: number;
  name: string;
  icon: string;
}

export interface GamificationSettings {
  xpThreshold: number;
  xpIncrement: number;
  dailyLoginReward: number;
  dailyStreakBonus: number;
  contestJoinReward: number;
  matchWinReward: number;
  signupBonus: number;
  referralBonus: number;
  voteReward: number;
  voteRewardXP: number;
  contestJoinXP: number;
  badges: Badge[];
}

const DEFAULT_SETTINGS: GamificationSettings = {
  xpThreshold: 500,
  xpIncrement: 500,
  dailyLoginReward: 10,
  dailyStreakBonus: 2,
  contestJoinReward: 50,
  matchWinReward: 100,
  signupBonus: 100,
  referralBonus: 50,
  voteReward: 1,
  voteRewardXP: 10,
  contestJoinXP: 50,
  badges: [],
};

export async function getSettings(env: Env): Promise<GamificationSettings> {
  const data = (await loadGamification(env)) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...data,
    dailyLoginReward: data.dailyLoginReward ?? data.dailyBaseReward ?? DEFAULT_SETTINGS.dailyLoginReward,
    badges: data.badges || [],
  };
}

/** Level from cumulative XP with escalating thresholds (unchanged formula). */
export function calculateLevel(xp: number, threshold: number, increment: number): number {
  let level = 1;
  let currentThreshold = threshold;
  let accumulatedXp = 0;
  while (xp >= accumulatedXp + currentThreshold) {
    accumulatedXp += currentThreshold;
    level++;
    currentThreshold += increment;
  }
  return level;
}

/** Award XP (and handle level-up + badges). */
export async function awardXp(env: Env, userId: string, amount: number): Promise<void> {
  const settings = await getSettings(env);
  const db = getDb(env);
  const user = await db
    .select({ xp: schema.users.xp, level: schema.users.level, badges: schema.users.badges })
    .from(schema.users)
    .where(eq(schema.users.uid, userId))
    .get();
  if (!user) return;

  const newXp = (user.xp || 0) + amount;
  const newLevel = calculateLevel(newXp, settings.xpThreshold, settings.xpIncrement);
  const leveledUp = newLevel > (user.level || 1);

  let badges = (user.badges as unknown as Badge[]) || [];
  if (leveledUp) {
    const badge = settings.badges.find((b) => b.level === newLevel);
    if (badge && !badges.some((b) => b.name === badge.name)) badges = [...badges, badge];
  }

  await db
    .update(schema.users)
    .set({ xp: newXp, level: newLevel, badges: badges as any, updatedAt: Date.now() })
    .where(eq(schema.users.uid, userId));

  if (leveledUp) {
    await sendPushNotification(env, userId, "Level Up! 🌟", `You reached Level ${newLevel}.`, "level_up");
  }
}

/** Award coins + XP for a named action (daily_login, contest_join, match_win, battle_vote). */
export async function awardReward(
  env: Env,
  userId: string,
  action: "daily_login" | "contest_join" | "match_win" | "battle_vote",
): Promise<void> {
  const settings = await getSettings(env);
  let xpAmount = 0;
  let coinAmount = 0;
  switch (action) {
    case "daily_login":
      coinAmount = settings.dailyLoginReward;
      xpAmount = 20;
      break;
    case "contest_join":
      coinAmount = settings.contestJoinReward;
      xpAmount = settings.contestJoinXP;
      break;
    case "match_win":
      coinAmount = settings.matchWinReward;
      xpAmount = 100;
      break;
    case "battle_vote":
      xpAmount = settings.voteRewardXP;
      coinAmount = settings.voteReward;
      break;
  }
  if (xpAmount <= 0 && coinAmount <= 0) return;

  const db = getDb(env);
  if (coinAmount > 0) {
    await db
      .update(schema.users)
      .set({ dpcoin: sql`${schema.users.dpcoin} + ${coinAmount}`, updatedAt: Date.now() })
      .where(eq(schema.users.uid, userId));
    await sendPushNotification(
      env,
      userId,
      "Reward Received! 🪙",
      `You earned ${coinAmount} Dpcoins!`,
      "reward_received",
    );
  }
  if (xpAmount > 0) await awardXp(env, userId, xpAmount);
}
