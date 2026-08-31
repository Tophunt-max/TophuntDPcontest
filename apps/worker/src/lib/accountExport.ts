import { eq, or, desc } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { httpsError } from "./http";
import { now } from "./ids";

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
    db.select().from(schema.messages).where(eq(schema.messages.senderId, uid)).limit(CAP).all(),
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
