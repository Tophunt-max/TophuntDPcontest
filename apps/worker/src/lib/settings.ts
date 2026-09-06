/**
 * App settings (was settings/appConfig, settings/gamification) read from D1 and
 * cached in KV for a short TTL to avoid a DB hit on hot paths.
 */
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { kvWritesDisabled } from "./cache";
import { memoDelete, memoGet, memoPut } from "./memo";

/**
 * KV lifetime.
 *
 * Raised from 60s. Freshness here does NOT come from the ttl — every admin write
 * calls `invalidateSetting`, which deletes the key — so the ttl is only a
 * backstop against a missed invalidation. At 60s it was an expensive backstop:
 * `getAppConfig` / `getGamificationSettings` are called from 14 places including
 * the feed ranker and `/app-config` (which the app polls hard), so the key was
 * re-written up to 1,440 times a day per settings id purely to re-cache a blob
 * that had not changed.
 */
const CACHE_TTL = 600;

/**
 * Isolate-memory lifetime — the layer that actually removes the writes.
 *
 * Short on purpose. An admin edit deletes the KV key but cannot reach another
 * isolate's memory, so this value IS the worst-case delay before a config change
 * is live everywhere. 30s is under the 60s that the old KV ttl already imposed on
 * every reader, so no caller sees staler config than it did before.
 */
const MEMO_TTL = 30;

async function readSetting(env: Env, id: string): Promise<any> {
  const cacheKey = `settings:${id}`;

  const memo = memoGet<any>(cacheKey);
  if (memo !== undefined) return memo;

  // A KV read throwing used to 500 the request. Settings are read on hot paths
  // (and on the feed), so a transport blip degrading to "read it from D1" is the
  // behaviour every other cache in this codebase already has.
  let cached: any = null;
  try {
    cached = await env.CACHE_KV.get(cacheKey, "json");
  } catch (e) {
    console.error("[settings] cache read failed (continuing)", id, e);
  }
  if (cached) {
    memoPut(cacheKey, cached, MEMO_TTL);
    return cached;
  }

  const db = getDb(env);
  const row = await db.select().from(schema.settings).where(eq(schema.settings.id, id)).get();
  const data = row?.data ?? {};
  memoPut(cacheKey, data, MEMO_TTL);
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

export async function getRewardSettings(env: Env): Promise<{ signupBonus: number; [k: string]: any }> {
  const cfg = await readSetting(env, "appConfig");
  return cfg?.rewardSettings ?? { signupBonus: 100 };
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
 * Drops the isolate copy as well as the KV key. Without the `memoDelete` the
 * admin panel would write a setting, re-read it on the very next request, and be
 * served the pre-edit value out of the same isolate's memory — which reads as
 * "the save did not work".
 */
export async function invalidateSetting(env: Env, id: string): Promise<void> {
  const cacheKey = `settings:${id}`;
  memoDelete(cacheKey);
  await env.CACHE_KV.delete(cacheKey);
}
