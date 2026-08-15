import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

const { width } = Dimensions.get('window');
const MEDIA = (width - 42) / 2;

export const PostSkeleton = (_props: { isDark?: boolean }) => (
  <View style={styles.container}>
    {/* Header */}
    <View style={styles.header}>
      <SkeletonCircle size={44} />
      <View style={styles.headerText}>
        <Skeleton width={120} height={16} />
        <Skeleton width={80} height={12} style={{ marginTop: 6 }} />
      </View>
    </View>

    {/* Media */}
    <View style={styles.media}>
      <Skeleton width={MEDIA} height={MEDIA} borderRadius={20} />
      <Skeleton width={MEDIA} height={MEDIA} borderRadius={20} />
    </View>

    {/* Voting buttons */}
    <View style={styles.voting}>
      <Skeleton width={MEDIA} height={45} borderRadius={25} />
      <Skeleton width={MEDIA} height={45} borderRadius={25} />
    </View>

    {/* Split info */}
    <View style={styles.split}>
      <Skeleton width={200} height={14} style={{ marginBottom: 15 }} />
      <Skeleton width="100%" height={6} borderRadius={3} />
    </View>
  </View>
);

const styles = StyleSheet.create({
  container: { paddingBottom: 20, marginBottom: 10 },
  header: { flexDirection: 'row', padding: 16, alignItems: 'center' },
  headerText: { marginLeft: 12 },
  media: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16 },
  voting: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16, marginTop: 20 },
  split: { paddingHorizontal: 16, marginTop: 20, alignItems: 'center' },
});
