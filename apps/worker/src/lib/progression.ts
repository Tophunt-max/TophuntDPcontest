/**
 * Progression config and the level engine: the ONE place a level, a rank or a
 * progress bar is computed. The server returns the result (`levelInfo`) and the
 * app renders it as-is, so the two can never disagree.
 *
 * The formula is the one the app has always used (lib/gamification.ts
 * `calculateLevel`): going from level L to L+1 costs
 * `xpThreshold + (L - 1) * xpIncrement`, so the cumulative XP to REACH level L is
 *
 *     (L - 1) * xpThreshold + xpIncrement * (L - 1) * (L - 2) / 2
 *
 * What is new is a maximum level (default 100). XP keeps accumulating past it;
 * only the level number stops.
 *
 * Config lives on the existing `gamification` settings row under `progression`,
 * so it uses the same KV cache and admin invalidation as the rest of that row.
 */
import type { Env } from "../types";
import { getSettings, type GamificationSettings } from "./gamification";
import { httpsError } from "./http";

/** users.xp is clamped to this so it can never overflow a 32-bit consumer. */
export const MAX_LIFETIME_XP = 2_000_000_000;
export const MAX_LEVEL_CAP = 1000;
/** Largest XP a single rule may award. */
export const MAX_RULE_XP = 10_000;

/** Every action that can move XP. Clients never name an action or an amount. */
export const XP_ACTIONS = [
  "vote",
  "contest_entry",
  "match_win",
  "match_loss",
  "daily_checkin",
  "hall_of_fame",
  "daily_task",
  "quest",
  "achievement",
  "admin_adjustment",
  "reversal",
  "opening_balance",
] as const;
export type XpAction = (typeof XP_ACTIONS)[number];

/** Actions whose amount and cap an admin can configure. */
export const CONFIGURABLE_XP_ACTIONS = [
  "vote",
  "contest_entry",
  "match_win",
  "match_loss",
  "daily_checkin",
  "hall_of_fame",
  "daily_task",
  "quest",
  "achievement",
] as const;
export type ConfigurableXpAction = (typeof CONFIGURABLE_XP_ACTIONS)[number];

export interface XpRule {
  /** Fixed XP for actions with a fixed amount. Ignored for daily_task / quest / achievement (amount comes from the task, quest or achievement). */
  xp: number;
  enabled: boolean;
  /** Max XP from this action per reward day, or null for no cap. */
  dailyCap: number | null;
}

export interface Rank {
  id: string;
  name: string;
  minLevel: number;
  icon: string;
  color: string;
}

export interface Milestone {
  level: number;
  title: string;
  description: string;
  /** reward_catalog ids granted on reaching this level. */
  items: string[];
  /** Feature unlock key shown on the roadmap (e.g. "advanced_insights"). */
  feature: string | null;
  /** Diamonds paid through the reward budget when reached after launch. 0 = none. */
  coins: number;
}

export type QuestMetric = "votes" | "entries" | "wins" | "checkins" | "active_days" | "xp";
export const QUEST_METRICS: QuestMetric[] = ["votes", "entries", "wins", "checkins", "active_days", "xp"];

export interface QuestDef {
  id: string;
  title: string;
  period: "week" | "month";
  metric: QuestMetric;
  target: number;
  xp: number;
  minLevel: number;
  enabled: boolean;
}

export interface ProgressionConfig {
  /**
   * Shows the new experience (achievements, quests, seasons, level-up
   * notifications, coin milestone rewards). Off = the XP ledger still records
   * every award and levels still compute, but nothing new is shown or paid.
   */
  enabled: boolean;
  /** Accounts that get the experience while `enabled` is off (staged rollout). */
  betaUids: string[];
  maxLevel: number;
  rules: Record<ConfigurableXpAction, XpRule>;
  ranks: Rank[];
  milestones: Milestone[];
  quests: QuestDef[];
  /** Achievements a user may pin on their profile. */
  pinnedLimit: number;
  /** Budget that pays milestone / season Diamonds. Falls back to the free-rewards budget. */
  rewardBudgetId: string | null;
  /** XP events per day per action that raise a review flag (never a block). */
  velocityFlagEvents: number;
  /** Bumped by the admin save; stored on every XP event. */
  version: number;
}

/**
 * Defaults. XP amounts are the ones the app ALREADY paid before the ledger, so
 * turning this on changes nobody's earning rate except through the new daily
 * caps (vote: 20 votes' worth a day, entries: 6 a day).
 */
export const DEFAULT_RULES: Record<ConfigurableXpAction, XpRule> = {
  vote: { xp: 5, enabled: true, dailyCap: 100 },
  contest_entry: { xp: 10, enabled: true, dailyCap: 60 },
  match_win: { xp: 100, enabled: true, dailyCap: null },
  match_loss: { xp: 20, enabled: true, dailyCap: null },
  daily_checkin: { xp: 50, enabled: true, dailyCap: null },
  hall_of_fame: { xp: 500, enabled: true, dailyCap: null },
  daily_task: { xp: 0, enabled: true, dailyCap: 100 },
  quest: { xp: 0, enabled: true, dailyCap: null },
  achievement: { xp: 0, enabled: true, dailyCap: null },
};

export const DEFAULT_RANKS: Rank[] = [
  { id: "newcomer", name: "Newcomer", minLevel: 1, icon: "leaf", color: "#8BC34A" },
  { id: "creator", name: "Creator", minLevel: 6, icon: "brush", color: "#29B6F6" },
  { id: "challenger", name: "Challenger", minLevel: 16, icon: "flash", color: "#AB47BC" },
  { id: "champion", name: "Champion", minLevel: 31, icon: "trophy", color: "#FFB300" },
  { id: "legend", name: "Legend", minLevel: 51, icon: "diamond", color: "#FF5252" },
];

const m = (level: number, title: string, description: string, items: string[] = [], feature: string | null = null): Milestone => ({
  level, title, description, items, feature, coins: 0,
});

export const DEFAULT_MILESTONES: Milestone[] = [
  m(1, "Level badge", "Your level badge and XP progress bar.", [], "level_badge"),
  m(2, "Achievement showcase", "Pin achievements on your profile.", [], "achievement_showcase"),
  m(5, "Starter frame", "Bronze profile frame.", ["frame_bronze"]),
  m(10, "Creator title", "The Creator title and your personal stats summary.", ["title_creator"], "stats_summary"),
  m(15, "More customization", "Silver frame and the Midnight profile theme.", ["frame_silver", "theme_midnight"], "customization"),
  m(20, "Weekly challenges", "Unlocks the weekly challenge track.", [], "weekly_challenges"),
  m(25, "Animated frame", "Golden Pulse animated frame.", ["frame_gold_animated"]),
  m(30, "Advanced insights", "Trends and advanced performance insights.", [], "advanced_insights"),
  m(35, "Rare creator badge", "A rare badge for your profile.", ["badge_rare_creator"]),
  m(40, "Seasonal collectibles", "Season Star collectible.", ["collectible_season_star"]),
  m(50, "Champion", "Champion title and a place in the Hall of Fame legends list.", ["title_champion"], "hall_of_fame"),
  m(60, "Royal theme", "Premium-style Royal profile theme.", ["theme_royal"]),
  m(75, "Elite set", "Elite collection.", ["collectible_elite_set"]),
  m(90, "Diamond Aura", "Rare animated frame.", ["frame_diamond_animated"]),
  m(100, "Legend", "Legendary title, frame, celebration effect and lifetime showcase.", ["title_legend", "frame_legendary", "effect_legend_burst"], "lifetime_showcase"),
];

export const DEFAULT_QUESTS: QuestDef[] = [
  { id: "weekly_votes", title: "Vote in 25 battles this week", period: "week", metric: "votes", target: 25, xp: 25, minLevel: 1, enabled: true },
  { id: "weekly_entries", title: "Enter 3 battles this week", period: "week", metric: "entries", target: 3, xp: 25, minLevel: 1, enabled: true },
  { id: "weekly_checkins", title: "Check in on 5 days this week", period: "week", metric: "checkins", target: 5, xp: 20, minLevel: 1, enabled: true },
  { id: "weekly_challenge_wins", title: "Weekly challenge: win 2 battles", period: "week", metric: "wins", target: 2, xp: 25, minLevel: 20, enabled: true },
  { id: "monthly_active", title: "Be active on 15 days this month", period: "month", metric: "active_days", target: 15, xp: 50, minLevel: 1, enabled: true },
];

export const DEFAULT_PROGRESSION: ProgressionConfig = {
  enabled: false,
  betaUids: [],
  maxLevel: 100,
  rules: DEFAULT_RULES,
  ranks: DEFAULT_RANKS,
  milestones: DEFAULT_MILESTONES,
  quests: DEFAULT_QUESTS,
  pinnedLimit: 3,
  rewardBudgetId: null,
  velocityFlagEvents: 200,
  version: 1,
};

/** Level formula inputs plus the cap. */
export interface LevelCurve {
  xpThreshold: number;
  xpIncrement: number;
  maxLevel: number;
}

/** Cumulative XP needed to REACH `level` (level 1 = 0). */
export function xpForLevel(level: number, curve: Pick<LevelCurve, "xpThreshold" | "xpIncrement">): number {
  const l = Math.max(1, Math.floor(level));
  return (l - 1) * curve.xpThreshold + (curve.xpIncrement * (l - 1) * (l - 2)) / 2;
}

/** Level for cumulative XP, capped at maxLevel. Bounded loop: at most maxLevel steps. */
export function levelFor(xp: number, curve: LevelCurve): number {
  const n = Number(xp);
  const safe = Number.isFinite(n) && n > 0 ? n : 0;
  let level = 1;
  while (level < curve.maxLevel && safe >= xpForLevel(level + 1, curve)) level++;
  return level;
}

export function rankFor(level: number, ranks: Rank[]): Rank {
  let best = ranks[0] ?? DEFAULT_RANKS[0];
  for (const r of ranks) if (level >= r.minLevel && r.minLevel >= best.minLevel) best = r;
  return best;
}

export interface LevelInfo {
  xp: number;
  level: number;
  maxLevel: number;
  isMaxLevel: boolean;
  /** Cumulative XP at which the current level started. */
  levelStartXp: number;
  /** Cumulative XP needed for the next level; null at max level. */
  nextLevelXp: number | null;
  /** XP earned inside the current level. At max level: XP past the max-level threshold. */
  xpIntoLevel: number;
  /** Size of the current level; null at max level. */
  xpForNextLevel: number | null;
  /** XP still needed; null at max level. */
  xpToNextLevel: number | null;
  /** 0..1, and exactly 1 at max level. */
  progress: number;
  rank: Pick<Rank, "id" | "name" | "icon" | "color">;
  nextRank: { name: string; minLevel: number } | null;
  /** The next milestone above the current level, if any. */
  nextMilestone: Pick<Milestone, "level" | "title" | "description" | "items" | "feature"> | null;
}

export function levelInfo(xpRaw: number, curve: LevelCurve, cfg: Pick<ProgressionConfig, "ranks" | "milestones">): LevelInfo {
  const n = Number(xpRaw);
  const xp = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const level = levelFor(xp, curve);
  const isMaxLevel = level >= curve.maxLevel;
  const levelStartXp = xpForLevel(level, curve);
  const nextLevelXp = isMaxLevel ? null : xpForLevel(level + 1, curve);
  const span = nextLevelXp === null ? null : nextLevelXp - levelStartXp;
  const into = xp - levelStartXp;
  const rank = rankFor(level, cfg.ranks);
  const nextRank = [...cfg.ranks].sort((a, b) => a.minLevel - b.minLevel).find((r) => r.minLevel > level) ?? null;
  const next = [...cfg.milestones].sort((a, b) => a.level - b.level).find((mm) => mm.level > level && mm.level <= curve.maxLevel) ?? null;
  return {
    xp,
    level,
    maxLevel: curve.maxLevel,
    isMaxLevel,
    levelStartXp,
    nextLevelXp,
    xpIntoLevel: into,
    xpForNextLevel: span,
    xpToNextLevel: nextLevelXp === null ? null : nextLevelXp - xp,
    progress: span === null ? 1 : Math.max(0, Math.min(1, into / span)),
    rank: { id: rank.id, name: rank.name, icon: rank.icon, color: rank.color },
    nextRank: nextRank ? { name: nextRank.name, minLevel: nextRank.minLevel } : null,
    nextMilestone: next
      ? { level: next.level, title: next.title, description: next.description, items: next.items, feature: next.feature }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Loading and validation
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const ID_RE = /^[a-z0-9_-]{2,40}$/;

function mergeRules(raw: unknown): Record<ConfigurableXpAction, XpRule> {
  const out = {} as Record<ConfigurableXpAction, XpRule>;
  for (const a of CONFIGURABLE_XP_ACTIONS) {
    const r = isObj(raw) && isObj(raw[a]) ? raw[a] : {};
    const d = DEFAULT_RULES[a];
    out[a] = {
      xp: isInt(r.xp, 0, MAX_RULE_XP) ? r.xp : d.xp,
      enabled: typeof r.enabled === "boolean" ? r.enabled : d.enabled,
      dailyCap: r.dailyCap === null ? null : isInt(r.dailyCap, 0, 1_000_000) ? r.dailyCap : d.dailyCap,
    };
  }
  return out;
}

/** Read-side sanitiser: whatever is stored, the result is safe to compute with. */
export function sanitizeProgression(raw: unknown): ProgressionConfig {
  const p = isObj(raw) ? raw : {};
  const maxLevel = isInt(p.maxLevel, 2, MAX_LEVEL_CAP) ? p.maxLevel : DEFAULT_PROGRESSION.maxLevel;
  return {
    enabled: p.enabled === true,
    betaUids: Array.isArray(p.betaUids) ? p.betaUids.filter((u: unknown) => typeof u === "string").slice(0, 500) : [],
    maxLevel,
    rules: mergeRules(p.rules),
    ranks: Array.isArray(p.ranks) && p.ranks.length ? p.ranks : DEFAULT_RANKS,
    milestones: Array.isArray(p.milestones) ? p.milestones : DEFAULT_MILESTONES,
    quests: Array.isArray(p.quests) ? p.quests : DEFAULT_QUESTS,
    pinnedLimit: isInt(p.pinnedLimit, 0, 12) ? p.pinnedLimit : DEFAULT_PROGRESSION.pinnedLimit,
    rewardBudgetId: typeof p.rewardBudgetId === "string" && p.rewardBudgetId ? p.rewardBudgetId : null,
    velocityFlagEvents: isInt(p.velocityFlagEvents, 1, 1_000_000) ? p.velocityFlagEvents : DEFAULT_PROGRESSION.velocityFlagEvents,
    version: isInt(p.version, 1, 1_000_000_000) ? p.version : 1,
  };
}

/**
 * Write-side validation for `POST /admin/gamification/config`. Throws a message
 * naming the bad field. Also checks the level curve the row will produce, since
 * xpThreshold / xpIncrement live on the same row.
 */
export function validateProgression(p: any, curve: Pick<LevelCurve, "xpThreshold" | "xpIncrement">): void {
  if (!isObj(p)) throw new Error("progression must be an object.");
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") throw new Error("enabled must be true or false.");
  if (p.betaUids !== undefined && (!Array.isArray(p.betaUids) || p.betaUids.length > 500 || !p.betaUids.every((u: unknown) => typeof u === "string" && u.length > 0 && u.length <= 128))) {
    throw new Error("betaUids must be a list of up to 500 user ids.");
  }
  const maxLevel = p.maxLevel ?? DEFAULT_PROGRESSION.maxLevel;
  if (!isInt(maxLevel, 2, MAX_LEVEL_CAP)) throw new Error(`maxLevel must be a whole number from 2 to ${MAX_LEVEL_CAP}.`);
  if (!isInt(curve.xpThreshold, 1, 1_000_000) || !isInt(curve.xpIncrement, 0, 1_000_000)) {
    throw new Error("xpThreshold must be 1-1,000,000 and xpIncrement 0-1,000,000.");
  }
  if (xpForLevel(maxLevel, curve) > MAX_LIFETIME_XP) {
    throw new Error(`Level ${maxLevel} would need more than ${MAX_LIFETIME_XP.toLocaleString("en-US")} XP. Lower maxLevel, xpThreshold or xpIncrement.`);
  }
  if (p.rules !== undefined) {
    if (!isObj(p.rules)) throw new Error("rules must be an object.");
    for (const [k, r] of Object.entries(p.rules)) {
      if (!(CONFIGURABLE_XP_ACTIONS as readonly string[]).includes(k)) throw new Error(`rules.${k} is not a known XP action.`);
      if (!isObj(r)) throw new Error(`rules.${k} must be an object.`);
      if (r.xp !== undefined && !isInt(r.xp, 0, MAX_RULE_XP)) throw new Error(`rules.${k}.xp must be a whole number from 0 to ${MAX_RULE_XP}.`);
      if (r.enabled !== undefined && typeof r.enabled !== "boolean") throw new Error(`rules.${k}.enabled must be true or false.`);
      if (r.dailyCap !== undefined && r.dailyCap !== null && !isInt(r.dailyCap, 0, 1_000_000)) throw new Error(`rules.${k}.dailyCap must be empty or a whole number from 0 to 1,000,000.`);
    }
  }
  if (p.ranks !== undefined) {
    if (!Array.isArray(p.ranks) || p.ranks.length < 1 || p.ranks.length > 20) throw new Error("ranks must be a list of 1-20 ranks.");
    const ids = new Set<string>();
    let prev = 0;
    for (const r of p.ranks) {
      if (!isObj(r) || typeof r.id !== "string" || !ID_RE.test(r.id)) throw new Error("Every rank needs an id (2-40 letters, digits, _ or -).");
      if (ids.has(r.id)) throw new Error(`Rank id "${r.id}" is used twice.`);
      ids.add(r.id);
      if (typeof r.name !== "string" || !r.name.trim() || r.name.length > 40) throw new Error(`Rank "${r.id}": name is required (max 40).`);
      if (!isInt(r.minLevel, 1, maxLevel)) throw new Error(`Rank "${r.id}": minLevel must be 1-${maxLevel}.`);
      if (r.minLevel <= prev) throw new Error("Ranks must be ordered by strictly increasing minLevel.");
      prev = r.minLevel;
      if (typeof r.icon !== "string" || r.icon.length > 40) throw new Error(`Rank "${r.id}": icon is required.`);
      if (typeof r.color !== "string" || !/^#[0-9a-f]{6}$/i.test(r.color)) throw new Error(`Rank "${r.id}": color must be #RRGGBB.`);
    }
    if (p.ranks[0].minLevel !== 1) throw new Error("The first rank must start at level 1.");
  }
  if (p.milestones !== undefined) {
    if (!Array.isArray(p.milestones) || p.milestones.length > 200) throw new Error("milestones must be a list of at most 200.");
    const levels = new Set<number>();
    for (const ms of p.milestones) {
      if (!isObj(ms) || !isInt(ms.level, 1, maxLevel)) throw new Error(`Every milestone needs a level from 1 to ${maxLevel}.`);
      if (levels.has(ms.level)) throw new Error(`Two milestones use level ${ms.level}.`);
      levels.add(ms.level);
      if (typeof ms.title !== "string" || !ms.title.trim() || ms.title.length > 60) throw new Error(`Milestone ${ms.level}: title is required (max 60).`);
      if (typeof ms.description !== "string" || ms.description.length > 200) throw new Error(`Milestone ${ms.level}: description max 200 characters.`);
      if (!Array.isArray(ms.items) || ms.items.length > 10 || !ms.items.every((i: unknown) => typeof i === "string" && ID_RE.test(i))) {
        throw new Error(`Milestone ${ms.level}: items must be up to 10 catalog item ids.`);
      }
      if (ms.feature !== null && ms.feature !== undefined && (typeof ms.feature !== "string" || !ID_RE.test(ms.feature))) {
        throw new Error(`Milestone ${ms.level}: feature must be empty or an id.`);
      }
      if (!isInt(ms.coins ?? 0, 0, 100_000)) throw new Error(`Milestone ${ms.level}: coins must be a whole number from 0 to 100,000.`);
    }
  }
  if (p.quests !== undefined) {
    if (!Array.isArray(p.quests) || p.quests.length > 30) throw new Error("quests must be a list of at most 30.");
    const ids = new Set<string>();
    for (const q of p.quests) {
      if (!isObj(q) || typeof q.id !== "string" || !ID_RE.test(q.id)) throw new Error("Every quest needs an id (2-40 letters, digits, _ or -).");
      if (ids.has(q.id)) throw new Error(`Quest id "${q.id}" is used twice.`);
      ids.add(q.id);
      if (typeof q.title !== "string" || !q.title.trim() || q.title.length > 80) throw new Error(`Quest "${q.id}": title is required (max 80).`);
      if (q.period !== "week" && q.period !== "month") throw new Error(`Quest "${q.id}": period must be week or month.`);
      if (!QUEST_METRICS.includes(q.metric)) throw new Error(`Quest "${q.id}": metric must be ${QUEST_METRICS.join(", ")}.`);
      if (!isInt(q.target, 1, 100_000)) throw new Error(`Quest "${q.id}": target must be 1-100,000.`);
      if (!isInt(q.xp, 0, MAX_RULE_XP)) throw new Error(`Quest "${q.id}": xp must be 0-${MAX_RULE_XP}.`);
      if (!isInt(q.minLevel ?? 1, 1, maxLevel)) throw new Error(`Quest "${q.id}": minLevel must be 1-${maxLevel}.`);
      if (q.enabled !== undefined && typeof q.enabled !== "boolean") throw new Error(`Quest "${q.id}": enabled must be true or false.`);
    }
  }
  if (p.pinnedLimit !== undefined && !isInt(p.pinnedLimit, 0, 12)) throw new Error("pinnedLimit must be 0-12.");
  if (p.rewardBudgetId !== undefined && p.rewardBudgetId !== null && (typeof p.rewardBudgetId !== "string" || p.rewardBudgetId.length > 128)) {
    throw new Error("rewardBudgetId must be empty or a budget id.");
  }
  if (p.velocityFlagEvents !== undefined && !isInt(p.velocityFlagEvents, 1, 1_000_000)) throw new Error("velocityFlagEvents must be 1-1,000,000.");
}

export interface Progression {
  settings: GamificationSettings;
  cfg: ProgressionConfig;
  curve: LevelCurve;
}

/** Settings row + progression config + level curve, from one cached read. */
export async function getProgression(env: Env): Promise<Progression> {
  const settings = await getSettings(env);
  const cfg = sanitizeProgression((settings as any).progression);
  return { settings, cfg, curve: { xpThreshold: settings.xpThreshold, xpIncrement: settings.xpIncrement, maxLevel: cfg.maxLevel } };
}

/** True when this user sees the new experience. */
export function experienceOn(cfg: ProgressionConfig, uid: string | null | undefined): boolean {
  return cfg.enabled || (!!uid && cfg.betaUids.includes(uid));
}

/** Milestones at or below `level`, sorted. */
export function milestonesUpTo(cfg: ProgressionConfig, level: number): Milestone[] {
  return cfg.milestones.filter((x) => x.level <= level).sort((a, b) => a.level - b.level);
}

/** Highest unlocked feature keys for gating (e.g. "advanced_insights"). */
export function unlockedFeatures(cfg: ProgressionConfig, level: number): Set<string> {
  return new Set(milestonesUpTo(cfg, level).map((x) => x.feature).filter((f): f is string => !!f));
}

/** Level at which a feature unlocks, or null when no milestone gates it. */
export function featureLevel(cfg: ProgressionConfig, feature: string): number | null {
  const ms = cfg.milestones.find((x) => x.feature === feature);
  return ms ? ms.level : null;
}

/**
 * Level-based tournament eligibility (contests.min_level / max_level). Checked
 * on the server before any entry fee moves. It only decides who may ENTER: it
 * never changes vote weight, matchmaking, fees, prizes or any other check.
 */
export async function assertLevelEligible(
  env: Env,
  contest: { minLevel?: number | null; maxLevel?: number | null } | null | undefined,
  xp: number | null | undefined,
): Promise<void> {
  if (!contest || (contest.minLevel == null && contest.maxLevel == null)) return;
  const { curve } = await getProgression(env);
  const level = levelFor(Number(xp) || 0, curve);
  if (contest.minLevel != null && level < contest.minLevel) {
    throw httpsError("failed-precondition", `This contest is for level ${contest.minLevel}+ players. You are level ${level}.`, "level_too_low");
  }
  if (contest.maxLevel != null && level > contest.maxLevel) {
    throw httpsError("failed-precondition", `This contest is for players up to level ${contest.maxLevel}. You are level ${level}.`, "level_too_high");
  }
}
