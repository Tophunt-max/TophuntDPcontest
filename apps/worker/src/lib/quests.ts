/**
 * Weekly and monthly quests (daily quests are the existing daily tasks, which
 * now also carry XP — see claimDailyTask).
 *
 * Progress is always recounted on the server from authoritative tables for the
 * quest's period. A claim is one D1 batch: an INSERT OR IGNORE on
 * (uid, quest, period) plus the XP award keyed `quest:<id>:<period>:<uid>`, so a
 * double tap or a replay can never pay twice.
 *
 * Periods use the same reward-day boundary as the daily check-in
 * (`dayResetOffsetMinutes`). A week runs Monday to Sunday.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { rewardDayNumber } from "./gamification";
import { ENTRY_MATCH_JOIN, ENTRY_ROWS, VALID_ENTRY_STATUS } from "./achievements";
import { levelFor, type Progression, type QuestDef } from "./progression";
import { xpAwardStatements, xpEventOutcome } from "./xpService";

const DAY_MS = 86_400_000;

export interface Period {
  key: string;
  startDay: number;
  endDay: number;
  startMs: number;
  endMs: number;
}

export function weekPeriod(ts: number, offsetMinutes: number): Period {
  const day = rewardDayNumber(ts, offsetMinutes);
  // Reward day 0 is Thursday 1970-01-01; +3 makes weeks start on Monday.
  const w = Math.floor((day + 3) / 7);
  const startDay = w * 7 - 3;
  return periodOf(`w${w}`, startDay, startDay + 6, offsetMinutes);
}

export function monthPeriod(ts: number, offsetMinutes: number): Period {
  const day = rewardDayNumber(ts, offsetMinutes);
  const local = new Date(day * DAY_MS);
  const y = local.getUTCFullYear();
  const mo = local.getUTCMonth();
  const startDay = Date.UTC(y, mo, 1) / DAY_MS;
  const endDay = Date.UTC(y, mo + 1, 1) / DAY_MS - 1;
  return periodOf(`m${y}-${String(mo + 1).padStart(2, "0")}`, startDay, endDay, offsetMinutes);
}

function periodOf(key: string, startDay: number, endDay: number, offsetMinutes: number): Period {
  const off = offsetMinutes * 60_000;
  return { key, startDay, endDay, startMs: startDay * DAY_MS - off, endMs: (endDay + 1) * DAY_MS - off };
}

export function periodFor(quest: Pick<QuestDef, "period">, ts: number, offsetMinutes: number): Period {
  return quest.period === "month" ? monthPeriod(ts, offsetMinutes) : weekPeriod(ts, offsetMinutes);
}

/** Server-side progress for one quest metric over a period. */
export async function questProgress(env: Env, uid: string, metric: QuestDef["metric"], period: Period): Promise<number> {
  let row: { n: number | null } | null = null;
  switch (metric) {
    case "votes":
      row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM votes WHERE voter_uid = ? AND created_at >= ? AND created_at < ?`)
        .bind(uid, period.startMs, period.endMs).first();
      break;
    case "entries":
      row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM coin_transactions t ${ENTRY_MATCH_JOIN}
          WHERE t.uid = ? AND ${ENTRY_ROWS} AND ${VALID_ENTRY_STATUS} AND t.created_at >= ? AND t.created_at < ?`,
      ).bind(uid, period.startMs, period.endMs).first();
      break;
    case "wins":
    case "checkins":
      row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM user_xp_events e
          WHERE e.uid = ? AND e.action = ? AND e.created_at >= ? AND e.created_at < ?
            AND NOT EXISTS (SELECT 1 FROM user_xp_events r WHERE r.reverses = e.id)`,
      ).bind(uid, metric === "wins" ? "match_win" : "daily_checkin", period.startMs, period.endMs).first();
      break;
    case "active_days":
      row = await env.DB.prepare(
        `SELECT COUNT(DISTINCT day) AS n FROM user_xp_daily
          WHERE uid = ? AND day BETWEEN ? AND ? AND xp > 0 AND action NOT IN ('admin_adjustment', 'reversal')`,
      ).bind(uid, period.startDay, period.endDay).first();
      break;
    case "xp":
      row = await env.DB.prepare(
        `SELECT COALESCE(SUM(xp), 0) AS n FROM user_xp_daily
          WHERE uid = ? AND day BETWEEN ? AND ? AND action NOT IN ('admin_adjustment', 'quest')`,
      ).bind(uid, period.startDay, period.endDay).first();
      break;
  }
  return Math.max(0, Number(row?.n || 0));
}

export interface QuestView {
  id: string;
  title: string;
  period: "week" | "month";
  metric: QuestDef["metric"];
  target: number;
  progress: number;
  xp: number;
  claimed: boolean;
  claimable: boolean;
  locked: boolean;
  minLevel: number;
  resetsAt: number;
}

export async function listQuests(env: Env, uid: string, p: Progression, xp: number, ts = Date.now()): Promise<QuestView[]> {
  const off = p.settings.dayResetOffsetMinutes;
  const level = levelFor(xp, p.curve);
  const quests = p.cfg.quests.filter((q) => q.enabled !== false);
  const claimed = await env.DB.prepare(`SELECT quest_id, period_key FROM quest_claims WHERE uid = ?
      AND period_key IN (?, ?)`).bind(uid, weekPeriod(ts, off).key, monthPeriod(ts, off).key).all<{ quest_id: string; period_key: string }>();
  const done = new Set((claimed.results ?? []).map((r) => `${r.quest_id}|${r.period_key}`));
  const progressCache = new Map<string, number>();
  const out: QuestView[] = [];
  for (const q of quests) {
    const period = periodFor(q, ts, off);
    const locked = level < (q.minLevel ?? 1);
    const ck = `${q.metric}|${period.key}`;
    let progress = 0;
    if (!locked) {
      if (!progressCache.has(ck)) progressCache.set(ck, await questProgress(env, uid, q.metric, period));
      progress = progressCache.get(ck)!;
    }
    const isClaimed = done.has(`${q.id}|${period.key}`);
    out.push({
      id: q.id,
      title: q.title,
      period: q.period,
      metric: q.metric,
      target: q.target,
      progress: Math.min(progress, q.target),
      xp: q.xp,
      claimed: isClaimed,
      claimable: !locked && !isClaimed && progress >= q.target,
      locked,
      minLevel: q.minLevel ?? 1,
      resetsAt: period.endMs,
    });
  }
  return out;
}

export async function claimQuest(env: Env, uid: string, p: Progression, questIdRaw: unknown, ts = Date.now()): Promise<{ xpEarned: number }> {
  const questId = typeof questIdRaw === "string" ? questIdRaw : "";
  const quest = p.cfg.quests.find((q) => q.id === questId && q.enabled !== false);
  if (!quest) throw httpsError("not-found", "Unknown quest.");
  const user = await env.DB.prepare(`SELECT xp FROM users WHERE uid = ?`).bind(uid).first<{ xp: number }>();
  if (!user) throw httpsError("not-found", "User not found.");
  if (levelFor(user.xp ?? 0, p.curve) < (quest.minLevel ?? 1)) {
    throw httpsError("failed-precondition", `This quest unlocks at level ${quest.minLevel}.`);
  }
  const period = periodFor(quest, ts, p.settings.dayResetOffsetMinutes);
  if ((await questProgress(env, uid, quest.metric, period)) < quest.target) {
    throw httpsError("failed-precondition", "Quest not completed yet.");
  }
  const award = xpAwardStatements(env, p, {
    uid,
    action: "quest",
    eventId: `quest:${quest.id}:${period.key}:${uid}`,
    amount: quest.xp,
    sourceType: "quest",
    sourceId: `${quest.id}:${period.key}`,
    ts,
    gate: `EXISTS (SELECT 1 FROM quest_claims WHERE uid = ? AND quest_id = ? AND period_key = ? AND created_at = ?)`,
    gateArgs: [uid, quest.id, period.key, ts],
  });
  const res = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO quest_claims (uid, quest_id, period_key, xp, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(uid, quest.id, period.key, quest.xp, ts),
    ...award.statements,
  ]);
  if (Number(res[0]?.meta?.changes || 0) === 0) throw httpsError("already-exists", "Quest already claimed.");
  const out = award.active ? await xpEventOutcome(env, award.eventId, award.nonce) : { delta: 0 };
  return { xpEarned: out.delta };
}
