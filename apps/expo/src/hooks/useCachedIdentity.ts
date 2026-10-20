import { useEffect, useState } from 'react';
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

  return {
    name: profile?.fullName || cached?.name || cached?.username || null,
    username: profile?.username || cached?.username || null,
    avatarUrl: profile?.profileImageUrl || profile?.avatarUrl || cached?.avatarUrl || null,
    hasIdentity: !!profile || !!cached,
  };
}
