import { auth } from "./firebase";

// Base URL of the tophunt-api Cloudflare Worker. In dev, requests are proxied
// (see vite.config.ts); in production VITE_API_URL is baked in at build time.
const BASE = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

/** Current Firebase ID token (force-refreshes when `force` is true). */
async function idToken(force = false): Promise<string | null> {
  const u = auth.currentUser;
  if (!u) return null;
  try {
    return await u.getIdToken(force);
  } catch {
    return null;
  }
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type BlogStatus = "published" | "draft";

/** Lightweight row returned by GET /admin/blog. Full content/tags are detail-only. */
export interface BlogListItem {
  id: string;
  slug: string;
  title: string;
  excerpt: string | null;
  coverImageUrl: string | null;
  category: string | null;
  author: string | null;
  status: BlogStatus;
  source: "admin" | "archive" | string | null;
  viewCount: number | null;
  publishedAt: number | null;
  createdAt: number;
}

export interface BlogPostDetail extends BlogListItem {
  content: string | null;
  tags: string[] | null;
  metaTitle: string | null;
  metaDescription: string | null;
  canonicalUrl: string | null;
  originalUrl: string | null;
  contentHash: string | null;
  updatedAt: number;
}

export interface BlogWritePayload {
  title: string;
  slug?: string;
  excerpt: string | null;
  content: string | null;
  coverImageUrl: string | null;
  category: string | null;
  tags: string[];
  author: string;
  status: BlogStatus;
  metaTitle: string | null;
  metaDescription: string | null;
  publishedAt?: number | null;
  /** Optimistic-concurrency guard used by edits; create ignores it. */
  expectedUpdatedAt?: number;
}

export interface BlogStats {
  total: number;
  published: number;
  drafts: number;
  imported: number;
}

export type ContestType = "photo" | "video";
export type ContestStatus = "live" | "upcoming" | "paused" | "ended";

export interface AdminContest {
  id: string;
  title: string | null;
  name: string | null;
  type: ContestType;
  status: ContestStatus;
  bannerUrl: string | null;
  totalEntryFee: number;
  entryFishCoins: number;
  rewardCoins: number;
  prizePool: number;
  voteDurationDays: number;
  autoCancelHours: number;
  minVotes: number;
  description: string | null;
  rules: string | null;
  createdBy: string | null;
  createdAt: number;
  totalMatches: number;
  waitingMatches: number;
  activeMatches: number;
}

export interface ContestWritePayload {
  title: string;
  description: string | null;
  rules: string | null;
  type: ContestType;
  status: ContestStatus;
  bannerUrl: string | null;
  totalEntryFee: number;
  rewardCoins: number;
  voteDurationDays: number;
  autoCancelHours: number;
  minVotes: number;
}

export interface ContestBannerUpload {
  fileKey: string;
  publicUrl: string;
}

export type UploadProgressHandler = (percent: number) => void;

function parseApiErrorPayload(text: string, fallback: string): { message: string; code?: string } {
  try {
    const payload = JSON.parse(text) as { error?: { message?: string; status?: string }; message?: string };
    return {
      message: payload.error?.message || payload.message || fallback,
      code: payload.error?.status,
    };
  } catch {
    return { message: fallback };
  }
}

/** Raw authenticated binary upload (image) with browser-native progress. */
async function uploadBinary(
  path: string,
  file: File,
  onProgress?: UploadProgressHandler,
  failMessage = "Upload failed. Check your connection and try again.",
): Promise<ContestBannerUpload> {
  const send = async (forceToken: boolean): Promise<{ status: number; statusText: string; body: string }> => {
    const token = await idToken(forceToken);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}${path}`);
      xhr.setRequestHeader("Content-Type", file.type);
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
      };
      xhr.onerror = () => reject(new ApiError(failMessage, 0));
      xhr.onabort = () => reject(new ApiError("Upload was cancelled.", 0));
      xhr.onload = () => resolve({ status: xhr.status, statusText: xhr.statusText, body: xhr.responseText });
      xhr.send(file);
    });
  };

  onProgress?.(0);
  let response = await send(false);
  if (response.status === 401) response = await send(true);
  if (response.status < 200 || response.status >= 300) {
    const error = parseApiErrorPayload(response.body, response.statusText || failMessage);
    throw new ApiError(error.message, response.status, error.code);
  }
  onProgress?.(100);
  return JSON.parse(response.body) as ContestBannerUpload;
}

const uploadContestBanner = (file: File, onProgress?: UploadProgressHandler) =>
  uploadBinary("/admin/media/contest-banner", file, onProgress, "Banner upload failed. Check your connection and try again.");

const uploadPaymentQr = (file: File, onProgress?: UploadProgressHandler) =>
  uploadBinary("/admin/media/payment-qr", file, onProgress, "QR upload failed. Check your connection and try again.");

/**
 * Core request helper. Attaches the Firebase ID token as a Bearer header — the
 * Worker's /admin gate verifies it and checks the admin role. On a 401 it
 * force-refreshes the token once and retries.
 */
export async function req<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const doFetch = async (force: boolean) => {
    const token = await idToken(force);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  let res = await doFetch(false);
  if (res.status === 401) res = await doFetch(true);

  if (!res.ok) {
    let msg = res.statusText;
    let code: string | undefined;
    try {
      const j = (await res.json()) as any;
      msg = j?.error?.message || j?.message || msg;
      code = j?.error?.status;
    } catch {
      /* non-JSON error */
    }
    throw new ApiError(msg, res.status, code);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(p: string) => req<T>("GET", p);
const post = <T>(p: string, b?: unknown) => req<T>("POST", p, b ?? {});
const patch = <T>(p: string, b?: unknown) => req<T>("PATCH", p, b ?? {});
const put = <T>(p: string, b?: unknown) => req<T>("PUT", p, b ?? {});
const del = <T>(p: string) => req<T>("DELETE", p);

// ─── Integrations (SMS / email / payments / video / storage) ─────────────────

export type SecretSource = "panel" | "environment" | "unset";

/**
 * A credential's STATE — never its value. The API deliberately cannot return a
 * stored secret; `hint` and `fingerprint` are all that come back.
 */
export interface SecretStatus {
  name: string;
  label: string;
  group: "sms" | "email" | "payments" | "video" | "storage" | "auth" | "observability";
  help?: string;
  sensitive: boolean;
  multiline: boolean;
  configured: boolean;
  source: SecretSource;
  hint?: string | null;
  fingerprint?: string | null;
  updatedAt?: number | null;
  updatedBy?: string | null;
}

// --- SEO audit (worker: src/lib/seoAudit.ts) -------------------------------
export type SeoSeverity = "critical" | "high" | "medium" | "low";

export interface SeoIssue {
  id: string;
  category: string;
  severity: SeoSeverity;
  title: string;
  detail: string;
  affected: string[];
  affectedCount: number;
  suggestion?: string;
}

export interface SeoCategoryScore {
  id: string;
  label: string;
  /** null means the category has no data source — render it, never fake it. */
  score: number | null;
  status: "ok" | "warn" | "fail" | "not_configured";
  checksRun: number;
  checksPassed: number;
  note?: string;
}

export interface SeoAudit {
  /** null before the first audit has ever run. */
  ranAt: number | null;
  durationMs?: number;
  origin?: string;
  overall?: number | null;
  categories?: SeoCategoryScore[];
  issues?: SeoIssue[];
  passed?: { id: string; category: string; title: string }[];
  totals?: Record<SeoSeverity, number>;
  scope?: { posts: number; publicRoutes: number; probes: number };
}

export interface IntegrationsConfig {
  sms: {
    provider: "twilio" | "msg91" | "fast2sms" | "custom" | "none";
    from: string;
    templateId: string;
    otpVariable: string;
    route: string;
    customUrl: string;
    customMethod: "GET" | "POST";
    customBody: string;
  };
  email: { provider: "resend" | "brevo" | "none"; from: string; replyTo: string };
  payments: { razorpayKeyId: string };
  video: { provider: "bunny" | "r2"; libraryId: string; cdnHostname: string };
  push: { vapidPublicKey: string };
}

// ---- system health -------------------------------------------------------
export interface HealthCheck {
  ok: boolean;
  detail?: string;
  ms?: number;
}
export interface CronJobHealth {
  job: string;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastDurationMs: number | null;
  stale: boolean;
}
export interface DeepHealth {
  ok: boolean;
  ts: number;
  checks: Record<string, HealthCheck>;
  crons: CronJobHealth[];
}
export interface LedgerDriftSample {
  uid: string;
  balance: number;
  ledger: number;
  diff: number;
}
export interface MoneyHealth {
  ok: boolean;
  ts: number;
  ledgerDrift: { count: number; samples: LedgerDriftSample[] };
  negativeBalances: { count: number; samples: { uid: string; balance: number }[] };
  strandedPaidOrders: number;
  stuckCreatedOrders: number;
  clawbackShortfalls: { count: number; coins: number };
  pendingDeposits: { count: number; oldestAgeMs: number | null };
  pendingWithdrawals: { count: number; oldestAgeMs: number | null };
}

export interface IntegrationsResponse {
  config: IntegrationsConfig;
  defaults: IntegrationsConfig;
  secrets: SecretStatus[];
  /** False when the server has no encryption key, so credentials can't be saved. */
  secretStorage: boolean;
}

// ─── Typed surface over the Worker's /admin endpoints ───────────────────────
export const api = {
  // dashboard
  overview: () =>
    get<{
      users: number;
      posts: number;
      reports: number;
      support: number;
      /** COINS sold all-time (payments.amount has always held coins). */
      revenue: number;
      /** Actual money collected, in rupees. */
      revenueInr: number;
      activeMatches: number;
      liveContests: number;
      pendingWithdrawals: number;
      pendingDeposits: number;
    }>("/admin/overview"),
  deviceStats: () =>
    get<{ web: number; mobile: number; other: number }>("/admin/device-stats"),
  userGrowth: () =>
    get<{ categories: string[]; data: number[] }>("/admin/user-growth"),
  recentTickets: () => get<any[]>("/admin/recent-tickets"),

  // users
  users: (params?: { q?: string; offset?: number; limit?: number }) => {
    const s = new URLSearchParams();
    if (params?.q) s.set("q", params.q);
    if (params?.offset) s.set("offset", String(params.offset));
    if (params?.limit) s.set("limit", String(params.limit));
    const qs = s.toString();
    return get<any[]>(`/admin/users${qs ? `?${qs}` : ""}`);
  },
  user: (id: string) => get<any>(`/admin/users/${id}`),
  userPosts: (id: string) => get<any[]>(`/admin/users/${id}/posts`),
  userStories: (id: string) => get<any[]>(`/admin/users/${id}/stories`),
  setUserBlocked: (id: string, isBlocked: boolean) =>
    patch(`/admin/users/${id}`, { isBlocked }),
  deleteUser: (id: string) => del(`/admin/users/${id}`),
  adjustWallet: (id: string, amount: number, type: "add" | "subtract") =>
    post<{ newBalance: number }>(`/admin/users/${id}/wallet`, { amount, type }),
  setRole: (payload: { email?: string; userId?: string; makeAdmin?: boolean; role?: string }) =>
    post("/admin/set-role", payload),
  updateUserProfile: (id: string, payload: any) => patch(`/admin/users/${id}/profile`, payload),
  grantUser: (id: string, payload: { xp?: number; badge?: string }) =>
    post(`/admin/users/${id}/grant`, payload),

  // contests
  contests: () => get<AdminContest[]>("/admin/contests"),
  createContest: (payload: ContestWritePayload) =>
    post<{ success: true; contestId: string; id: string }>("/admin/contests", payload),
  updateContest: (id: string, payload: Partial<ContestWritePayload>) =>
    patch<{ message: string; id: string }>(`/admin/contests/${encodeURIComponent(id)}`, payload),
  deleteContest: (id: string) =>
    del<{ message: string }>(`/admin/contests/${encodeURIComponent(id)}`),
  uploadContestBanner,
  deleteContestBanner: (url: string) =>
    req<{ success: true }>("DELETE", "/admin/media/contest-banner", { url }),

  // Manual payment QR image upload (stored in R2, returns a public URL).
  uploadPaymentQr,

  // posts / stories (moderation)
  posts: () => get<any[]>("/admin/posts"),
  setPostHidden: (id: string, isHidden: boolean) =>
    patch(`/admin/posts/${id}`, { isHidden }),
  deletePost: (id: string) => del(`/admin/posts/${id}`),
  stories: () => get<any[]>("/admin/stories"),
  deleteStory: (id: string) => del(`/admin/stories/${id}`),

  // reports (media moderation)
  reports: () => get<any[]>("/admin/reports"),
  deleteReport: (id: string) => del(`/admin/reports?id=${encodeURIComponent(id)}`),
  resolveReport: (id: string, action: "dismiss" | "remove") =>
    post(`/admin/reports/${id}/resolve`, { action }),

  // referrals + finance trends
  referrals: () => get<any[]>("/admin/referrals"),
  // `deposits` / `withdrawals` are RUPEES (they used to be coin counts charted as
  // money); the *Coins fields carry the coin volume.
  financeTrends: () =>
    get<{
      date: string;
      deposits: number;
      withdrawals: number;
      depositsInr: number;
      withdrawalsInr: number;
      depositsCoins: number;
      withdrawalsCoins: number;
    }[]>("/admin/finance-trends"),

  // support
  support: () => get<any[]>("/admin/support"),
  updateTicket: (id: string, status: string, adminReply?: string) =>
    patch("/admin/support", { id, status, adminReply }),
  deleteTicket: (id: string) =>
    del(`/admin/support?id=${encodeURIComponent(id)}`),

  // blog
  blog: (q?: string) => get<BlogListItem[]>(`/admin/blog${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  blogStats: () => get<BlogStats>("/admin/blog/stats"),
  blogPost: (id: string) => get<BlogPostDetail>(`/admin/blog/${encodeURIComponent(id)}`),
  createBlog: (payload: BlogWritePayload) =>
    post<{ success: true; id: string; slug: string }>("/admin/blog", payload),
  updateBlog: (id: string, payload: Partial<BlogWritePayload>) =>
    patch<{ message: string; id: string; slug: string }>(`/admin/blog/${encodeURIComponent(id)}`, payload),
  deleteBlog: (id: string) =>
    del<{ message: string }>(`/admin/blog/${encodeURIComponent(id)}`),

  // archive import status (Wayback importer)
  blogImportSummary: () =>
    get<{ byStatus: Record<string, number>; missingImages: number }>("/admin/blog/import/summary"),
  blogImportProgress: () => get<any | null>("/admin/blog/import/progress"),
  blogImportLog: (status?: string, limit = 100) =>
    get<any[]>(`/admin/blog/import/log?limit=${limit}${status ? `&status=${encodeURIComponent(status)}` : ""}`),
  blogImportDiscover: (payload: { type: string }) => post<{urls: string[]}>("/admin/blog/import/discover", payload),
  blogImportProcessBatch: (payload: { urls: string[], state: any }) => post<{state: any}>("/admin/blog/import/process-batch", payload),
  blogImportFinish: (payload: { state: any }) => post("/admin/blog/import/finish", payload),
  blogImportRetry: (payload: { status: string }) => post<{requeued: number}>("/admin/blog/import/retry", payload),
  blogImportFail: (payload: { url: string; error: string }) => post("/admin/blog/import/fail", payload),

  // settings
  rewards: () => get<any>("/admin/rewards"),
  saveRewards: (payload: any) => post("/admin/rewards", payload),
  appSettings: () => get<any>("/admin/app-settings"),
  saveAppSettings: (payload: any) => post("/admin/app-settings", payload),

  // integrations — provider config plus write-only credentials
  integrations: () => get<IntegrationsResponse>("/admin/integrations"),
  saveIntegrations: (config: IntegrationsConfig) => put("/admin/integrations", config),
  /** Store or rotate a credential. The value is encrypted server-side. */
  setIntegrationSecret: (name: string, value: string) =>
    put<{ success: boolean; fingerprint: string; hint: string }>(
      `/admin/integrations/secrets/${encodeURIComponent(name)}`,
      { value },
    ),
  deleteIntegrationSecret: (name: string) =>
    del<{ success: boolean; fellBackToEnvironment: boolean; message: string }>(
      `/admin/integrations/secrets/${encodeURIComponent(name)}`,
    ),
  /** Exercise a provider with its real credential, server-side. */
  testIntegration: (provider: string, payload?: { to?: string }) =>
    post<{ ok: boolean; message?: string; provider?: string; error?: string }>(
      `/admin/integrations/test/${encodeURIComponent(provider)}`,
      payload ?? {},
    ),

  // contest matches (battles)
  matches: (status?: string) =>
    get<any[]>(`/admin/matches${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  match: (id: string) => get<any>(`/admin/matches/${id}`),
  matchVotes: (id: string) => get<any[]>(`/admin/matches/${id}/votes`),
  declareWinner: (id: string, winnerUid?: string) =>
    post(`/admin/matches/${id}/declare-winner`, winnerUid ? { winnerUid } : {}),
  cancelMatch: (id: string) => post(`/admin/matches/${id}/cancel`),

  // transactions + revenue
  transactions: (params?: { uid?: string; type?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.uid) q.set("uid", params.uid);
    if (params?.type) q.set("type", params.type);
    if (params?.limit) q.set("limit", String(params.limit));
    const s = q.toString();
    return get<any[]>(`/admin/transactions${s ? `?${s}` : ""}`);
  },
  transactionTypes: () => get<string[]>("/admin/transactions/types"),
  // Revenue is reported in RUPEES; coin counts are separate fields. The old
  // response summed a coin column and called it revenue.
  revenue: () =>
    get<{
      totalRevenue: number; // rupees (same as grossRevenueInr)
      grossRevenueInr: number;
      refundedInr: number;
      netRevenueInr: number;
      refundedCount: number;
      coinsSold: number;
      coinsInCirculation: number;
      paymentsWithoutRecordedAmount: number;
      paymentCount: number;
      byType: { type: string; total: number; n: number }[];
      trend: { date: string; amount: number; revenueInr: number; coins: number }[];
      topSpenders: {
        userId: string;
        total: number;
        totalInr: number;
        totalCoins: number;
        username?: string;
        fullName?: string;
      }[];
    }>("/admin/revenue"),
  payments: () => get<any[]>("/admin/payments"),

  // fraud
  fraudVotes: () => get<{ deviceId: string; accounts: number; totalVotes: number }[]>("/admin/fraud/votes"),
  // Many accounts from one network converging on one entry in one match. Only
  // possible now that the voter IP is recorded.
  fraudVoteNetworks: (minAccounts = 3) =>
    get<{
      matchId: string;
      ip: string;
      votedForUid: string;
      accounts: number;
      devices: number;
      totalVotes: number;
    }[]>(`/admin/fraud/vote-networks?minAccounts=${minAccounts}`),

  // comments moderation
  comments: (postId?: string) =>
    get<any[]>(`/admin/comments${postId ? `?postId=${encodeURIComponent(postId)}` : ""}`),
  deleteComment: (id: string) => del(`/admin/comments/${id}`),

  // followers
  userFollowers: (id: string) => get<any[]>(`/admin/users/${id}/followers`),
  userFollowing: (id: string) => get<any[]>(`/admin/users/${id}/following`),

  // withdrawals
  withdrawals: (status?: string) =>
    get<any[]>(`/admin/withdrawals${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  // `payoutRef` (bank UTR / RRN) is REQUIRED by the server when marking a
  // payout paid, so an outgoing rupee can be reconciled against a statement.
  actionWithdrawal: (
    id: string,
    action: "approve" | "reject" | "paid",
    adminNote?: string,
    payoutRef?: string,
  ) => patch(`/admin/withdrawals/${id}`, { action, adminNote, payoutRef }),

  // deposits (manual QR/UPI top-ups)
  deposits: (status?: string) =>
    get<any[]>(`/admin/deposits${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  actionDeposit: (id: string, action: "approve" | "reject", adminNote?: string) =>
    patch(`/admin/deposits/${id}`, { action, adminNote }),

  // audit log
  auditLog: (action?: string) =>
    get<any[]>(`/admin/audit-log${action ? `?action=${encodeURIComponent(action)}` : ""}`),

  // error logs (observability)
  logs: (params?: { level?: string; q?: string; limit?: number }) => {
    const s = new URLSearchParams();
    if (params?.level) s.set("level", params.level);
    if (params?.q) s.set("q", params.q);
    if (params?.limit) s.set("limit", String(params.limit));
    const qs = s.toString();
    return get<any[]>(`/admin/logs${qs ? `?${qs}` : ""}`);
  },
  logStats: () => get<{ total: number; last24h: number }>("/admin/logs/stats"),
  clearLogs: () => del<{ success: true }>("/admin/logs"),

  // notifications
  notifications: () => get<any[]>("/admin/notifications"),
  markNotificationsRead: () => post("/admin/notifications/read"),
  notify: (payload: { userId: string; title: string; body: string; type?: string }) =>
    post("/admin/notify", payload),
  broadcast: (payload: { title: string; body: string; image?: string; segment?: { platform?: string; minLevel?: number } }) =>
    post<{ recipients: number }>("/admin/broadcast", payload),

  // scheduled notifications
  scheduledNotifications: () => get<any[]>("/admin/scheduled-notifications"),
  createScheduledNotification: (payload: any) => post("/admin/scheduled-notifications", payload),
  cancelScheduledNotification: (id: string) => del(`/admin/scheduled-notifications/${id}`),

  // coin packages
  coinPackages: () => get<any[]>("/admin/coin-packages"),
  createCoinPackage: (payload: any) => post("/admin/coin-packages", payload),
  updateCoinPackage: (id: string, payload: any) => patch(`/admin/coin-packages/${id}`, payload),
  deleteCoinPackage: (id: string) => del(`/admin/coin-packages/${id}`),

  // banned words
  bannedWords: () => get<string[]>("/admin/banned-words"),
  addBannedWord: (word: string) => post("/admin/banned-words", { word }),
  deleteBannedWord: (word: string) => del(`/admin/banned-words/${encodeURIComponent(word)}`),

  // admins / roles
  admins: () => get<any[]>("/admin/admins"),

  // leaderboard
  leaderboard: (metric?: string) => get<any[]>(`/admin/leaderboard${metric ? `?metric=${encodeURIComponent(metric)}` : ""}`),

  // messages moderation
  messages: () => get<any[]>("/admin/messages"),
  deleteMessage: (id: string) => del(`/admin/messages/${id}`),

  // analytics
  analytics: () =>
    get<{
      totalUsers: number; newUsersToday: number; newUsers7d: number; newUsers30d: number;
      dau: number; mau: number;
      // Coin counts (labelled "Coins Sold" in the UI).
      revenueToday: number; revenue7d: number; revenue30d: number;
      // Real money, in rupees.
      revenueTodayInr: number; revenue7dInr: number; revenue30dInr: number;
      matchesToday: number; votesToday: number; postsToday: number;
      activeMatches: number; completedMatches: number;
      // previous-period comparators (for week-over-week / day-over-day deltas)
      newUsersYesterday: number; votesYesterday: number; dauYesterday: number; revenueYesterday: number;
      newUsersPrev7d: number; revenuePrev7d: number;
    }>("/admin/analytics"),

  // ops (manual cron triggers)
  opsResolveContests: () => post("/admin/ops/resolve-contests"),
  opsHallOfFame: () => post("/admin/ops/hall-of-fame"),

  // system health console
  systemHealth: () => get<DeepHealth>("/admin/health"),

  moneyHealth: () => get<MoneyHealth>("/admin/money-health"),
  cronHealth: () => get<CronJobHealth[]>("/admin/ops/cron-health"),

  // SEO
  seoAudit: () => get<SeoAudit>("/admin/seo"),
  seoScan: () => post<{ message: string }>("/admin/seo/scan"),
};
