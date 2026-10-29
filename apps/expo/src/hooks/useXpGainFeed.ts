import { useCallback, useEffect, useRef, useState } from 'react';
import { BoundedIdSet, XpGainQueue, unseenEvents, type ServerXpEvent, type XpGainItem } from '@/src/lib/xpAnimation';
import { loadSeenIds, saveSeenIds } from '@/src/services/gamification';

/**
 * Turns server XP events into at most one floating "+XP" item at a time.
 *
 * - Dedupe is by the server's event id, persisted per account on this device,
 *   so polling, refetches, remounts and re-opening the app never replay a gain.
 * - The first snapshot a device ever sees is a silent baseline.
 * - The queue is bounded and bursts are batched (lib/xpAnimation.ts).
 * - Everything is cleared on unmount; no timers live here.
 */
export function useXpGainFeed(uid: string | null | undefined, events: ServerXpEvent[] | null | undefined) {
  const seen = useRef<BoundedIdSet | null>(null);
  const baseline = useRef(false);
  const queue = useRef(new XpGainQueue());
  const [current, setCurrent] = useState<XpGainItem | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    const q = queue.current;
    seen.current = null;
    setReady(false);
    if (!uid) return;
    loadSeenIds('xp', uid).then((ids) => {
      if (!alive) return;
      baseline.current = ids === null;
      seen.current = new BoundedIdSet(200, ids ?? []);
      setReady(true);
    });
    return () => {
      alive = false;
      q.clear();
    };
  }, [uid]);

  useEffect(() => {
    if (!ready || !uid || !seen.current || !events?.length) return;
    const fresh = unseenEvents(events, seen.current, baseline.current);
    baseline.current = false;
    void saveSeenIds('xp', uid, seen.current.toArray());
    if (!fresh.length) return;
    queue.current.push(fresh);
    setCurrent((cur) => cur ?? queue.current.shift() ?? null);
  }, [events, ready, uid]);

  /** Call when the floating item finished; shows the next one, if any. */
  const done = useCallback(() => setCurrent(queue.current.shift() ?? null), []);

  return { current, done };
}
