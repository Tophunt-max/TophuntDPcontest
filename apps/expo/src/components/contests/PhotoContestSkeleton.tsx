import React from 'react';
import {
  View,
  StyleSheet,
  Dimensions,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Skeleton } from '../ui/Skeleton';

const { width } = Dimensions.get('window');

const Card = () => {
  const isDark = useColorScheme() === 'dark';
  const cardBg = isDark ? '#16171E' : '#FFFFFF';
  const border = isDark ? '#23262F' : '#EEEEEE';
  return (
    <View style={[styles.contestCard, { backgroundColor: cardBg, borderColor: border }]}>
      <View style={styles.cardHeader}>
        <Skeleton width={40} height={40} borderRadius={12} />
        <Skeleton width={width * 0.5} height={20} style={{ marginLeft: 14 }} />
      </View>
      <Skeleton width="100%" height={width * 0.55} borderRadius={14} />
      <View style={styles.cardBody}>
        <Skeleton width={90} height={12} />
        <Skeleton width={160} height={24} borderRadius={8} style={{ marginTop: 8 }} />
        <View style={styles.infoRow}>
          <View style={styles.infoItem}>
            <Skeleton width={18} height={18} borderRadius={9} />
            <Skeleton width={70} height={16} style={{ marginLeft: 8 }} />
          </View>
          <View style={styles.infoItem}>
            <Skeleton width={18} height={18} borderRadius={9} />
            <Skeleton width={90} height={16} style={{ marginLeft: 8 }} />
          </View>
        </View>
        <Skeleton width="100%" height={50} borderRadius={16} style={{ marginTop: 18 }} />
      </View>
    </View>
  );
};

export const PhotoContestSkeleton = () => (
  <View style={{ paddingHorizontal: 20, paddingTop: 8 }}>
    <Card />
    <Card />
  </View>
);

const styles = StyleSheet.create({
  contestCard: {
    borderRadius: 24,
    marginBottom: 20,
    borderWidth: 1,
    padding: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  cardBody: {
    paddingTop: 16,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 18,
  },
  infoItem: {
    flexDirection: 'row',
    alignItems: 'center',
  },
});
