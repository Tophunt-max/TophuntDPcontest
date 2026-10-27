import React from 'react';
import { View } from 'react-native';
import { Skeleton } from '../ui/Skeleton';
import { ContestCardSkeleton } from '../skeletons/ContestListSkeleton';

/**
 * Photo Contests while loading. The screen already pads the scroll view by 20,
 * so this adds no inset of its own. It mirrors the list header ("Pick your
 * battle" 26pt, a 14pt subtitle on a 20 line, the live-count pill) and then
 * the contest cards.
 */
export const PhotoContestSkeleton = () => (
  <View>
    <View style={{ marginBottom: 20 }}>
      <Skeleton width={190} height={26} borderRadius={8} style={{ marginTop: 3 }} />
      <Skeleton width="92%" height={13} borderRadius={6} style={{ marginTop: 10 }} />
      <Skeleton width="58%" height={13} borderRadius={6} style={{ marginTop: 7 }} />
      <Skeleton width={118} height={30} borderRadius={20} style={{ marginTop: 14 }} />
    </View>
    <ContestCardSkeleton />
    <ContestCardSkeleton />
  </View>
);
