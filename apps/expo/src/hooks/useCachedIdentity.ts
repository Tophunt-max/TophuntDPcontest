import { useEffect, useState } from 'react';
import { cachedValueForUid } from '@/src/lib/authState';
import { loadCachedIdentity, saveCachedIdentity, type CachedIdentity } from '@/src/lib/cachedIdentity';

/** Last-known identity first, fresh profile wins and refreshes the cache. */
export function useCachedIdentity(uid: string | null | undefined, profile: any) {
  const [cached, setCached] = useState<CachedIdentity | null>(null);

  useEffect(() => {
    let active = true;
    setCached(null);
    if (uid) loadCachedIdentity(uid).then((v) => active && setCached(v));
    return () => {
      active = false;
    };
  }, [uid]);

  useEffect(() => {
    if (!uid || !profile) return;
    const next: CachedIdentity = {
      uid,
      name: profile.fullName || null,
      username: profile.username || null,
      avatarUrl: profile.profileImageUrl || profile.avatarUrl || null,
      savedAt: Date.now(),
    };
    setCached(next);
    void saveCachedIdentity(next);
  }, [uid, profile]);

  const validCached = cachedValueForUid(uid, cached);
  return {
    name: profile?.fullName || validCached?.name || validCached?.username || null,
    username: profile?.username || validCached?.username || null,
    avatarUrl: profile?.profileImageUrl || profile?.avatarUrl || validCached?.avatarUrl || null,
    hasIdentity: !!profile || !!validCached,
  };
}
