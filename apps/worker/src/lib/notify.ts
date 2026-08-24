/**
 * Notification pipeline.
 *
 * In the Firebase backend notifications came from two places: explicit
 * createNotification() calls and 12 Firestore onDocument triggers. D1 has no
 * triggers, so every notification is now an explicit call from a handler.
 *
 * What `createNotification` does, in order:
 *
 *  1. reads the recipient's push tokens AND preferences in ONE query;
 *  2. writes (or COLLAPSES onto) a row in `notifications`;
 *  3. publishes to the recipient's live WebSocket for instant in-app delivery;
 *  4. sends an OS push — unless preferences, quiet hours or the anti-spam cap
 *     say otherwise.
 *
 * Two invariants worth knowing before changing anything here:
 *
 *  - **The in-app row is always written.** Preferences, quiet hours and rate
 *    limits only suppress the PUSH. That keeps the notification centre a
 *    complete history and avoids "I muted notifications and missed my
 *    withdrawal being paid".
 *  - **Failures never propagate.** A notification is a side effect of some other
 *    action (a like, a payout); it must not fail that action.
 */
import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema, type NotificationActor } from "../db";
import { newId, now } from "./ids";
import { sendFcmToToken } from "./firebaseAdmin";
import { publish } from "./publish";
import { consumeRateLimit } from "./rateLimit";
import { logErrorToDb } from "./observability";
import { isNotificationSuppressed } from "./blocks";
import {
  categoryForType,
  isCollapsibleType,
  resolvePrefs,
  shouldSendPush,
  type NotificationPrefs,
} from "./notificationPrefs";

/**
 * How long a grouped notification keeps absorbing new actors.
 *
 * Generous, because "12 people liked your photo" should keep aggregating for as
 * long as the post is live — but not unbounded, or a stray like months later
 * would resurrect an ancient notification to the top of the list.
 */
const COLLAPSE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Ignore the same actor repeating the same action within this window. This is
 * the idempotency guard: a retried request resolves to the same collapse key and
 * the same actor, and is absorbed instead of double-counted.
 */
const DEDUP_WINDOW_MS = 60 * 1000;

/** How many actors to retain on a row (a few are displayed; the rest aid dedup). */
const MAX_STORED_ACTORS = 10;

/** Anti-spam cap on PUSHES per recipient per type. Rows are still written. */
const PUSH_BURST_MAX = 20;
const PUSH_BURST_WINDOW_SEC = 60;

/**
 * Notification-fatigue cap: total pushes per recipient per day.
 *
 * The burst cap above stops a single spike, but says nothing about a steady drip
 * — a busy account could still be buzzed hundreds of times across a day, which is
 * the fastest way to get notifications disabled at the OS level.
 *
 * `wallet` is EXEMPT (see PUSH_CAP_EXEMPT_CATEGORIES): a payout confirmation or a
 * failed top-up must never be dropped because the user had a popular day.
 */
const PUSH_DAILY_MAX = 40;
const PUSH_DAILY_WINDOW_SEC = 24 * 60 * 60;

/** Categories that bypass the daily fatigue cap. */
const PUSH_CAP_EXEMPT_CATEGORIES = new Set(["wallet"]);

/** Android channel per category, so users can mute a category in OS settings. */
const ANDROID_CHANNEL: Record<string, string> = {
  social: "social",
  contest: "contest",
  wallet: "wallet",
  admin: "announcements",
};

/** Phrasing used when a notification represents multiple actors. */
const GROUPED_PHRASE: Record<string, string> = {
  like: "liked your post",
  match_like: "liked your entry",
  comment: "commented on your post",
  match_comment: "commented on your entry",
  reaction: "reacted to your story",
  share: "shared your post",
  vote: "voted on your entry",
  follow: "started following you",
  profile_visit: "viewed your profile",
};

/**
 * Compose "Asha and 4 others liked your post".
 *
 * Returns null for types with no grouped phrasing, in which case the caller's
 * original body is kept.
 */
function groupedBody(type: string, actors: NotificationActor[], count: number): string | null {
  const phrase = GROUPED_PHRASE[type];
  if (!phrase) return null;

  const first = actors[0]?.username;
  const second = actors[1]?.username;
  if (!first) return null;

  const others = Math.max(count - 1, 0);
  if (others === 0) return `${first} ${phrase}`;
  if (others === 1 && second) return `${first} and ${second} ${phrase}`;
  return `${first} and ${others} others ${phrase}`;
}

// ---------------------------------------------------------------------------
// Retention
//
// `notifications` had no retention at all, so it grew forever. That is a real
// problem rather than just wasted storage: the list query and the polled badge
// count are both scoped per recipient, so a user who accumulates tens of
// thousands of rows makes their own queries progressively slower, and D1 storage
// grows without bound.
//
// Two windows, because "read" and "ignored" are different signals:
//   - anything the user has already opened is safe to drop fairly early;
//   - anything still unopened after six months is not going to be opened.
// ---------------------------------------------------------------------------

/** Drop notifications the user has already opened after this long. */
const READ_RETENTION_MS = 60 * 24 * 60 * 60 * 1000; // 60 days

/** Hard ceiling — drop anything older than this regardless of state. */
const HARD_RETENTION_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

/**
 * Rows deleted per statement.
 *
 * Bounded so a first run against a large backlog cannot blow the cron's time
 * budget — it simply makes progress and the next tick continues. The delete uses
 * a subquery rather than `DELETE ... LIMIT`, which requires SQLite to be built
 * with SQLITE_ENABLE_UPDATE_DELETE_LIMIT and is not something to rely on.
 */
const PRUNE_BATCH = 500;

/** Delete notifications past their retention window. Called from the cron. */
export async function pruneNotifications(env: Env): Promise<void> {
  const nowMs = Date.now();
  const passes: { label: string; sql: string; cutoff: number }[] = [
    {
      label: "read",
      cutoff: nowMs - READ_RETENTION_MS,
      sql:
        "DELETE FROM notifications WHERE id IN (" +
        `SELECT id FROM notifications WHERE read = 1 AND created_at < ? LIMIT ${PRUNE_BATCH})`,
    },
    {
      label: "hard",
      cutoff: nowMs - HARD_RETENTION_MS,
      sql:
        "DELETE FROM notifications WHERE id IN (" +
        `SELECT id FROM notifications WHERE created_at < ? LIMIT ${PRUNE_BATCH})`,
    },
  ];

  for (const pass of passes) {
    try {
      await env.DB.prepare(pass.sql).bind(pass.cutoff).run();
    } catch (e) {
      // Housekeeping must never take the cron down.
      console.error(`[notify] pruneNotifications (${pass.label}) failed (continuing)`, e);
    }
  }
}

export interface NotificationActorInput {
  uid: string;
  username?: string | null;
  avatarUrl?: string | null;
}

export interface NotificationInput {
  title: string;
  body: string;
  type: "like" | "comment" | "follow" | "contest" | "admin" | string;
  targetId: string;
  image?: string;
  data?: Record<string, string>;
  /**
   * Who triggered this. Supplying it enables grouping for collapsible types —
   * without it the notification is written ungrouped, so existing call sites
   * keep their current behaviour until they opt in.
   */
  actor?: NotificationActorInput;
  /** Never collapse this one, even if the type normally would. */
  noCollapse?: boolean;
}

/** The recipient's unread total, for the iOS app-icon badge. */
async function unreadCount(env: Env, uid: string): Promise<number | undefined> {
  try {
    const row = await getDb(env)
      .select({ v: sql<number>`count(*)` })
      .from(schema.notifications)
      .where(and(eq(schema.notifications.recipientId, uid), eq(schema.notifications.read, false)))
      .get();
    return row?.v ?? 0;
  } catch {
    // Omitting the badge leaves the existing one untouched, which is safer than
    // sending a wrong number.
    return undefined;
  }
}

export interface PushOptions {
  badge?: number;
  collapseKey?: string;
  category?: string;
}

/**
 * Deliver an OS push to every registered device for a user.
 *
 * Prunes tokens FCM reports as permanently invalid, retries once on a transient
 * failure, and records anything still failing to `error_logs` — previously a
 * transient 503 silently dropped the notification with no trace.
 */
export async function sendPushNotification(
  env: Env,
  userId: string,
  title: string,
  body: string,
  type: string,
  data: Record<string, string> = {},
  options: PushOptions = {},
): Promise<void> {
  try {
    const db = getDb(env);
    const user = await db
      .select({ fcmTokens: schema.users.fcmTokens })
      .from(schema.users)
      .where(eq(schema.users.uid, userId))
      .get();

    const tokens: string[] = (user?.fcmTokens as string[]) || [];
    if (!tokens.length) return;

    await deliverToTokens(env, userId, tokens, title, body, type, data, options);
  } catch (e) {
    console.error("[notify] push failed", e);
  }
}

/** Shared delivery core, so createNotification does not re-read the token list. */
async function deliverToTokens(
  env: Env,
  userId: string,
  tokens: string[],
  title: string,
  body: string,
  type: string,
  data: Record<string, string>,
  options: PushOptions,
): Promise<void> {
  const androidChannelId = ANDROID_CHANNEL[options.category ?? categoryForType(type)];
  const sendOptions = {
    badge: options.badge,
    collapseKey: options.collapseKey,
    androidChannelId,
  };

  const results = await Promise.all(
    tokens.map(async (t) => {
      let res = await sendFcmToToken(env, t, { title, body }, { type, ...data }, sendOptions);
      // One retry for transient failures (429 / 5xx / UNAVAILABLE). A short
      // delay is enough here — anything longer risks the Worker's time budget.
      if (!res.ok && res.retryable) {
        await new Promise((r) => setTimeout(r, 300));
        res = await sendFcmToToken(env, t, { title, body }, { type, ...data }, sendOptions);
      }
      return res;
    }),
  );

  const validTokens = tokens.filter((_, i) => !results[i].invalid);
  if (validTokens.length !== tokens.length) {
    await getDb(env)
      .update(schema.users)
      .set({ fcmTokens: validTokens })
      .where(eq(schema.users.uid, userId))
      .run();
  }

  // Surface deliveries that failed for a reason OTHER than a dead token, so a
  // systemic FCM/credentials problem is visible instead of silent.
  const hardFailures = results.filter((r) => !r.ok && !r.invalid);
  if (hardFailures.length) {
    await logErrorToDb(
      env,
      new Error(
        `FCM delivery failed for ${hardFailures.length}/${tokens.length} token(s) ` +
          `(type=${type}, statuses=${[...new Set(hardFailures.map((r) => r.status))].join(",")})`,
      ),
      { path: "notify/push" },
    ).catch(() => {});
  }
}

/**
 * Write a notification and deliver it.
 *
 * For collapsible types with an `actor`, this may UPDATE an existing row instead
 * of inserting — see COLLAPSE_WINDOW_MS. Note that collapsing bumps
 * `created_at`, which is what makes the regrouped notification rise back to the
 * top of the list (the list orders and paginates by `created_at`).
 */
export async function createNotification(
  env: Env,
  recipientId: string,
  n: NotificationInput,
): Promise<void> {
  if (!recipientId) return;
  // Never notify someone about their own action.
  if (n.actor?.uid && n.actor.uid === recipientId) return;

  // Blocked or muted: drop the notification entirely — including the in-app row.
  //
  // This is the one deliberate exception to the "the in-app row is always
  // written" invariant above. That invariant exists so a user who silenced
  // pushes still has a complete history; it does not extend to someone they
  // asked never to hear from again. Writing the row would leave the blocked
  // user's name sitting in the notification centre, which is precisely the
  // outcome the block was meant to prevent.
  //
  // Placing the check here rather than at each call site covers every
  // `createNotification` caller at once — there are 20-odd of them, and a new
  // one added later is covered automatically instead of leaking by default.
  // Actor-less notifications (system, wallet, admin) have nobody to compare
  // against and are never suppressed.
  if (n.actor?.uid && (await isNotificationSuppressed(env, recipientId, n.actor.uid))) return;

  try {
    const db = getDb(env);
    const ts = now();

    // One query for both the push tokens and the preferences.
    const user = await db
      .select({
        fcmTokens: schema.users.fcmTokens,
        notificationPrefs: schema.users.notificationPrefs,
      })
      .from(schema.users)
      .where(eq(schema.users.uid, recipientId))
      .get();

    const prefs: NotificationPrefs = resolvePrefs(user?.notificationPrefs);
    const category = categoryForType(n.type);

    const collapsible = !n.noCollapse && isCollapsibleType(n.type) && !!n.targetId && !!n.actor;
    const collapseKey = collapsible ? `${n.type}:${n.targetId}` : null;

    let notifId: string | null = null;
    let title = n.title;
    let body = n.body;

    if (collapsible && collapseKey) {
      const existing = await db
        .select({
          id: schema.notifications.id,
          actors: schema.notifications.actors,
          actorCount: schema.notifications.actorCount,
          actorId: schema.notifications.actorId,
          createdAt: schema.notifications.createdAt,
        })
        .from(schema.notifications)
        .where(
          and(
            eq(schema.notifications.recipientId, recipientId),
            eq(schema.notifications.collapseKey, collapseKey),
            gt(schema.notifications.createdAt, ts - COLLAPSE_WINDOW_MS),
          ),
        )
        .orderBy(desc(schema.notifications.createdAt))
        .limit(1)
        .get();

      if (existing) {
        // Idempotency: the same actor repeating the same action within the dedup
        // window is a retry. Absorb it silently — no row change, no push.
        if (existing.actorId === n.actor!.uid && ts - existing.createdAt < DEDUP_WINDOW_MS) {
          return;
        }

        const priorActors: NotificationActor[] = (existing.actors as NotificationActor[]) || [];
        const alreadyPresent = priorActors.some((a) => a.uid === n.actor!.uid);
        const nextActors: NotificationActor[] = [
          {
            uid: n.actor!.uid,
            username: n.actor!.username ?? null,
            avatarUrl: n.actor!.avatarUrl ?? null,
          },
          ...priorActors.filter((a) => a.uid !== n.actor!.uid),
        ].slice(0, MAX_STORED_ACTORS);

        // Only a NEW actor increases the count.
        const nextCount = (existing.actorCount ?? 1) + (alreadyPresent ? 0 : 1);
        body = groupedBody(n.type, nextActors, nextCount) ?? n.body;

        await db
          .update(schema.notifications)
          .set({
            title,
            body,
            actorId: n.actor!.uid,
            actors: nextActors,
            actorCount: nextCount,
            image: n.image ?? null,
            // Bumped so the regrouped notification returns to the top, and
            // re-marked unread because there is genuinely something new.
            createdAt: ts,
            updatedAt: ts,
            read: false,
            seen: false,
          })
          .where(eq(schema.notifications.id, existing.id))
          .run();

        notifId = existing.id;
      }
    }

    if (!notifId) {
      notifId = newId();
      const actors: NotificationActor[] | null = n.actor
        ? [
            {
              uid: n.actor.uid,
              username: n.actor.username ?? null,
              avatarUrl: n.actor.avatarUrl ?? null,
            },
          ]
        : null;
      await db.insert(schema.notifications).values({
        id: notifId,
        recipientId,
        title,
        body,
        type: n.type,
        targetId: n.targetId,
        image: n.image ?? null,
        data: n.data ?? null,
        read: false,
        seen: false,
        actorId: n.actor?.uid ?? null,
        actors,
        actorCount: 1,
        collapseKey,
        createdAt: ts,
        updatedAt: ts,
      });
    }

    // Instant in-app delivery over the recipient's live socket.
    await publish(env, `user:${recipientId}`, {
      type: "notification",
      notification: {
        id: notifId,
        title,
        body,
        notifType: n.type,
        targetId: n.targetId,
        image: n.image ?? null,
      },
    });

    // ---- push gating -------------------------------------------------------
    if (!shouldSendPush(prefs, n.type, ts)) return;

    const tokens: string[] = (user?.fcmTokens as string[]) || [];
    if (!tokens.length) return;

    // Anti-spam: cap PUSHES per recipient per type. The row is already written,
    // so nothing is lost — the device just stops buzzing.
    if (!(await consumeRateLimit(env, `push:${recipientId}:${n.type}`, PUSH_BURST_MAX, PUSH_BURST_WINDOW_SEC))) {
      return;
    }

    // Notification fatigue: cap total daily pushes. Money notifications bypass
    // this — being rate-limited out of "your payout was sent" is unacceptable.
    if (
      !PUSH_CAP_EXEMPT_CATEGORIES.has(category) &&
      !(await consumeRateLimit(env, `pushday:${recipientId}`, PUSH_DAILY_MAX, PUSH_DAILY_WINDOW_SEC))
    ) {
      return;
    }

    await deliverToTokens(
      env,
      recipientId,
      tokens,
      title,
      body,
      n.type,
      { targetId: n.targetId, image: n.image || "", ...(n.data || {}) },
      {
        badge: await unreadCount(env, recipientId),
        // Makes the OS REPLACE the previous notification for this target rather
        // than stacking a new one per like.
        collapseKey: collapseKey ?? undefined,
        category,
      },
    );
  } catch (e) {
    console.error("[notify] createNotification failed", e);
  }
}
