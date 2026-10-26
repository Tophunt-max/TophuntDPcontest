import { useCallback, useEffect, useRef } from 'react';

/**
 * One AbortSignal per user action, aborted when the screen unmounts (or when a
 * new action starts).
 *
 * Upload screens awaited the upload and then wrote to the server: a story, or a
 * contest entry that DEBITS the entry fee. If the user left mid-upload the
 * handler kept running and still published, charged and navigated from a
 * screen that no longer existed. Pass the signal to the upload, and check
 * `signal.aborted` before any server write.
 */
export function useAbortOnUnmount(): () => AbortSignal {
  const current = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      current.current?.abort();
    },
    [],
  );
  return useCallback(() => {
    current.current?.abort();
    const c = new AbortController();
    current.current = c;
    return c.signal;
  }, []);
}
