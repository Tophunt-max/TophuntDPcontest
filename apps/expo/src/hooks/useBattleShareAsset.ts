import { useCallback, useEffect, useRef, useState } from 'react';
import { contestService } from '@/src/services/contests/contestService';
import { resolveBattleShareAsset, type BattleShareAsset } from '@/src/lib/vsShareAsset';

const POLL_MS = 3000;
const MAX_POLLS = 10;

/**
 * Resolve a battle's canonical share image while a share surface is open.
 *
 * - Keyed by `matchId`: state is cleared the moment the match changes, and a
 *   late answer for a previous match is discarded, so one battle's image can
 *   never be offered for another.
 * - Polls (bounded) while the server reports `preparing`.
 * - `retry()` re-resolves on demand; it only ever reads.
 */
export function useBattleShareAsset(matchId: string, active: boolean) {
  const [asset, setAsset] = useState<BattleShareAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef(matchId);
  current.current = matchId;
  const polls = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resolve = useCallback(async () => {
    const target = matchId;
    if (!target) return;
    setLoading(true);
    try {
      const next = await resolveBattleShareAsset(target, { fetchShareImage: contestService.getMatchShareImage });
      if (current.current === target) setAsset(next);
    } finally {
      if (current.current === target) setLoading(false);
    }
  }, [matchId]);

  // New match or reopened sheet: forget everything about the previous one.
  useEffect(() => {
    setAsset(null);
    polls.current = 0;
    if (active && matchId) void resolve();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, matchId, resolve]);

  useEffect(() => {
    if (!active || loading || asset?.status !== 'preparing' || asset.matchId !== matchId) return;
    if (polls.current >= MAX_POLLS) return;
    timer.current = setTimeout(() => {
      polls.current += 1;
      void resolve();
    }, POLL_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, loading, asset, matchId, resolve]);

  const retry = useCallback(() => {
    polls.current = 0;
    void resolve();
  }, [resolve]);

  // Never hand back an asset that belongs to a different match.
  const safe = asset && asset.matchId === matchId ? asset : null;
  return { asset: safe, loading: loading || (active && !safe), retry };
}
