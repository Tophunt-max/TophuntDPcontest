/**
 * The way into "My Prizes" from the user's own profile.
 *
 * Renders NOTHING when the user has never won a product. Almost nobody has, and a
 * permanent empty row on every profile is the kind of dead UI that makes the rows
 * around it easier to ignore.
 *
 * When there IS something waiting on the user it stops being a link and becomes a
 * call to action, because that state is the one failure mode this whole feature
 * has: a prize is sitting there, unshippable, until the winner supplies an address,
 * and the notification that told them so may be days old and buried.
 */
import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@/src/lib/icons';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { useMyPrizes } from '@/src/hooks/usePrizes';
import { needsAddress } from '@/src/services/prizes/prizeService';

export function PrizeEntryCard({ isDark }: { isDark: boolean }) {
  // Five minutes: this mounts on every own-profile render for every user, and
  // almost none of them have ever won a product. The prize screens themselves
  // still read it fresh.
  const { data: prizes = [] } = useMyPrizes({ staleTime: 5 * 60_000 });
  if (!prizes.length) return null;

  const waiting = needsAddress(prizes);
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const borderColor = isDark ? '#23262D' : '#EEF0F4';
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subTextColor = isDark ? '#A0A0A0' : '#757575';

  const open = () => router.push('/prizes');

  if (waiting.length > 0) {
    return (
      <TouchableOpacity onPress={open} activeOpacity={0.9} style={styles.wrap} accessibilityRole="button">
        <LinearGradient
          colors={['#7C3AED', '#A78BFA']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.actionCard}
        >
          <View style={styles.iconCircle}>
            <Ionicons name="cube" size={20} color="#FFFFFF" />
          </View>
          <View style={styles.actionBody}>
            <Text style={styles.actionTitle} numberOfLines={1}>
              {waiting.length === 1 ? 'You won a prize!' : `${waiting.length} prizes to claim`}
            </Text>
            <Text style={styles.actionSub} numberOfLines={2}>
              {waiting.length === 1
                ? `Add your delivery address to claim ${waiting[0].productTitle}.`
                : 'Add your delivery address so we can ship them.'}
            </Text>
          </View>
          <ArrowIcon size={16} color="#FFFFFF" variant="arrow" />
        </LinearGradient>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity onPress={open} activeOpacity={0.85} style={styles.wrap} accessibilityRole="button">
      <View style={[styles.row, { backgroundColor: cardBg, borderColor }]}>
        <View style={[styles.iconCircle, styles.iconCircleQuiet]}>
          <Ionicons name="cube" size={18} color="#A78BFA" />
        </View>
        <View style={styles.actionBody}>
          <Text style={[styles.rowTitle, { color: textColor }]}>My Prizes</Text>
          <Text style={[styles.rowSub, { color: subTextColor }]} numberOfLines={1}>
            {prizes.length === 1 ? '1 prize won' : `${prizes.length} prizes won`}
          </Text>
        </View>
        <ArrowIcon size={14} color={subTextColor} variant="arrow" />
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 16, marginBottom: 8 },
  actionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 18,
    padding: 16,
    shadowColor: '#7C3AED',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 8,
    elevation: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderRadius: 18,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  iconCircle: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconCircleQuiet: { backgroundColor: 'rgba(167,139,250,0.16)' },
  actionBody: { flex: 1, gap: 2 },
  actionTitle: { color: '#FFFFFF', fontFamily: 'Urbanist-Bold', fontSize: 15 },
  actionSub: { color: 'rgba(255,255,255,0.88)', fontFamily: 'Urbanist-Medium', fontSize: 12, lineHeight: 16 },
  rowTitle: { fontFamily: 'Urbanist-Bold', fontSize: 15 },
  rowSub: { fontFamily: 'Urbanist-Medium', fontSize: 12 },
});
