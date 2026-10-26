import { useCallback, useRef, useState } from 'react';
import { useIsFocused } from '@react-navigation/native';

import { sameIds } from '@/src/lib/liveWindow';
import { shouldAutoplay, visibleIdsFor } from '@/src/lib/playbackPolicy';
import { useAppActive, useReduceMotion } from '@/src/hooks/usePlaybackEnvironment';

/**
 * Home's playback rule (src/lib/playbackPolicy.ts) for any list of battle cards.
 *
 * Profile and Wins rendered `<PostCard>` without `playActive`, so every mounted
 * card (FlatList keeps several screens mounted, two players per video battle)
 * autoplayed, including under a pushed screen. Spread `listProps` on the FlatList
 * and pass `playActive={isPlaying(item.id)}` to each card.
 */
export function useListPlayback() {
  const [visibleIds, setVisibleIds] = useState<Set<string>>(() => new Set());
  const screenFocused = useIsFocused();
  const appActive = useAppActive();
  const reduceMotion = useReduceMotion();

  // FlatList throws if these change identity.
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { item: any }[] }) => {
    const next = visibleIdsFor(viewableItems);
    setVisibleIds((prev) => (sameIds(prev, next) ? prev : next));
  }).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 50 }).current;

  const isPlaying = useCallback(
    (id: string) => shouldAutoplay({ visible: visibleIds.has(id), screenFocused, appActive, reduceMotion }),
    [visibleIds, screenFocused, appActive, reduceMotion],
  );

  return { listProps: { onViewableItemsChanged, viewabilityConfig }, isPlaying, visibleIds };
}

/** A single card that is always on screen (battle detail): play only while focused and in the foreground. */
export function useScreenPlayback(): boolean {
  const screenFocused = useIsFocused();
  const appActive = useAppActive();
  const reduceMotion = useReduceMotion();
  return shouldAutoplay({ visible: true, screenFocused, appActive, reduceMotion });
}
