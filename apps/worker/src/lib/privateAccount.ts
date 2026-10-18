/**
 * Private accounts — the Instagram rule for everything on a profile.
 *
 * A private account's profile header (name, avatar, bio, counters) stays
 * visible to everyone, so people can find it and ask to follow. Everything
 * BEHIND the header — the battles grid, the Wins list, posts, the followers and
 * following lists and the account's own `following[]` — is shown only to:
 *   - the owner;
 *   - accounts that follow it (an APPROVED follow, i.e. a `follows` row).
 * Guests and everyone else get the locked answer. Stories and highlights already
 * apply the same rule through `lib/storyAudience.ts`.
 *
 * Deliberately NOT covered: a battle itself in the public feed and at
 * `/battle/<id>`. A battle has two participants, a public vote and a prize; the
 * opponent (who may be public) and every voter are entitled to see it. That is
 * the one intentional difference from Instagram — see GUEST_ACCESS.md.
 *
 * Follow REQUESTS live in `follow_requests` (migration 0057) and never count as
 * a follow: nothing here reads that table.
 */
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";

/** True when `viewer` has an approved follow of `target`. */
export async function viewerFollows(env: Env, viewer: string | undefined, target: string): Promise<boolean> {
  if (!viewer) return false;
  const row = await getDb(env)
    .select({ f: schema.follows.followerId })
    .from(schema.follows)
    .where(and(eq(schema.follows.followerId, viewer), eq(schema.follows.followingId, target)))
    .get();
  return !!row;
}

/** True when the account is private. A missing account reads as not private (callers 404/empty on their own). */
export async function isPrivateAccount(env: Env, uid: string): Promise<boolean> {
  const row = await getDb(env)
    .select({ isPrivate: schema.users.isPrivate })
    .from(schema.users)
    .where(eq(schema.users.uid, uid))
    .get();
  return !!row?.isPrivate;
}

/**
 * True when `viewer` (undefined = guest) must get the locked answer for the
 * content behind `target`'s profile header.
 *
 * `knownPrivate` lets a caller that already has the profile skip the users read.
 */
export async function privateContentLocked(
  env: Env,
  viewer: string | undefined,
  target: string,
  knownPrivate?: boolean,
): Promise<boolean> {
  if (viewer && viewer === target) return false;
  const priv = knownPrivate ?? (await isPrivateAccount(env, target));
  if (!priv) return false;
  return !(await viewerFollows(env, viewer, target));
}

/** The relationship a viewer has with another account, for the Follow button. */
export type FollowState = "self" | "following" | "requested" | "none";

export async function followStateOf(env: Env, viewer: string, target: string): Promise<FollowState> {
  if (viewer === target) return "self";
  const db = getDb(env);
  const [follow, request] = await Promise.all([
    viewerFollows(env, viewer, target),
    db
      .select({ r: schema.followRequests.requesterId })
      .from(schema.followRequests)
      .where(and(eq(schema.followRequests.requesterId, viewer), eq(schema.followRequests.targetId, target)))
      .get(),
  ]);
  if (follow) return "following";
  return request ? "requested" : "none";
}
