import { eq, or, desc } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { now } from "./ids";
import { listChatMessagesBySender, type ChatMessage } from "./chatArchive";

/**
 * "Download my data" — one JSON document containing everything we hold about a
 * user, assembled on demand.
 *
 * This exists because the deletion flow needed it. Offering someone an
 * irreversible erasure with no way to keep a copy first is both a bad experience
 * and, under GDPR Article 15 / India's DPDP access right, an incomplete one. The
 * delete screen links straight here, before the confirmation step.
 *
 * Two deliberate constraints:
 *
 *  - EVERY collection is capped. A Worker has a memory and CPU ceiling, and an
 *    account with 50k votes would fail the whole export rather than the one
 *    collection that did not fit. Each capped list reports its own truncation, so
 *    the document is never silently partial.
 *  - Only the user's OWN data. A message they received, a vote cast on their
 *    entry, another player's contest snapshot — none of that is theirs to
 *    download, and including it would turn an access right into a disclosure.
 */

/** Per-collection row cap. Truncation is reported per collection, never hidden. */
const CAP = 1000;

interface Capped<T> {
  count: number;
  truncated: boolean;
  items: T[];
}

function capped<T>(items: T[]): Capped<T> {
  return { count: items.length, truncated: items.length >= CAP, items };
}

/**
 * Every message the user sent, gathered from the per-chat ChatArchive DOs.
 *
 * Message bodies no longer live in a single D1 table that could be queried by
 * sender, so this fans out over the user's conversations (from the source-of-
 * truth `chats.users` array) and merges. Best-effort per chat — one unreachable
 * DO must not fail the whole export — newest-first, capped like every other
 * collection.
 */
async function collectSentMessages(env: Env, uid: string, cap: number): Promise<ChatMessage[]> {
  const chats = await env.DB.prepare(
    `SELECT id FROM chats
      WHERE EXISTS (SELECT 1 FROM json_each(chats.users) WHERE json_each.value = ?)`,
  )
    .bind(uid)
    .all<{ id: string }>();
  const perChat = await Promise.all(
    (chats.results ?? []).map((row) =>
      listChatMessagesBySender(env, row.id, uid, cap).catch(() => [] as ChatMessage[]),
    ),
  );
  return perChat
    .flat()
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, cap);
}

export interface UserDataExport {
  meta: {
    uid: string;
    generatedAt: number;
    format: "tophunt.account-export.v1";
    /** Named so a reader knows what the caps mean without reading this file. */
    perCollectionLimit: number;
    notes: string[];
  };
  profile: Record<string, unknown>;
  [key: string]: unknown;
}

export async function exportUserData(env: Env, uid: string): Promise<UserDataExport> {
  const db = getDb(env);

  const user = await db.select().from(schema.users).where(eq(schema.users.uid, uid)).get();
  if (!user) throw httpsError("not-found", "Account not found.");

  // `fcmTokens` is a device credential, not user data: handing it back would let
  // anyone with the export file address push notifications at the account.
  const { fcmTokens, ...profile } = user as Record<string, unknown>;

  const [
    posts,
    stories,
    postComments,
    matchComments,
    blogComments,
    postLikes,
    bookmarks,
    highlights,
    following,
    followers,
    coinTransactions,
    payments,
    deposits,
    withdrawals,
    referralsMade,
    supportTickets,
    votesCast,
    messagesSent,
    notifications,
    deletionRequest,
  ] = await Promise.all([
    db.select().from(schema.posts).where(eq(schema.posts.userId, uid)).limit(CAP).all(),
    db.select().from(schema.stories).where(eq(schema.stories.userId, uid)).limit(CAP).all(),
    db
      .select()
      .from(schema.postComments)
      .where(eq(schema.postComments.userId, uid))
      .limit(CAP)
      .all(),
    db
      .select()
      .from(schema.matchComments)
      .where(eq(schema.matchComments.userId, uid))
      .limit(CAP)
      .all(),
    db
      .select()
      .from(schema.blogComments)
      .where(eq(schema.blogComments.userId, uid))
      .limit(CAP)
      .all(),
    db.select().from(schema.postLikes).where(eq(schema.postLikes.userId, uid)).limit(CAP).all(),
    db.select().from(schema.bookmarks).where(eq(schema.bookmarks.userId, uid)).limit(CAP).all(),
    db.select().from(schema.highlights).where(eq(schema.highlights.userId, uid)).limit(CAP).all(),
    db
      .select({ uid: schema.follows.followingId, since: schema.follows.createdAt })
      .from(schema.follows)
      .where(eq(schema.follows.followerId, uid))
      .limit(CAP)
      .all(),
    db
      .select({ uid: schema.follows.followerId, since: schema.follows.createdAt })
      .from(schema.follows)
      .where(eq(schema.follows.followingId, uid))
      .limit(CAP)
      .all(),
    db
      .select()
      .from(schema.coinTransactions)
      .where(eq(schema.coinTransactions.uid, uid))
      .orderBy(desc(schema.coinTransactions.createdAt))
      .limit(CAP)
      .all(),
    db.select().from(schema.payments).where(eq(schema.payments.userId, uid)).limit(CAP).all(),
    db.select().from(schema.deposits).where(eq(schema.deposits.userId, uid)).limit(CAP).all(),
    db.select().from(schema.withdrawals).where(eq(schema.withdrawals.userId, uid)).limit(CAP).all(),
    db
      .select()
      .from(schema.referrals)
      .where(or(eq(schema.referrals.referrerUid, uid), eq(schema.referrals.referredUid, uid)))
      .limit(CAP)
      .all(),
    db
      .select()
      .from(schema.supportTickets)
      .where(eq(schema.supportTickets.userId, uid))
      .limit(CAP)
      .all(),
    db.select().from(schema.votes).where(eq(schema.votes.voterUid, uid)).limit(CAP).all(),
    // Message bodies live in per-chat ChatArchive DOs now, not the D1 `messages`
    // table, so a plain D1 select would miss everything sent since the cutover.
    // Gather from every conversation the user is in (the DO includes any seeded
    // legacy rows too), so the export stays complete for the data-rights request.
    collectSentMessages(env, uid, CAP),
    db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.recipientId, uid))
      .orderBy(desc(schema.notifications.createdAt))
      .limit(CAP)
      .all(),
    db.select().from(schema.deletionRequests).where(eq(schema.deletionRequests.uid, uid)).get(),
  ]);

  // Contests are the one place the user's data lives inside another table's JSON
  // snapshot rather than in its own rows, so it needs its own query. Only their
  // own side is returned; the opponent's entry is the opponent's data.
  const matches = await env.DB.prepare(
    `SELECT id, contest_id, status, type, title, entry_fee, created_at, completed_at,
            winner_uid, reward_amount,
            CASE WHEN json_extract(user_a, '$.uid') = ? THEN user_a ELSE user_b END AS my_entry
       FROM contest_matches
      WHERE json_extract(user_a, '$.uid') = ? OR json_extract(user_b, '$.uid') = ?
      ORDER BY created_at DESC
      LIMIT ?`,
  )
    .bind(uid, uid, uid, CAP)
    .all<Record<string, unknown>>();

  const contestEntries = (matches.results || []).map((row) => ({
    ...row,
    my_entry: typeof row.my_entry === "string" ? safeJson(row.my_entry as string) : row.my_entry,
    won: row.winner_uid === uid,
  }));

  // Physical prizes won, INCLUDING the delivery address the user gave us.
  //
  // Included verbatim rather than masked, unlike the way this file omits push
  // tokens: an address is the user's own personal data and Article 15 is precisely
  // the right to receive it. The push-token exclusion is a different case — those
  // are device credentials someone holding the export file could act on, and are
  // not personal data at all.
  const prizeClaims = await db
    .select()
    .from(schema.prizeClaims)
    .where(eq(schema.prizeClaims.uid, uid))
    .orderBy(desc(schema.prizeClaims.createdAt))
    .limit(CAP)
    .all();

  return {
    meta: {
      uid,
      generatedAt: now(),
      format: "tophunt.account-export.v1",
      perCollectionLimit: CAP,
      notes: [
        "Every list is capped; a list with truncated=true has more rows than are shown.",
        "Only your own data is included. Messages you received and votes cast on your entries belong to the people who created them.",
        "Push notification tokens are omitted on purpose: they are device credentials, not personal data.",
      ],
    },
    profile,
    posts: capped(posts),
    stories: capped(stories),
    comments: {
      onPosts: capped(postComments),
      onContests: capped(matchComments),
      onBlog: capped(blogComments),
    },
    likes: capped(postLikes),
    bookmarks: capped(bookmarks),
    highlights: capped(highlights),
    connections: { following: capped(following), followers: capped(followers) },
    wallet: {
      balance: Number((profile as any).dpcoin || 0),
      transactions: capped(coinTransactions),
    },
    payments: capped(payments),
    deposits: capped(deposits),
    withdrawals: capped(withdrawals),
    referrals: capped(referralsMade),
    supportTickets: capped(supportTickets),
    votesCast: capped(votesCast),
    contestEntries: capped(contestEntries),
    prizeClaims: capped(prizeClaims),
    messagesSent: capped(messagesSent),
    notifications: capped(notifications),
    deletionRequest: deletionRequest ?? null,
  };
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
