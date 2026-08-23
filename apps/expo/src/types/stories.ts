/**
 * Story shapes as returned by the Worker's `/read/stories/*` endpoints.
 *
 * Timestamps are **epoch milliseconds** (plain numbers). D1 stores
 * `stories.created_at` / `stories.expires_at` as INTEGER and the Worker hands
 * them back untouched, so there is no Firestore `Timestamp` anywhere in this
 * payload — do not call `.toMillis()` or read `.seconds` on these fields.
 */

export interface Story {
  id: string;
  userId: string;
  username?: string;
  avatarUrl?: string;
  mediaUrl: string;
  mediaType: 'image' | 'video';
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  expiresAt: number;
  seen?: boolean;
  // Optional creative overlays attached to a story.
  overlayText?: string;
  textPosition?: { x: number; y: number } | null;
  mentions?: string[];
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
