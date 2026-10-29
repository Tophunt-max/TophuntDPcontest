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
  /** Machine-readable reason, e.g. `reauth_required`, `approval_not_set`. */
  reason?: string;
  constructor(message: string, status: number, code?: string, reason?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.reason = reason;
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
  /**
   * Promo budget (kind contest_prize) that pays the part of `rewardCoins` above
   * the pot, reserved per match. Null = the prize is capped at the pot.
   */
  subsidyBudgetId?: string | null;
  /** Admin-only coin cost of a product prize; paid above the pot by a product_prize budget. Never shown in the app. */
  prizeCostCoins?: number;
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
  /** Level-based eligibility (null = anyone), migration 0070. */
  minLevel?: number | null;
  maxLevel?: number | null;
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
  /** Level-based eligibility (null = anyone), migration 0070. */
  minLevel?: number | null;
  maxLevel?: number | null;
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

export interface OnboardingStats {
  days: number;
  since: string;
  totals: { shown: number; completed: number; skipped: number; login: number };
  reachedBySlide: number[];
  skippedBySlide: number[];
  byPlatform: Record<string, { shown: number; completed: number }>;
  daily: { day: string; shown: number; completed: number; skipped: number }[];
}

const uploadOnboardingImage = (file: File, onProgress?: UploadProgressHandler) =>
  uploadBinary("/admin/media/onboarding-image", file, onProgress, "Image upload failed. Check your connection and try again.");

const uploadExploreBanner = (file: File, onProgress?: UploadProgressHandler) =>
  uploadBinary("/admin/media/explore-banner", file, onProgress, "Banner upload failed. Check your connection and try again.");

const uploadProductImage = (file: File, onProgress?: UploadProgressHandler) =>
  uploadBinary("/admin/media/product-image", file, onProgress, "Product image upload failed. Check your connection and try again.");

/**
 * Core request helper. Attaches the Firebase ID token as a Bearer header — the
 * Worker's /admin gate verifies it and checks the admin role. On a 401 it
 * force-refreshes the token once and retries.
 */
/**
 * Sensitive actions need a recent sign-in (the Worker's "sudo mode"). When the
 * server answers `reauth_required`, the auth provider asks for the password again
 * and the request is retried once with the refreshed token.
 */
let reauthHandler: (() => Promise<boolean>) | null = null;
export function setReauthHandler(fn: (() => Promise<boolean>) | null) {
  reauthHandler = fn;
}

/**
 * Promo actions (budgets, budget-funded packages and contest prizes) also need
 * the separate APPROVAL password (worker lib/approvalPassword.ts). When the
 * server answers `approval_required` / `approval_invalid`, the handler prompts
 * for it and the request is re-sent with `approvalPassword` in the body. The
 * password is never stored by the panel.
 */
type ApprovalHandler = (opts: { invalid: boolean; message: string }) => Promise<string | null>;
let approvalHandler: ApprovalHandler | null = null;
export function setApprovalHandler(fn: ApprovalHandler | null) {
  approvalHandler = fn;
}
const MAX_APPROVAL_TRIES = 3;

export async function req<T>(
  method: string,
  path: string,
  body?: unknown,
  retried = false,
  approvalTries = 0,
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
    let reason: string | undefined;
    try {
      const j = (await res.json()) as any;
      msg = j?.error?.message || j?.message || msg;
      code = j?.error?.status;
      reason = j?.error?.reason;
    } catch {
      /* non-JSON error */
    }
    if (res.status === 412 && reason === "reauth_required" && !retried && reauthHandler) {
      if (await reauthHandler()) return req<T>(method, path, body, true, approvalTries);
      throw new ApiError("Cancelled: this action needs your password.", res.status, code, reason);
    }
    if (
      res.status === 412 &&
      (reason === "approval_required" || reason === "approval_invalid") &&
      approvalTries < MAX_APPROVAL_TRIES &&
      approvalHandler
    ) {
      const password = await approvalHandler({ invalid: reason === "approval_invalid", message: msg });
      if (!password) throw new ApiError("Cancelled: approval password chahiye.", res.status, code, reason);
      const base = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
      return req<T>(method, path, { ...base, approvalPassword: password }, retried, approvalTries + 1);
    }
    throw new ApiError(msg, res.status, code, reason);
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
  video: { provider: "qencode" | "r2" };
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
  /** Approved manual deposits whose coins never landed (optional on older Workers). */
  strandedApprovedDeposits?: number;
  stuckCreatedOrders: number;
  clawbackShortfalls: { count: number; coins: number };
  /** Locked (play-only promo) coins out of step with the ledger or above the balance. */
  lockedDrift?: { count: number; overBalance: number; samples: { uid: string; locked: number; ledger: number; balance: number }[] };
  /** Promo-budget holds left on a finished match / processed deposit. */
  staleReservations?: number;
  /** Escrowed withdrawals missing their hold/refund ledger row (optional on older Workers). */
  withdrawalLedgerGaps?: { count: number; samples: { id: string; status: string; missing: string }[] };
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

// ─── Announcement popups ─────────────────────────────────────────────────────

export type AnnouncementTargetType = "all" | "users";

/** A row from GET /admin/announcements (includes its explicit-target count). */
export interface AdminAnnouncement {
  id: string;
  title: string;
  body: string;
  link: string | null;
  image: string | null;
  isActive: boolean;
  targetType: AnnouncementTargetType;
  /** Hours the popup stays hidden after a user closes it, then re-appears. */
  snoozeHours: number;
  /** Higher shows first when several are active for one user. */
  priority: number;
  /** Schedule window in epoch ms; null = unbounded on that side. */
  startAt: number | null;
  endAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  /** How many uids are explicitly targeted (0 for an "all" announcement). */
  targetCount: number;
}

export interface AnnouncementWritePayload {
  title: string;
  body: string;
  link?: string | null;
  image?: string | null;
  isActive?: boolean;
  targetType?: AnnouncementTargetType;
  snoozeHours?: number;
  priority?: number;
  startAt?: number | null;
  endAt?: number | null;
  /** Explicit target uids; only used when targetType is "users". */
  userIds?: string[];
}

// ─── Capacity (Cloudflare free-tier headroom) ────────────────────────────────
export interface CapacityTable {
  name: string;
  count: number;
  threshold: number;
}
export interface Capacity {
  caps: { rowsRead: number; rowsWritten: number; kvWrites: number };
  storageBytes: number | null;
  storageCapBytes: number;
  tables: CapacityTable[];
  /** Today's usage (UTC day). null when the analytics token isn't configured. */
  usage: { rowsRead: number; rowsWritten: number } | null;
  generatedAt: number;
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
  capacity: () => get<Capacity>("/admin/capacity"),
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
  /** `requestId` makes a retry or double click a no-op on the server; `reason` is audited. */
  adjustWallet: (id: string, amount: number, type: "add" | "subtract", reason: string, requestId: string, locked = false) =>
    post<{ newBalance: number; replayed?: boolean }>(`/admin/users/${id}/wallet`, { amount, type, reason, requestId, locked }),
  setRole: (payload: { email?: string; userId?: string; makeAdmin?: boolean; role?: string }) =>
    post("/admin/set-role", payload),
  updateUserProfile: (id: string, payload: any) => patch(`/admin/users/${id}/profile`, payload),
  /** XP grants need a `reason`; they are audited ledger events (worker lib/xpService.ts). */
  grantUser: (id: string, payload: { xp?: number; badge?: string; reason?: string }) =>
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
  referrals: (params: { status?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.status) qs.set("status", params.status);
    if (params.q) qs.set("q", params.q);
    const s = qs.toString();
    return get<{
      rows: any[];
      stats: { byStatus: Record<string, number>; coinsPaid: number; milestonePaid: number; paidThisMonth?: number };
      topReferrers: { uid: string; username: string | null; rewarded: number; earned: number }[];
      program: any;
    }>(`/admin/referrals${s ? `?${s}` : ""}`);
  },
  /** approve / reject a pending or in-review referral; reverse (claw back) a rewarded one. */
  decideReferral: (id: string, action: "approve" | "reject" | "reverse", reason?: string) =>
    patch<{ success: boolean; status: string; sides?: { uid: string; credited: number; taken: number; unit: string }[] }>(
      `/admin/referrals/${encodeURIComponent(id)}`,
      { action, reason },
    ),
  bulkDecideReferrals: (ids: string[], action: "approve" | "reject", reason?: string) =>
    post<{ success: boolean; results: { id: string; ok: boolean; status?: string; error?: string }[] }>("/admin/referrals/bulk", {
      ids,
      action,
      reason,
    }),
  referralLinks: (id: string) =>
    get<{
      referral: { id: string; referrerUid: string; referredUid: string; deviceId: string | null; ip: string | null };
      sameDevice: { uid: string; username: string | null; createdAt: number; isBlocked: number | boolean | null; status: string | null }[];
      sameIp: { id: string; uid: string; username: string | null; referrerUid: string; referrerUsername: string | null; status: string; createdAt: number }[];
      inviterIps: { ip: string; n: number; rewarded: number }[];
    }>(`/admin/referrals/${encodeURIComponent(id)}/links`),
  /** Daily check-in + daily task activity per reward day. */
  rewardStats: (days = 14) =>
    get<{
      dayResetOffsetMinutes: number;
      tasks: { id: string; title: string; type: string; enabled: boolean }[];
      days: {
        day: number;
        date: string;
        checkins: number;
        checkinCoins: number;
        taskClaims: number;
        taskCoins: number;
        tasks: Record<string, { claims: number; coins: number }>;
      }[];
      activeStreaks: { atLeast7: number; atLeast30: number };
    }>(`/admin/rewards/stats?days=${days}`),
  userRewards: (uid: string) => get<any>(`/admin/users/${encodeURIComponent(uid)}/rewards`),
  setUserStreak: (uid: string, body: { streak: number; continueStreak?: boolean; reason: string }) =>
    patch(`/admin/users/${encodeURIComponent(uid)}/streak`, body),
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
  // gamification (worker routes/adminGamification.ts)
  gamification: {
    config: () => get<any>("/admin/gamification/config"),
    saveConfig: (payload: { progression?: any; xpThreshold?: number; xpIncrement?: number }) => post("/admin/gamification/config", payload),
    achievements: () => get<any[]>("/admin/gamification/achievements"),
    saveAchievement: (id: string, payload: any) => put(`/admin/gamification/achievements/${encodeURIComponent(id)}`, payload),
    catalog: () => get<any[]>("/admin/gamification/catalog"),
    saveItem: (id: string, payload: any) => put(`/admin/gamification/catalog/${encodeURIComponent(id)}`, payload),
    seasons: () => get<any[]>("/admin/gamification/seasons"),
    createSeason: (payload: any) => post<{ id: string }>("/admin/gamification/seasons", payload),
    updateSeason: (id: string, payload: any) => patch(`/admin/gamification/seasons/${encodeURIComponent(id)}`, payload),
    finalizeSeason: (id: string) => post<any>(`/admin/gamification/seasons/${encodeURIComponent(id)}/finalize`),
    cancelSeason: (id: string, reason: string) => post(`/admin/gamification/seasons/${encodeURIComponent(id)}/cancel`, { reason }),
    seasonResults: (id: string) => get<any[]>(`/admin/gamification/seasons/${encodeURIComponent(id)}/results`),
    user: (uid: string) => get<any>(`/admin/gamification/users/${encodeURIComponent(uid)}`),
    userEvents: (uid: string, before?: number) =>
      get<{ events: any[]; nextBefore: number | null }>(`/admin/gamification/users/${encodeURIComponent(uid)}/events${before ? `?before=${before}` : ""}`),
    adjustXp: (uid: string, payload: { amount: number; reason: string; notify?: boolean }) =>
      post<any>(`/admin/gamification/users/${encodeURIComponent(uid)}/xp`, payload),
    reverseEvent: (eventId: string, reason: string) => post<any>(`/admin/gamification/events/${encodeURIComponent(eventId)}/reverse`, { reason }),
    grantAchievement: (uid: string, achievementId: string, reason: string) =>
      post<any>(`/admin/gamification/users/${encodeURIComponent(uid)}/achievements/${encodeURIComponent(achievementId)}`, { reason }),
    revokeItem: (uid: string, itemId: string, reason: string) =>
      post(`/admin/gamification/users/${encodeURIComponent(uid)}/inventory/${encodeURIComponent(itemId)}/revoke`, { reason }),
    restoreItem: (uid: string, itemId: string, reason: string) =>
      post(`/admin/gamification/users/${encodeURIComponent(uid)}/inventory/${encodeURIComponent(itemId)}/restore`, { reason }),
    flags: (status = "open") => get<any[]>(`/admin/gamification/flags?status=${encodeURIComponent(status)}`),
    reviewFlag: (id: string, status: string, note?: string) => patch(`/admin/gamification/flags/${encodeURIComponent(id)}`, { status, note }),
    analytics: (days = 30) => get<any>(`/admin/gamification/analytics?days=${days}`),
    reconcile: (uids?: string[]) => post<{ checked: number; mismatches: any[] }>("/admin/gamification/reconcile", uids ? { uids } : {}),
    grants: (status = "claimable") => get<any[]>(`/admin/gamification/grants?status=${encodeURIComponent(status)}`),
  },
  rewards: () => get<any>("/admin/rewards"),
  saveRewards: (payload: any) => post("/admin/rewards", payload),
  appSettings: () => get<any>("/admin/app-settings"),
  // For You ranking weights: defaults, ranges, stored and effective values (full admins).
  feedWeights: () => get<any>("/admin/feed-weights"),
  saveAppSettings: (payload: any) => post("/admin/app-settings", payload),
  // Sign-in / sign-up switches (resolved) + sign-ups per method over 30 days.
  authMethods: () => get<any>("/admin/auth-methods"),
  saveAuthMethods: (authMethods: any) => post("/admin/app-settings", { authMethods }),
  uploadOnboardingImage,
  uploadExploreBanner,
  onboardingStats: (days = 30) => get<OnboardingStats>(`/admin/onboarding/stats?days=${days}`),
  verificationReward: () => get<any>("/admin/verification-reward"),

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
  /** Requeue + run a failed/stuck VS Story publication (full admin, audited). */
  retryVsStory: (id: string) =>
    post<{ outcome: string; reason?: string }>(`/admin/matches/${id}/vs-story/retry`),

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
  clearNotifications: () => del("/admin/notifications"),
  notify: (payload: { userId: string; title: string; body: string; type?: string }) =>
    post("/admin/notify", payload),
  broadcast: (payload: { title: string; body: string; image?: string; segment?: { platform?: string; minLevel?: number } }) =>
    post<{ recipients: number }>("/admin/broadcast", payload),

  // announcement popups (in-app modal shown to users; targeted, 24h-snooze)
  announcements: () => get<AdminAnnouncement[]>("/admin/announcements"),
  announcementTargets: (id: string) => get<string[]>(`/admin/announcements/${encodeURIComponent(id)}/targets`),
  createAnnouncement: (payload: AnnouncementWritePayload) =>
    post<{ success: true; id: string }>("/admin/announcements", payload),
  updateAnnouncement: (id: string, payload: Partial<AnnouncementWritePayload>) =>
    patch<{ success: true; id: string }>(`/admin/announcements/${encodeURIComponent(id)}`, payload),
  deleteAnnouncement: (id: string) =>
    del<{ success: true }>(`/admin/announcements/${encodeURIComponent(id)}`),

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
  // Message bodies live in per-chat Durable Objects, so a delete is addressed by
  // (chatId, id) — the id alone no longer locates the message.
  deleteMessage: (chatId: string, id: string) =>
    del(`/admin/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(id)}`),

  // Anonymous usage counters from Analytics Engine (full admins). `configured` is
  // false until CF_ANALYTICS_TOKEN is set on the Worker.
  usageEvents: (days = 7) =>
    get<{ configured: boolean; days: number; rows: { name: string; dim: string; platform: string; count: number; avgMs: number | null }[] }>(
      `/admin/usage-events?days=${days}`,
    ),
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

  // coin economy (promo budgets, ledger reports)
  coinEconomy: (range?: { from?: number; to?: number }) => {
    const s = new URLSearchParams();
    if (range?.from) s.set("from", String(range.from));
    if (range?.to) s.set("to", String(range.to));
    const qs = s.toString();
    return get<CoinEconomy>(`/admin/coin-economy${qs ? `?${qs}` : ""}`);
  },
  coinEconomyContests: () => get<ContestPnl[]>("/admin/coin-economy/contests"),
  coinEconomyPackages: () => get<PackagePnl[]>("/admin/coin-economy/packages"),
  coinEconomyUser: (uid: string, limit = 300) =>
    get<UserStatement>(`/admin/coin-economy/users/${encodeURIComponent(uid)}?limit=${limit}`),
  promoBudgets: () => get<PromoBudget[]>("/admin/promo-budgets"),
  promoBudget: (id: string) => get<PromoBudgetDetail>(`/admin/promo-budgets/${encodeURIComponent(id)}`),
  createPromoBudget: (payload: PromoBudgetWrite & { kind: PromoBudgetKind; reason: string }) =>
    post<{ success: boolean; id: string; budget: PromoBudget }>("/admin/promo-budgets", payload),
  updatePromoBudget: (id: string, payload: Partial<PromoBudgetWrite> & { status?: PromoBudgetStatus; reason: string }) =>
    patch<{ success: boolean; budget: PromoBudget }>(`/admin/promo-budgets/${encodeURIComponent(id)}`, payload),
  approvalPasswordStatus: () => get<{ configured: boolean; updatedAt: number | null }>("/admin/approval-password"),
  setApprovalPassword: (payload: { current?: string; next: string }) =>
    post<{ success: boolean }>("/admin/approval-password", payload),
  requestApprovalReset: () => post<{ success: boolean; sentTo: string }>("/admin/approval-password/reset/request", {}),
  confirmApprovalReset: (payload: { code: string; next: string }) =>
    post<{ success: boolean }>("/admin/approval-password/reset/confirm", payload),
  sendCoinReport: (period: "daily" | "weekly") => post<{ success: boolean; to: string }>("/admin/coin-economy/report", { period }),
  runCoinAlerts: () => post<{ budgets: number; liability: boolean; heavyEarners: number }>("/admin/coin-economy/alerts/run", {}),
  cronHealth: () => get<CronJobHealth[]>("/admin/ops/cron-health"),

  // SEO
  seoAudit: () => get<SeoAudit>("/admin/seo"),
  seoScan: () => post<{ message: string }>("/admin/seo/scan"),
};

// ─── Coin economy (worker: lib/promoBudget.ts, lib/coinEconomy.ts) ───────────

export type PromoBudgetKind = "package_bonus" | "contest_prize" | "product_prize" | "free_rewards";
export type PromoBudgetStatus = "active" | "paused" | "closed";

export interface PromoBudget {
  id: string;
  name: string;
  kind: PromoBudgetKind;
  status: PromoBudgetStatus;
  totalCoins: number;
  spentCoins: number;
  heldCoins: number;
  remainingCoins: number;
  startsAt: number | null;
  endsAt: number | null;
  perUserLimit: number | null;
  note: string | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  live: boolean;
  usedCount: number;
  heldCount: number;
  linkedPackages: number;
  linkedContests: number;
}

export interface PromoBudgetWrite {
  name: string;
  totalCoins: number;
  startsAt: number | null;
  endsAt: number | null;
  perUserLimit: number | null;
  note: string | null;
}

export interface PromoBudgetDetail {
  budget: PromoBudget;
  packages: { id: string; name: string | null; coins: number; bonusCoins: number; active: boolean }[];
  contests: { id: string; title: string | null; status: string | null; totalEntryFee: number | null; rewardCoins: number | null }[];
  reservations: { id: string; uid: string | null; coins: number; status: string; refType: string; refId: string; expiresAt: number | null; createdAt: number; updatedAt: number }[];
  payouts: { id: string; kind: string; coins: number; contestId: string | null; matchId: string | null; uid: string | null; refId: string | null; description: string | null; createdAt: number }[];
}

export interface CoinEconomy {
  ts: number;
  range: { from: number | null; to: number | null };
  payoutRate: number;
  supply: { total: number; withdrawable: number; locked: number; holders: number; liabilityInr: number };
  /** Superadmin coins: platform money, left out of supply, liability and flows. */
  house?: { total: number; locked: number; accounts: number };
  cash: { paidInInr: number; refundedInr: number; paidOutInr: number; pendingOutInr: number };
  categories: Record<string, { label: string; credits: number; debits: number; net: number; locked: number }>;
  types: {
    type: string; category: string; credits: number; debits: number; net: number; locked: number; count: number;
    /** Split by balance: Diamond = locked_delta, DP coin = amount − locked_delta. */
    diamondIn: number; diamondOut: number; dpIn: number; dpOut: number;
  }[];
  /** Each balance's flow in the range, by source category. */
  diamondFlow?: BalanceFlow;
  dpFlow?: BalanceFlow;
  /** Diamonds paid in entry fees (net of refunds) vs DP coins paid as prizes. */
  conversion?: { entryDiamonds: number; prizeDp: number; subsidyDp: number; burnedDiamonds: number };
  platform: { kinds: Record<string, { coins: number; count: number }>; net: number };
  budgets: { total: number; spent: number; active: number; count: number };
  checks: { key: string; label: string; ok: boolean; detail: string }[];
  ok: boolean;
  budgetList: PromoBudget[];
  approvalPassword: { configured: boolean; updatedAt: number | null };
}

export interface BalanceFlow {
  in: Record<string, number>;
  out: Record<string, number>;
  totalIn: number;
  totalOut: number;
}

export interface ContestPnl {
  id: string;
  title: string | null;
  status: string | null;
  totalEntryFee: number;
  rewardCoins: number;
  prizeType: string;
  subsidyBudgetId: string | null;
  prizeCostCoins: number;
  matches: number;
  won: number;
  live: number;
  feesIn: number;
  refunds: number;
  prizes: number;
  subsidy: number;
  subsidyHeld: number;
  platformKept: number;
  net: number;
}

export interface PackagePnl {
  id: string;
  name: string | null;
  active: boolean;
  coins: number;
  bonusCoins: number;
  budgetId: string | null;
  purchases: number;
  inr: number;
  refundedInr: number;
  baseCoins: number;
  bonusCoinsGiven: number;
  promoBonusGiven: number;
}

export interface UserStatement {
  user: { uid: string; username: string | null; fullName: string | null; email: string | null; balance: number; locked: number; withdrawable: number };
  ledger: { count: number; sum: number; lockedSum: number; balanced: boolean };
  entries: {
    id: string;
    type: string;
    category: string;
    amount: number;
    lockedDelta: number;
    contestId: string | null;
    matchId: string | null;
    budgetId: string | null;
    description: string | null;
    createdAt: number;
    balanceAfter: number;
    lockedAfter: number;
  }[];
  truncated: boolean;
}
