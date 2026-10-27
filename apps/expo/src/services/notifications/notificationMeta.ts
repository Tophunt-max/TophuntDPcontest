/**
 * Single source of truth for notification TYPE → (route, badge) mapping.
 *
 * Both the in-app notifications list (app/notifications/index.tsx) and the
 * push-notification tap handler (app/_layout.tsx) use these helpers, so a tap
 * behaves identically whether it happens inside the app or from the OS tray.
 *
 * The `type` strings here are the REAL values written by the Worker's
 * createNotification() call sites (see apps/worker/src/lib/notify.ts and its
 * callers) — not the older/looser client union. Keep this in sync with the
 * backend: adding a new notification type means adding it here too.
 */

/** All notification type strings the backend can emit (+ legacy aliases). */
export type NotificationType =
  | "follow"
  | "follow_request"
  | "follow_accept"
  | "profile_visit"
  | "match_like"
  | "match_comment"
  | "contest-win"
  | "contest-loss"
  | "contest-refund"
  | "contest-tie"
  | "prize-claim"
  | "purchase"
  | "admin"
  | "contest-ending"
  | "report_update"
  // legacy / loose aliases still accepted for safety
  | "like"
  | "comment"
  | "contest"
  | "match"
  | (string & {}); // allow unknown strings without losing autocomplete

export interface NotificationTag {
  label: string;
  /** Accent colour for the pill (text + tinted background). */
  color: string;
  /** Ionicons name (resolved by @/src/lib/icons). */
  icon: string;
}

/**
 * Resolve the in-app route for a notification. Returns a route string that
 * expo-router can push, or null when there's nothing meaningful to open (the
 * caller then falls back to the notifications list).
 *
 * `url` (admin deep-link) wins when present AND it is an in-app route.
 */
export function getNotificationDestination(
  type: NotificationType | undefined,
  targetId?: string | null,
  url?: string | null,
): string | null {
  const deepLink = safeInAppRoute(url);
  if (deepLink) return deepLink;

  switch (type) {
    case "follow":
    case "profile_visit":
    // "X accepted your follow request": open their (now unlocked) profile.
    case "follow_accept":
      return targetId ? `/profile?userId=${encodeURIComponent(targetId)}` : "/profile";

    // "X wants to follow you": the owner's Follow requests list, where it is
    // confirmed or deleted.
    case "follow_request":
      return "/notifications/requests";

    // Post permalinks live at the root-level app/[slug].tsx route.
    case "like":
    case "comment":
      return targetId ? `/${encodeURIComponent(targetId)}` : null;

    // Battle engagement and results open that battle's detail page
    // (app/battle/[id]/index.tsx). `targetId` is the match id on all of these; without
    // one there is nothing specific to open, so the feed.
    case "match_like":
    case "match_comment":
    case "match":
    // "Battle ending soon" / "Last chance to vote" (cron): open the battle to vote.
    case "contest-ending":
      return targetId ? `/battle/${encodeURIComponent(targetId)}` : "/home";

    // "Update on your report": the reporter's own list of reports and outcomes.
    case "report_update":
      return "/setting/reports";
    // The result itself: straight to the winner page (app/battle/[id]/result.tsx).
    case "contest-win":
    case "contest-loss":
      return targetId ? `/battle/${encodeURIComponent(targetId)}/result` : "/home";
    case "contest":
      return "/home";

    /**
     * Physical prize won, or a fulfilment step on one. `targetId` is
     * `prize:<matchId>`, and the claim's own id is `prize_claim:<matchId>`, so the
     * match id is the addressable part.
     *
     * This is the ONE notification in the app that asks the user to do something
     * before they get what they won, so it deep-links to that specific prize
     * rather than to a list they then have to search.
     */
    case "prize-claim": {
      const matchId = targetId?.startsWith("prize:") ? targetId.slice("prize:".length) : null;
      return matchId ? `/prizes/${matchId}` : "/prizes";
    }

    // Wallet-affecting events open the wallet.
    case "contest-refund":
    case "contest-tie":
    case "purchase":
      return "/wallet";

    // Referral rewards / review / milestones open Refer & Earn.
    case "referral" as NotificationType:
      return "/referral";

    case "admin":
      return null; // url already handled above; nothing else to open

    default:
      return null;
  }
}

/**
 * Accept a push/notification `url` only if it is a path inside this app.
 *
 * The value arrives in the push payload and was handed to `router.push` as-is,
 * so any absolute URL (`https://…`, `intent://…`, `javascript:`) or
 * protocol-relative `//host` in a notification opened whatever it pointed at —
 * a phishing primitive for anyone able to put a payload in front of the device.
 */
export function safeInAppRoute(url?: string | null): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  if (!u.startsWith("/") || u.startsWith("//") || u.includes("\\")) return null;
  if (/[\u0000-\u001f]/.test(u)) return null;
  return u;
}

const DEFAULT_TAG: NotificationTag = { label: "Update", color: "#6B7280", icon: "notifications" };

/**
 * Badge metadata (label + colour + icon) shown as a small pill on each row so
 * the user can tell at a glance what kind of notification it is.
 */
export function getNotificationTag(type: NotificationType | undefined): NotificationTag {
  switch (type) {
    case "follow":
      return { label: "Follow", color: "#3B82F6", icon: "person" };
    case "follow_request":
      return { label: "Request", color: "#3B82F6", icon: "person-add" };
    case "follow_accept":
      return { label: "Accepted", color: "#22C55E", icon: "person" };
    case "profile_visit":
      return { label: "Visit", color: "#6366F1", icon: "eye-outline" };
    case "match_like":
    case "like":
      return { label: "Like", color: "#EF4444", icon: "heart" };
    case "match_comment":
    case "comment":
      return { label: "Comment", color: "#8B5CF6", icon: "chatbubble-outline" };
    case "contest-win":
      return { label: "Win", color: "#22C55E", icon: "trophy" };
    case "prize-claim":
      return { label: "Prize", color: "#8B5CF6", icon: "cube" };
    case "contest-loss":
      return { label: "Result", color: "#F59E0B", icon: "sad-outline" };
    case "contest-refund":
      return { label: "Refund", color: "#14B8A6", icon: "cash-outline" };
    case "contest-tie":
      return { label: "Tie", color: "#64748B", icon: "information-circle-outline" };
    case "purchase":
      return { label: "Purchase", color: "#10B981", icon: "wallet" };
    case "admin":
      return { label: "News", color: "#EC4899", icon: "megaphone" };
    case "report_update":
      return { label: "Safety", color: "#0EA5E9", icon: "shield-checkmark-outline" };
    case "contest-ending":
      return { label: "Ending", color: "#F97316", icon: "time-outline" };
    case "contest":
    case "match":
      return { label: "Battle", color: "#F97316", icon: "trophy" };
    default:
      return DEFAULT_TAG;
  }
}


// ---------------------------------------------------------------------------
// Categories
//
// Mirror of `apps/worker/src/lib/notificationPrefs.ts`. The worker is the
// authority — it decides whether a push is actually sent — but the client needs
// the same mapping for two things: the preferences screen, and picking the
// Android notification channel.
//
// Keep the two in sync when adding a type. An unmapped type falls back to
// "social" on BOTH sides, which is the conservative choice: social is the
// category users are most likely to have muted, so a new type errs towards
// silence rather than spam.
// ---------------------------------------------------------------------------

export type NotificationCategory = "social" | "contest" | "wallet" | "admin";

/**
 * Exported so the parity with the worker's copy is enforced by a test rather
 * than by the comment above — see `test/notificationCategoryParity.test.ts`.
 */
export const CATEGORY_BY_TYPE: Record<string, NotificationCategory> = {
  // social
  follow: "social",
  follow_request: "social",
  follow_accept: "social",
  profile_visit: "social",
  like: "social",
  match_like: "social",
  comment: "social",
  match_comment: "social",
  reaction: "social",
  share: "social",
  message: "social",
  level_up: "social",
  // contest
  vote: "contest",
  photo: "contest",
  video_ready: "contest",
  match_status: "contest",
  contest_match_live: "contest",
  match_active: "contest",
  contest_announcement: "contest",
  contest_entry_fee: "contest",
  "contest-win": "contest",
  "contest-loss": "contest",
  "contest-tie": "contest",
  "contest-refund": "contest",
  "contest-ending": "contest",
  "hall-of-fame": "contest",
  monthly_hall_of_fame_reward: "contest",
  "prize-claim": "contest",
  // wallet
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
  verification_bonus: "wallet",
  daily_reward: "wallet",
  daily_task: "wallet",
  ad_reward: "wallet",
  // admin
  admin: "admin",
  report_update: "admin",
  event: "admin",
  ad: "admin",
};

export function categoryForType(type: string | undefined): NotificationCategory {
  return (type && CATEGORY_BY_TYPE[type]) || "social";
}

/**
 * Android channel id per category. Separate channels are what let a user mute
 * one kind of notification from the OS settings screen — with a single
 * "default" channel it is all-or-nothing.
 *
 * Must match `ANDROID_CHANNEL` in the worker's lib/notify.ts, because the worker
 * stamps `channel_id` onto the FCM payload.
 */
export const ANDROID_CHANNEL_ID: Record<NotificationCategory, string> = {
  social: "social",
  contest: "contest",
  wallet: "wallet",
  admin: "announcements",
};

/** Copy for the preferences screen. */
export interface CategoryMeta {
  key: NotificationCategory;
  title: string;
  description: string;
  icon: string;
}

export const NOTIFICATION_CATEGORIES: CategoryMeta[] = [
  {
    key: "social",
    title: "Likes, comments & follows",
    description: "When someone interacts with you or your posts",
    icon: "heart-outline",
  },
  {
    key: "contest",
    title: "Contests & battles",
    description: "Votes, results and battles ending soon",
    icon: "trophy-outline",
  },
  {
    key: "wallet",
    title: "Diamond, DP coin & payouts",
    description: "Top-ups, withdrawals, rewards and refunds",
    icon: "wallet-outline",
  },
  {
    key: "admin",
    title: "Announcements",
    description: "News and updates from TopHunt",
    icon: "megaphone-outline",
  },
];
