/**
 * The public coin-package catalog (wallet store + manual deposit), and its
 * realtime push.
 *
 * Read straight from D1, never edge-cached: it is a handful of indexed rows read
 * only when someone opens the store, and an edge copy is exactly what kept an
 * edited price on screen after the admin changed it (cached hits also carried
 * the zone's 4-hour browser TTL). Purchases never trust this list anyway —
 * `createOrder` / `requestDeposit` re-read the package from D1 — so this is about
 * the user SEEING the right price, instantly.
 */
import { asc, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { appConfigChannels } from "./appControl";
import { publishMany } from "./publish";
import { getAppConfig } from "./settings";
import { coinValueFromConfig, pricePackage } from "./coinPricing";

export interface PublicCoinPackage {
  id: string;
  name: string | null;
  coins: number;
  bonusCoins: number;
  /** Base coins × coin value (lib/coinPricing.ts). Bonus coins are free. */
  priceInr: number;
  totalCoins: number;
  /** False when the price is under ₹1 (or the coin value is unusable): shown, not sold. */
  purchasable: boolean;
}

export async function listPublicCoinPackages(env: Env): Promise<PublicCoinPackage[]> {
  const [rows, cfg] = await Promise.all([
    getDb(env)
    .select()
    .from(schema.coinPackages)
    .where(eq(schema.coinPackages.active, true))
    .orderBy(asc(schema.coinPackages.sortOrder))
    .all(),
    getAppConfig(env),
  ]);
  const rate = coinValueFromConfig(cfg);
  return rows.map((p: any) => {
    const priced = pricePackage(p, rate);
    return {
      id: p.id,
      name: p.name ?? null,
      coins: priced.baseCoins,
      bonusCoins: priced.bonusCoins,
      priceInr: priced.priceInr,
      totalCoins: priced.totalCoins,
      purchasable: priced.purchasable,
    };
  });
}

/**
 * Push the current catalog to every open app (the App Control shards, which
 * every app instance — signed in or not — listens on). `version` is the push
 * time; the app ignores a push older than the copy it has.
 */
export async function publishCoinCatalog(env: Env): Promise<void> {
  try {
    const packages = await listPublicCoinPackages(env);
    await publishMany(env, appConfigChannels(), { type: "coin-packages", version: Date.now(), packages });
  } catch (e) {
    console.error("[coinCatalog] publish failed (continuing)", e);
  }
}
