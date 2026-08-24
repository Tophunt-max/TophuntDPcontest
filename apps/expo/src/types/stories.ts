/**
 * Story shapes as returned by the Worker's `/read/stories/*` endpoints.
 *
 * Timestamps are **epoch milliseconds** (plain numbers). D1 stores
 * `stories.created_at` / `stories.expires_at` as INTEGER and the Worker hands
 * them back untouched, so there is no Firestore `Timestamp` anywhere in this
 * payload — do not call `.toMillis()` or read `.seconds` on these fields.
 */

/**
 * What produced a story.
 *
 * `contest_announcement` — someone entered a contest and is waiting for a rival.
 * `contest_vs`           — a battle filled up; both participants get one of these
 *                          and it renders as a head-to-head frame.
 *
 * `contest_match_live` is the retired name for what is now `contest_vs`; rows
 * written before that change may still carry it, so treat it as an alias.
 */
export type StoryKind = 'user' | 'contest_announcement' | 'contest_vs' | 'contest_match_live';

export interface Story {
  id: string;
  userId: string;
  username?: string;
  avatarUrl?: string;
  mediaUrl: string;
  /**
   * NOTE: not reliably one of these two. The contest flows historically wrote
   * `"photo"`, so never compare against `'image'` directly — use
   * `isVideoStory()` below, which treats anything that is not a video as an image.
   */
  mediaType: 'image' | 'video' | string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  seen?: boolean;
  // Optional creative overlays attached to a story.
  overlayText?: string;
  textPosition?: { x: number; y: number } | null;
  mentions?: string[];
  // --- contest stories ---
  /** Absent on older rows. */
  type?: StoryKind;
  /** The battle this story is about. Present on both contest story kinds. */
  matchId?: string | null;
  contestTitle?: string | null;
}

/**
 * True only for an actual video.
 *
 * Deliberately inverted: the worker's contest flows wrote `mediaType: "photo"`
 * while the viewer checked `=== 'image'`, so every auto-posted contest story fell
 * through to the video branch and rendered an empty player whose progress bar
 * never advanced. Asking "is it a video" instead of "is it an image" is correct
 * for every value that has ever been stored, including `undefined`.
 */
export function isVideoStory(story?: Pick<Story, 'mediaType'> | null): boolean {
  return story?.mediaType === 'video';
}

/**
 * The story's media type, normalised to the two values the rest of the app uses.
 *
 * Use this wherever a raw `mediaType` would be stored or passed on (the offline
 * cache, a repost), so a legacy `"photo"` is cleaned up at the boundary instead
 * of being copied further.
 */
export function storyMediaKind(story?: Pick<Story, 'mediaType'> | null): 'image' | 'video' {
  return isVideoStory(story) ? 'video' : 'image';
}

/**
 * True when a story should render as a head-to-head battle frame rather than a
 * single photo. Requires a `matchId`, since that is what the frame is built from.
 */
export function isVsStory(story?: Story | null): boolean {
  if (!story?.matchId) return false;
  return story.type === 'contest_vs' || story.type === 'contest_match_live';
}

export interface UserStories {
  userId: string;
  username: string;
  /** Null when the user has no photo — render local initials. */
  avatarUrl: string | null;
  /**
   * Small avatar variant for the stories rail. Identical to `avatarUrl` until
   * Cloudflare Transformations is enabled on the media zone, so it is always
   * safe to prefer.
   */
  avatarUrlThumb?: string | null;
  stories: Story[];
  hasUnseen?: boolean;
}

/** A single viewer row from `/read/stories/:id/viewers`. */
export interface StoryViewer {
  uid: string;
  username: string;
  avatarUrl: string;
  /** Epoch milliseconds. */
  viewedAt: number;
  reaction: string | null;
}
