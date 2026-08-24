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
    // Prefer the resized variant; it falls back to the original url itself until
    // Cloudflare Transformations is enabled, so this is always safe.
    uri: participant?.mediaUrlOptimized || participant?.mediaUrl || null,
    avatarUri: participant?.profilePicThumb || participant?.profilePic || null,
  };
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
