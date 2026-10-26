/**
 * For You ranking weights: defaults, the range each one may take, and the
 * ranking version that identifies which weights produced a page.
 *
 * Defaults live here and can be overridden at runtime from the
 * `appConfig.feedWeights` setting, so a weight can be tuned without a redeploy.
 * Two guards keep an override from breaking the feed:
 *   - `validateFeedWeightsPatch` refuses an out-of-range or unknown key at admin
 *     save time, with a message naming the key and its range;
 *   - `sanitizeFeedWeights` clamps again at read time, so a value written before
 *     validation existed (or straight into D1) can never invert or blow up the
 *     ranking. A negative `votedPenalty`, for example, would PROMOTE battles the
 *     viewer already voted on.
 *
 * `rankingVersion` names the algorithm plus a hash of the effective weights. It is
 * sent as `X-Feed-Ranking` and is part of the per-viewer order-cache key, so a
 * weight change takes effect on the next request instead of after the order
 * cache expires, and a page can be traced to the weights that ranked it.
 * Rollback is a save of the previous weights (or `feedWeights: null` for the
 * defaults); the audit log records every change with before/after values.
 */
import { httpsError } from "./http";

export interface FeedWeights {
  freshness: number;
  velocity: number;
  urgency: number;
  prize: number;
  follow: number;
  votedAffinity: number;
  visitAffinity: number;
  votedPenalty: number;
  seenPenalty: number;
  seenCap: number;
  /** Prominence bump for a freshly finished battle's result. */
  result: number;
  /** Extra bump when the viewer voted on that finished battle. */
  resultVotedBoost: number;
  /** Cold-start exploration: bump for a live battle with a new, small creator. */
  newCreator: number;
  /** Demotion for battles featuring a creator the viewer marked "Not interested". */
  notInterested: number;
}

export const FEED_DEFAULT_WEIGHTS: Readonly<FeedWeights> = Object.freeze({
  freshness: 2.2,
  velocity: 1.6,
  urgency: 1.2,
  prize: 0.3,
  follow: 3.0,
  votedAffinity: 1.5,
  visitAffinity: 1.0,
  votedPenalty: 1.5,
  seenPenalty: 0.6,
  seenCap: 5,
  result: 2.6,
  resultVotedBoost: 2.0,
  newCreator: 0.8,
  notInterested: 2.0,
});

/**
 * Inclusive range per weight. Every signal is added or subtracted by the code
 * that uses it, so none may go negative. The upper bound is ~3-5x the default:
 * room to tune, but no single signal can drown every other one.
 */
export const FEED_WEIGHT_BOUNDS: Readonly<Record<keyof FeedWeights, readonly [number, number]>> = Object.freeze({
  freshness: [0, 10],
  velocity: [0, 10],
  urgency: [0, 10],
  prize: [0, 5],
  follow: [0, 10],
  votedAffinity: [0, 10],
  visitAffinity: [0, 10],
  votedPenalty: [0, 10],
  seenPenalty: [0, 5],
  seenCap: [0, 20],
  result: [0, 10],
  resultVotedBoost: [0, 10],
  newCreator: [0, 5],
  notInterested: [0, 10],
});

/** Integer-valued weights (a count, not a multiplier). */
export const INTEGER_WEIGHTS: ReadonlySet<keyof FeedWeights> = new Set<keyof FeedWeights>(["seenCap"]);

/** Bump this when the scoring code changes, not when weights change. */
export const FEED_RANKING_ALGORITHM = "foryou-2";

const KEYS = Object.keys(FEED_DEFAULT_WEIGHTS) as Array<keyof FeedWeights>;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, v));

/**
 * Effective weights from a stored override: defaults for missing or non-numeric
 * keys, every value clamped to its range, unknown keys ignored.
 */
export function sanitizeFeedWeights(raw: unknown): FeedWeights {
  const out = { ...FEED_DEFAULT_WEIGHTS } as FeedWeights;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const src = raw as Record<string, unknown>;
  for (const k of KEYS) {
    const v = src[k];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const c = clamp(v, FEED_WEIGHT_BOUNDS[k]);
    out[k] = INTEGER_WEIGHTS.has(k) ? Math.round(c) : c;
  }
  return out;
}

/**
 * Admin-save check for `body.feedWeights`. `null` resets to the defaults; an
 * object may set any subset of keys (the save merges it over the stored one).
 * Throws `invalid-argument` naming the first bad key.
 */
export function validateFeedWeightsPatch(patch: unknown): void {
  if (patch === undefined || patch === null) return;
  const bad = (m: string): never => {
    throw httpsError("invalid-argument", m);
  };
  if (typeof patch !== "object" || Array.isArray(patch)) bad("feedWeights must be an object, or null for the defaults.");
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in FEED_WEIGHT_BOUNDS)) bad(`feedWeights.${k} is not a ranking weight. Known: ${KEYS.join(", ")}.`);
    const [lo, hi] = FEED_WEIGHT_BOUNDS[k as keyof FeedWeights];
    if (typeof v !== "number" || !Number.isFinite(v) || v < lo || v > hi) {
      bad(`feedWeights.${k} must be a number from ${lo} to ${hi}.`);
    }
    if (INTEGER_WEIGHTS.has(k as keyof FeedWeights) && !Number.isInteger(v)) bad(`feedWeights.${k} must be a whole number.`);
  }
}

/** FNV-1a, 32-bit. Not security-relevant: only tells weight sets apart. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** e.g. `foryou-2.1a2b3c4d`. Same weights → same version, in any key order. */
export function rankingVersion(w: FeedWeights): string {
  return `${FEED_RANKING_ALGORITHM}.${fnv1a(KEYS.map((k) => `${k}=${w[k]}`).join(";"))}`;
}
