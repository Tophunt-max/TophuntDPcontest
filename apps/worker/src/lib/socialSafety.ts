/**
 * Restrict, hide-story-from and mutual followers (migration 0067).
 *
 * These follow the rules in lib/blocks.ts:
 *   - reads filter AFTER any shared cache, never inside it, so one viewer's
 *     relations are never baked into another viewer's answer;
 *   - the restrict comment filter is fail-OPEN (an extra comment rather than a
 *     blank thread); the story-hide lookup is NOT, because it is the owner's
 *     privacy choice, so a failed lookup fails the read instead of leaking.
 *
 * RESTRICT (Instagram-style, one-way, silent):
 *   The restricted account's comments on the restricter's battles/posts are
 *   visible only to the commenter and the restricter (marked `restricted`), and
 *   none of their activity notifies the restricter (lib/blocks.ts
 *   isNotificationSuppressed). Follows are untouched and they are not told.
 *
 * HIDE STORY FROM:
 *   The owner's stories never reach that one account on any story surface
 *   (feed ring, profile ring, highlights), and viewing/reacting is refused.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { isHiddenAccountStatus } from "./accountStatus";

const MAX_IDS = 200;

// ---------------------------------------------------------------------------
// Restrict
// ---------------------------------------------------------------------------

/** restrictedUid -> the owners (among `ownerIds`) who restricted them. */
export async function restrictionsByOwners(env: Env, ownerIds: Array<string | null | undefined>): Promise<Map<string, Set<string>>> {
  const ids = [...new Set(ownerIds.filter((x): x is string => !!x))].slice(0, MAX_IDS);
  const out = new Map<string, Set<string>>();
  if (!ids.length) return out;
  try {
    const rows = await getDb(env)
      .select({ restricter: schema.userRestricts.restricterId, restricted: schema.userRestricts.restrictedId })
      .from(schema.userRestricts)
      .where(inArray(schema.userRestricts.restricterId, ids))
      .limit(5000)
      .all();
    for (const r of rows) {
      const set = out.get(r.restricted) ?? new Set<string>();
      set.add(r.restricter);
      out.set(r.restricted, set);
    }
  } catch (e) {
    console.error("[socialSafety] restrictionsByOwners failed (continuing unfiltered)", e);
  }
  return out;
}

/**
 * Drop comments by restricted authors, except for the two people allowed to see
 * them: the commenter, and the owner who restricted them (who gets `restricted:
 * true` so the app can label it).
 */
export function filterRestrictedComments<T extends { userId?: string | null }>(
  items: T[],
  restrictions: Map<string, Set<string>>,
  viewerUid: string | null | undefined,
): Array<T & { restricted?: boolean }> {
  if (!restrictions.size) return items;
  const out: Array<T & { restricted?: boolean }> = [];
  for (const item of items) {
    const author = item.userId || "";
    const by = restrictions.get(author);
    if (!by) {
      out.push(item);
      continue;
    }
    if (viewerUid && (viewerUid === author || by.has(viewerUid))) out.push({ ...item, restricted: true });
  }
  return out;
}

export async function isRestrictedBy(env: Env, restricter: string, restricted: string): Promise<boolean> {
  if (!restricter || !restricted || restricter === restricted) return false;
  const row = await getDb(env)
    .select({ r: schema.userRestricts.restricterId })
    .from(schema.userRestricts)
    .where(and(eq(schema.userRestricts.restricterId, restricter), eq(schema.userRestricts.restrictedId, restricted)))
    .get();
  return !!row;
}

// ---------------------------------------------------------------------------
// Hide story from
// ---------------------------------------------------------------------------

/** The owners (among `ownerIds`) who hide their stories from `viewerUid`. */
export async function storyHidersAmong(env: Env, viewerUid: string | null | undefined, ownerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(ownerIds.filter((id) => id && id !== viewerUid))].slice(0, MAX_IDS);
  if (!viewerUid || !ids.length) return new Set();
  // Not fail-open: this is a privacy choice by the owner, so a failed lookup
  // fails the read (like the follow check beside it) instead of leaking the story.
  const rows = await getDb(env)
    .select({ owner: schema.userStoryHides.ownerId })
    .from(schema.userStoryHides)
    .where(and(eq(schema.userStoryHides.hiddenUid, viewerUid), inArray(schema.userStoryHides.ownerId, ids)))
    .all();
  return new Set(rows.map((r) => r.owner));
}

export async function isStoryHiddenFrom(env: Env, ownerId: string, viewerUid: string): Promise<boolean> {
  if (!ownerId || !viewerUid || ownerId === viewerUid) return false;
  const row = await getDb(env)
    .select({ o: schema.userStoryHides.ownerId })
    .from(schema.userStoryHides)
    .where(and(eq(schema.userStoryHides.ownerId, ownerId), eq(schema.userStoryHides.hiddenUid, viewerUid)))
    .get();
  return !!row;
}

// The write-path guard (view / react) lives in lib/blocks.ts
// assertStoryInteractionAllowed, which every story action already calls.

// ---------------------------------------------------------------------------
// Mutual followers
// ---------------------------------------------------------------------------

export interface MutualFollowers {
  /** Accounts the viewer follows that also follow the target. */
  count: number;
  /** Up to `limit` of them, for "Followed by @a, @b and N others". */
  users: Array<{ uid: string; username: string | null; profileImageUrl: string | null }>;
}

/**
 * People the viewer follows who also follow `target`, excluding `exclude`
 * (blocked uids) and hidden/deleted/banned accounts. Two indexed lookups via
 * idx_follows_following and the follows primary key.
 */
export async function mutualFollowersOf(
  env: Env,
  viewer: string,
  target: string,
  exclude: ReadonlySet<string>,
  limit = 3,
): Promise<MutualFollowers> {
  if (!viewer || !target || viewer === target) return { count: 0, users: [] };
  const res = await env.DB.prepare(
    `SELECT u.uid AS uid, u.username AS username, u.profile_image_url AS profileImageUrl,
            u.status AS status, u.is_blocked AS isBlocked
       FROM follows f
       JOIN follows mine ON mine.following_id = f.follower_id AND mine.follower_id = ?1
       JOIN users u ON u.uid = f.follower_id
      WHERE f.following_id = ?2 AND f.follower_id <> ?1 AND f.follower_id <> ?2
      ORDER BY f.created_at DESC
      LIMIT 500`,
  )
    .bind(viewer, target)
    .all<{ uid: string; username: string | null; profileImageUrl: string | null; status: string | null; isBlocked: number | null }>();
  const visible = (res.results || []).filter((r) => !exclude.has(r.uid) && !isHiddenAccountStatus(r.status) && !r.isBlocked);
  return {
    count: visible.length,
    users: visible.slice(0, limit).map((r) => ({ uid: r.uid, username: r.username, profileImageUrl: r.profileImageUrl })),
  };
}

// Account deletion removes restrict / story-hide rows in both directions:
// see lib/accountDeletion.ts, next to the user_mutes cleanup.
