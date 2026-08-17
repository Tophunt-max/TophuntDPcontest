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
  | "profile_visit"
  | "match_like"
  | "match_comment"
  | "contest-win"
  | "contest-loss"
  | "contest-refund"
  | "contest-tie"
  | "purchase"
  | "admin"
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
 * `url` (admin deep-link) always wins when present.
 */
export function getNotificationDestination(
  type: NotificationType | undefined,
  targetId?: string | null,
  url?: string | null,
): string | null {
  if (url) return url;

  switch (type) {
    case "follow":
    case "profile_visit":
      return targetId ? `/profile?userId=${targetId}` : "/profile";

    // Post permalinks live at the root-level app/[slug].tsx route.
    case "like":
    case "comment":
      return targetId ? `/${targetId}` : null;

    // Battle/match engagement — no standalone match detail route exists yet,
    // so send the user to the live battles feed on home.
    case "match_like":
    case "match_comment":
    case "match":
    case "contest":
    case "contest-win":
    case "contest-loss":
      return "/home";

    // Wallet-affecting events open the wallet.
    case "contest-refund":
    case "contest-tie":
    case "purchase":
      return "/wallet";

    case "admin":
      return null; // url already handled above; nothing else to open

    default:
      return null;
  }
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
    case "contest":
    case "match":
      return { label: "Battle", color: "#F97316", icon: "trophy" };
    default:
      return DEFAULT_TAG;
  }
}
