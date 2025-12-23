import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';

const SkeletonPlaceholder = ({ height, width, borderRadius = 4 }: { height: number; width?: number | string; borderRadius?: number }) => (
  <View style={[styles.skeleton, { height, width, borderRadius }]} />
);

export const ProfileHeaderSkeleton = () => (
  <View style={styles.headerContainer}>
    <View style={styles.topBar}>
      <SkeletonPlaceholder height={24} width={24} borderRadius={12} />
      <SkeletonPlaceholder height={24} width={150} />
      <SkeletonPlaceholder height={24} width={24} borderRadius={12} />
    </View>
    <SkeletonPlaceholder height={100} width={100} borderRadius={50} />
    <SkeletonPlaceholder height={20} width={200} style={{ marginTop: 12 }} />
    <SkeletonPlaceholder height={16} width={180} style={{ marginTop: 8 }} />
    <SkeletonPlaceholder height={40} width="80%" style={{ marginTop: 16 }} />
    <View style={styles.statsContainer}>
      <SkeletonPlaceholder height={50} width={80} />
      <SkeletonPlaceholder height={50} width={80} />
      <SkeletonPlaceholder height={50} width={80} />
    </View>
  </View>
);

const { width } = Dimensions.get('window');
const itemSize = width / 3;

export const PostGridSkeleton = () => (
  <View style={styles.gridContainer}>
    {Array.from({ length: 9 }).map((_, index) => (
      <View key={index} style={styles.gridItem}>
        <SkeletonPlaceholder height={itemSize * 1.5 - 2} width={itemSize - 2} borderRadius={8} />
      </View>
    ))}
  </View>
);

const styles = StyleSheet.create({
  skeleton: {
    backgroundColor: '#E1E9EE',
    borderRadius: 4,
  },
  headerContainer: {
    alignItems: 'center',
    padding: 16,
    width: '100%',
  },
  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    marginBottom: 16,
  },
  statsContainer: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    width: '100%',
    marginTop: 16,
  },
  gridContainer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  gridItem: {
    width: itemSize,
    height: itemSize * 1.5,
    padding: 1,
  },
});
