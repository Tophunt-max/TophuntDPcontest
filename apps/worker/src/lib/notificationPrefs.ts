/**
 * Notification categories, user preferences and quiet hours.
 *
 * The app emits ~40 distinct notification `type` strings and, until now, users
 * had no way to mute any of them. Grouping them into four categories gives a
 * settings screen that stays small as new types are added.
 *
 * ## Design rule: preferences gate PUSH, never the in-app row
 *
 * `createNotification` ALWAYS writes the notification row. Preferences and quiet
 * hours only decide whether an OS push is delivered. Two reasons:
 *
 *  - the notification centre stays a complete history, so nothing is silently
 *    lost and a user who re-enables a category does not have a mysterious gap;
 *  - it removes the "I muted notifications and then missed my withdrawal being
 *    paid" failure mode, which matters because `wallet` covers real money.
 */

export type NotificationCategory = "social" | "contest" | "wallet" | "admin";

/**
 * type -> category. Anything not listed falls back to `social`, which is the
 * most conservative choice: it is the category users are most likely to have
 * muted, so an unmapped new type errs towards silence rather than spam.
 *
 * Keep in sync with `apps/expo/src/services/notifications/notificationMeta.ts`.
 */
const CATEGORY_BY_TYPE: Record<string, NotificationCategory> = {
  // --- social ---
  follow: "social",
  profile_visit: "social",
  like: "social",
  match_like: "social",
  comment: "social",
  match_comment: "social",
  reaction: "social",
  share: "social",
  message: "social",

  // --- contest ---
  vote: "contest",
  photo: "contest",
  video_ready: "contest",
  match_status: "contest",
  contest_match_live: "contest",
  contest_announcement: "contest",
  contest_entry_fee: "contest",
  "contest-win": "contest",
  "contest-loss": "contest",
  "contest-tie": "contest",
  "contest-refund": "contest",
  "contest-ending": "contest",
  "hall-of-fame": "contest",
  monthly_hall_of_fame_reward: "contest",

  // --- wallet (real money / balances) ---
  purchase: "wallet",
  deposit: "wallet",
  manual_deposit: "wallet",
  withdrawal: "wallet",
  withdrawal_hold: "wallet",
  withdrawal_refund: "wallet",
  admin_adjustment: "wallet",
  referral: "wallet",
  referral_bonus: "wallet",
  signup_bonus: "wallet",
  daily_reward: "wallet",
  daily_task: "wallet",
  ad_reward: "wallet",

  // --- admin / marketing ---
  admin: "admin",
  event: "admin",
  ad: "admin",
};

export function categoryForType(type: string): NotificationCategory {
  return CATEGORY_BY_TYPE[type] ?? "social";
}

/**
 * Types where many actors act on the SAME target, so they should collapse into
 * one grouped notification ("Asha and 5 others liked your photo") instead of one
 * row and one push per actor.
 *
 * Deliberately excludes everything in `wallet` and every contest RESULT: each of
 * those is a distinct event the user needs to see individually.
 */
const COLLAPSIBLE_TYPES = new Set<string>([
  "like",
  "match_like",
  "comment",
  "match_comment",
  "reaction",
  "share",
  "vote",
  "follow",
  "profile_visit",
]);

export function isCollapsibleType(type: string): boolean {
  return COLLAPSIBLE_TYPES.has(type);
}

export interface NotificationPrefs {
  social: boolean;
  contest: boolean;
  wallet: boolean;
  admin: boolean;
  /** Master push switch. In-app rows are still written when false. */
  push: boolean;
  /** Local hour 0-23 when quiet hours begin (inclusive). */
  quietStart: number | null;
  /** Local hour 0-23 when quiet hours end (exclusive). */
  quietEnd: number | null;
  /** Minutes to add to UTC for the user's local time (IST = 330). */
  utcOffsetMinutes: number;
}

/** Everything on, no quiet hours, UTC. Absent keys mean "enabled". */
export const DEFAULT_PREFS: NotificationPrefs = {
  social: true,
  contest: true,
  wallet: true,
  admin: true,
  push: true,
  quietStart: null,
  quietEnd: null,
  utcOffsetMinutes: 0,
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Hour in 0-23, or null. */
function hour(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : null;
}

/** Parse the stored JSON into a fully-populated prefs object. */
export function resolvePrefs(raw: unknown): NotificationPrefs {
  if (!raw || typeof raw !== "object") return DEFAULT_PREFS;
  const p = raw as Record<string, unknown>;
  const offset = Number(p.utcOffsetMinutes);
  return {
    social: bool(p.social, true),
    contest: bool(p.contest, true),
    wallet: bool(p.wallet, true),
    admin: bool(p.admin, true),
    push: bool(p.push, true),
    quietStart: hour(p.quietStart),
    quietEnd: hour(p.quietEnd),
    // Clamp to the real range of world offsets (-12:00 .. +14:00).
    utcOffsetMinutes:
      Number.isFinite(offset) && offset >= -720 && offset <= 840 ? Math.trunc(offset) : 0,
  };
}

/** Serialize only what differs from the defaults, so rows stay small. */
export function serializePrefs(prefs: NotificationPrefs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!prefs.social) out.social = false;
  if (!prefs.contest) out.contest = false;
  if (!prefs.wallet) out.wallet = false;
  if (!prefs.admin) out.admin = false;
  if (!prefs.push) out.push = false;
  if (prefs.quietStart !== null) out.quietStart = prefs.quietStart;
  if (prefs.quietEnd !== null) out.quietEnd = prefs.quietEnd;
  if (prefs.utcOffsetMinutes) out.utcOffsetMinutes = prefs.utcOffsetMinutes;
  return out;
}

/**
 * Is the user inside their quiet window right now?
 *
 * Handles windows that wrap midnight (22 -> 7), which is the common case.
 */
export function isInQuietHours(prefs: NotificationPrefs, nowMs: number = Date.now()): boolean {
  const { quietStart, quietEnd } = prefs;
  if (quietStart === null || quietEnd === null) return false;
  if (quietStart === quietEnd) return false; // zero-length window

  const localHour = Math.floor(
    ((nowMs + prefs.utcOffsetMinutes * 60_000) / 3_600_000) % 24,
  );
  const h = ((localHour % 24) + 24) % 24;

  return quietStart < quietEnd
    ? h >= quietStart && h < quietEnd // same-day window, e.g. 13 -> 15
    : h >= quietStart || h < quietEnd; // wraps midnight, e.g. 22 -> 7
}

/**
 * Should an OS push be delivered for this notification type?
 *
 * The in-app row is written regardless — see the design rule at the top.
 */
export function shouldSendPush(
  prefs: NotificationPrefs,
  type: string,
  nowMs: number = Date.now(),
): boolean {
  if (!prefs.push) return false;
  if (!prefs[categoryForType(type)]) return false;
  if (isInQuietHours(prefs, nowMs)) return false;
  return true;
}
