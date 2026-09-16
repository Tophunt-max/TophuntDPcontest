import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Local snooze cache for announcement popups.
 *
 * The server is the source of truth for whether a popup is eligible
 * (/read/announcements/active already excludes snoozed ones), and dismissing
 * calls `dismissAnnouncement` which records the snooze server-side. This cache
 * is purely a latency shim: the moment the user taps ×, we hide the popup and
 * remember "don't show this id until T" locally so a refetch that races the
 * dismiss write can't flash the same popup back up before the server catches up.
 *
 * Keyed by announcement id and stored as one small JSON blob. Entries are
 * self-expiring (a past timestamp is ignored), so the map stays tiny.
 */

const STORAGE_KEY = 'tophunt.announcementSnoozes';

type SnoozeMap = Record<string, number>; // announcementId -> snoozedUntil (epoch ms)

/** Read the persisted map, dropping entries whose snooze has already lapsed. */
export async function loadSnoozes(): Promise<SnoozeMap> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SnoozeMap;
    const now = Date.now();
    const fresh: SnoozeMap = {};
    for (const [id, until] of Object.entries(parsed)) {
      if (typeof until === 'number' && until > now) fresh[id] = until;
    }
    return fresh;
  } catch {
    return {};
  }
}

/** Persist a snooze for one announcement, pruning lapsed entries as we go. */
export async function snoozeAnnouncement(id: string, snoozedUntil: number): Promise<void> {
  try {
    const current = await loadSnoozes();
    current[id] = snoozedUntil;
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    /* in-memory hide still applies; only persistence failed */
  }
}
