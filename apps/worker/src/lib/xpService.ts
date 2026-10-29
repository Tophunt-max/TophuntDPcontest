/**
 * The ONE path that moves `users.xp`.
 *
 * Every XP change is three statements that go into the CALLER's D1 batch (one
 * transaction), so XP is atomic with whatever earned it — the vote flush, the
 * match settlement, the daily check-in, the task claim:
 *
 *   1. INSERT OR IGNORE the `user_xp_events` row. Its id is a deterministic
 *      idempotency key (`vote:<match>:<uid>`, `match_win:<match>`, …), so a
 *      retry, a replayed request or a second resolver can never apply the same
 *      award twice — the PRIMARY KEY refuses it. The XP actually granted
 *      (`delta`) is computed INSIDE this statement: the rule amount, clamped by
 *      what is left of today's cap for that action and by MAX_LIFETIME_XP.
 *      Computing it in SQL is what makes two concurrent awards against the same
 *      cap exact: D1 serialises the transactions, the second one sees the
 *      first one's daily row.
 *   2. UPDATE users.xp by that delta — only if THIS attempt wrote the event
 *      (matched by a per-attempt nonce).
 *   3. UPSERT `user_xp_daily`, the per-day counter the caps and the period
 *      leaderboards read.
 *
 * A caller-supplied `gate` (SQL) is added to statement 1 only. Statements 2 and
 * 3 key off the event row, so they apply exactly when statement 1 did.
 *
 * Reversals are new rows pointing at the original (`reverses`, unique), never
 * edits or deletes, so XP history is append-only.
 *
 * Amounts never come from a client: callers pass an action, and the amount is
 * the configured rule (or, for tasks / quests / achievements / admin, a value
 * the server read from its own config).
 */
import type { Env } from "../types";
import { rewardDayNumber } from "./gamification";
import {
  getProgression,
  MAX_LIFETIME_XP,
  MAX_RULE_XP,
  type ConfigurableXpAction,
  type Progression,
  type XpAction,
} from "./progression";

export interface XpAwardInput {
  uid: string;
  action: XpAction;
  /** Deterministic idempotency key. */
  eventId: string;
  /**
   * Amount for actions whose XP is not a fixed rule (daily_task, quest,
   * achievement, admin_adjustment). Ignored for fixed-rule actions. Never a
   * client value.
   */
  amount?: number;
  sourceType?: string | null;
  sourceId?: string | null;
  reason?: string | null;
  actor?: string | null;
  ts: number;
  /** Extra SQL condition on the event insert (e.g. the settlement claim). */
  gate?: string;
  gateArgs?: unknown[];
}

export interface XpStatements {
  statements: D1PreparedStatement[];
  eventId: string;
  nonce: string;
  /** False when the rule is disabled or the amount is 0: no statements. */
  active: boolean;
}

const VARIABLE_AMOUNT: ReadonlySet<XpAction> = new Set(["daily_task", "quest", "achievement", "admin_adjustment"]);

/** Resolve the amount and cap for an award. */
function resolve(p: Progression, input: XpAwardInput): { amount: number; cap: number | null } {
  if (input.action === "admin_adjustment") {
    const a = Math.trunc(Number(input.amount) || 0);
    return { amount: a, cap: null };
  }
  const rule = p.cfg.rules[input.action as ConfigurableXpAction];
  if (!rule || !rule.enabled) return { amount: 0, cap: null };
  const raw = VARIABLE_AMOUNT.has(input.action) ? Number(input.amount) || 0 : rule.xp;
  const amount = Math.max(0, Math.min(MAX_RULE_XP, Math.trunc(raw)));
  return { amount, cap: rule.dailyCap };
}

/**
 * Statements for one XP award. Put them in the same batch as the event that
 * earned it, AFTER any statement the gate depends on.
 */
export function xpAwardStatements(env: Env, p: Progression, input: XpAwardInput): XpStatements {
  const nonce = crypto.randomUUID();
  const { amount, cap } = resolve(p, input);
  if (amount === 0) return { statements: [], eventId: input.eventId, nonce, active: false };
  const day = rewardDayNumber(input.ts, p.settings.dayResetOffsetMinutes);
  const gate = input.gate ? `AND (${input.gate})` : "";
  const curXp = `COALESCE((SELECT xp FROM users WHERE uid = ?), 0)`;

  let deltaSql: string;
  let deltaArgs: unknown[];
  if (amount > 0) {
    // Room left under the cap and under the lifetime ceiling.
    const capRoom = cap === null
      ? ""
      : `, ? - COALESCE((SELECT xp FROM user_xp_daily WHERE uid = ? AND day = ? AND action = ?), 0)`;
    deltaSql = `MAX(0, MIN(?, ${MAX_LIFETIME_XP} - ${curXp}${capRoom}))`;
    deltaArgs = [amount, input.uid, ...(cap === null ? [] : [cap, input.uid, day, input.action])];
  } else {
    // Negative admin adjustment: never below zero.
    deltaSql = `-MIN(?, ${curXp})`;
    deltaArgs = [-amount, input.uid];
  }

  const insert = env.DB.prepare(
    `INSERT OR IGNORE INTO user_xp_events
       (id, uid, action, delta, requested, day, source_type, source_id, rule_version, reason, actor, nonce, created_at)
     SELECT ?, ?, ?, ${deltaSql}, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM users WHERE uid = ?) ${gate}`,
  ).bind(
    input.eventId,
    input.uid,
    input.action,
    ...deltaArgs,
    amount,
    day,
    input.sourceType ?? null,
    input.sourceId ?? null,
    p.cfg.version,
    input.reason ? String(input.reason).slice(0, 500) : null,
    input.actor ?? null,
    nonce,
    input.ts,
    input.uid,
    ...(input.gateArgs ?? []),
  );
  return {
    statements: [insert, ...applyStatements(env, input.eventId, nonce, input.ts)],
    eventId: input.eventId,
    nonce,
    active: true,
  };
}

/** Move users.xp and the daily counter by the event this attempt wrote. */
function applyStatements(env: Env, eventId: string, nonce: string, ts: number, dailyAction?: "original"): D1PreparedStatement[] {
  const mine = `SELECT 1 FROM user_xp_events WHERE id = ? AND nonce = ?`;
  return [
    env.DB.prepare(
      `UPDATE users
          SET xp = MIN(${MAX_LIFETIME_XP}, MAX(0, COALESCE(xp, 0) + (SELECT delta FROM user_xp_events WHERE id = ? AND nonce = ?))),
              updated_at = ?
        WHERE uid = (SELECT uid FROM user_xp_events WHERE id = ? AND nonce = ?)
          AND EXISTS (${mine} AND delta <> 0)`,
    ).bind(eventId, nonce, ts, eventId, nonce, eventId, nonce),
    dailyAction === "original"
      ? env.DB.prepare(
          `INSERT INTO user_xp_daily (uid, day, action, xp, events)
           SELECT r.uid, r.day, o.action, r.delta, 0
             FROM user_xp_events r JOIN user_xp_events o ON o.id = r.reverses
            WHERE r.id = ? AND r.nonce = ?
           ON CONFLICT (uid, day, action) DO UPDATE SET xp = xp + excluded.xp`,
        ).bind(eventId, nonce)
      : env.DB.prepare(
          `INSERT INTO user_xp_daily (uid, day, action, xp, events)
           SELECT uid, day, action, delta, 1 FROM user_xp_events WHERE id = ? AND nonce = ?
           ON CONFLICT (uid, day, action) DO UPDATE SET xp = xp + excluded.xp, events = events + 1`,
        ).bind(eventId, nonce),
  ];
}

export interface XpReversalInput {
  /** The event being reversed. */
  originalId: string;
  reason: string;
  actor?: string | null;
  ts: number;
  gate?: string;
  gateArgs?: unknown[];
}

/** Deterministic id of the reversal of `originalId` (one reversal per event). */
export const reversalId = (originalId: string) => `reversal:${originalId}`;

/**
 * Statements that reverse a positive XP event: a new `reversal` row for
 * -min(original delta, current XP), so XP never goes negative. A no-op if the
 * original does not exist, granted nothing, or was already reversed. The day
 * counter of the ORIGINAL action and day is reduced, so period leaderboards
 * lose the reversed XP from the period that earned it.
 */
export function xpReversalStatements(env: Env, input: XpReversalInput): D1PreparedStatement[] {
  const id = reversalId(input.originalId);
  const nonce = crypto.randomUUID();
  const gate = input.gate ? `AND (${input.gate})` : "";
  return [
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_xp_events
         (id, uid, action, delta, requested, day, source_type, source_id, rule_version, reverses, reason, actor, nonce, created_at)
       SELECT ?, o.uid, 'reversal', -MIN(o.delta, COALESCE((SELECT xp FROM users u WHERE u.uid = o.uid), 0)), -o.delta,
              o.day, o.source_type, o.source_id, o.rule_version, o.id, ?, ?, ?, ?
         FROM user_xp_events o
        WHERE o.id = ? AND o.delta > 0 AND o.reverses IS NULL ${gate}`,
    ).bind(id, String(input.reason).slice(0, 500), input.actor ?? null, nonce, input.ts, input.originalId, ...(input.gateArgs ?? [])),
    ...applyStatements(env, id, nonce, input.ts, "original"),
  ];
}

/** Read back what an award did after its batch ran. */
export async function xpEventOutcome(env: Env, eventId: string, nonce: string): Promise<{ applied: boolean; delta: number }> {
  const row = await env.DB.prepare(`SELECT delta, nonce FROM user_xp_events WHERE id = ?`).bind(eventId).first<{ delta: number; nonce: string | null }>();
  if (!row || row.nonce !== nonce) return { applied: false, delta: 0 };
  return { applied: true, delta: Number(row.delta) };
}

/** Award on its own (not part of another batch). */
export async function awardXp(env: Env, input: XpAwardInput, p?: Progression): Promise<{ applied: boolean; delta: number }> {
  const prog = p ?? (await getProgression(env));
  const s = xpAwardStatements(env, prog, input);
  if (!s.active) return { applied: false, delta: 0 };
  await env.DB.batch(s.statements);
  return xpEventOutcome(env, s.eventId, s.nonce);
}

/** Reverse on its own. Returns the (negative) delta applied, or null if nothing was reversed. */
export async function reverseXp(env: Env, input: XpReversalInput): Promise<number | null> {
  await env.DB.batch(xpReversalStatements(env, input));
  const row = await env.DB.prepare(`SELECT delta, created_at FROM user_xp_events WHERE id = ?`)
    .bind(reversalId(input.originalId))
    .first<{ delta: number; created_at: number }>();
  return row && Number(row.created_at) === input.ts ? Number(row.delta) : null;
}

/**
 * Ledger vs balance check for a set of users: `users.xp` must equal the sum of
 * their events. Returns the mismatches.
 */
export async function reconcileXp(env: Env, uids: string[]): Promise<{ uid: string; xp: number; ledger: number }[]> {
  if (!uids.length) return [];
  const out: { uid: string; xp: number; ledger: number }[] = [];
  for (let i = 0; i < uids.length; i += 50) {
    const chunk = uids.slice(i, i + 50);
    const ph = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT u.uid, COALESCE(u.xp, 0) AS xp,
              COALESCE((SELECT SUM(delta) FROM user_xp_events e WHERE e.uid = u.uid), 0) AS ledger
         FROM users u WHERE u.uid IN (${ph})`,
    ).bind(...chunk).all<{ uid: string; xp: number; ledger: number }>();
    for (const r of rows.results ?? []) {
      if (Number(r.xp) !== Number(r.ledger)) out.push({ uid: r.uid, xp: Number(r.xp), ledger: Number(r.ledger) });
    }
  }
  return out;
}
