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
  await env.CACHE_KV.put(cacheKey, JSON.stringify(data), { expirationTtl: CACHE_TTL });
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

/** Invalidate a cached setting (call after admin updates it). */
export async function invalidateSetting(env: Env, id: string): Promise<void> {
  await env.CACHE_KV.delete(`settings:${id}`);
}
