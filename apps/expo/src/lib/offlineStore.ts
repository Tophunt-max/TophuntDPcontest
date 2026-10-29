/**
 * Small, owner-scoped offline snapshots: the last good answer for a screen, so
 * an offline (or slow) open paints it instead of a blank list, Instagram-style.
 *
 * Where it is used: React Query persistence (src/lib/queryPersistence.ts), the
 * notifications list and the inbox chat list. The Home feed and Stories have
 * their own WatermelonDB caches (feedSnapshot.ts, offlineStoryService.ts).
 *
 * Rules
 *  - Every entry records its owner (`u:<uid>` or `guest`). A read for one owner
 *    never returns another owner's entry, so a shared device cannot show
 *    account A's inbox to account B even if a wipe was missed.
 *  - Wiped on sign-out (services/auth.ts `clearAccountScopedCaches`) and when
 *    the signed-in account changes (app/_layout.tsx).
 *  - Bounded: each entry is capped (MAX_ENTRY_BYTES); an over-size value is
 *    simply not saved. Storage is AsyncStorage (SQLite on native, localStorage
 *    on web, ~5 MB), so the caps keep the whole set well under the web quota.
 *  - Never authoritative: callers paint it, then the network answer replaces it.
 *  - Callers must not pass wallet / payment / contact data (see
 *    queryPersistence.ts for the field filter used there).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'tophunt.offline.v1:';
/** Per-entry size cap (serialized characters). */
export const MAX_ENTRY_BYTES = 400_000;
/** Default: entries older than this are not painted. */
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface OfflineEntry<T> {
  owner: string;
  savedAt: number;
  data: T;
}

export function offlineOwner(uid: string | null | undefined): string {
  return uid ? `u:${uid}` : 'guest';
}

const storageKey = (name: string) => `${PREFIX}${name}`;

/** Bumped by every clear; a save that started before a clear is dropped. */
let generation = 0;
export const offlineGeneration = () => generation;

/** Pure: may `entry` be painted for `owner` now? */
export function usableEntry<T>(entry: OfflineEntry<T> | null | undefined, owner: string, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now()): entry is OfflineEntry<T> {
  return !!entry && entry.owner === owner && typeof entry.savedAt === 'number' && now - entry.savedAt >= 0 && now - entry.savedAt <= maxAgeMs;
}

/** Last saved value for `owner`, or null. Never throws. */
export async function loadOffline<T>(owner: string, name: string, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<OfflineEntry<T> | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(name));
    if (!raw) return null;
    const entry = JSON.parse(raw) as OfflineEntry<T>;
    return usableEntry(entry, owner, maxAgeMs) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * Save `data` as `owner`'s latest value. One owner per name: saving replaces any
 * other owner's entry. Never throws; an over-size value is skipped.
 */
export async function saveOffline<T>(owner: string, name: string, data: T, startedAtGeneration = generation): Promise<boolean> {
  if (startedAtGeneration !== generation) return false;
  let raw: string;
  try {
    raw = JSON.stringify({ owner, savedAt: Date.now(), data } satisfies OfflineEntry<T>);
  } catch {
    return false;
  }
  if (raw.length > MAX_ENTRY_BYTES) return false;
  try {
    await AsyncStorage.setItem(storageKey(name), raw);
    // A clear that ran while this write was queued wins.
    if (startedAtGeneration !== generation) {
      await AsyncStorage.removeItem(storageKey(name));
      return false;
    }
    return true;
  } catch {
    return false; // quota exceeded / storage unavailable: offline paint is best-effort
  }
}

/**
 * Save one member of a bounded group (e.g. the last messages of each chat):
 * only the `max` most recently saved members are kept; older ones are removed.
 */
export async function saveOfflineInGroup<T>(owner: string, group: string, id: string, data: T, max: number): Promise<boolean> {
  const gen = generation;
  const indexName = `${group}#index`;
  const index = (await loadOffline<string[]>(owner, indexName))?.data ?? [];
  const next = [id, ...index.filter((x) => x !== id)];
  const dropped = next.slice(max);
  const ok = await saveOffline(owner, `${group}:${id}`, data, gen);
  if (!ok) return false;
  await saveOffline(owner, indexName, next.slice(0, max), gen);
  if (dropped.length) {
    try {
      await AsyncStorage.multiRemove(dropped.map((d) => storageKey(`${group}:${d}`)));
    } catch {
      /* best-effort */
    }
  }
  return true;
}

export const loadOfflineInGroup = <T>(owner: string, group: string, id: string, maxAgeMs = DEFAULT_MAX_AGE_MS) =>
  loadOffline<T>(owner, `${group}:${id}`, maxAgeMs);

/** Remove every offline entry (all owners). Never throws. */
export async function clearOffline(): Promise<void> {
  generation += 1;
  try {
    const keys = (await AsyncStorage.getAllKeys()).filter((k) => k.startsWith(PREFIX));
    if (keys.length) await AsyncStorage.multiRemove(keys);
  } catch {
    /* best-effort */
  }
}
