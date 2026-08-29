/**
 * Auto-posted stories for a contest battle.
 *
 * A battle is the app's headline content, so both participants get a story about
 * it. The shape of those stories changes at the moment the battle fills up:
 *
 *   creation  -> the creator posts a solo "I've entered, come challenge me"
 *                story (`contest_announcement`), because there is no opponent yet.
 *   join      -> the battle is live and has two sides, so BOTH users get a
 *                head-to-head story (`contest_vs`) and the creator's now-stale
 *                announcement is removed.
 *
 * Two rows rather than one shared row, because `/read/stories/feed` groups
 * strictly by `stories.user_id` and the viewer plays one reel per user. A single
 * row could only ever appear on one participant's ring.
 *
 * ---------------------------------------------------------------------------
 * Why the VS visual is NOT composed into an image HERE
 * ---------------------------------------------------------------------------
 * There is no server-side image composition available. `lib/media.ts` only builds
 * Cloudflare Image *Resizing* URLs — which cannot combine two sources — and it is
 * inert anyway until the media custom domain exists (`transformationsAvailable`).
 * The Worker has no canvas and no image library, so compositing would mean adding
 * a WASM decoder, then fetching, decoding, re-encoding and uploading a new R2
 * object on the paid-join hot path.
 *
 * So each row stores that user's OWN entry as `media_url` — which keeps the story
 * meaningful on any client that just renders `media_url` — plus `match_id`. The
 * client reads `match_id`, loads the battle, and draws the head-to-head frame at
 * render time.
 *
 * A composite image DOES exist, but it is produced later and elsewhere: a
 * participant's device screenshots that rendered frame and reports it through the
 * `setMatchVsImage` action, which records it on `contest_matches.vs_image_url`.
 * Two things about it matter here:
 *
 *   - it is recorded on the MATCH, never copied into these rows. `media_url`
 *     staying each user's own entry is what keeps blocking working, and what keeps
 *     the card owned by one thing instead of two. `routes/api.ts` has the full
 *     reasoning at `setMatchVsImage`.
 *   - it is the one contest-story object that has an owner in cleanup: `cron.ts`
 *     deletes it when these stories expire, because nothing else displays it.
 */
import { and, eq } from "drizzle-orm";
import type { Env } from "../types";
import { canonicalMediaUrl } from "./r2";
import { getDb, schema } from "../db";
import { newId } from "./ids";

/** Story lifetime, matching the 24h the rest of the story system assumes. */
const STORY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Normalise a participant's media type to what the client understands.
 *
 * The contest flows were writing `"photo"` while the story viewer only ever
 * checked for `"image"`, so every auto-posted contest story fell through to the
 * video branch and rendered an empty player with a progress bar that never
 * advanced. Anything that is not explicitly a video is an image.
 */
export function storyMediaType(mediaType: unknown): "image" | "video" {
  return mediaType === "video" ? "video" : "image";
}

export interface VsParticipant {
  uid: string;
  username?: string | null;
  profilePic?: string | null;
  mediaUrl?: string | null;
  mediaType?: string | null;
}

/**
 * Replace the creator's solo announcement with a head-to-head story for both
 * participants.
 *
 * Best-effort by design: a story is decoration on top of a transaction that has
 * already taken the joiner's entry fee and activated the battle. It must never
 * turn a successful, paid join into an error, so every failure is logged and
 * swallowed. The three writes go in one `db.batch` so the two users' stories
 * either both appear or neither does — one participant seeing a battle story the
 * other does not would look like a bug to both of them.
 */
export async function publishVsStories(
  env: Env,
  input: {
    matchId: string;
    contestTitle: string;
    userA: VsParticipant;
    userB: VsParticipant;
    ts: number;
  },
): Promise<void> {
  const { matchId, contestTitle, userA, userB, ts } = input;
  if (!userA?.uid || !userB?.uid) return;

  const row = (p: VsParticipant) => ({
    id: newId(),
    userId: p.uid,
    username: p.username || "Anonymous",
    // Canonicalised onto the current media base. These values are copied out of
    // the match's participant snapshot, so for any match created before the media
    // domain cutover they still name the Worker proxy — and this function runs at
    // JOIN time, which means a pre-cutover match was minting brand-new rows on the
    // old host indefinitely. Canonicalising here breaks that propagation chain.
    avatarUrl: canonicalMediaUrl(env, p.profilePic) || "",
    // The participant's own entry, so a client that only understands
    // `media_url` still shows something true rather than nothing.
    mediaUrl: canonicalMediaUrl(env, p.mediaUrl) || "",
    mediaType: storyMediaType(p.mediaType),
    type: "contest_vs",
    matchId,
    contestTitle,
    createdAt: ts,
    expiresAt: ts + STORY_TTL_MS,
  });

  try {
    await getDb(env).batch([
      // The creator's solo "come challenge me" story is now wrong — the battle
      // has an opponent. Leaving it would show them two stories about the same
      // match, one of them out of date.
      getDb(env)
        .delete(schema.stories)
        .where(and(eq(schema.stories.matchId, matchId), eq(schema.stories.type, "contest_announcement"))),
      getDb(env).insert(schema.stories).values(row(userA)),
      getDb(env).insert(schema.stories).values(row(userB)),
    ]);
  } catch (e) {
    // Never fail the join for a story.
    console.error("[matchStories] could not publish VS stories", matchId, e);
  }
}
