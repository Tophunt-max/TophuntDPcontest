/**
 * App settings (was settings/appConfig, settings/gamification) read from D1 and
 * cached in KV for a short TTL to avoid a DB hit on hot paths.
 */
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { delCache, kvWritesDisabled } from "./cache";

/**
 * KV lifetime.
 *
 * Raised 60s -> 600s -> 1800s, and that is where the write saving comes from.
 * Freshness does NOT depend on the ttl — every admin write calls
 * `invalidateSetting`, which DELETES the key, and a KV delete is visible to every
 * isolate and colo. So the ttl is only a backstop against a missed invalidation, and
 * at 60s it was an expensive one: `getAppConfig` / `getGamificationSettings` are
 * called from 14 places including the feed ranker and `/app-config` (which the app
 * polls hard), so the key was re-written up to 1,440 times a day per settings id
 * purely to re-cache a blob that had not changed. At 600s that was ~144, and at
 * 1800s it is ~48 — across `appConfig`, `gamification` and `seoAudit`, ~144/day in
 * total rather than ~4,300.
 *
 * NOT moved to the Cache API or to isolate memory, and NOT for lack of trying —
 * `appConfig` carries `payoutsFrozen`, the emergency switch that blocks all new
 * payout requests during a suspected-fraud incident. Both of those tiers are
 * unpurgeable from anywhere but the isolate/colo that wrote them, so either would
 * mean the kill-switch takes effect everywhere EXCEPT the machines already serving
 * traffic, for as long as its ttl. A fraud switch that is live in one colo is not a
 * switch. KV's globally-visible delete is exactly the property this needs, so this
 * cache stays on KV by design and pays for it with a long backstop instead.
 *
 * (The same argument, in the same words, applies to `cache:blocks:*` — see
 * lib/blocks.ts.)
 */
const CACHE_TTL = 1800;

async function readSetting(env: Env, id: string): Promise<any> {
  const cacheKey = `settings:${id}`;

  // A KV read throwing used to 500 the request. Settings are read on hot paths
  // (and on the feed), so a transport blip degrading to "read it from D1" is the
  // behaviour every other cache in this codebase already has.
  let cached: any = null;
  try {
    cached = await env.CACHE_KV.get(cacheKey, "json");
  } catch (e) {
    console.error("[settings] cache read failed (continuing)", id, e);
  }
  if (cached) return cached;

  const db = getDb(env);
  const row = await db.select().from(schema.settings).where(eq(schema.settings.id, id)).get();
  const data = row?.data ?? {};
  // Never let a KV write failure (e.g. the daily put() quota being exhausted)
  // break config reads — we already have the data from D1. Fail open: skip the
  // cache write and just serve the fresh value.
  if (!kvWritesDisabled(env)) {
    try {
      await env.CACHE_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: CACHE_TTL });
    } catch (e) {
      console.error("[settings] cache write failed (continuing)", e);
    }
  }
  return data;
}

/** Reward coins are credited straight to a balance, so cap them and never mint. */
export const MAX_REWARD_COINS = 1_000_000;

/**
 * Floor a stored reward-coin value to a safe whole number.
 *
 * `appConfig.rewardSettings` is the single source of truth for the signup and
 * referral bonuses (both are credited straight to `users.dpcoin`). The write path
 * (`POST /admin/app-settings`) rejects bad input, and this is the second line of
 * defence for values stored before that check — a fraction is floored (never pays
 * more than intended) and a negative/NaN falls back to the default rather than
 * silently DEBITING a new user.
 */
function sanitizeRewardCoins(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(MAX_REWARD_COINS, Math.floor(n));
}

/**
 * The signup and referral welcome bonuses, both sourced from
 * `appConfig.rewardSettings`. This is the ONE place either value is read for
 * crediting — the gamification row no longer carries them, so the admin's App
 * Settings fields are authoritative.
 */
export async function getRewardSettings(env: Env): Promise<{ signupBonus: number; referralBonus: number }> {
  const cfg = await readSetting(env, "appConfig");
  const rs = (cfg?.rewardSettings ?? {}) as Record<string, unknown>;
  return {
    signupBonus: sanitizeRewardCoins(rs.signupBonus, 100),
    referralBonus: sanitizeRewardCoins(rs.referralBonus, 50),
  };
}

export async function getGamificationSettings(env: Env): Promise<any> {
  return readSetting(env, "gamification");
}

export async function getAppConfig(env: Env): Promise<any> {
  return readSetting(env, "appConfig");
}

/**
 * The most recent SEO audit, or null before the first run.
 *
 * Stored as a settings blob rather than in its own table: the dashboard only ever
 * wants the latest result, and a full audit is one JSON document. Run *history*
 * is already covered by `cron_runs`, which records each audit's score summary.
 */
export async function getSeoAudit(env: Env): Promise<any | null> {
  const data = await readSetting(env, "seoAudit");
  return data && (data as any).ranAt ? data : null;
}

export interface RewardedAdConfig {
  /** Master switch. Rewarded ads are OFF until an admin turns them on. */
  enabled: boolean;
  /**
   * Credit on the client's word alone. Only safe with a provider that has no
   * server-side verification, and only as a conscious decision — a rewarded ad
   * mints withdrawable currency, so an unverified claim is a coin printer.
   */
  trustClient: boolean;
  provider: string | null;
  reward: number;
  dailyCap: number;
}

/**
 * Rewarded-ad policy, read from admin App Control with fail-CLOSED defaults.
 *
 * Every default here is the safe one: disabled, no client trust, small reward,
 * small cap. A misconfigured or empty `appConfig` therefore cannot mint coins.
 */
export async function getRewardedAdConfig(env: Env): Promise<RewardedAdConfig> {
  const cfg = await readSetting(env, "appConfig");
  const ads = (cfg?.ads ?? {}) as Record<string, unknown>;
  const asPositiveInt = (value: unknown, fallback: number, max: number): number => {
    const n = Number(value);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
    return Math.min(n, max);
  };
  return {
    enabled: ads.enabled === true,
    trustClient: ads.trustClient === true,
    provider: typeof ads.provider === "string" && ads.provider ? ads.provider : null,
    reward: asPositiveInt(ads.reward, 5, 100),
    dailyCap: asPositiveInt(ads.dailyCap, 10, 100),
  };
}

/**
 * Invalidate a cached setting (call after admin updates it).
 *
 * This is what makes the long `CACHE_TTL` above safe: a delete reaches every
 * isolate, so an admin edit is live immediately rather than after the ttl.
 *
 * Goes through `delCache` rather than `env.CACHE_KV.delete` so it also clears the
 * isolate memo. Settings are not memoised today and deliberately so (see
 * CACHE_TTL), which makes this inert right now — but lib/memo.ts states
 * "delCache clears the memo" as the invariant that makes memoising a key safe at
 * all, and a hand-rolled delete here is exactly the hole the next person to
 * memoise something would not think to look for.
 */
export async function invalidateSetting(env: Env, id: string): Promise<void> {
  await delCache(env, `settings:${id}`);
}
