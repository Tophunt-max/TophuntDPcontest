/**
 * Last-known basic account identity, for an Instagram-style stable shell while
 * the fresh D1 profile is loading. Public profile fields only — never tokens,
 * email/phone, wallet balance or private settings.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface CachedIdentity {
  uid: string;
  name: string | null;
  username: string | null;
  avatarUrl: string | null;
  savedAt: number;
}

const PREFIX = 'tophunt.cachedIdentity.';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const memory = new Map<string, CachedIdentity>();
const key = (uid: string) => `${PREFIX}${uid}`;

export async function loadCachedIdentity(uid: string): Promise<CachedIdentity | null> {
  if (!uid) return null;
  const hit = memory.get(uid);
  if (hit) return hit;
  try {
    const raw = await AsyncStorage.getItem(key(uid));
    const v = raw ? (JSON.parse(raw) as CachedIdentity) : null;
    if (!v || v.uid !== uid || Date.now() - Number(v.savedAt) > MAX_AGE) {
      await AsyncStorage.removeItem(key(uid));
      return null;
    }
    const safe: CachedIdentity = {
      uid,
      name: typeof v.name === 'string' ? v.name.slice(0, 120) : null,
      username: typeof v.username === 'string' ? v.username.slice(0, 64) : null,
      avatarUrl: typeof v.avatarUrl === 'string' && /^https:\/\//.test(v.avatarUrl) ? v.avatarUrl.slice(0, 1000) : null,
      savedAt: Number(v.savedAt),
    };
    memory.set(uid, safe);
    return safe;
  } catch {
    return null;
  }
}

export async function saveCachedIdentity(identity: CachedIdentity): Promise<void> {
  if (!identity.uid) return;
  const safe = { ...identity, savedAt: Date.now() };
  memory.set(identity.uid, safe);
  try {
    await AsyncStorage.setItem(key(identity.uid), JSON.stringify(safe));
  } catch {
    /* best-effort: the fresh profile still renders */
  }
}

export async function clearCachedIdentity(uid: string | null | undefined): Promise<void> {
  if (!uid) return;
  memory.delete(uid);
  try {
    await AsyncStorage.removeItem(key(uid));
  } catch {
    /* best-effort */
  }
}
