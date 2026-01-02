import React from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';

const { width } = Dimensions.get('window');

const SkeletonPlaceholder = ({ height, width, borderRadius = 4, style }: { height: number; width?: number | string; borderRadius?: number; style?: object }) => (
  <View style={[styles.skeleton, { height, width, borderRadius }, style]} />
);

export const PhotoContestSkeleton = () => {
  return (
    <View>
      <View style={styles.contestCard}>
        <View style={styles.cardHeaderSkeleton}> {/* Mimicking header area */}
          <SkeletonPlaceholder height={40} width={40} borderRadius={12} />
          <SkeletonPlaceholder height={22} width={width * 0.5} style={{ marginLeft: 15 }} />
        </View>
        <SkeletonPlaceholder height={width * 0.7} width={width - 40} borderRadius={10} style={{ marginHorizontal: 20, marginTop: 10 }} />
        <View style={styles.cardBody}>
          <SkeletonPlaceholder height={14} width={80} style={{ marginBottom: 5 }} /> {/* Prize Pool label */}
          <SkeletonPlaceholder height={25} width={160} borderRadius={8} style={{ marginBottom: 15 }} /> {/* Prize badge */}

          <SkeletonPlaceholder height={1} width="100%" style={{ marginVertical: 15 }} /> {/* Divider */}

          <View style={styles.infoRow}> {/* Single info row */}
            <View style={styles.infoItemSkeleton}> {/* Entry Fee */}
              <SkeletonPlaceholder height={18} width={18} borderRadius={9} />
              <SkeletonPlaceholder height={18} width={80} style={{ marginLeft: 6 }} />
            </View>
            <View style={styles.infoItemSkeleton}> {/* Time Left */}
              <SkeletonPlaceholder height={18} width={18} borderRadius={9} />
              <SkeletonPlaceholder height={18} width={100} style={{ marginLeft: 6 }} />
            </View>
          </View>

          <SkeletonPlaceholder height={50} width="100%" borderRadius={16} style={{ marginTop: 20 }} /> {/* Enter Now Button */}
        </View>
      </View>
      <View style={{ height: 20 }} /> {/* Spacer between cards */}
      <View style={styles.contestCard}>
        <View style={styles.cardHeaderSkeleton}>
          <SkeletonPlaceholder height={40} width={40} borderRadius={12} />
          <SkeletonPlaceholder height={22} width={width * 0.5} style={{ marginLeft: 15 }} />
        </View>
        <SkeletonPlaceholder height={width * 0.7} width={width - 40} borderRadius={10} style={{ marginHorizontal: 20, marginTop: 10 }} />
        <View style={styles.cardBody}>
          <SkeletonPlaceholder height={14} width={80} style={{ marginBottom: 5 }} />
          <SkeletonPlaceholder height={25} width={160} borderRadius={8} style={{ marginBottom: 15 }} />

          <SkeletonPlaceholder height={1} width="100%" style={{ marginVertical: 15 }} />

          <View style={styles.infoRow}>
            <View style={styles.infoItemSkeleton}>
              <SkeletonPlaceholder height={18} width={18} borderRadius={9} />
              <SkeletonPlaceholder height={18} width={80} style={{ marginLeft: 6 }} />
            </View>
            <View style={styles.infoItemSkeleton}>
              <SkeletonPlaceholder height={18} width={18} borderRadius={9} />
              <SkeletonPlaceholder height={18} width={100} style={{ marginLeft: 6 }} />
            </View>
          </View>

          <SkeletonPlaceholder height={50} width="100%" borderRadius={16} style={{ marginTop: 20 }} />
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  skeleton: {
    backgroundColor: '#E1E9EE',
    borderRadius: 4,
  },
  contestCard: { 
    borderRadius: 24, 
    marginBottom: 20,
    borderWidth: 1,
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    backgroundColor: '#FFFFFF', // Default background for skeleton card
    borderColor: '#EEEEEE', // Default border for skeleton card
  },
  cardHeaderSkeleton: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 20,
    paddingBottom: 10,
  },
  cardBody: {
    padding: 20,
    paddingTop: 10,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 20,
  },
  infoItemSkeleton: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
