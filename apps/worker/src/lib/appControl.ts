/**
 * App Control (admin panel → App Control): maintenance, force update, the
 * announcement banner, feature flags and withdrawal rules — resolved, validated,
 * projected for the app, and enforced.
 *
 * One module, three readers:
 *  - GET /read/app-config and the realtime push both send `publicAppConfig`, so
 *    the polled answer and the pushed answer can never differ;
 *  - POST /admin/app-settings runs `validateAppControlPatch` and stamps a new
 *    `_version`, so a client never replaces newer state with older;
 *  - the API gate (`appControlGate`) refuses writes during maintenance, writes
 *    that belong to a switched-off feature, and requests from a native build
 *    below the hard-update minimum.
 *
 * Stored shape (`settings/appConfig`), all optional; legacy keys keep working:
 *   maintenanceMode, maintenanceMessage, maintenanceEta,
 *   maintenanceSchedule { startAt, endAt, notice },
 *   forceUpdate, forceUpdateMode 'hard'|'soft', minAppVersion,
 *   updateUrls { android, ios }, updateUrl (legacy), updateMessage,
 *   announcement { id, enabled, message, link, tone, audience, startAt, endAt },
 *   features { contests, chat, stories, topups, withdrawals, posts },
 *   withdrawal { enabled, payoutsFrozen, minAmount, maxAmount, maxPerDay, conversionRate },
 *   _version (ms; bumped on every save).
 */
import { validateCoinPricingPatch } from "./coinPricing";
import { httpsError } from "./http";
import { legacyAuthSettings, methodAllowed, resolveAuthMethods } from "./authMethods";
import { onboardingEnabled, ONBOARDING_MAX_SLIDES } from "./onboardingConfig";

export const FEATURE_KEYS = ["contests", "chat", "stories", "topups", "withdrawals", "posts"] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Realtime channels every app instance can listen on (one is picked at random). */
export const APP_CONFIG_SHARDS = 16;
export const appConfigChannels = (): string[] =>
  Array.from({ length: APP_CONFIG_SHARDS }, (_, i) => `app:cfg${i}`);

/** Show an upcoming scheduled maintenance this long before it starts. */
export const MAINTENANCE_NOTICE_WINDOW_MS = 48 * 3_600_000;

const ANNOUNCEMENT_TONES = ["info", "warning", "success", "danger"] as const;
const ANNOUNCEMENT_AUDIENCES = ["all", "signedIn"] as const;
const UPDATE_MODES = ["hard", "soft"] as const;
const VERSION_RE = /^v?\d{1,4}(\.\d{1,4}){0,3}$/i;
const MAX_MESSAGE = 500;
const MAX_ANNOUNCEMENT = 300;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
};

// ---------------------------------------------------------------- versions

/** "v1.4.0-beta.2" -> [1,4,0]. Non-numeric parts end the number list. */
export function parseVersion(v: unknown): number[] {
  const s = String(v ?? "").trim().replace(/^v/i, "").split(/[-+ ]/)[0];
  if (!s) return [0];
  return s.split(".").map((p) => {
    const m = p.match(/^\d+/);
    return m ? parseInt(m[0], 10) : 0;
  });
}

export function compareVersions(a: unknown, b: unknown): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// --------------------------------------------------------------- resolution

export interface MaintenanceState {
  /** On right now (manual switch, or inside the scheduled window). */
  active: boolean;
  manual: boolean;
  message: string;
  /** When users are told to expect the app back (ms), or null. */
  endsAt: number | null;
  schedule: { startAt: number; endAt: number; notice: string } | null;
}

export function resolveMaintenance(cfg: any, nowMs: number): MaintenanceState {
  const manual = cfg?.maintenanceMode === true;
  const s = cfg?.maintenanceSchedule;
  const startAt = num(s?.startAt);
  const endAt = num(s?.endAt);
  const schedule =
    startAt !== null && endAt !== null && endAt > startAt
      ? { startAt, endAt, notice: typeof s?.notice === "string" ? s.notice.slice(0, MAX_MESSAGE) : "" }
      : null;
  const inWindow = !!schedule && nowMs >= schedule.startAt && nowMs < schedule.endAt;
  const eta = num(cfg?.maintenanceEta);
  return {
    active: manual || inWindow,
    manual,
    message: typeof cfg?.maintenanceMessage === "string" ? cfg.maintenanceMessage : "",
    endsAt: inWindow ? schedule!.endAt : manual && eta !== null && eta > nowMs ? eta : null,
    schedule: schedule && schedule.endAt > nowMs ? schedule : null,
  };
}

export interface UpdatePolicy {
  enabled: boolean;
  mode: "hard" | "soft";
  minVersion: string;
  androidUrl: string;
  iosUrl: string;
  message: string;
}

export function resolveUpdatePolicy(cfg: any): UpdatePolicy {
  const minVersion = typeof cfg?.minAppVersion === "string" ? cfg.minAppVersion.trim() : "";
  const legacyUrl = typeof cfg?.updateUrl === "string" ? cfg.updateUrl : "";
  return {
    enabled: cfg?.forceUpdate === true && !!minVersion,
    mode: cfg?.forceUpdateMode === "soft" ? "soft" : "hard",
    minVersion,
    androidUrl: (typeof cfg?.updateUrls?.android === "string" && cfg.updateUrls.android) || legacyUrl,
    iosUrl: (typeof cfg?.updateUrls?.ios === "string" && cfg.updateUrls.ios) || legacyUrl,
    message: typeof cfg?.updateMessage === "string" ? cfg.updateMessage : "",
  };
}

export function resolveFeatures(cfg: any): Record<FeatureKey, boolean> {
  const f = (cfg && typeof cfg.features === "object" && cfg.features) || {};
  return Object.fromEntries(FEATURE_KEYS.map((k) => [k, f[k] !== false])) as Record<FeatureKey, boolean>;
}

/** Stable id for the current announcement (dismissals are keyed on it). */
export function announcementId(a: any): string {
  if (typeof a?.id === "string" && a.id) return a.id;
  // Legacy rows (saved before ids existed): derive from the text, matching how
  // dismissals used to be keyed.
  const text = String(a?.message || "");
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return `m${(h >>> 0).toString(36)}`;
}

/**
 * Everything the app may know, for every caller (it is public and unauthenticated).
 * Explicit allow-list: a new setting is private unless it is added here.
 */
export function publicAppConfig(cfg: any, nowMs: number = Date.now()) {
  cfg = cfg || {};
  const ads = cfg.ads || {};
  const withdrawal = cfg.withdrawal || {};
  const authMethods = resolveAuthMethods(cfg);
  const maintenance = resolveMaintenance(cfg, nowMs);
  const update = resolveUpdatePolicy(cfg);
  const a = cfg.announcement || {};
  return {
    /** Bumped on every admin save; clients keep whichever copy is newer. */
    version: Number(cfg._version) || 0,
    serverTime: nowMs,
    // Legacy top-level gates (older builds read only these). A soft update is
    // never forced on a build that cannot show "later".
    maintenanceMode: maintenance.active,
    maintenanceMessage: maintenance.message,
    forceUpdate: update.enabled && update.mode === "hard",
    minAppVersion: update.minVersion,
    updateUrl: update.androidUrl || update.iosUrl || "",
    maintenance,
    update,
    announcement: {
      id: announcementId(a),
      enabled: !!a.enabled,
      message: typeof a.message === "string" ? a.message : "",
      link: typeof a.link === "string" ? a.link : "",
      tone: (ANNOUNCEMENT_TONES as readonly string[]).includes(a.tone) ? a.tone : "info",
      audience: (ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(a.audience) ? a.audience : "all",
      startAt: num(a.startAt),
      endAt: num(a.endAt),
    },
    features: resolveFeatures(cfg),
    authMethods,
    authSettings: legacyAuthSettings(authMethods),
    googleLogin: methodAllowed(authMethods, "google"),
    appleLogin: methodAllowed(authMethods, "apple"),
    facebookLogin: methodAllowed(authMethods, "facebook"),
    withdrawal: {
      enabled: withdrawal.enabled !== false,
      payoutsFrozen: withdrawal.payoutsFrozen === true,
      minAmount: Number(withdrawal.minAmount ?? 0),
      maxAmount: Number(withdrawal.maxAmount ?? 0),
      maxPerDay: Number(withdrawal.maxPerDay ?? 0),
      conversionRate: Number(withdrawal.conversionRate ?? 1),
    },
    paymentGateway: { mode: cfg.paymentGateway?.mode || "auto" },
    ads: { enabled: ads.enabled === true, reward: Number(ads.reward ?? 0), dailyCap: Number(ads.dailyCap ?? 0) },
    supportEmail: cfg.supportEmail || "",
    socialLinks: cfg.socialLinks || {},
    splashImageUrl: typeof cfg.splashImageUrl === "string" ? cfg.splashImageUrl : "",
    headerLogoUrl: typeof cfg.headerLogoUrl === "string" ? cfg.headerLogoUrl : "",
    onboardingEnabled: onboardingEnabled(cfg),
    onboarding: Array.isArray(cfg.onboarding)
      ? cfg.onboarding.slice(0, ONBOARDING_MAX_SLIDES).map((s: any) => ({
          title: typeof s?.title === "string" ? s.title : "",
          description: typeof s?.description === "string" ? s.description : "",
          imageUrl: typeof s?.imageUrl === "string" ? s.imageUrl : "",
        }))
      : [],
  };
}

// --------------------------------------------------------------- validation

const isBool = (v: unknown) => typeof v === "boolean";
const isHttpsUrl = (v: unknown) => typeof v === "string" && /^https:\/\/\S+$/i.test(v.trim());
const tsOrNull = (v: unknown) => v === null || (typeof v === "number" && Number.isFinite(v) && v > 0);

/**
 * Validate (and normalise, in place) the App Control parts of an admin patch.
 * `existing` is the stored config. Throws `invalid-argument` with a message an
 * admin can act on. Other sections are validated elsewhere and pass through.
 */
export function validateAppControlPatch(body: any, existing: any, nowMs: number = Date.now()): void {
  const bad = (m: string): never => {
    throw httpsError("invalid-argument", m);
  };
  if (!body || typeof body !== "object") return;

  for (const k of ["maintenanceMode", "forceUpdate"]) {
    if (body[k] !== undefined && !isBool(body[k])) bad(`${k} must be true or false.`);
  }
  if (body.maintenanceMessage !== undefined) {
    if (typeof body.maintenanceMessage !== "string") bad("maintenanceMessage must be text.");
    body.maintenanceMessage = body.maintenanceMessage.trim();
    if (body.maintenanceMessage.length > MAX_MESSAGE) bad(`Maintenance message: at most ${MAX_MESSAGE} characters.`);
  }
  if (body.maintenanceEta !== undefined && !tsOrNull(body.maintenanceEta)) bad("maintenanceEta must be a time or null.");
  if (body.maintenanceSchedule !== undefined && body.maintenanceSchedule !== null) {
    const s = body.maintenanceSchedule;
    if (typeof s !== "object") bad("maintenanceSchedule must be an object or null.");
    const start = s.startAt ?? null;
    const end = s.endAt ?? null;
    if (!tsOrNull(start) || !tsOrNull(end)) bad("Schedule start and end must be times.");
    if ((start === null) !== (end === null)) bad("Schedule needs both a start and an end (or neither).");
    if (start !== null && end <= start) bad("Schedule end must be after its start.");
    if (start !== null && end <= nowMs) bad("Schedule end is already in the past.");
    if (start !== null && end - start > 7 * 86_400_000) bad("A scheduled maintenance can last at most 7 days.");
    if (s.notice !== undefined && (typeof s.notice !== "string" || s.notice.length > MAX_MESSAGE)) {
      bad(`Schedule notice: text, at most ${MAX_MESSAGE} characters.`);
    }
    body.maintenanceSchedule = start === null ? null : { startAt: start, endAt: end, notice: (s.notice || "").trim() };
  }

  if (body.forceUpdateMode !== undefined && !(UPDATE_MODES as readonly string[]).includes(body.forceUpdateMode)) {
    bad("forceUpdateMode must be 'hard' or 'soft'.");
  }
  if (body.minAppVersion !== undefined) {
    if (typeof body.minAppVersion !== "string") bad("minAppVersion must be text.");
    body.minAppVersion = body.minAppVersion.trim();
    if (body.minAppVersion && !VERSION_RE.test(body.minAppVersion)) bad("Minimum version must look like 1.4.0.");
  }
  if (body.updateUrls !== undefined) {
    const u = body.updateUrls;
    if (!u || typeof u !== "object") bad("updateUrls must be an object.");
    for (const p of ["android", "ios"]) {
      if (u[p] === undefined || u[p] === "" || u[p] === null) {
        if (u[p] !== undefined) u[p] = "";
        continue;
      }
      if (!isHttpsUrl(u[p])) bad(`${p} store link must be an https:// URL.`);
      u[p] = String(u[p]).trim();
    }
  }
  if (body.updateMessage !== undefined) {
    if (typeof body.updateMessage !== "string" || body.updateMessage.length > MAX_MESSAGE) bad("Update message: text, at most 500 characters.");
  }
  const forceOn = body.forceUpdate ?? existing?.forceUpdate;
  const minV = body.minAppVersion ?? existing?.minAppVersion;
  if (forceOn === true && !minV) bad("Force update needs a minimum version.");

  if (body.announcement !== undefined) {
    const a = body.announcement;
    if (!a || typeof a !== "object") bad("announcement must be an object.");
    if (a.enabled !== undefined && !isBool(a.enabled)) bad("announcement.enabled must be true or false.");
    if (a.message !== undefined) {
      if (typeof a.message !== "string") bad("Announcement message must be text.");
      a.message = a.message.trim();
      if (a.message.length > MAX_ANNOUNCEMENT) bad(`Announcement: at most ${MAX_ANNOUNCEMENT} characters.`);
    }
    if (a.tone !== undefined && !(ANNOUNCEMENT_TONES as readonly string[]).includes(a.tone)) bad("Unknown announcement tone.");
    if (a.audience !== undefined && !(ANNOUNCEMENT_AUDIENCES as readonly string[]).includes(a.audience)) bad("Unknown announcement audience.");
    for (const k of ["startAt", "endAt"]) if (a[k] !== undefined && !tsOrNull(a[k])) bad(`announcement.${k} must be a time or null.`);
    const start = a.startAt !== undefined ? a.startAt : existing?.announcement?.startAt ?? null;
    const end = a.endAt !== undefined ? a.endAt : existing?.announcement?.endAt ?? null;
    if (start && end && end <= start) bad("Announcement end must be after its start.");
    const enabled = a.enabled ?? existing?.announcement?.enabled;
    const message = a.message ?? existing?.announcement?.message;
    if (enabled === true && !String(message || "").trim()) bad("An enabled announcement needs a message.");
    // A changed message/link/tone (or an explicit republish) is a NEW announcement:
    // users who dismissed the old one see this one.
    const prev = existing?.announcement || {};
    const changed =
      (a.message !== undefined && a.message !== (prev.message || "")) ||
      (a.link !== undefined && a.link !== (prev.link || "")) ||
      (a.tone !== undefined && a.tone !== (prev.tone || "info"));
    if (a.republish === true || changed || !prev.id) a.id = crypto.randomUUID().slice(0, 8);
    delete a.republish;
  }

  if (body.features !== undefined) {
    const f = body.features;
    if (!f || typeof f !== "object" || Array.isArray(f)) bad("features must be an object.");
    for (const [k, v] of Object.entries(f)) {
      if (!(FEATURE_KEYS as readonly string[]).includes(k)) bad(`Unknown feature '${k}'.`);
      if (!isBool(v)) bad(`features.${k} must be true or false.`);
    }
  }

  if (body.withdrawal !== undefined) {
    const w = body.withdrawal;
    if (!w || typeof w !== "object") bad("withdrawal must be an object.");
    for (const k of ["enabled", "payoutsFrozen"]) if (w[k] !== undefined && !isBool(w[k])) bad(`withdrawal.${k} must be true or false.`);
    for (const k of ["minAmount", "maxAmount", "maxPerDay"]) {
      if (w[k] === undefined) continue;
      const n = Number(w[k]);
      if (w[k] === "" || w[k] === null || !Number.isInteger(n) || n < 0 || n > 10_000_000) {
        bad(`withdrawal.${k} must be a whole number of coins from 0 to 10000000 (0 = no limit).`);
      }
      w[k] = n;
    }
    if (w.conversionRate !== undefined) {
      const r = Number(w.conversionRate);
      if (!Number.isFinite(r) || r <= 0 || r > 1000) bad("Coin → ₹ rate must be more than 0.");
      w.conversionRate = r;
    }
    const merged = { ...(existing?.withdrawal || {}), ...w };
    if (Number(merged.maxAmount) > 0 && Number(merged.minAmount) > Number(merged.maxAmount)) {
      bad("Minimum payout cannot be more than the maximum.");
    }
  }
  // Coin package buy rate (lib/coinPricing.ts). Checked against the packages by
  // the save handler, which has them.
  if (body.coinPricing !== undefined) validateCoinPricingPatch(body.coinPricing);
}

// ---------------------------------------------------------------- the gate

/** /api actions that belong to each feature switch. */
export const FEATURE_ACTIONS: Record<FeatureKey, string[]> = {
  contests: ["startMatch", "joinMatch", "join", "submitVote", "vote", "setMatchVsImage"],
  chat: ["startChat", "sendMessage", "setTyping"],
  stories: ["createStory", "getStoryUrl", "reactToStory", "createHighlight", "addStoryToHighlight"],
  topups: ["createOrder", "topup", "requestDeposit"],
  withdrawals: ["requestWithdrawal"],
  posts: ["createPost"],
};
const ACTION_FEATURE = new Map<string, FeatureKey>(
  Object.entries(FEATURE_ACTIONS).flatMap(([f, acts]) => acts.map((a) => [a, f as FeatureKey] as const)),
);
export const featureForAction = (action: string): FeatureKey | null => ACTION_FEATURE.get(action) ?? null;

/**
 * /api actions still allowed for everyone during maintenance: housekeeping a
 * user may need while the app is closed (push tokens, sign-out, support, account
 * deletion status). Everything else waits.
 */
export const MAINTENANCE_ALLOWED_ACTIONS = new Set([
  "registerFcmToken",
  "unregisterFcmToken",
  "logoutAllDevices",
  "notifyPasswordChanged",
  "accountDeletionStatus",
  "cancelAccountDeletion",
  "createSupportTicket",
  "getNotificationPrefs",
  "dismissAnnouncement",
]);

export const STAFF_ROLES = new Set(["superadmin", "admin", "moderator"]);

const FEATURE_LABEL: Record<FeatureKey, string> = {
  contests: "Contests",
  chat: "Chat",
  stories: "Stories",
  topups: "Coin top-up",
  withdrawals: "Withdrawals",
  posts: "Posts",
};

export interface GateInput {
  action: string | null;
  role?: string | null;
  platform?: string | null;
  appVersion?: string | null;
}

/** Throw if this request must be refused under the current App Control state. */
export function appControlGate(cfg: any, input: GateInput, nowMs: number = Date.now()): void {
  if (input.role && STAFF_ROLES.has(input.role)) return;
  const maintenance = resolveMaintenance(cfg, nowMs);
  if (maintenance.active && !(input.action && MAINTENANCE_ALLOWED_ACTIONS.has(input.action))) {
    throw httpsError(
      "unavailable",
      maintenance.message || "TopHunt abhi maintenance mein hai. Thodi der baad try karo.",
      "maintenance",
    );
  }
  // Native builds only: web is always the latest build.
  if (input.platform === "android" || input.platform === "ios") {
    const update = resolveUpdatePolicy(cfg);
    if (update.enabled && update.mode === "hard" && input.appVersion && compareVersions(input.appVersion, update.minVersion) < 0) {
      throw httpsError(
        "failed-precondition",
        update.message || "App ka naya version available hai. Aage badhne ke liye update karo.",
        "update_required",
      );
    }
  }
  const feature = input.action ? featureForAction(input.action) : null;
  if (feature && !resolveFeatures(cfg)[feature]) {
    throw httpsError("failed-precondition", `${FEATURE_LABEL[feature]} abhi band hai. Thodi der baad try karo.`, "feature_disabled");
  }
}

/** Sections whose edits are audited (who changed what, from what, to what). */
export const AUDITED_SECTIONS = [
  "coinPricing",
  "verificationReward",
  "rewardSettings",
  "onboarding",
  "onboardingEnabled",
  "authMethods",
  "maintenanceMode",
  "maintenanceMessage",
  "maintenanceEta",
  "maintenanceSchedule",
  "forceUpdate",
  "forceUpdateMode",
  "minAppVersion",
  "updateUrls",
  "updateMessage",
  "announcement",
  "features",
  "withdrawal",
] as const;
