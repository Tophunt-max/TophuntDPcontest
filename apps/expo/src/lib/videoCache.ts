import { Platform } from 'react-native';
import {
  clearVideoCacheAsync,
  getCurrentVideoCacheSize,
  setVideoCacheSizeAsync,
} from 'expo-video';

/**
 * expo-video disk cache management.
 *
 * Note this is only half of video caching — the other half is `useCaching: true`
 * on each `VideoSource`, which is what actually populates this cache. See
 * `videoSourceFor()` in `./videoSource`. Without that flag the cache stays empty
 * no matter what size is configured here.
 *
 * expo-video's default cache budget is **1 GB**, which is a lot of a user's
 * phone to claim silently for short contest clips and 24h stories. 256 MB still
 * holds a few hundred of them and the cache is evicted least-recently-used.
 */

const VIDEO_CACHE_BYTES = 256 * 1024 * 1024; // 256 MB

/** Cache APIs are Android/iOS only. */
const supported = Platform.OS === 'ios' || Platform.OS === 'android';

/**
 * Apply our cache budget.
 *
 * MUST run before any `VideoPlayer` exists — expo-video rejects this call once a
 * player has been created. Call it from module scope at the app root so it lands
 * before any screen mounts. The size is persisted by expo-video, so a failure
 * here is harmless: the previous (or default) budget stays in effect.
 */
export function configureVideoCache(): void {
  if (!supported) return;
  setVideoCacheSizeAsync(VIDEO_CACHE_BYTES).catch((e) => {
    // Most likely cause: a player already existed by the time this ran.
    console.warn('[videoCache] could not set cache size:', e);
  });
}

/** Bytes currently held by the video cache, or null where unsupported. */
export function videoCacheSize(): number | null {
  if (!supported) return null;
  try {
    return getCurrentVideoCacheSize();
  } catch {
    return null;
  }
}

/**
 * Empty the video cache — for a "Clear cache" action in settings.
 *
 * Only works when no `VideoPlayer` instances exist, so call it from a screen that
 * is not playing anything.
 */
export async function clearVideoCache(): Promise<boolean> {
  if (!supported) return false;
  try {
    await clearVideoCacheAsync();
    return true;
  } catch (e) {
    console.warn('[videoCache] clear failed (a player is probably still active):', e);
    return false;
  }
}
