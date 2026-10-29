/**
 * Cosmetic catalog, inventory and equipped state.
 *
 * Every item is visual only: a frame, a theme, a title. Nothing here changes a
 * vote, a fee, a prize, feed placement or any permission. Ownership lives in
 * `user_inventory`; what is shown lives in `users.cosmetics` (JSON), and the
 * equip write checks ownership in the SAME statement, so a client can never
 * equip something it does not own.
 */
import type { Env } from "../types";
import { httpsError } from "./http";
import { memoDelete, memoGet, memoPut } from "./memo";

export const ITEM_TYPES = ["frame", "theme", "title", "accessory", "sticker", "effect", "collectible", "badge"] as const;
export type ItemType = (typeof ITEM_TYPES)[number];
/** Slots a user can equip. Stickers and collectibles are shown in the showcase instead. */
export const EQUIP_SLOTS = ["frame", "theme", "title", "badge", "accessory", "effect"] as const;
export type EquipSlot = (typeof EQUIP_SLOTS)[number];
export const RARITIES = ["common", "uncommon", "rare", "epic", "legendary"] as const;

export interface CatalogItem {
  id: string;
  type: ItemType;
  name: string;
  description: string;
  rarity: string;
  asset: Record<string, unknown>;
  active: boolean;
  sort: number;
}

export interface AchievementDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  rarity: string;
  metric: string;
  threshold: number;
  xpReward: number;
  itemId: string | null;
  repeatable: boolean;
  maxTiers: number;
  active: boolean;
  hidden: boolean;
  startsAt: number | null;
  endsAt: number | null;
  sort: number;
  version: number;
}

const CATALOG_MEMO = "memo:gamification:catalog";
const ACHIEVEMENTS_MEMO = "memo:gamification:achievements";
/** Catalog edits are rare and cosmetic; 60s isolate staleness is acceptable. */
const MEMO_TTL = 60;

const parseJson = (v: unknown): any => {
  if (typeof v !== "string") return v ?? {};
  try {
    return JSON.parse(v);
  } catch {
    return {};
  }
};

export async function loadCatalog(env: Env): Promise<CatalogItem[]> {
  const hit = memoGet<CatalogItem[]>(CATALOG_MEMO);
  if (hit) return hit;
  const rows = await env.DB.prepare(`SELECT * FROM reward_catalog ORDER BY sort, id`).all<any>();
  const items: CatalogItem[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    type: r.type,
    name: r.name,
    description: r.description,
    rarity: r.rarity,
    asset: parseJson(r.asset),
    active: !!r.active,
    sort: Number(r.sort),
  }));
  memoPut(CATALOG_MEMO, items, MEMO_TTL);
  return items;
}

export async function loadAchievementDefs(env: Env): Promise<AchievementDef[]> {
  const hit = memoGet<AchievementDef[]>(ACHIEVEMENTS_MEMO);
  if (hit) return hit;
  const rows = await env.DB.prepare(`SELECT * FROM achievement_definitions ORDER BY sort, id`).all<any>();
  const defs: AchievementDef[] = (rows.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    icon: r.icon,
    category: r.category,
    rarity: r.rarity,
    metric: r.metric,
    threshold: Number(r.threshold),
    xpReward: Number(r.xp_reward),
    itemId: r.item_id ?? null,
    repeatable: !!r.repeatable,
    maxTiers: Math.max(1, Number(r.max_tiers) || 1),
    active: !!r.active,
    hidden: !!r.hidden,
    startsAt: r.starts_at ?? null,
    endsAt: r.ends_at ?? null,
    sort: Number(r.sort),
    version: Number(r.version),
  }));
  memoPut(ACHIEVEMENTS_MEMO, defs, MEMO_TTL);
  return defs;
}

/** Drop this isolate's copies after an admin edit. */
export function invalidateGamificationCatalog(): void {
  memoDelete(CATALOG_MEMO, ACHIEVEMENTS_MEMO);
}

export interface EquippedState {
  frame?: string | null;
  theme?: string | null;
  title?: string | null;
  badge?: string | null;
  accessory?: string | null;
  effect?: string | null;
  pinned?: string[];
}

export function parseEquipped(raw: unknown): EquippedState {
  const v = parseJson(raw);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as EquippedState) : {};
}

export interface PublicCosmetics {
  frame: { id: string; name: string; rarity: string; asset: Record<string, unknown> } | null;
  theme: { id: string; name: string; rarity: string; asset: Record<string, unknown> } | null;
  title: { id: string; name: string; rarity: string; text: string } | null;
  badge: { id: string; name: string; rarity: string; asset: Record<string, unknown> } | null;
  accessory: { id: string; name: string; rarity: string; asset: Record<string, unknown> } | null;
  effect: { id: string; name: string; rarity: string; asset: Record<string, unknown> } | null;
  pinned: { id: string; name: string; icon: string; rarity: string; description: string }[];
}

/**
 * What other people see: the equipped items resolved against the catalog, with
 * inactive items dropped. No inventory, no acquisition history.
 */
export async function resolveCosmetics(env: Env, raw: unknown): Promise<PublicCosmetics> {
  const eq = parseEquipped(raw);
  const out: PublicCosmetics = { frame: null, theme: null, title: null, badge: null, accessory: null, effect: null, pinned: [] };
  const hasAny = EQUIP_SLOTS.some((s) => eq[s]) || (eq.pinned?.length ?? 0) > 0;
  if (!hasAny) return out;
  const catalog = await loadCatalog(env);
  const byId = new Map(catalog.map((i) => [i.id, i]));
  for (const slot of EQUIP_SLOTS) {
    const id = eq[slot];
    const item = id ? byId.get(id) : undefined;
    if (!item || !item.active || item.type !== slot) continue;
    if (slot === "title") {
      out.title = { id: item.id, name: item.name, rarity: item.rarity, text: String((item.asset as any)?.text ?? item.name) };
    } else {
      (out as any)[slot] = { id: item.id, name: item.name, rarity: item.rarity, asset: item.asset };
    }
  }
  if (eq.pinned?.length) {
    const defs = new Map((await loadAchievementDefs(env)).map((d) => [d.id, d]));
    for (const id of eq.pinned) {
      const d = defs.get(id);
      if (d) out.pinned.push({ id: d.id, name: d.name, icon: d.icon, rarity: d.rarity, description: d.description });
    }
  }
  return out;
}

export interface InventoryEntry {
  itemId: string;
  source: string;
  acquiredAt: number;
  revoked: boolean;
}

export async function loadInventory(env: Env, uid: string): Promise<InventoryEntry[]> {
  const rows = await env.DB.prepare(
    `SELECT item_id, source, acquired_at, revoked_at FROM user_inventory WHERE uid = ? ORDER BY acquired_at`,
  ).bind(uid).all<any>();
  return (rows.results ?? []).map((r) => ({
    itemId: r.item_id,
    source: r.source,
    acquiredAt: Number(r.acquired_at),
    revoked: r.revoked_at != null,
  }));
}

/** Grant items idempotently. A revoked item stays revoked (the row exists). */
export function grantItemStatements(
  env: Env,
  uid: string,
  itemIds: string[],
  source: string,
  sourceRef: string | null,
  ts: number,
): D1PreparedStatement[] {
  return [...new Set(itemIds)].map((itemId) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO user_inventory (uid, item_id, source, source_ref, acquired_at)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM reward_catalog WHERE id = ?)`,
    ).bind(uid, itemId, source, sourceRef, ts, itemId),
  );
}

/**
 * Equip (or clear) one slot. Ownership, revocation, the item's type and its
 * active state are all checked inside the UPDATE itself.
 */
export async function equipCosmetic(env: Env, uid: string, slotRaw: unknown, itemRaw: unknown): Promise<void> {
  const slot = String(slotRaw ?? "") as EquipSlot;
  if (!(EQUIP_SLOTS as readonly string[]).includes(slot)) {
    throw httpsError("invalid-argument", `slot must be one of ${EQUIP_SLOTS.join(", ")}.`);
  }
  if (itemRaw === null || itemRaw === undefined || itemRaw === "") {
    await env.DB.prepare(`UPDATE users SET cosmetics = json_remove(COALESCE(cosmetics, '{}'), ?), updated_at = ? WHERE uid = ?`)
      .bind(`$.${slot}`, Date.now(), uid)
      .run();
    return;
  }
  if (typeof itemRaw !== "string" || !/^[a-z0-9_-]{2,40}$/.test(itemRaw)) throw httpsError("invalid-argument", "Invalid item id.");
  const res = await env.DB.prepare(
    `UPDATE users SET cosmetics = json_set(COALESCE(cosmetics, '{}'), ?, ?), updated_at = ?
      WHERE uid = ?
        AND EXISTS (SELECT 1 FROM user_inventory i WHERE i.uid = ? AND i.item_id = ? AND i.revoked_at IS NULL)
        AND EXISTS (SELECT 1 FROM reward_catalog r WHERE r.id = ? AND r.type = ? AND r.active = 1)`,
  ).bind(`$.${slot}`, itemRaw, Date.now(), uid, uid, itemRaw, itemRaw, slot).run();
  if (Number(res.meta?.changes || 0) === 0) {
    throw httpsError("permission-denied", "You don't own this item, or it can't be used in that slot.");
  }
}

/** Pin achievements on the profile: each must be unlocked by this user. */
export async function pinAchievements(env: Env, uid: string, idsRaw: unknown, limit: number): Promise<string[]> {
  if (!Array.isArray(idsRaw)) throw httpsError("invalid-argument", "achievementIds must be a list.");
  const ids = [...new Set(idsRaw.map(String))];
  if (ids.length > limit) throw httpsError("invalid-argument", `You can pin up to ${limit} achievements.`);
  if (ids.some((i) => !/^[a-z0-9_-]{2,40}$/.test(i))) throw httpsError("invalid-argument", "Invalid achievement id.");
  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    const owned = await env.DB.prepare(
      `SELECT COUNT(DISTINCT achievement_id) AS n FROM user_achievements WHERE uid = ? AND achievement_id IN (${ph})`,
    ).bind(uid, ...ids).first<{ n: number }>();
    if (Number(owned?.n || 0) !== ids.length) throw httpsError("permission-denied", "You can only pin achievements you have unlocked.");
  }
  await env.DB.prepare(`UPDATE users SET cosmetics = json_set(COALESCE(cosmetics, '{}'), '$.pinned', json(?)), updated_at = ? WHERE uid = ?`)
    .bind(JSON.stringify(ids), Date.now(), uid)
    .run();
  return ids;
}
