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
import { pricePackage, ratesFromConfig } from "./coinPricing";
import { budgetsWithRoom } from "./promoBudget";

export interface PublicCoinPackage {
  id: string;
  name: string | null;
  coins: number;
  bonusCoins: number;
  /** Base coins × buy rate (lib/coinPricing.ts). Bonus coins are free. */
  priceInr: number;
  totalCoins: number;
  /** False when under ₹1, or when it would pay out more than it costs: shown, not sold. */
  purchasable: boolean;
  /** The bonus is a platform promo (lib/promoBudget.ts): play-only coins, not withdrawable. */
  bonusLocked: boolean;
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
  const rates = ratesFromConfig(cfg);
  // A promo bonus is only shown while its budget can still pay it: once the
  // budget runs out, pauses or ends, the package sells without the bonus — the
  // same thing `createOrder` does — so the store never advertises coins the
  // purchase will not credit.
  const room = await budgetsWithRoom(env, rows.map((p: any) => p.budgetId).filter(Boolean));
  return rows.map((p: any) => {
    const priced = pricePackage(p, rates);
    const promoOff = priced.bonusLocked && (room.get(p.budgetId) ?? 0) < priced.bonusCoins;
    const bonusCoins = promoOff ? 0 : priced.bonusCoins;
    return {
      id: p.id,
      name: p.name ?? null,
      coins: priced.baseCoins,
      bonusCoins,
      priceInr: priced.priceInr,
      totalCoins: priced.baseCoins + bonusCoins,
      purchasable: priced.purchasable,
      bonusLocked: priced.bonusLocked && !promoOff,
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
