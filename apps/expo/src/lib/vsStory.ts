/**
 * Which two entries a battle story draws, and in which order.
 *
 * Pulled out of `StoryVsFrame` as a pure function so the part that can actually
 * be wrong — picking the right media for each side, preferring the optimised
 * variant, deciding video vs photo, and what to do when the battle can't be
 * loaded — is testable. The component keeps only the layout, which is two
 * `flex: 1` halves in a `flexDirection: 'row'`.
 */

export interface VsSideData {
  uid?: string;
  username: string;
  /** Admin-granted blue check on this participant, from the enriched match read. */
  verified?: boolean;
  /** Best available image/video url for this side. */
  uri: string | null;
  avatarUri: string | null;
}

export interface VsFrameData {
  /** Left half. Always the battle's creator (userA), for both viewers. */
  left: VsSideData;
  /** Right half. Always the joiner (userB). */
  right: VsSideData;
  isVideo: boolean;
  title: string;
  prize: number;
}

function side(participant: any): VsSideData {
  return {
    uid: participant?.uid,
    username: participant?.username || 'user',
    verified: !!participant?.verified,
    // Prefer the resized variant; it falls back to the original url itself until
    // Cloudflare Transformations is enabled, so this is always safe.
    uri: participant?.mediaUrlOptimized || participant?.mediaUrl || null,
    avatarUri: participant?.profilePicThumb || participant?.profilePic || null,
  };
}

/**
 * The battle's composite head-to-head image, if one has been produced.
 *
 * When present this is a single file showing both entries with the VS tag, which
 * is what gets shared outside the app and what the story displays directly.
 *
 * Read from the MATCH, never from the story row — the row keeps each user's own
 * entry as its media. That is what keeps blocking working: a viewer who blocked a
 * participant gets no match back, so they never see the composite.
 *
 * Null is normal and expected: for battles that predate the feature, for any
 * install whose native capture module is missing, for video battles, and for every
 * battle whose stories have expired (the cron deletes the card and clears the
 * column). So this is never a precondition, only a preference.
 */
export function vsImageOf(match: any): string | null {
  const url = match?.vsImageUrl;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

/**
 * Build the frame data, or return null when a head-to-head frame is not possible.
 *
 * Null means "fall back to the single entry this story row carries". That happens
 * for a real reason rather than an error: `/read/matches/:id` deliberately returns
 * nothing when a participant is blocked by the viewer, and a story outlives
 * nothing else that could remove the match.
 *
 * The order is deliberately NOT viewer-relative — userA is always on the left,
 * for both participants and for anyone else watching. Both users must see the
 * same story, and mirroring it per viewer would quietly make them two different
 * stories.
 */
/**
 * Whether a "this frame is painted" signal should be turned into a capture.
 *
 * Lives here, next to the other pure battle-story logic, because it is the part
 * that decides whether a PERMANENT image gets written: the server keeps the first
 * card recorded for a battle, so a wrong answer puts the wrong picture on both
 * participants' stories until the stories expire. The hook around it
 * (`hooks/useVsStoryCard.ts`) keeps only the timing, which needs a device to
 * exercise; this is the part that can be wrong in a way a test can catch.
 */
export function shouldCaptureVsCard(state: {
  /** The battle the ready signal is for. */
  matchId?: string | null;
  /** Whether this client is a participant, and so allowed to record a card. */
  canGenerate: boolean;
  /** Whether the device can screenshot at all. */
  captureSupported: boolean;
  /** Battles this screen has already carried through to a capture. */
  attempted: ReadonlySet<string>;
}): boolean {
  const { matchId, canGenerate, captureSupported, attempted } = state;
  if (!matchId) return false;
  if (!canGenerate) return false;
  if (!captureSupported) return false;
  return !attempted.has(matchId);
}

export function resolveVsFrame(match: any): VsFrameData | null {
  const userA = match?.userA;
  const userB = match?.userB;
  // Both sides are required — a "VS" with one photo is not the thing being asked
  // for, so the caller shows the single-entry fallback instead.
  if (!userA?.uid || !userB?.uid) return null;

  const left = side(userA);
  const right = side(userB);
  if (!left.uri || !right.uri) return null;

  return {
    left,
    right,
    isVideo: match?.type === 'video',
    title: match?.title || 'Battle',
    prize: Number(match?.rewardAmount ?? match?.prizeCoins ?? 0) || 0,
  };
}
