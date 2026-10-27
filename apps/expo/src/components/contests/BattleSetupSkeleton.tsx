import React from 'react';
import { View, StyleSheet, ScrollView, Platform } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Colors } from '@/constants/theme';
import { useResolvedColorScheme } from '@/src/lib/themePreference';
import { Skeleton, SkeletonCircle } from '../ui/Skeleton';

/**
 * Battle Setup while the contest loads. Mirrors app/contest/photo/setup.tsx:
 *
 *   header (pad 20/10): 40 back circle · 18pt title · 40-tall wallet pill
 *   scroll (padH 20, padT 8):
 *     breakdown card (radius 24, border, pad 20, mb 24): label row, two 78
 *       avatar rings around a 46 VS orb, then the ~46-tall winner banner
 *     step 1 (mb 22): 26 badge + 19pt title, upload box (aspect 1.5, radius 20)
 *     step 2 (mb 22): badge + title, three labelled 56-tall inputs (last 100)
 *   footer (top border, pad 20/14): 60-tall join button
 */
export const BattleSetupSkeleton = () => {
  const isDark = useResolvedColorScheme() === 'dark';
  const bg = isDark ? Colors.dark.background : Colors.light.background;
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  const player = (
    <View style={styles.playerItem}>
      <SkeletonCircle size={78} style={{ marginBottom: 10 }} />
      <Skeleton width={64} height={15} borderRadius={7} style={{ marginBottom: 6 }} />
      <Skeleton width={44} height={16} borderRadius={8} />
    </View>
  );

  const sectionHeader = (titleW: number) => (
    <View style={styles.sectionHeaderRow}>
      <SkeletonCircle size={26} />
      <Skeleton width={titleW} height={19} borderRadius={8} />
    </View>
  );

  const input = (labelW: number, height = 56) => (
    <View style={styles.inputGroup}>
      <Skeleton width={labelW} height={12} borderRadius={6} style={{ marginBottom: 9, marginLeft: 4 }} />
      <Skeleton width="100%" height={height} borderRadius={16} />
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
        <SkeletonCircle size={40} />
        <Skeleton width={110} height={18} borderRadius={8} />
        <Skeleton width={78} height={40} borderRadius={20} />
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} scrollEnabled={false}>
        <View style={[styles.breakdownCard, { backgroundColor: cardBg, borderColor }]}>
          <Skeleton width={150} height={15} borderRadius={7} style={{ marginBottom: 22 }} />
          <View style={styles.playersContainer}>
            {player}
            <SkeletonCircle size={46} />
            {player}
          </View>
          <Skeleton width="100%" height={46} borderRadius={14} />
        </View>

        <View style={styles.formSection}>
          {sectionHeader(150)}
          <View style={{ width: '100%', aspectRatio: 1.5 }}>
            <Skeleton width="100%" height="100%" borderRadius={20} />
          </View>
        </View>

        <View style={styles.formSection}>
          {sectionHeader(130)}
          {input(90)}
          {input(80)}
          {input(110, 100)}
        </View>
      </ScrollView>

      <View style={[styles.footer, { backgroundColor: bg, borderTopColor: borderColor }]}>
        <Skeleton width="100%" height={60} borderRadius={20} style={{ marginBottom: 12 }} />
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
  },
  scrollContent: { paddingHorizontal: 20, alignItems: 'center', paddingBottom: 20, paddingTop: 8 },
  breakdownCard: {
    width: '100%',
    borderRadius: 24,
    borderWidth: 1,
    padding: 20,
    alignItems: 'center',
    marginBottom: 24,
  },
  playersContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 10,
    marginBottom: 22,
  },
  playerItem: { alignItems: 'center', flex: 1 },
  formSection: { width: '100%', marginBottom: 22 },
  sectionHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 16 },
  inputGroup: { width: '100%', marginBottom: 16 },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: Platform.OS === 'ios' ? 0 : 20,
    borderTopWidth: 1,
  },
});
