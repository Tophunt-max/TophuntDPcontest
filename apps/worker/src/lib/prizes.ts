/**
 * What a contest awards, and what a specific match therefore owes its winner.
 *
 * A contest awards EITHER coins OR a physical product, never both.
 *
 * ---------------------------------------------------------------------------
 * Why a product is not just a big `rewardCoins`
 * ---------------------------------------------------------------------------
 * `assertPrizeFundedByPot` (lib/money.ts) refuses any contest whose `rewardCoins`
 * exceeds the pot the two players funded, because `rewardCoins` is credited
 * directly to a wallet — unbounded, it is a coin printer, and that assertion is
 * the only thing standing between an admin typo and the coin supply. A phone has
 * no coin value, so expressing it as coins would mean either weakening that rule
 * or misstating the prize.
 *
 * So the two kinds live in separate columns and a product contest keeps
 * `rewardCoins` at 0. The pot rule then holds trivially rather than being
 * bypassed, and the entry fees such a contest collects are simply retained — which
 * is what pays for the product.
 *
 * ---------------------------------------------------------------------------
 * Snapshot-first resolution
 * ---------------------------------------------------------------------------
 * `resolveMatchPrize` reads the MATCH's own snapshot before the template, for the
 * reason already documented on `contest_matches.prizeCoins`: settlement must pay
 * what was promised when the battle started, so editing a template cannot change
 * the prize of a match already in flight. A NULL snapshot means "legacy row" and
 * falls back to the template, exactly as `prizeCoins` and `minVotesRequired` do.
 */
import { httpsError } from "./http";

export type PrizeType = "coins" | "product";

export const PRIZE_TYPES: readonly PrizeType[] = ["coins", "product"] as const;

/** Bounds for the admin-supplied product fields. */
export const PRODUCT_TITLE_MAX = 120;
export const PRODUCT_DESCRIPTION_MAX = 1000;
export const PRODUCT_VALUE_MAX = 100_000_000;

/** The product half of a prize, once resolved. */
export interface ProductPrize {
  title: string;
  imageUrl: string | null;
  /** Declared retail value. Display only — never credited, never spendable. */
  value: number;
  description?: string | null;
}

/** What a match owes its winner. Exactly one of `coins` / `product` is meaningful. */
export interface ResolvedPrize {
  type: PrizeType;
  /** Coins to credit. Always 0 for a product prize. */
  coins: number;
  /** Set only when `type === "product"`. */
  product: ProductPrize | null;
}

/** Anything carrying the prize columns — a contest row or a match snapshot. */
export interface PrizeFields {
  prizeType?: string | null;
  prizeProductTitle?: string | null;
  prizeProductImageUrl?: string | null;
  prizeProductValue?: number | null;
  prizeProductDescription?: string | null;
}

/**
 * Coerce a stored/incoming value to a known prize type.
 *
 * Anything unrecognised — including NULL on a row written before migration 0042 —
 * reads as "coins". That is the safe direction: an unknown value must not make a
 * coin contest silently owe a product nobody has, and every pre-0042 contest was a
 * coin contest by definition.
 */
export function normalizePrizeType(value: unknown): PrizeType {
  return value === "product" ? "product" : "coins";
}

/** True when this row describes a physical prize. */
export function isProductPrize(row: PrizeFields | null | undefined): boolean {
  return normalizePrizeType(row?.prizeType) === "product";
}

function productFrom(row: PrizeFields): ProductPrize | null {
  const title = typeof row.prizeProductTitle === "string" ? row.prizeProductTitle.trim() : "";
  if (!title) return null;
  const value = Number(row.prizeProductValue ?? 0);
  return {
    title,
    imageUrl: typeof row.prizeProductImageUrl === "string" && row.prizeProductImageUrl
      ? row.prizeProductImageUrl
      : null,
    value: Number.isFinite(value) && value > 0 ? value : 0,
    description: typeof row.prizeProductDescription === "string" && row.prizeProductDescription
      ? row.prizeProductDescription
      : null,
  };
}

/**
 * Resolve the prize a match owes, preferring its own immutable snapshot.
 *
 * `coinFallback` is the caller's already-clamped coin figure (cron and the admin
 * declare-winner path each compute it against `matchPot`, and this function must
 * not second-guess that arithmetic).
 *
 * Returns a COIN prize when a product prize is claimed but no title survives.
 * Losing the title means we cannot say what was won, and paying the clamped coin
 * figure is the outcome that leaves the winner no worse off than a coin contest
 * would have — whereas creating a claim for an unnamed product would leave an
 * admin holding a delivery request for "something".
 */
export function resolveMatchPrize(
  matchSnapshot: PrizeFields | null | undefined,
  template: PrizeFields | null | undefined,
  coinFallback: number,
): ResolvedPrize {
  const coins = Number.isFinite(coinFallback) && coinFallback > 0 ? coinFallback : 0;

  // A snapshot exists the moment `prizeType` is non-null; only then may it win
  // over the template.
  const snapshotDeclared = matchSnapshot?.prizeType != null;
  const source: PrizeFields | null | undefined = snapshotDeclared ? matchSnapshot : template;
  if (!source || !isProductPrize(source)) return { type: "coins", coins, product: null };

  const product = productFrom(source);
  if (!product) return { type: "coins", coins, product: null };

  // A product prize pays no coins, whatever the coin column happens to hold.
  return { type: "product", coins: 0, product };
}

/**
 * Validate an admin-supplied product prize, returning the normalised fields.
 *
 * Throws `invalid-argument` rather than silently coercing: a prize is a promise to
 * a user, and a contest that goes live advertising a blank product name is worse
 * than one that failed to save.
 */
export function assertProductPrize(input: {
  title: unknown;
  imageUrl: unknown;
  value: unknown;
  description?: unknown;
}): ProductPrize {
  const title = typeof input.title === "string" ? input.title.trim() : "";
  if (!title) {
    throw httpsError("invalid-argument", "A product prize needs a product name.");
  }
  if (title.length > PRODUCT_TITLE_MAX) {
    throw httpsError("invalid-argument", `Product name must be ${PRODUCT_TITLE_MAX} characters or fewer.`);
  }

  // The image is required, not optional. This is the one field that makes a
  // physical prize believable, it is shown on every card, and a product card with
  // an empty image well reads as a broken app rather than as a prize.
  const imageUrl = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
  if (!imageUrl) {
    throw httpsError("invalid-argument", "A product prize needs a product image.");
  }
  if (imageUrl.length > 2048) {
    throw httpsError("invalid-argument", "Product image URL is too long.");
  }
  let parsed: URL;
  try {
    parsed = new URL(imageUrl);
  } catch {
    throw httpsError("invalid-argument", "Product image must be a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw httpsError("invalid-argument", "Product image must be an http(s) URL.");
  }

  const rawValue = input.value;
  const value =
    rawValue === null || rawValue === undefined || rawValue === "" ? 0 : Number(rawValue);
  if (!Number.isFinite(value) || value < 0 || value > PRODUCT_VALUE_MAX) {
    throw httpsError("invalid-argument", `Product value must be between 0 and ${PRODUCT_VALUE_MAX}.`);
  }

  let description: string | null = null;
  if (input.description !== undefined && input.description !== null && input.description !== "") {
    if (typeof input.description !== "string") {
      throw httpsError("invalid-argument", "Product description must be text.");
    }
    const trimmed = input.description.trim();
    if (trimmed.length > PRODUCT_DESCRIPTION_MAX) {
      throw httpsError(
        "invalid-argument",
        `Product description must be ${PRODUCT_DESCRIPTION_MAX} characters or fewer.`,
      );
    }
    description = trimmed || null;
  }

  return { title, imageUrl, value: Math.round(value), description };
}

/**
 * The public shape of a prize, for `/read` payloads and the app.
 *
 * One helper so Explore, both contest lists, the setup screens and the battle card
 * cannot each invent their own idea of what a prize looks like — which is exactly
 * how entry pricing ended up being computed five different ways before
 * `contestPricing` existed.
 */
export function publicPrize(row: PrizeFields & { rewardCoins?: number | null }): {
  prizeType: PrizeType;
  prizeProductTitle: string | null;
  prizeProductImageUrl: string | null;
  prizeProductValue: number;
  prizeProductDescription: string | null;
} {
  const type = normalizePrizeType(row?.prizeType);
  const product = type === "product" ? productFrom(row) : null;
  return {
    prizeType: product ? "product" : "coins",
    prizeProductTitle: product?.title ?? null,
    prizeProductImageUrl: product?.imageUrl ?? null,
    prizeProductValue: product?.value ?? 0,
    prizeProductDescription: product?.description ?? null,
  };
}
