/**
 * Provider-aware media deletion.
 *
 * Media can now live in two places, so every delete path has to dispatch on the
 * URL rather than assuming R2. `deleteByPublicUrl()` only understands R2 keys, so
 * calling it on a Bunny playback URL is a silent no-op that leaves the video
 * object in the Bunny library — billed for storage forever.
 *
 * Use this everywhere a story / post / entry's media is removed.
 *
 * OWNERSHIP. A row's `mediaUrl` is a reference, not proof of ownership:
 * `createStory` / `createPost` accept any url, and the app's own "Repost" puts
 * another person's media url on a new story. Deleting by url alone therefore
 * deleted the ORIGINAL author's photo or video when the repost was deleted, or
 * 24 h later when the cron expired it, including media still shown in their
 * Highlights or contest entry. Anyone could do the same on purpose.
 *
 * Every upload records who made it: R2 `customMetadata.uploader` (since
 * 2026-10-18) and Bunny `videos.owner_uid`. An object recorded as someone
 * else's is never deleted on this account's behalf. An object with NO record
 * (legacy uploads) keeps the old behaviour, since refusing would leak every
 * legacy object and break account deletion for old accounts.
 */
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { deleteByPublicUrl, mediaKeyFromPublicUrl } from "./r2";
import { deleteVideo, guidFromUrl } from "./bunny";

export type MediaOwnership = "owned" | "foreign" | "unknown";

/** Who uploaded the object behind `publicUrl`, relative to `ownerUid`. */
export async function mediaOwnership(env: Env, publicUrl: string, ownerUid: string): Promise<MediaOwnership> {
  const guid = await guidFromUrl(env, publicUrl);
  if (guid) {
    const row = await getDb(env)
      .select({ ownerUid: schema.videos.ownerUid })
      .from(schema.videos)
      .where(eq(schema.videos.id, guid))
      .get();
    if (!row?.ownerUid) return "unknown";
    return row.ownerUid === ownerUid ? "owned" : "foreign";
  }
  const key = mediaKeyFromPublicUrl(env, publicUrl);
  if (!key) return "unknown";
  const head = await env.MEDIA.head(key);
  const uploader = (head as any)?.customMetadata?.uploader;
  if (!uploader) return "unknown";
  return uploader === ownerUid ? "owned" : "foreign";
}

/**
 * Delete the media behind `publicUrl`, on behalf of `ownerUid` (the account
 * whose story / post / profile is going away).
 *
 * Returns false when it was deliberately kept because another account owns it.
 * Errors from the ownership lookup propagate, so callers that retry (the story
 * sweep) retry instead of guessing.
 */
export async function deleteMediaByUrl(
  env: Env,
  publicUrl: string | null | undefined,
  ownerUid: string,
): Promise<boolean> {
  if (!publicUrl) return true;

  if ((await mediaOwnership(env, publicUrl, ownerUid)) === "foreign") {
    console.warn("[media] not deleting media owned by another account", { ownerUid, url: publicUrl });
    return false;
  }

  const guid = await guidFromUrl(env, publicUrl);
  if (guid) {
    await deleteVideo(env, guid);
    try {
      await getDb(env).delete(schema.videos).where(eq(schema.videos.id, guid)).run();
    } catch (e) {
      // The Bunny object is already gone; a stale row is harmless but noteworthy.
      console.error("[media] videos row cleanup failed", guid, e);
    }
    return true;
  }

  await deleteByPublicUrl(env, publicUrl);
  return true;
}
