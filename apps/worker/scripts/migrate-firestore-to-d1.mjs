#!/usr/bin/env node
/**
 * One-off data migration: Firestore -> D1.
 *
 * Reads every collection with the Firebase Admin SDK and emits a SQL file of
 * INSERTs matching apps/worker/src/db/schema.ts. Load it into D1 with:
 *
 *   wrangler d1 execute tophunt-db --remote --file=./d1-seed.sql
 *
 * Prereqs (run from apps/worker):
 *   npm i -D firebase-admin
 *   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccountKey.json
 *   node scripts/migrate-firestore-to-d1.mjs > d1-seed.sql
 *
 * Notes:
 *  - Timestamps are converted to epoch-millis (INTEGER) to match the schema.
 *  - The `Dpcoin`/`fishCoins`/`coins` legacy fields collapse into `dpcoin`.
 *  - The two ledgers (coinTransactions + coin_transactions) merge into one.
 *  - Nested maps (userA/userB/coordinates/data) are stored as JSON strings.
 */
import admin from "firebase-admin";
import { writeSync } from "node:fs";

admin.initializeApp();
const db = admin.firestore();

const out = [];
const emit = (line) => out.push(line);
const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "1" : "0";
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const ms = (ts) => {
  if (!ts) return "NULL";
  if (typeof ts?.toMillis === "function") return String(ts.toMillis());
  if (ts instanceof Date) return String(ts.getTime());
  if (typeof ts === "number") return String(ts);
  return "NULL";
};
const coinOf = (d) => Number(d.Dpcoin ?? d.fishCoins ?? d.coins ?? 0);

function insert(table, cols, vals) {
  emit(`INSERT OR REPLACE INTO ${table} (${cols.join(", ")}) VALUES (${vals.join(", ")});`);
}

async function migrateUsers() {
  const snap = await db.collection("users").get();
  for (const doc of snap.docs) {
    const d = doc.data();
    const s = d.stats || {};
    insert(
      "users",
      ["uid", "email", "username", "full_name", "profile_image_url", "dob", "phone", "occupation",
       "gender", "platform", "coordinates", "role", "status", "is_blocked", "dpcoin", "xp", "level",
       "badges", "equipped_badge", "streak", "last_daily_claim", "followers_count", "following_count",
       "posts_count", "wins", "monthly_wins", "total_votes_received", "contests_joined", "fcm_tokens",
       "signup_completed", "created_at", "updated_at"],
      [q(doc.id), q(d.email), q(d.username), q(d.fullName), q(d.profileImageUrl), q(d.dob), q(d.phone),
       q(d.occupation), q(d.gender), q(d.platform || "unknown"), q(d.coordinates), q(d.role || "user"),
       q(d.status || "active"), d.blocked || d.isBlocked ? 1 : 0, coinOf(d), Number(d.xp || 0),
       Number(d.level || 1), q(d.badges || []), q(d.equippedBadge), Number(d.streak || 0),
       ms(d.lastDailyClaim), Number(s.followersCount ?? d.followersCount ?? 0),
       Number(s.followingCount ?? d.followingCount ?? 0), Number(d.postsCount || 0),
       Number(s.wins || 0), Number(s.monthlyWins || 0), Number(s.totalVotesReceived || 0),
       Number(s.contestsJoined || 0), q(d.fcmTokens || []), d.signupCompleted ? 1 : 0,
       ms(d.createdAt) === "NULL" ? Date.now() : ms(d.createdAt),
       ms(d.updatedAt) === "NULL" ? Date.now() : ms(d.updatedAt)],
    );
    // following[] -> follows table
    for (const target of d.following || []) {
      insert("follows", ["follower_id", "following_id", "created_at"], [q(doc.id), q(target), Date.now()]);
    }
  }
}

async function migrateContests() {
  const snap = await db.collection("contests").get();
  for (const doc of snap.docs) {
    const d = doc.data();
    insert(
      "contests",
      ["id", "title", "type", "status", "total_entry_fee", "reward_coins", "vote_duration_days",
       "auto_cancel_hours", "min_votes", "extra", "created_by", "created_at"],
      [q(doc.id), q(d.title || d.name), q(d.type || "photo"), q(d.status || "live"),
       Number(d.totalEntryFee ?? d.entryDpcoin ?? 0), Number(d.rewardCoins ?? d.winningCoins ?? 0),
       Number(d.voteDurationDays || 1), Number(d.autoCancelHours || 24), Number(d.minVotes || 0),
       q(d), q(d.createdBy), ms(d.createdAt) === "NULL" ? Date.now() : ms(d.createdAt)],
    );
  }
}

async function migrateMatches() {
  const snap = await db.collection("contestMatches").get();
  for (const doc of snap.docs) {
    const d = doc.data();
    insert(
      "contest_matches",
      ["id", "contest_id", "status", "type", "title", "entry_fee", "is_private", "invited_uid",
       "join_id_a", "join_id_b", "user_a", "user_b", "total_votes", "like_count", "comment_count",
       "share_count", "winner_uid", "reward_amount", "ending_soon_notified", "created_at",
       "activated_at", "completed_at", "expires_at"],
      [q(doc.id), q(d.contestId), q(d.status), q(d.type || "photo"), q(d.title),
       Number(d.entryFee || 0), d.isPrivate ? 1 : 0, q(d.invitedUid), q(d.joinIdA), q(d.joinIdB),
       q(d.userA), q(d.userB), Number(d.totalVotes || 0), Number(d.likeCount || 0),
       Number(d.commentCount || 0), Number(d.shareCount || 0), q(d.winnerUid || d.winnerId),
       Number(d.rewardAmount || 0), d.endingSoonNotified ? 1 : 0,
       ms(d.createdAt) === "NULL" ? Date.now() : ms(d.createdAt), ms(d.activatedAt),
       ms(d.completedAt), ms(d.expiresAt)],
    );
  }
}

async function migrateSimple(coll, table, map) {
  const snap = await db.collection(coll).get();
  for (const doc of snap.docs) {
    const { cols, vals } = map(doc.id, doc.data());
    insert(table, cols, vals);
  }
}

async function main() {
  emit("PRAGMA foreign_keys=OFF;");
  emit("BEGIN TRANSACTION;");
  await migrateUsers();
  await migrateContests();
  await migrateMatches();

  await migrateSimple("posts", "posts", (id, d) => ({
    cols: ["id", "user_id", "media_url", "media_type", "caption", "location", "like_count", "comment_count", "is_hidden", "created_at"],
    vals: [q(id), q(d.userId), q(d.mediaUrl), q(d.mediaType || "photo"), q(d.caption), q(d.location),
      Number(d.likeCount || 0), Number(d.commentCount || 0), d.isHidden ? 1 : 0, ms(d.createdAt) === "NULL" ? Date.now() : ms(d.createdAt)],
  }));

  await migrateSimple("stories", "stories", (id, d) => ({
    cols: ["id", "user_id", "username", "avatar_url", "media_url", "media_type", "visibility", "overlay_text", "text_position", "mentions", "type", "match_id", "contest_title", "created_at", "expires_at"],
    vals: [q(id), q(d.userId), q(d.username), q(d.avatarUrl), q(d.mediaUrl), q(d.mediaType || "photo"),
      q(d.visibility || "public"), q(d.overlayText), q(d.textPosition), q(d.mentions), q(d.type),
      q(d.matchId), q(d.contestTitle), ms(d.createdAt) === "NULL" ? Date.now() : ms(d.createdAt),
      ms(d.expiresAt) === "NULL" ? Date.now() + 86400000 : ms(d.expiresAt)],
  }));

  // Merge both transaction ledgers.
  for (const coll of ["coinTransactions", "coin_transactions"]) {
    const snap = await db.collection(coll).get();
    for (const doc of snap.docs) {
      const d = doc.data();
      insert("coin_transactions",
        ["id", "uid", "amount", "type", "contest_id", "match_id", "description", "created_at"],
        [q(doc.id), q(d.uid || d.userId), Number(d.amount || 0), q(d.type), q(d.contestId), q(d.matchId),
         q(d.description), ms(d.timestamp || d.createdAt) === "NULL" ? Date.now() : ms(d.timestamp || d.createdAt)]);
    }
  }

  await migrateSimple("payments", "payments", (id, d) => ({
    cols: ["id", "user_id", "amount", "status", "created_at"],
    vals: [q(id), q(d.userId), Number(d.amount || 0), q(d.status || "success"), ms(d.createdAt) === "NULL" ? Date.now() : ms(d.createdAt)],
  }));

  await migrateSimple("settings", "settings", (id, d) => ({
    cols: ["id", "data", "updated_at"], vals: [q(id), q(d), Date.now()],
  }));

  emit("COMMIT;");
  writeSync(1, out.join("\n") + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
