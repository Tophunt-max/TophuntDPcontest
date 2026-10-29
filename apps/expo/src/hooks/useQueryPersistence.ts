import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import type { QueryClient } from '@tanstack/react-query';
import { persistQueries, restoreQueries } from '@/src/lib/queryPersistence';

/** Quiet period after the last successful fetch before writing. */
const SAVE_DEBOUNCE_MS = 3_000;
/** The splash waits at most this long for the saved queries on a cold start. */
export const RESTORE_WAIT_MS = 700;

/**
 * Restore `owner`'s saved queries once per launch, then keep saving successful
 * fetches (debounced, and right away when the app goes to the background).
 * Returns true once the first restore finished (or timed out), so the root can
 * keep its splash up for that moment instead of flashing skeletons.
 *
 * `owner` null = the session is not resolved yet: nothing is read or written.
 * Account changes are handled in app/_layout.tsx (cache cleared, then the new
 * owner's queries restored); this hook only follows the owner for saving.
 */
export function useQueryPersistence(client: QueryClient, owner: string | null): boolean {
  const [restored, setRestored] = useState(false);
  const startedRef = useRef(false);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;

  // First restore, for whoever the launch resolves to.
  useEffect(() => {
    if (!owner || startedRef.current) return;
    startedRef.current = true;
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        setRestored(true);
      }
    };
    const t = setTimeout(finish, RESTORE_WAIT_MS);
    restoreQueries(client, owner).catch(() => 0).finally(() => {
      clearTimeout(t);
      finish();
    });
  }, [client, owner]);

  // Save after successful fetches.
  useEffect(() => {
    if (!owner) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      const o = ownerRef.current;
      if (o) void persistQueries(client, o);
    };
    const unsub = client.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.action.type !== 'success') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, SAVE_DEBOUNCE_MS);
    });
    const app = AppState.addEventListener('change', (s) => {
      if (s !== 'active' && timer) flush();
    });
    const onHide = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && timer) flush();
    };
    if (Platform.OS === 'web' && typeof document !== 'undefined') document.addEventListener('visibilitychange', onHide);
    return () => {
      unsub();
      app.remove();
      if (Platform.OS === 'web' && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onHide);
      if (timer) clearTimeout(timer);
    };
  }, [client, owner]);

  return restored;
}
