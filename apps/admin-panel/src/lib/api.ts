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
 * Turn a thrown request error into something an admin can act on.
 *
 * The case that matters: when the browser blocks a request before it is sent
 * (CORS policy, DNS failure, offline), `fetch` rejects with a bare
 * `TypeError: Failed to fetch` and no status. Surfacing that string verbatim
 * sent people looking for a server outage when the actual cause was the panel
 * being opened on a host the API's allow-list does not include — so name that
 * possibility here instead of leaking the raw message.
 *
 * `uploadBinary` reports the same class of failure as `ApiError` with status 0.
 */
export function describeError(e: unknown): string {
  const transport =
    (e instanceof ApiError && e.status === 0) ||
    (e instanceof TypeError && /failed to fetch|networkerror|load failed/i.test(e.message));
  if (transport) {
    return `Could not reach the API at ${BASE || window.location.origin}. Check your connection, and confirm this admin host is allowed by the API's CORS allow-list.`;
  }
  if (e instanceof ApiError) {
    if (e.status === 401) return "Your session expired. Sign in again.";
    if (e.status === 403) return e.message || "Your account does not have access to this.";
    return e.message || `Request failed (${e.status}).`;
  }
  return e instanceof Error && e.message ? e.message : "Something went wrong.";
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

/**
 * What a contest awards. Mirrors `PRIZE_TYPES` in the Worker's lib/prizes.ts.
 *
 * `coins` credits `rewardCoins` to the winner's wallet. `product` ships a physical
 * item and credits nothing — the Worker forces `rewardCoins` to 0 for a product
 * contest, because `assertPrizeFundedByPot` caps coin rewards at the pot the two
 * players funded and a phone has no coin value to cap.
 */
export type PrizeType = "coins" | "product";

/** Bounds the Worker's `assertProductPrize` enforces; mirrored so the admin sees the error next to the field. */
export const PRODUCT_TITLE_MAX = 120;
export const PRODUCT_DESCRIPTION_MAX = 1000;
export const PRODUCT_VALUE_MAX = 100_000_000;

/** The prize columns, shared by a contest row and a contest write. */
export interface ContestPrizeFields {
  prizeType: PrizeType;
  prizeProductTitle: string | null;
  /** Required by the Worker whenever prizeType is "product". */
  prizeProductImageUrl: string | null;
  /** Declared retail value in rupees. Display only — never credited, never spendable. */
  prizeProductValue: number;
  prizeProductDescription: string | null;
}

export interface AdminContest extends ContestPrizeFields {
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
  /**
   * Validity window in epoch milliseconds; null means unbounded.
   *
   * The contest is only offered in the app between these two instants. Not to be
   * confused with voteDurationDays/autoCancelHours, which time an individual
   * match after two users have already started one.
   */
  startsAt: number | null;
  endsAt: number | null;
  description: string | null;
  rules: string | null;
  createdBy: string | null;
  createdAt: number;
  totalMatches: number;
  waitingMatches: number;
  activeMatches: number;
}

export interface ContestWritePayload extends ContestPrizeFields {
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
  startsAt: number | null;
  endsAt: number | null;
}

export interface ContestBannerUpload {
  fileKey: string;
  publicUrl: string;
}

// ─── Prize claims (physical prize fulfilment) ────────────────────────────────

/**
 * Fulfilment lifecycle. Mirrors `PRIZE_CLAIM_STATUSES` in the Worker's
 * routes/admin.ts, and the legal moves in `PRIZE_CLAIM_TRANSITIONS`.
 *
 * Only settlement creates `unclaimed`, and only the winner's own submit produces
 * `submitted`; everything after that is an operator decision.
 */
export type PrizeClaimStatus =
  | "unclaimed"
  | "submitted"
  | "approved"
  | "shipped"
  | "delivered"
  | "cancelled";

export const PRIZE_CLAIM_STATUSES: PrizeClaimStatus[] = [
  "unclaimed",
  "submitted",
  "approved",
  "shipped",
  "delivered",
  "cancelled",
];

/**
 * Which status an operator may move a claim to. A copy of the Worker's map, used
 * only to decide which buttons to render — the Worker re-checks every transition,
 * so a stale copy here can never authorise an illegal move.
 */
export const PRIZE_CLAIM_TRANSITIONS: Record<PrizeClaimStatus, PrizeClaimStatus[]> = {
  unclaimed: ["cancelled"],
  submitted: ["approved", "cancelled"],
  approved: ["shipped", "cancelled"],
  shipped: ["delivered", "cancelled"],
  delivered: [],
  cancelled: [],
};

/**
 * A row in the fulfilment queue.
 *
 * Deliberately has NO address fields. The list endpoint strips them and sends a
 * masked `deliverySummary` instead, so working the queue does not spray home
 * addresses across every operator's screen. The full address is on
 * `PrizeClaimDetail`, fetched only for the claim actually being packed — and that
 * read is audit-logged.
 */
export interface PrizeClaim {
  id: string;
  matchId: string;
  contestId: string | null;
  uid: string;
  status: PrizeClaimStatus;
  productTitle: string;
  productImageUrl: string | null;
  /**
   * Declared retail value in rupees, or null. Display only — never credited.
   *
   * Nullable because this list returns the raw column, unlike the app's
   * `/read/prizes`, which coerces it to 0. Coerce before comparing.
   */
  productValue: number | null;
  courier: string | null;
  trackingNumber: string | null;
  createdAt: number;
  submittedAt: number | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  username: string | null;
  fullName: string | null;
  /** "Name · City, State, PIN · masked phone". Null while `unclaimed`. */
  deliverySummary: string | null;
  hasAddress: boolean;
}

/** One claim with the full delivery address — the packing screen. */
export interface PrizeClaimDetail extends PrizeClaim {
  recipientName: string | null;
  phone: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  landmark: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  notes: string | null;
  adminNote: string | null;
  approvedAt: number | null;
  cancelledAt: number | null;
  updatedAt: number | null;
  /**
   * The address pre-formatted as a shipping label by the Worker. Used verbatim so
   * the panel and the app cannot disagree about field order. Null until submitted.
   */
  addressBlock: string | null;
}

export interface PrizeClaimStatusPayload {
  status: PrizeClaimStatus;
  /** Both required by the Worker when status is "shipped". */
  courier?: string;
  trackingNumber?: string;
  /** Required by the Worker when status is "cancelled". */
  adminNote?: string;
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

const uploadProductImage = (file: File, onProgress?: UploadProgressHandler) =>
  uploadBinary("/admin/media/product-image", file, onProgress, "Product image upload failed. Check your connection and try again.");

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

/** One legal document row for the editor (effective raw content + its source). */
export interface LegalDoc {
  key: string;
  label: string;
  note: string;
  /** RAW content the app serves for this doc (override or bundled), tokens intact. */
  content: string;
  /** True when a stored override is in effect; false when it is the bundled default. */
  isCustom: boolean;
}
export interface LegalDocsResponse {
  docs: LegalDoc[];
  lastUpdated: string;
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
    provider: "twilio" | "msg91" | "fast2sms" | "hanuotp" | "custom" | "none";
    from: string;
    templateId: string;
    otpVariable: string;
    route: string;
    customUrl: string;
    customMethod: "GET" | "POST";
    customBody: string;
  };
  email: { provider: "resend" | "brevo" | "maileroo" | "none"; from: string; replyTo: string };
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
export type DeletionRequestStatus = "pending" | "processing" | "completed" | "cancelled";
export interface AccountDeletionRequest {
  uid: string;
  /** Display handle for the account (null if the row no longer resolves). */
  username: string | null;
  /** Email on file, for support identification (null on phone-only / anonymised). */
  email: string | null;
  status: DeletionRequestStatus;
  reason: string | null;
  requestedAt: number;
  scheduledFor: number;
  deferredReason: string | null;
  deferredUntil: number | null;
  /** How far the purge got: snapshots | media | content | social | auth | done. */
  phase: string | null;
  attempts: number;
  lastError: string | null;
  balanceAtRequest: number;
  source: string;
  cancelledAt: number | null;
  completedAt: number | null;
  /** Grace period has lapsed but the purge has not finished — needs attention. */
  isOverdue: boolean;
}
export interface AccountDeletionsResponse {
  requests: AccountDeletionRequest[];
  stats: {
    pending: number;
    processing: number;
    completed: number;
    cancelled: number;
    /** Due but unpurged. Non-zero means the sweep is behind or a purge is failing. */
    overdue: number;
    /** Requests carrying a `lastError` and not yet complete. */
    failing: number;
    forfeitedCoinsTotal: number;
  };
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
      /**
       * Prize claims still needing an operator: everything that is neither
       * delivered nor cancelled. Includes `unclaimed`, which is waiting on the
       * winner rather than on us — a prize nobody ever claims is exactly the
       * thing an operator should notice and chase.
       */
      pendingPrizeClaims: number;
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
  /**
   * End every session on an account WITHOUT blocking it.
   *
   * For the support case blocking cannot serve: a user reports their account is
   * compromised. Blocking evicts the intruder and locks out the victim too, who has done
   * nothing wrong and still needs to reach their balance.
   */
  logoutAllUserSessions: (id: string) => post(`/admin/users/${id}/logout-all`, {}),
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

  // Product-prize image. Same pipeline as the banner, separate R2 prefix.
  uploadProductImage,
  /**
   * Only ever used to clean up an image whose contest then failed to save. The
   * Worker refuses to delete one that is attached to a contest or a prize claim,
   * so this cannot orphan a picture a winner is still looking at.
   */
  deleteProductImage: (url: string) =>
    req<{ success: true }>("DELETE", "/admin/media/product-image", { url }),

  // Manual payment QR image upload (stored in R2, returns a public URL).
  uploadPaymentQr,

  // prize claims (physical prize fulfilment queue)
  prizeClaims: (params?: { status?: PrizeClaimStatus; limit?: number }) => {
    const s = new URLSearchParams();
    if (params?.status) s.set("status", params.status);
    if (params?.limit) s.set("limit", String(params.limit));
    const qs = s.toString();
    return get<PrizeClaim[]>(`/admin/prize-claims${qs ? `?${qs}` : ""}`);
  },
  /** Fetches the full delivery address. The Worker audit-logs every call. */
  prizeClaim: (id: string) => get<PrizeClaimDetail>(`/admin/prize-claims/${encodeURIComponent(id)}`),
  updatePrizeClaimStatus: (id: string, payload: PrizeClaimStatusPayload) =>
    post<{ success: true; id: string; status: PrizeClaimStatus }>(
      `/admin/prize-claims/${encodeURIComponent(id)}/status`,
      payload,
    ),

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

  // Legal documents. `legal()` returns each doc's EFFECTIVE raw content (a stored
  // override, or the bundled default) so the editor is never blank; `saveLegal`
  // stores an override, or clears it (reverting to the bundled default) when
  // `content` is empty.
  legal: () => get<LegalDocsResponse>("/admin/legal"),
  saveLegal: (key: string, content: string) =>
    post<{ success: boolean; isCustom: boolean }>("/admin/legal", { key, content }),

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
  matchVoteAudit: (id: string) => get<any>(`/admin/matches/${id}/vote-audit`),
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

  // comments moderation. `target: "blog"` switches to reader comments on blog
  // articles (blog_comments), which are separate rows in a separate table — the
  // target MUST be passed to the delete as well, or the id will be looked up in
  // the wrong table and the delete will no-op.
  comments: (postId?: string, target?: "blog") => {
    const qs = new URLSearchParams();
    if (postId) qs.set("postId", postId);
    if (target) qs.set("target", target);
    const q = qs.toString();
    return get<any[]>(`/admin/comments${q ? `?${q}` : ""}`);
  },
  deleteComment: (id: string, target?: "blog") =>
    del(`/admin/comments/${id}${target ? `?target=${target}` : ""}`),

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

  // account deletions (compliance + purge health)
  accountDeletions: (params?: { status?: string; limit?: number }) => {
    const s = new URLSearchParams();
    if (params?.status) s.set("status", params.status);
    if (params?.limit) s.set("limit", String(params.limit));
    const qs = s.toString();
    return get<AccountDeletionsResponse>(`/admin/account-deletions${qs ? `?${qs}` : ""}`);
  },
  /** Force a purge to run now / resume a stalled one. Irreversible. */
  purgeAccountDeletion: (uid: string) =>
    post<{ success: boolean; forfeitedCoins?: number; mediaUrls?: string[] }>(
      `/admin/account-deletions/${encodeURIComponent(uid)}/purge`,
    ),
  /** Restore a pending deletion on the user's behalf. */
  cancelAccountDeletion: (uid: string) =>
    post<{ success: boolean; cancelled: boolean }>(
      `/admin/account-deletions/${encodeURIComponent(uid)}/cancel`,
    ),

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
