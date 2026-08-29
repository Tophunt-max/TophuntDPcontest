import { Platform } from 'react-native';
import { Image } from 'expo-image';
import { clearVideoCache, videoCacheSize } from './videoCache';
import { resetPrefetchTracking } from './mediaPrefetch';

/**
 * "Clear cache", for the Settings screen.
 *
 * ## What this deliberately does NOT touch
 *
 * The obvious implementation — `AsyncStorage.clear()` plus a database reset — is
 * a data-loss bug wearing a cache's clothing. Every AsyncStorage key this app
 * writes is state the user would notice losing:
 *
 *   `tophunt.deviceId`         stable device identity, used for vote integrity
 *   `tophunt.themePreference`  a setting, written by the screen calling this
 *   `push::deviceToken`        sign-out needs it to detach the FCM token, so
 *                              losing it means a resold phone keeps getting the
 *                              previous account's notifications
 *   `signup-draft`             an in-flight signup
 *   `remembered_email`         "remember me"
 *   `hasSeenOnboarding`        clearing it re-runs onboarding for an existing user
 *   tus upload URLs            resumable video uploads, broken mid-flight
 *
 * On native, Firebase Auth persistence also lives in AsyncStorage, so a blanket
 * clear can sign the user out — from a button labelled "free up space".
 *
 * WatermelonDB is excluded for a different reason: alongside cached stories it
 * holds `PendingActionModel`, the queue of actions taken offline that have not
 * reached the server yet. Wiping it discards work the user believes is saved.
 *
 * So this clears only things that are genuinely re-derivable from the network:
 * the video disk cache, the image caches, and the in-memory query cache.
 */

/** Bytes that clearing would actually reclaim, or null when not measurable. */
export function reclaimableBytes(): number | null {
  // The only real byte figure available: `expo-file-system` is not a dependency
  // (see the note in src/lib/share.ts), and expo-image exposes no cache-size API,
  // so image bytes cannot be counted — only cleared.
  return videoCacheSize();
}

/** True where a cache clear does something meaningful. */
export const canClearCache = Platform.OS === 'ios' || Platform.OS === 'android';

export interface ClearCacheResult {
  /** Bytes held before clearing, when measurable. */
  freedBytes: number | null;
  /** The video cache was emptied. False if a player was still active. */
  videoCleared: boolean;
  /** Image disk/memory caches were emptied. */
  imagesCleared: boolean;
}

/**
 * Empty the re-derivable caches.
 *
 * Never throws: this runs behind a settings row, and a cache that refuses to
 * clear is not worth failing a screen over. Each step is independent so one
 * failure does not skip the others.
 *
 * `queryClient.clear()` is the caller's job — the client is created in
 * `app/_layout.tsx` and is not exported, so the screen passes it in via
 * `useQueryClient()`. Keeping it out of here also keeps this module free of a
 * react-query import.
 */
export async function clearMediaCaches(): Promise<ClearCacheResult> {
  const freedBytes = reclaimableBytes();

  const videoCleared = await clearVideoCache().catch(() => false);

  let imagesCleared = false;
  try {
    // Disk and memory are separate caches in expo-image; clearing only one leaves
    // the other still serving the bytes we just claimed to have freed.
    await Promise.all([Image.clearDiskCache(), Image.clearMemoryCache()]);
    imagesCleared = true;
  } catch {
    imagesCleared = false;
  }

  // The prefetch tracker is a session-scoped "already requested" set. Left
  // populated after the disk cache is gone, it would suppress the re-prefetch of
  // exactly the images that are no longer cached.
  resetPrefetchTracking();

  return { freedBytes, videoCleared, imagesCleared };
}

/** Human size, e.g. `18.4 MB`. Returns null for null/zero so callers can omit it. */
export function formatBytes(bytes: number | null | undefined): string | null {
  if (bytes == null || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // One decimal below GB reads as precision the number does not have.
  return `${value >= 100 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}
