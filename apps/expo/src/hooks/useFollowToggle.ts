import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Haptics from 'expo-haptics';
import { useQueryClient } from '@tanstack/react-query';
import { toggleFollowService } from '@/src/services/users';
import { followStateFromResult, intentFor, stateInSets, withStateInSets, type FollowState } from '@/src/lib/followState';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { emitToast } from '@/src/lib/toastBridge';

/**
 * Optimistic follow / unfollow / request for lists of people (Explore, search).
 * Seeds from the viewer's `following` list, gates guests at the tap, and rolls
 * back on failure. Private accounts end up "Requested", not "Following".
 */
export function useFollowToggle(initialFollowing: string[] | null | undefined) {
  const { requireAuth } = useAuthGate();
  const qc = useQueryClient();
  const [followed, setFollowed] = useState<Set<string>>(new Set());
  const [requested, setRequested] = useState<Set<string>>(new Set());
  const busy = useRef(new Set<string>());

  useEffect(() => {
    if (initialFollowing) setFollowed(new Set(initialFollowing));
  }, [initialFollowing]);

  const stateOf = useCallback((id: string): FollowState => stateInSets(followed, requested, id), [followed, requested]);

  const toggle = useCallback(
    async (id: string) => {
      if (!requireAuth('follow') || busy.current.has(id)) return;
      busy.current.add(id);
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const before = stateInSets(followed, requested, id);
      const apply = (state: FollowState) => {
        setFollowed((f) => withStateInSets(f, new Set(), id, state).followed);
        setRequested((r) => withStateInSets(new Set(), r, id, state).requested);
      };
      apply(before === 'none' ? 'following' : 'none');
      try {
        apply(followStateFromResult(await toggleFollowService(id, intentFor(before))));
        qc.invalidateQueries({ queryKey: ['profile'] });
      } catch {
        apply(before);
        emitToast('Follow update nahi ho paya. Dobara try karo.', 'error');
      } finally {
        busy.current.delete(id);
      }
    },
    [followed, requested, requireAuth, qc],
  );

  return { stateOf, toggle };
}
