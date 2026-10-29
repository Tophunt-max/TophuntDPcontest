/**
 * Creator insights: the caller's OWN contest history, aggregated from data the
 * platform actually records. Nothing is estimated or invented, and nothing
 * about an opponent is returned beyond what the battle already showed publicly
 * (we read only the caller's own side of each battle).
 *
 * Gated by level milestones: the summary at `stats_summary` (level 10 by
 * default), trends at `advanced_insights` (level 30). Locked sections come back
 * as `null` with the level that unlocks them.
 */
import type { Env } from "../types";
import { ENTRY_MATCH_JOIN, ENTRY_ROWS, profileComplete } from "./achievements";
import { featureLevel, levelFor, type Progression } from "./progression";
import { weekPeriod } from "./quests";

const MAX_ENTRIES = 500;
const DAY_MS = 86_400_000;

interface EntryRow {
  id: string;
  type: string | null;
  status: string;
  winner_uid: string | null;
  user_a: string | null;
  user_b: string | null;
  created: number;
}

const sideOf = (row: EntryRow, uid: string): any => {
  for (const raw of [row.user_a, row.user_b]) {
    try {
      const s = raw ? JSON.parse(raw) : null;
      if (s?.uid === uid) return s;
    } catch {
      /* skip */
    }
  }
  return null;
};

export async function creatorInsights(env: Env, uid: string, p: Progression) {
  const user = await env.DB.prepare(
    `SELECT xp, profile_image_url, full_name, username, bio, followers_count FROM users WHERE uid = ?`,
  ).bind(uid).first<any>();
  if (!user) return null;
  const level = levelFor(user.xp ?? 0, p.curve);
  const summaryAt = featureLevel(p.cfg, "stats_summary") ?? 1;
  const advancedAt = featureLevel(p.cfg, "advanced_insights") ?? 1;

  const checklist = [
    { id: "photo", label: "Add a profile photo", done: !!String(user.profile_image_url ?? "").trim() },
    { id: "name", label: "Add your name", done: !!String(user.full_name ?? "").trim() },
    { id: "username", label: "Choose a username", done: !!String(user.username ?? "").trim() },
    { id: "bio", label: "Write a short bio", done: !!String(user.bio ?? "").trim() },
  ];

  const base = { level, checklist, profileComplete: profileComplete(user), summaryUnlocksAt: summaryAt, advancedUnlocksAt: advancedAt };
  if (level < summaryAt) return { ...base, summary: null, trends: null, tips: tipsFor(null, checklist) };

  const rows = await env.DB.prepare(
    `SELECT m.id, m.type, m.status, m.winner_uid, m.user_a, m.user_b, t.created_at AS created
       FROM coin_transactions t ${ENTRY_MATCH_JOIN}
      WHERE t.uid = ? AND ${ENTRY_ROWS}
      ORDER BY t.created_at DESC LIMIT ${MAX_ENTRIES}`,
  ).bind(uid).all<EntryRow>();
  const entries = rows.results ?? [];
  const votesCast = await env.DB.prepare(`SELECT COUNT(*) AS n FROM votes WHERE voter_uid = ?`).bind(uid).first<{ n: number }>();

  const byType = { photo: { entries: 0, wins: 0 }, video: { entries: 0, wins: 0 } };
  let wins = 0, losses = 0, ties = 0, cancelled = 0, live = 0, votesReceived = 0, finished = 0;
  for (const e of entries) {
    const t = e.type === "video" ? "video" : "photo";
    byType[t].entries++;
    const mine = sideOf(e, uid);
    if (e.status === "cancelled") cancelled++;
    else if (e.status === "completed" || e.status === "ended") {
      finished++;
      votesReceived += Number(mine?.votes) || 0;
      if (e.winner_uid === uid) { wins++; byType[t].wins++; }
      else if (e.winner_uid) losses++;
      else ties++;
    } else live++;
  }
  const summary = {
    entries: entries.length,
    entriesCapped: entries.length >= MAX_ENTRIES,
    finished,
    wins,
    losses,
    ties,
    cancelled,
    live,
    winRate: finished ? Math.round((wins / finished) * 1000) / 10 : null,
    votesReceived,
    avgVotesPerBattle: finished ? Math.round((votesReceived / finished) * 10) / 10 : null,
    votesCast: Number(votesCast?.n || 0),
    photo: byType.photo,
    video: byType.video,
  };

  let trends: { weekStart: number; xp: number; entries: number; wins: number }[] | null = null;
  if (level >= advancedAt) {
    const now = Date.now();
    const off = p.settings.dayResetOffsetMinutes;
    const weeks = Array.from({ length: 8 }, (_, i) => weekPeriod(now - (7 - i) * 7 * DAY_MS, off));
    const xpRows = await env.DB.prepare(
      `SELECT day, SUM(xp) AS xp FROM user_xp_daily WHERE uid = ? AND day BETWEEN ? AND ? AND action <> 'admin_adjustment' GROUP BY day`,
    ).bind(uid, weeks[0].startDay, weeks[7].endDay).all<{ day: number; xp: number }>();
    trends = weeks.map((w) => ({
      weekStart: w.startMs,
      xp: (xpRows.results ?? []).filter((r) => r.day >= w.startDay && r.day <= w.endDay).reduce((a, r) => a + Number(r.xp), 0),
      entries: entries.filter((e) => e.created >= w.startMs && e.created < w.endMs).length,
      wins: entries.filter((e) => e.created >= w.startMs && e.created < w.endMs && e.winner_uid === uid).length,
    }));
  }
  return { ...base, summary, trends, tips: tipsFor(summary, checklist) };
}

/** Plain, data-backed suggestions. Each one names the number it is based on. */
function tipsFor(summary: any, checklist: { done: boolean; label: string }[]): string[] {
  const tips: string[] = [];
  const todo = checklist.filter((c) => !c.done);
  if (todo.length) tips.push(`Complete your profile: ${todo.map((t) => t.label.toLowerCase()).join(", ")}.`);
  if (!summary) return tips;
  if (summary.entries === 0) tips.push("Enter your first battle to start building your record.");
  if (summary.cancelled > 0 && summary.cancelled >= summary.finished) {
    tips.push(`${summary.cancelled} of your battles were cancelled (no opponent or too few votes). Sharing your battle link brings in voters.`);
  }
  if (summary.photo.entries >= 3 && summary.video.entries === 0) tips.push("You've only entered photo battles. Try a video battle too.");
  if (summary.video.entries >= 3 && summary.photo.entries === 0) tips.push("You've only entered video battles. Try a photo battle too.");
  if (summary.votesCast < 10) tips.push("Voting in other battles is a good way to see what wins.");
  return tips.slice(0, 4);
}
