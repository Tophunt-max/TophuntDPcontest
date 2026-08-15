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
const del = <T>(p: string) => req<T>("DELETE", p);

// ─── Typed surface over the Worker's /admin endpoints ───────────────────────
export const api = {
  // dashboard
  overview: () =>
    get<{
      users: number;
      posts: number;
      reports: number;
      support: number;
      revenue: number;
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
  contests: () => get<any[]>("/admin/contests"),
  createContest: (payload: any) => post("/admin/contests", payload),
  deleteContest: (id: string) => del(`/admin/contests/${id}`),

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
  financeTrends: () => get<{ date: string; deposits: number; withdrawals: number }[]>("/admin/finance-trends"),

  // support
  support: () => get<any[]>("/admin/support"),
  updateTicket: (id: string, status: string, adminReply?: string) =>
    patch("/admin/support", { id, status, adminReply }),
  deleteTicket: (id: string) =>
    del(`/admin/support?id=${encodeURIComponent(id)}`),

  // blog
  blog: (q?: string) => get<any[]>(`/admin/blog${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  blogStats: () => get<any>("/admin/blog/stats"),
  blogPost: (id: string) => get<any>(`/admin/blog/${id}`),
  createBlog: (payload: any) => post("/admin/blog", payload),
  updateBlog: (id: string, payload: any) => patch(`/admin/blog/${id}`, payload),
  deleteBlog: (id: string) => del(`/admin/blog/${id}`),

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

  // contest editing / matches (battles)
  updateContest: (id: string, payload: any) => patch(`/admin/contests/${id}`, payload),
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
  revenue: () =>
    get<{
      totalRevenue: number;
      paymentCount: number;
      coinsInCirculation: number;
      byType: { type: string; total: number; n: number }[];
      trend: { date: string; amount: number }[];
      topSpenders: { userId: string; total: number; username?: string; fullName?: string }[];
    }>("/admin/revenue"),
  payments: () => get<any[]>("/admin/payments"),

  // fraud
  fraudVotes: () => get<{ deviceId: string; accounts: number; totalVotes: number }[]>("/admin/fraud/votes"),

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
  actionWithdrawal: (id: string, action: "approve" | "reject" | "paid", adminNote?: string) =>
    patch(`/admin/withdrawals/${id}`, { action, adminNote }),

  // deposits (manual QR/UPI top-ups)
  deposits: (status?: string) =>
    get<any[]>(`/admin/deposits${status ? `?status=${encodeURIComponent(status)}` : ""}`),
  actionDeposit: (id: string, action: "approve" | "reject", adminNote?: string) =>
    patch(`/admin/deposits/${id}`, { action, adminNote }),

  // audit log
  auditLog: (action?: string) =>
    get<any[]>(`/admin/audit-log${action ? `?action=${encodeURIComponent(action)}` : ""}`),

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
      dau: number; mau: number; revenueToday: number; revenue7d: number; revenue30d: number;
      matchesToday: number; votesToday: number; postsToday: number;
      activeMatches: number; completedMatches: number;
      // previous-period comparators (for week-over-week / day-over-day deltas)
      newUsersYesterday: number; votesYesterday: number; dauYesterday: number; revenueYesterday: number;
      newUsersPrev7d: number; revenuePrev7d: number;
    }>("/admin/analytics"),

  // ops (manual cron triggers)
  opsResolveContests: () => post("/admin/ops/resolve-contests"),
  opsHallOfFame: () => post("/admin/ops/hall-of-fame"),
};
