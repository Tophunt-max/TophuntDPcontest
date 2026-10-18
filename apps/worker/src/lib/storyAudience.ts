/**
 * Who may see a Story — one rule for every Story read surface (the stories bar
 * `/read/stories/feed`, profile rings `/read/users/:id/stories`, and highlights).
 *
 * A Story is visible to a viewer when its owner's account is publicly visible
 * (not deleted, pending deletion or banned) AND one of:
 *   - the viewer is the owner;
 *   - the Story is public (`visibility` 'public', or NULL on legacy rows) AND the
 *     owner's account is not private;
 *   - the viewer follows the owner (covers `followers` Stories and private
 *     accounts — "Only people you approve can see your entries and stories").
 *
 * Guests (no viewer) therefore only ever see public Stories of public accounts.
 *
 * Before this existed the feed returned every live Story to any signed-in user
 * regardless of `visibility`, and the composer's default IS `followers` — so
 * followers-only Stories were effectively public to every account. Opening the
 * feed to guests without this rule would have published them to the internet.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { isHiddenAccountStatus } from "./accountStatus";

/**
 * The shared stories-bar base (rows + owner privacy/ban facts). Purged when an
 * account's privacy or ban status changes so guests stop seeing its Stories
 * without waiting for the edge TTL. The Cache API purge is per colo, so other
 * colos converge within the 60s edge TTL.
 */
export const STORIES_FEED_CACHE_KEY = "cache:stories:feed:v2";

export interface StoryOwnerMeta {
  isPrivate: boolean;
  /** Deleted, pending deletion, or banned: their Stories are shown to nobody but themselves. */
  hidden: boolean;
}

/** Owner facts needed by `storyVisibleTo`, for a bounded set of owners. */
export async function storyOwnerMeta(env: Env, ownerIds: string[]): Promise<Map<string, StoryOwnerMeta>> {
  const ids = [...new Set(ownerIds.filter(Boolean))].slice(0, 200);
  const out = new Map<string, StoryOwnerMeta>();
  if (!ids.length) return out;
  const rows = await getDb(env)
    .select({
      uid: schema.users.uid,
      isPrivate: schema.users.isPrivate,
      status: schema.users.status,
      isBlocked: schema.users.isBlocked,
    })
    .from(schema.users)
    .where(inArray(schema.users.uid, ids))
    .all();
  for (const r of rows) {
    out.set(r.uid, { isPrivate: !!r.isPrivate, hidden: isHiddenAccountStatus(r.status) || !!r.isBlocked });
  }
  return out;
}

/** True when the Story needs a follow relationship to be seen (by anyone but its owner). */
export function storyNeedsFollow(story: { visibility?: string | null }, owner: StoryOwnerMeta | undefined): boolean {
  const visibility = story.visibility ?? "public";
  return visibility !== "public" || !!owner?.isPrivate;
}

export function storyVisibleTo(
  story: { userId: string; visibility?: string | null },
  owner: StoryOwnerMeta | undefined,
  viewerUid: string | null | undefined,
  viewerFollows: ReadonlySet<string>,
): boolean {
  if (viewerUid && story.userId === viewerUid) return true;
  // Unknown owner (row without a user) or a hidden account: fail closed.
  if (!owner || owner.hidden) return false;
  if (!storyNeedsFollow(story, owner)) return true;
  return !!viewerUid && viewerFollows.has(story.userId);
}

/** The subset of `ownerIds` the viewer follows (one indexed query; none for guests). */
export async function followedAmong(env: Env, viewerUid: string | null | undefined, ownerIds: string[]): Promise<Set<string>> {
  const ids = [...new Set(ownerIds.filter((id) => id && id !== viewerUid))].slice(0, 200);
  if (!viewerUid || !ids.length) return new Set();
  const rows = await getDb(env)
    .select({ followingId: schema.follows.followingId })
    .from(schema.follows)
    .where(and(eq(schema.follows.followerId, viewerUid), inArray(schema.follows.followingId, ids)))
    .all();
  return new Set(rows.map((r) => r.followingId));
}

/**
 * Filter Story rows for a viewer. `meta` may be supplied (e.g. computed once into
 * a shared cache); otherwise it is looked up. Only owners whose Stories need a
 * follow are checked against the follow graph.
 */
export async function filterStoriesForViewer<T extends { userId: string; visibility?: string | null }>(
  env: Env,
  rows: T[],
  viewerUid: string | null | undefined,
  meta?: Map<string, StoryOwnerMeta>,
): Promise<T[]> {
  if (!rows.length) return rows;
  const owners = meta ?? (await storyOwnerMeta(env, rows.map((r) => r.userId)));
  const needFollow = rows.filter((r) => r.userId !== viewerUid && storyNeedsFollow(r, owners.get(r.userId))).map((r) => r.userId);
  const follows = await followedAmong(env, viewerUid, needFollow);
  return rows.filter((r) => storyVisibleTo(r, owners.get(r.userId), viewerUid, follows));
}
