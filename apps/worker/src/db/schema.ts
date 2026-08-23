/**
 * D1 (SQLite) schema — relational model derived from the former Firestore
 * collections. Nested/variable maps (userA/userB, stats, coordinates, data)
 * are stored as JSON text columns.
 *
 * Timestamps are stored as INTEGER epoch-millis for easy comparison in cron
 * jobs (expiresAt, createdAt, etc.).
 */
import { sql } from "drizzle-orm";
import { sqliteTable, text, integer, real, index, uniqueIndex, primaryKey } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// users  (was: users/{uid})
// ---------------------------------------------------------------------------
export const users = sqliteTable(
  "users",
  {
    uid: text("uid").primaryKey(),
    email: text("email"),
    username: text("username"), // lowercase, unique
    fullName: text("full_name"),
    profileImageUrl: text("profile_image_url"),
    dob: text("dob"),
    phone: text("phone"),
    occupation: text("occupation"),
    gender: text("gender"),
    platform: text("platform").default("unknown"),
    coordinates: text("coordinates", { mode: "json" }),
    role: text("role").default("user"), // 'user' | 'admin'
    status: text("status").default("active"),
    isBlocked: integer("is_blocked", { mode: "boolean" }).default(false),
    bio: text("bio"),
    isPrivate: integer("is_private", { mode: "boolean" }).default(false),
    authProvider: text("auth_provider"),
    // Any profile fields without a dedicated column (facebook/twitter/instagram, etc.)
    extra: text("extra", { mode: "json" }),

    // currency + gamification
    dpcoin: real("dpcoin").default(0), // primary currency (was Dpcoin)
    xp: integer("xp").default(0),
    level: integer("level").default(1),
    badges: text("badges", { mode: "json" }).$type<string[]>().default([]),
    equippedBadge: text("equipped_badge"),
    streak: integer("streak").default(0),
    lastDailyClaim: integer("last_daily_claim"),

    // denormalized counters (were users.stats.* / top-level counts)
    followersCount: integer("followers_count").default(0),
    followingCount: integer("following_count").default(0),
    postsCount: integer("posts_count").default(0),
    wins: integer("wins").default(0),
    monthlyWins: integer("monthly_wins").default(0),
    totalVotesReceived: integer("total_votes_received").default(0),
    contestsJoined: integer("contests_joined").default(0),

    // FCM registration tokens (array json)
    fcmTokens: text("fcm_tokens", { mode: "json" }).$type<string[]>().default([]),

    signupCompleted: integer("signup_completed", { mode: "boolean" }).default(false),
    // admin flags
    verified: integer("verified", { mode: "boolean" }).default(false),
    featured: integer("featured", { mode: "boolean" }).default(false),
    // referral program
    referralCode: text("referral_code"),
    referredBy: text("referred_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    // Unique to guarantee no two accounts share an identifier. SQLite treats
    // NULLs as distinct, so users without a phone/email still coexist. The
    // actual DB-level enforcement is applied by migration 0012 (as PARTIAL
    // unique indexes `WHERE <col> IS NOT NULL`); these declarations keep the
    // Drizzle model in sync for drizzle-kit/introspection.
    usernameIdx: uniqueIndex("idx_users_username").on(t.username),
    emailIdx: uniqueIndex("idx_users_email").on(t.email),
    phoneIdx: uniqueIndex("idx_users_phone").on(t.phone),
    monthlyWinsIdx: index("idx_users_monthly_wins").on(t.monthlyWins),
  }),
);

// ---------------------------------------------------------------------------
// follows  (was: users/{uid}/followers subcollection + following[])
// ---------------------------------------------------------------------------
export const follows = sqliteTable(
  "follows",
  {
    followerId: text("follower_id").notNull(),
    followingId: text("following_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.followerId, t.followingId] }),
    followingIdx: index("idx_follows_following").on(t.followingId),
    // Composite indexes for ordered, keyset-paginated connection lists
    // (routes/read.ts). Match the WHERE + ORDER BY created_at of each direction
    // so SQLite serves the page from the index without a sort (migration 0015).
    followingCreatedIdx: index("idx_follows_following_created").on(t.followingId, t.createdAt),
    followerCreatedIdx: index("idx_follows_follower_created").on(t.followerId, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// contests  (was: contests/{contestId} — admin templates)
// ---------------------------------------------------------------------------
export const contests = sqliteTable("contests", {
  id: text("id").primaryKey(),
  title: text("title"),
  type: text("type").default("photo"), // photo | video
  status: text("status").default("live"),
  totalEntryFee: real("total_entry_fee").default(0),
  rewardCoins: real("reward_coins").default(0),
  voteDurationDays: integer("vote_duration_days").default(1),
  autoCancelHours: integer("auto_cancel_hours").default(24),
  minVotes: integer("min_votes").default(0),
  bannerUrl: text("banner_url"), // contest photo/banner shown in the user app
  extra: text("extra", { mode: "json" }), // any additional template fields
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// contest_matches  (was: contestMatches/{matchId})
// ---------------------------------------------------------------------------
export const contestMatches = sqliteTable(
  "contest_matches",
  {
    id: text("id").primaryKey(),
    contestId: text("contest_id"),
    status: text("status").notNull(), // waiting_for_opponent | active | completed | ended | cancelled
    type: text("type").default("photo"),
    title: text("title"),
    entryFee: real("entry_fee").default(0),
    isPrivate: integer("is_private", { mode: "boolean" }).default(false),
    invitedUid: text("invited_uid"),
    joinIdA: text("join_id_a"),
    joinIdB: text("join_id_b"),
    // participant snapshots (uid, username, profilePic, mediaUrl, mediaType, caption, votes, ...)
    userA: text("user_a", { mode: "json" }),
    userB: text("user_b", { mode: "json" }),
    totalVotes: integer("total_votes").default(0),
    likeCount: integer("like_count").default(0),
    commentCount: integer("comment_count").default(0),
    shareCount: integer("share_count").default(0),
    winnerUid: text("winner_uid"),
    rewardAmount: real("reward_amount").default(0),
    // Immutable eligibility threshold captured when the match is created/activated.
    minVotesRequired: integer("min_votes_required"),
    // Unique token used to make status + financial settlement one atomic D1 batch.
    settlementId: text("settlement_id"),
    // { fire: n, heart: n, laugh: n } quick-reaction counters
    reactions: text("reactions", { mode: "json" }),
    endingSoonNotified: integer("ending_soon_notified", { mode: "boolean" }).default(false),
    // Coarse marker for the Bunny backfill: 'r2' | 'bunny' | null (not yet
    // considered). Per-participant video identity lives in the userA/userB
    // snapshots' mediaUrl; processing state lives in the `videos` table.
    videoProvider: text("video_provider"),
    createdAt: integer("created_at").notNull(),
    activatedAt: integer("activated_at"),
    completedAt: integer("completed_at"),
    expiresAt: integer("expires_at"),
  },
  (t) => ({
    statusIdx: index("idx_matches_status").on(t.status),
    expiresIdx: index("idx_matches_expires").on(t.expiresAt),
    statusExpiresIdx: index("idx_matches_status_expires").on(t.status, t.expiresAt),
    settlementUnique: uniqueIndex("uniq_matches_settlement_id")
      .on(t.settlementId)
      .where(sql`${t.settlementId} IS NOT NULL`),
  }),
);

// ---------------------------------------------------------------------------
// votes  (was: votes/{matchId_voterUid}) — dedup + audit
// ---------------------------------------------------------------------------
export const votes = sqliteTable(
  "votes",
  {
    id: text("id").primaryKey(), // `${matchId}_${voterUid}`
    matchId: text("match_id").notNull(),
    voterUid: text("voter_uid").notNull(),
    votedForUid: text("voted_for_uid").notNull(),
    deviceId: text("device_id"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    matchIdx: index("idx_votes_match").on(t.matchId),
    matchVoterUnique: uniqueIndex("uniq_votes_match_voter").on(t.matchId, t.voterUid),
    matchDeviceUnique: uniqueIndex("uniq_votes_match_device")
      .on(t.matchId, t.deviceId)
      .where(sql`${t.deviceId} IS NOT NULL AND ${t.deviceId} <> ''`),
  }),
);

// Exactly-once vote XP ledger. The DO checks/inserts this in the same D1 batch
// as the XP increment, so actor retries cannot credit a voter twice.
export const voteXpAwards = sqliteTable(
  "vote_xp_awards",
  {
    matchId: text("match_id").notNull(),
    voterUid: text("voter_uid").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.matchId, t.voterUid] }),
    voterIdx: index("idx_vote_xp_awards_voter").on(t.voterUid, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// coin_transactions  (consolidates coinTransactions + coin_transactions)
// ---------------------------------------------------------------------------
export const coinTransactions = sqliteTable(
  "coin_transactions",
  {
    id: text("id").primaryKey(),
    uid: text("uid").notNull(),
    amount: real("amount").notNull(),
    type: text("type").notNull(), // signup_bonus | contest_entry_fee | purchase | reward | admin_adjust ...
    contestId: text("contest_id"),
    matchId: text("match_id"),
    description: text("description"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    uidIdx: index("idx_txn_uid").on(t.uid),
    createdIdx: index("idx_txn_created").on(t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// payments  (idempotency for top-ups)
// ---------------------------------------------------------------------------
export const payments = sqliteTable("payments", {
  id: text("id").primaryKey(), // paymentId
  userId: text("user_id").notNull(),
  amount: real("amount").notNull(),
  status: text("status").default("success"),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// payment_orders  (persistent record of Razorpay orders for reconciliation)
//
// Created when the client calls `createOrder`; credited exactly once by EITHER
// the client callback (`topup`) OR the server-to-server webhook — whichever
// arrives first. The `status` CAS (created -> paid) is the idempotency guard so
// a paid-but-not-credited order can be reconciled without double-crediting.
// ---------------------------------------------------------------------------
export const paymentOrders = sqliteTable(
  "payment_orders",
  {
    orderId: text("order_id").primaryKey(), // Razorpay order id
    userId: text("user_id").notNull(),
    packageId: text("package_id"),
    coins: real("coins").notNull(), // server-authoritative coins to credit
    amountPaise: integer("amount_paise").notNull(), // expected amount (paise)
    currency: text("currency").notNull().default("INR"),
    status: text("status").notNull().default("created"), // created | paid | failed
    paymentId: text("payment_id"),
    source: text("source"), // callback | webhook
    creditedAt: integer("credited_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_payment_orders_user").on(t.userId),
    statusIdx: index("idx_payment_orders_status").on(t.status, t.createdAt),
  }),
);

// ---------------------------------------------------------------------------
// posts + engagement
// ---------------------------------------------------------------------------
export const posts = sqliteTable(
  "posts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    mediaUrl: text("media_url"),
    mediaType: text("media_type").default("photo"),
    caption: text("caption"),
    location: text("location"),
    likeCount: integer("like_count").default(0),
    commentCount: integer("comment_count").default(0),
    isHidden: integer("is_hidden", { mode: "boolean" }).default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ userIdx: index("idx_posts_user").on(t.userId) }),
);

export const postLikes = sqliteTable(
  "post_likes",
  {
    postId: text("post_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.postId, t.userId] }) }),
);

export const postComments = sqliteTable(
  "post_comments",
  {
    id: text("id").primaryKey(),
    postId: text("post_id").notNull(),
    userId: text("user_id").notNull(),
    text: text("text"),
    parentId: text("parent_id"), // for replies
    likeCount: integer("like_count").default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ postIdx: index("idx_comments_post").on(t.postId) }),
);

export const commentLikes = sqliteTable(
  "comment_likes",
  {
    commentId: text("comment_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.commentId, t.userId] }) }),
);

// ---------------------------------------------------------------------------
// stories  (was: stories/{storyId}, 24h TTL)
// ---------------------------------------------------------------------------
export const stories = sqliteTable(
  "stories",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    username: text("username"),
    avatarUrl: text("avatar_url"),
    mediaUrl: text("media_url"),
    mediaType: text("media_type").default("photo"),
    visibility: text("visibility").default("public"),
    overlayText: text("overlay_text"),
    textPosition: text("text_position", { mode: "json" }),
    mentions: text("mentions", { mode: "json" }).$type<string[]>(),
    type: text("type"),
    matchId: text("match_id"),
    contestTitle: text("contest_title"),
    // 'r2' | 'bunny' | null. See contestMatches.videoProvider.
    videoProvider: text("video_provider"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => ({
    userIdx: index("idx_stories_user").on(t.userId),
    expiresIdx: index("idx_stories_expires").on(t.expiresAt),
  }),
);

export const storyViews = sqliteTable(
  "story_views",
  {
    storyId: text("story_id").notNull(),
    viewerId: text("viewer_id").notNull(),
    reaction: text("reaction"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.storyId, t.viewerId] }) }),
);

// ---------------------------------------------------------------------------
// contest-match engagement (were contestMatches/{id}/likes|comments|reactions)
// ---------------------------------------------------------------------------
export const matchLikes = sqliteTable(
  "match_likes",
  {
    matchId: text("match_id").notNull(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.matchId, t.userId] }) }),
);

export const matchComments = sqliteTable(
  "match_comments",
  {
    id: text("id").primaryKey(),
    matchId: text("match_id").notNull(),
    userId: text("user_id").notNull(),
    text: text("text"),
    parentId: text("parent_id"),
    likeCount: integer("like_count").default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ matchIdx: index("idx_match_comments_match").on(t.matchId) }),
);

export const matchReactions = sqliteTable(
  "match_reactions",
  {
    matchId: text("match_id").notNull(),
    userId: text("user_id").notNull(),
    type: text("type").notNull(), // fire | heart | laugh
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.matchId, t.userId, t.type] }) }),
);

// ---------------------------------------------------------------------------
// bookmarks (was users/{uid}/bookmarks/{matchId})
// ---------------------------------------------------------------------------
export const bookmarks = sqliteTable(
  "bookmarks",
  {
    userId: text("user_id").notNull(),
    matchId: text("match_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.matchId] }) }),
);

// ---------------------------------------------------------------------------
// highlights (was users/{uid}/highlights/{id})
// ---------------------------------------------------------------------------
export const highlights = sqliteTable(
  "highlights",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name"),
    coverImageUrl: text("cover_image_url"),
    storyIds: text("story_ids", { mode: "json" }).$type<string[]>(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ userIdx: index("idx_highlights_user").on(t.userId) }),
);

// ---------------------------------------------------------------------------
// notifications  (was: notifications/{userId}/items/{id})
// ---------------------------------------------------------------------------
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    recipientId: text("recipient_id").notNull(),
    title: text("title"),
    body: text("body"),
    type: text("type"),
    targetId: text("target_id"),
    image: text("image"),
    data: text("data", { mode: "json" }),
    read: integer("read", { mode: "boolean" }).default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    recipientIdx: index("idx_notif_recipient").on(t.recipientId, t.createdAt),
    // Partial index for the polled unread-count query (migration 0016): indexes
    // only unread rows so COUNT(*) WHERE recipient_id=? AND read=0 is index-only.
    unreadIdx: index("idx_notif_unread").on(t.recipientId).where(sql`${t.read} = 0`),
  }),
);

// ---------------------------------------------------------------------------
// chats + messages
// ---------------------------------------------------------------------------
export const chats = sqliteTable("chats", {
  id: text("id").primaryKey(),
  users: text("users", { mode: "json" }).$type<string[]>(),
  usersData: text("users_data", { mode: "json" }),
  lastMessage: text("last_message", { mode: "json" }),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").notNull(),
    senderId: text("sender_id").notNull(),
    text: text("text"),
    read: integer("read", { mode: "boolean" }).default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ chatIdx: index("idx_messages_chat").on(t.chatId, t.createdAt) }),
);

// ---------------------------------------------------------------------------
// shares / profile visits / moderation
// ---------------------------------------------------------------------------
export const shares = sqliteTable("shares", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  createdAt: integer("created_at").notNull(),
});

export const profileVisits = sqliteTable(
  "profile_visits",
  {
    userId: text("user_id").notNull(),
    visitorId: text("visitor_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.visitorId] }) }),
);

export const reports = sqliteTable("reports", {
  id: text("id").primaryKey(),
  reporterId: text("reporter_id"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  reason: text("reason"),
  status: text("status").default("open"),
  createdAt: integer("created_at").notNull(),
});

export const supportTickets = sqliteTable("support_tickets", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  subject: text("subject"),
  message: text("message"),
  status: text("status").default("open"),
  adminReply: text("admin_reply"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// ---------------------------------------------------------------------------
// admin_notifications  (admin panel activity feed: new reports/support tickets)
// ---------------------------------------------------------------------------
export const adminNotifications = sqliteTable(
  "admin_notifications",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    message: text("message"),
    link: text("link"),
    isRead: integer("is_read", { mode: "boolean" }).default(false),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ createdIdx: index("idx_admin_notif_created").on(t.createdAt) }),
);

// ---------------------------------------------------------------------------
// blog_posts  (editorial blog + imported tophunt.in archive posts)
// ---------------------------------------------------------------------------
export const blogPosts = sqliteTable(
  "blog_posts",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(), // URL permalink (unique via index below)
    title: text("title").notNull(),
    excerpt: text("excerpt"), // short summary for list cards
    content: text("content"), // full HTML body
    coverImageUrl: text("cover_image_url"), // featured image (Wayback URL or R2)
    category: text("category"),
    tags: text("tags", { mode: "json" }).$type<string[]>().default([]),
    author: text("author").default("TopHunt"),
    status: text("status").default("published"), // 'published' | 'draft'
    // SEO (must never be missing — populated from source or derived from content):
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    canonicalUrl: text("canonical_url"), // the original tophunt.in permalink
    // Provenance for imports + dedup:
    source: text("source").default("admin"), // 'admin' | 'archive'
    originalUrl: text("original_url"), // original tophunt.in permalink (import dedup key)
    contentHash: text("content_hash"), // sha256 of normalized text (dedup)
    viewCount: integer("view_count").default(0),
    // Original publish date if it could be confidently determined; otherwise
    // NULL (we never fall back to the Wayback capture date).
    publishedAt: integer("published_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    slugIdx: index("idx_blog_slug").on(t.slug),
    statusPublishedIdx: index("idx_blog_status_published").on(t.status, t.publishedAt),
    categoryIdx: index("idx_blog_category").on(t.category),
    originalUrlIdx: index("idx_blog_original_url").on(t.originalUrl),
    contentHashIdx: index("idx_blog_content_hash").on(t.contentHash),
  }),
);

// ---------------------------------------------------------------------------
// blog_import_log  (per-URL state for the resumable Wayback archive importer)
// ---------------------------------------------------------------------------
export const blogImportLog = sqliteTable(
  "blog_import_log",
  {
    id: text("id").primaryKey(),
    url: text("url").notNull(), // canonical original tophunt.in URL (unique)
    status: text("status").notNull().default("pending"), // pending|imported|updated|skipped|duplicate|failed
    error: text("error"),
    postId: text("post_id"),
    imagesTotal: integer("images_total").default(0),
    imagesMissing: integer("images_missing").default(0),
    attempts: integer("attempts").default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    urlIdx: uniqueIndex("idx_blog_import_url").on(t.url),
    statusIdx: index("idx_blog_import_status").on(t.status),
  }),
);

// ---------------------------------------------------------------------------
// withdrawals  (cash payout requests against Dpcoin balance)
// ---------------------------------------------------------------------------
export const withdrawals = sqliteTable(
  "withdrawals",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    amount: real("amount").notNull(), // Dpcoins requested
    cashAmount: real("cash_amount").default(0), // local currency value
    method: text("method").default("upi"), // upi | bank | paytm ...
    accountDetails: text("account_details"), // UPI id / bank details
    status: text("status").notNull().default("pending"), // pending | approved | rejected | paid
    adminNote: text("admin_note"),
    processedBy: text("processed_by"), // admin uid who actioned it
    // true = coins were already deducted (escrowed) at request time. Legacy rows
    // (created before this model) are 0 and are deducted on admin approval.
    reserved: integer("reserved", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    statusIdx: index("idx_withdrawals_status").on(t.status, t.createdAt),
    userIdx: index("idx_withdrawals_user").on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// referrals  (referral bonus ledger; one row per referred user)
// ---------------------------------------------------------------------------
export const referrals = sqliteTable(
  "referrals",
  {
    id: text("id").primaryKey(),
    referrerUid: text("referrer_uid").notNull(),
    referredUid: text("referred_uid").notNull().unique(),
    bonus: real("bonus").default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ referrerIdx: index("idx_referrals_referrer").on(t.referrerUid) }),
);

// ---------------------------------------------------------------------------
// daily_task_claims  (one row per user/task/UTC-day)
// ---------------------------------------------------------------------------
export const dailyTaskClaims = sqliteTable(
  "daily_task_claims",
  {
    uid: text("uid").notNull(),
    taskId: text("task_id").notNull(),
    day: integer("day").notNull(), // days since epoch (UTC)
    reward: real("reward").default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.uid, t.taskId, t.day] }) }),
);

// ---------------------------------------------------------------------------
// deposits  (manual QR/UPI top-up requests, admin-approved)
// ---------------------------------------------------------------------------
export const deposits = sqliteTable(
  "deposits",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    amount: real("amount").notNull(), // coins to credit on approval
    payAmount: real("pay_amount").default(0), // INR paid
    method: text("method").default("qr"), // qr | upi | bank
    utr: text("utr"), // user-entered bank transaction reference
    screenshotUrl: text("screenshot_url"),
    status: text("status").notNull().default("pending"), // pending | approved | rejected
    adminNote: text("admin_note"),
    processedBy: text("processed_by"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    statusIdx: index("idx_deposits_status").on(t.status, t.createdAt),
    userIdx: index("idx_deposits_user").on(t.userId),
  }),
);

// ---------------------------------------------------------------------------
// admin_audit_log  (accountability: who did what admin action, when)
// ---------------------------------------------------------------------------
export const adminAuditLog = sqliteTable(
  "admin_audit_log",
  {
    id: text("id").primaryKey(),
    adminUid: text("admin_uid"),
    adminEmail: text("admin_email"),
    action: text("action").notNull(), // e.g. user.block, wallet.adjust
    targetType: text("target_type"), // user | contest | match | withdrawal ...
    targetId: text("target_id"),
    detail: text("detail", { mode: "json" }), // extra context
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    createdIdx: index("idx_audit_created").on(t.createdAt),
    actionIdx: index("idx_audit_action").on(t.action),
  }),
);

// ---------------------------------------------------------------------------
// error_logs  (server error trail surfaced in the admin panel)
// Persisted from app.onError so admins can triage without the Cloudflare
// dashboard. Pruned by retention in the cron. Errors are rare -> low write load.
// ---------------------------------------------------------------------------
export const errorLogs = sqliteTable(
  "error_logs",
  {
    id: text("id").primaryKey(),
    level: text("level").notNull().default("error"), // error | warn
    message: text("message").notNull(),
    stack: text("stack"),
    requestId: text("request_id"),
    path: text("path"),
    method: text("method"),
    status: integer("status"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => ({
    createdIdx: index("idx_error_logs_created").on(t.createdAt),
    levelIdx: index("idx_error_logs_level").on(t.level),
  }),
);

// ---------------------------------------------------------------------------
// coin_packages  (admin-managed top-up store items)
// ---------------------------------------------------------------------------
export const coinPackages = sqliteTable(
  "coin_packages",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    coins: real("coins").notNull().default(0),
    bonusCoins: real("bonus_coins").notNull().default(0),
    priceInr: real("price_inr").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({ activeIdx: index("idx_coin_packages_active").on(t.active, t.sortOrder) }),
);

// ---------------------------------------------------------------------------
// scheduled_notifications  (scheduled / segmented broadcasts, sent by cron)
// ---------------------------------------------------------------------------
export const scheduledNotifications = sqliteTable(
  "scheduled_notifications",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    image: text("image"),
    segment: text("segment", { mode: "json" }), // { platform?, minLevel? }
    sendAt: integer("send_at").notNull(),
    status: text("status").notNull().default("pending"), // pending | sent | cancelled
    recipients: integer("recipients").default(0),
    createdBy: text("created_by"),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (t) => ({ statusIdx: index("idx_sched_notif_status").on(t.status, t.sendAt) }),
);

// ---------------------------------------------------------------------------
// banned_words  (auto-moderation word list)
// ---------------------------------------------------------------------------
export const bannedWords = sqliteTable("banned_words", {
  word: text("word").primaryKey(),
  createdAt: integer("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// settings  (was: settings/{docId}: appConfig, gamification)
// ---------------------------------------------------------------------------
export const settings = sqliteTable("settings", {
  id: text("id").primaryKey(), // 'appConfig' | 'gamification'
  data: text("data", { mode: "json" }).notNull(),
  updatedAt: integer("updated_at").notNull(),
});


// ---------------------------------------------------------------------------
// videos  (Bunny Stream processing state — MEDIA_MIGRATION_PLAN.md Phase 2)
//
// Keyed by Bunny's own video guid so the encoding webhook is a primary-key
// update rather than a search across every table that could own a video.
//
// Content links back by URL, not by a foreign key: a Bunny playback URL is
// https://{cdn-host}/{guid}/playlist.m3u8, so the guid is recoverable from the
// existing stories.mediaUrl / userA.mediaUrl values. That is what lets contest
// matches — which hold TWO participant videos in JSON — work without any
// participant-snapshot migration.
// ---------------------------------------------------------------------------
export const videos = sqliteTable(
  "videos",
  {
    /** Bunny video guid. */
    id: text("id").primaryKey(),
    libraryId: text("library_id"),
    ownerUid: text("owner_uid").notNull(),
    provider: text("provider").notNull().default("bunny"), // bunny | r2
    /** uploading | processing | ready | failed */
    status: text("status").notNull().default("uploading"),
    /**
     * What the video is attached to. Null until the story / contest entry is
     * created, which is how orphaned uploads are found.
     */
    targetType: text("target_type"), // story | contest_entry
    targetId: text("target_id"),
    /** 'A' | 'B' — which participant of a contest match this video belongs to. */
    targetSide: text("target_side"),
    thumbnailUrl: text("thumbnail_url"),
    durationSec: integer("duration_sec"),
    /** Written on the 'ready' webhook so clients never construct URLs. */
    playbackUrl: text("playback_url"),
    mp4Url: text("mp4_url"),
    /** Original R2 object, when this row came from the Phase 3 backfill. */
    r2SourceUrl: text("r2_source_url"),
    errorMessage: text("error_message"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => ({
    ownerIdx: index("idx_videos_owner").on(t.ownerUid, t.createdAt),
    statusIdx: index("idx_videos_status").on(t.status),
    targetIdx: index("idx_videos_target").on(t.targetType, t.targetId),
  }),
);
