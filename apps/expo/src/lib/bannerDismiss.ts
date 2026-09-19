import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Persistent dismissal for the admin announcement BANNER (the top strip driven
 * by appConfig.announcement — not the popup, which has its own snooze).
 *
 * The banner used to be dismissed with an in-memory `useState`, so it came back
 * on every reload / app restart. This stores the exact message text the user
 * closed, so:
 *   - once closed, the banner stays closed across reloads and restarts, and
 *   - it re-appears on its own only when the admin changes the message.
 *
 * One tiny string in AsyncStorage; there is only ever a single banner at a time.
 */

const STORAGE_KEY = 'tophunt.dismissedAnnouncementBanner';

/** The message text the user last dismissed, or null if none. */
export async function loadDismissedBanner(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

/** Remember that the user dismissed the banner carrying this exact message. */
export async function dismissBanner(message: string): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, message);
  } catch {
    /* the in-memory hide still applies this session; only persistence failed */
  }
}
