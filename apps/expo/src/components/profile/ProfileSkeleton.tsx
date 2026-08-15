import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

export const ProfileHeaderSkeleton = () => (
  <View style={styles.headerContainer}>
    <View style={styles.topBar}>
      <SkeletonCircle size={26} />
      <Skeleton width={140} height={20} />
      <SkeletonCircle size={26} />
    </View>

    <SkeletonCircle size={100} style={{ marginTop: 20 }} />
    <Skeleton width={180} height={20} style={{ marginTop: 14 }} />
    <Skeleton width={120} height={13} style={{ marginTop: 8 }} />

    <View style={styles.statsContainer}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={{ alignItems: 'center' }}>
          <Skeleton width={44} height={20} />
          <Skeleton width={60} height={11} style={{ marginTop: 8 }} />
        </View>
      ))}
    </View>

    <Skeleton width="88%" height={44} borderRadius={12} style={{ marginTop: 20 }} />

    {/* WalletCard placeholder */}
    <Skeleton width="100%" height={120} borderRadius={20} style={{ marginTop: 20 }} />

    {/* Highlights row */}
    <View style={styles.highlightsContainer}>
      {[0, 1, 2, 3].map((i) => (
        <SkeletonCircle key={i} size={60} style={{ marginRight: 14 }} />
      ))}
    </View>

    {/* Tabs */}
    <View style={styles.tabsContainer}>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} width={80} height={30} borderRadius={15} />
      ))}
    </View>
  </View>
);

const { width } = Dimensions.get('window');
const GAP = 2;
const itemSize = (width - GAP * 2) / 3;

export const PostGridSkeleton = () => (
  <View style={styles.gridContainer}>
    {Array.from({ length: 9 }).map((_, index) => (
      <Skeleton
        key={index}
        width={itemSize}
        height={itemSize * 1.4}
        borderRadius={10}
        style={{ margin: GAP / 2 }}
      />
    ))}
  </View>
);

const styles = StyleSheet.create({
  headerContainer: { alignItems: 'center', padding: 16, width: '100%' },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginTop: 22,
  },
  highlightsContainer: {
    flexDirection: 'row',
    marginTop: 22,
    alignSelf: 'flex-start',
    paddingLeft: 4,
  },
  tabsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginTop: 22,
    paddingHorizontal: 20,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: GAP / 2,
    marginTop: 8,
  },
});
