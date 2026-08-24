/**
 * Provider-aware media deletion.
 *
 * Media can now live in two places, so every delete path has to dispatch on the
 * URL rather than assuming R2. `deleteByPublicUrl()` only understands R2 keys, so
 * calling it on a Bunny playback URL is a silent no-op that leaves the video
 * object in the Bunny library — billed for storage forever.
 *
 * Use this everywhere a story / post / entry's media is removed.
 */
import { eq } from "drizzle-orm";
import type { Env } from "../types";
import { getDb, schema } from "../db";
import { deleteByPublicUrl } from "./r2";
import { deleteVideo, guidFromUrl } from "./bunny";

export async function deleteMediaByUrl(env: Env, publicUrl: string | null | undefined): Promise<void> {
  if (!publicUrl) return;

  const guid = await guidFromUrl(env, publicUrl);
  if (guid) {
    await deleteVideo(env, guid);
    try {
      await getDb(env).delete(schema.videos).where(eq(schema.videos.id, guid)).run();
    } catch (e) {
      // The Bunny object is already gone; a stale row is harmless but noteworthy.
      console.error("[media] videos row cleanup failed", guid, e);
    }
    return;
  }

  await deleteByPublicUrl(env, publicUrl);
}
