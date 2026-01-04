import React from 'react';
import { View, StyleSheet, Dimensions, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Skeleton } from '../ui/Skeleton';

const { width } = Dimensions.get('window');

export const BattleSetupSkeleton = () => {
  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        {/* Title Skeleton */}
        <Skeleton width={200} height={35} borderRadius={10} style={{ marginVertical: 15, marginTop: 60 }} />

        {/* Breakdown Card Skeleton */}
        <View style={styles.breakdownCard}>
          <Skeleton width={150} height={20} borderRadius={5} style={{ marginBottom: 20 }} />
          
          <View style={styles.playersContainer}>
            <View style={styles.playerItem}>
              <Skeleton width={70} height={70} borderRadius={35} style={{ marginBottom: 8 }} />
              <Skeleton width={60} height={18} borderRadius={5} style={{ marginBottom: 4 }} />
              <Skeleton width={40} height={16} borderRadius={5} />
            </View>

            <View style={styles.vsCircle}>
              <Skeleton width={44} height={44} borderRadius={22} />
            </View>

            <View style={styles.playerItem}>
              <Skeleton width={70} height={70} borderRadius={35} style={{ marginBottom: 8 }} />
              <Skeleton width={60} height={18} borderRadius={5} style={{ marginBottom: 4 }} />
              <Skeleton width={40} height={16} borderRadius={5} />
            </View>
          </View>

          <Skeleton width="100%" height={45} borderRadius={12} />
        </View>

        {/* Your Submission Section Skeleton */}
        <View style={styles.submissionSection}>
           <Skeleton width={150} height={25} borderRadius={5} style={{ marginBottom: 15 }} />
           
           <Skeleton width="100%" height={width / 1.5} borderRadius={20} />
        </View>

        {/* Join Button Skeleton */}
        <Skeleton width="100%" height={65} borderRadius={20} style={{ marginBottom: 15 }} />
        
        {/* Rules Text Skeleton */}
        <Skeleton width={250} height={15} borderRadius={5} />

      </ScrollView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  scrollContent: { paddingHorizontal: 20, alignItems: 'center', paddingBottom: 40 },
  breakdownCard: {
    width: '100%',
    borderRadius: 25,
    borderWidth: 1,
    borderColor: '#EEEEEE',
    padding: 20,
    alignItems: 'center',
    marginBottom: 25,
  },
  playersContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 10,
    marginBottom: 20,
  },
  playerItem: {
    alignItems: 'center',
    flex: 1,
  },
  vsCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
  },
  submissionSection: {
    width: '100%',
    marginBottom: 30,
  },
});
