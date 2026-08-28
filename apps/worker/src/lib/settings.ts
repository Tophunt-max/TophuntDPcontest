/**
 * App settings (was settings/appConfig, settings/gamification) read from D1 and
 * cached in KV for a short TTL to avoid a DB hit on hot paths.
 */
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";

const CACHE_TTL = 60; // seconds

async function readSetting(env: Env, id: string): Promise<any> {
  const cacheKey = `settings:${id}`;
  const cached = await env.CACHE_KV.get(cacheKey, "json");
  if (cached) return cached;

  const db = getDb(env);
  const row = await db.select().from(schema.settings).where(eq(schema.settings.id, id)).get();
  const data = row?.data ?? {};
  // Never let a KV write failure (e.g. the daily put() quota being exhausted)
  // break config reads — we already have the data from D1. Fail open: skip the
  // cache write and just serve the fresh value.
  try {
    await env.CACHE_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: CACHE_TTL });
  } catch (e) {
    console.error("[settings] cache write failed (continuing)", e);
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

/** Invalidate a cached setting (call after admin updates it). */
export async function invalidateSetting(env: Env, id: string): Promise<void> {
  await env.CACHE_KV.delete(`settings:${id}`);
}
