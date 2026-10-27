import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { UserProfile } from '../../types/user';
import { LinearGradient } from 'expo-linear-gradient';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { DiamondIcon } from '@/src/components/ui/DiamondIcon';
import { useCoinRate } from '@/src/hooks/useCoinPackages';
import { coinsInInr } from '@/src/lib/coinValue';

interface WalletCardProps {
  Dpcoin: number;
  /** The Diamond part of `Dpcoin` (users.locked_coins): play-only, never withdrawable. */
  lockedCoins?: number;
  stats: UserProfile['stats'];
  onPress?: () => void;
  /** Tapping the Wins stat opens the list of battles this user has won. */
  onPressWins?: () => void;
}

export const WalletCard = ({ Dpcoin, lockedCoins, stats, onPress, onPressWins }: WalletCardProps) => {
  // Two balances (src/lib/balances.ts): DP coins are withdrawable and carry a
  // ₹ value; Diamonds only pay entry fees, so they have none.
  const diamonds = Math.min(Math.max(0, Number(lockedCoins) || 0), Math.max(0, Dpcoin || 0));
  const dpcoin = Math.max(0, (Dpcoin || 0) - diamonds);
  const value = coinsInInr(dpcoin, useCoinRate());
  return (
    <LinearGradient
      colors={['#FF4D67', '#FF8A9B']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.container}
    >
      {/* Wallet balance → wallet screen */}
      <TouchableOpacity onPress={onPress} activeOpacity={0.9} style={styles.header}>
        <View style={styles.balances}>
          <View accessible accessibilityLabel={`${dpcoin} DP coins, withdrawable`}>
            <Text style={styles.label}>DP coin</Text>
            <View style={styles.coinRow}>
              <CoinIcon size={24} color="#FFFFFF" style={{ marginRight: 6 }} />
              <Text style={styles.coinValue}>{dpcoin}</Text>
            </View>
            <Text style={styles.split}>{value ? `Withdraw · ${value}` : 'Withdraw ho sakte'}</Text>
          </View>
          <View style={styles.balanceDivider} />
          <View accessible accessibilityLabel={`${diamonds} Diamonds, for contest entry only`}>
            <Text style={styles.label}>Diamond</Text>
            <View style={styles.coinRow}>
              <DiamondIcon size={24} color="#FFFFFF" style={{ marginRight: 6 }} />
              <Text style={styles.coinValue}>{diamonds}</Text>
            </View>
            <Text style={styles.split}>Contest entry ke liye</Text>
          </View>
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>Active</Text>
        </View>
      </TouchableOpacity>

      <View style={styles.divider} />

      <View style={styles.statsRow}>
        {/* Wins → winner list */}
        <TouchableOpacity style={styles.statItem} activeOpacity={0.7} onPress={onPressWins} accessibilityRole="button" accessibilityLabel="View your wins">
          <Text style={styles.statValue}>{stats.wins || 0}</Text>
          <Text style={styles.statLabel}>Wins</Text>
        </TouchableOpacity>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{stats.contestsJoined || 0}</Text>
          <Text style={styles.statLabel}>Battles</Text>
        </View>
        <View style={styles.statItem}>
          <Text style={styles.statValue}>{stats.totalVotesReceived || 0}</Text>
          <Text style={styles.statLabel}>Votes</Text>
        </View>
      </View>
    </LinearGradient>
  );
};

const styles = StyleSheet.create({
  container: {
    margin: 16,
    padding: 24,
    borderRadius: 20,
    elevation: 5,
    shadowColor: '#FF4D67',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  label: {
    fontSize: 14,
    color: 'rgba(255, 255, 255, 0.8)',
    marginBottom: 4,
    fontFamily: 'Urbanist-Medium',
  },
  balances: { flexDirection: 'row', alignItems: 'flex-start', flexShrink: 1 },
  balanceDivider: { width: 1, alignSelf: 'stretch', backgroundColor: 'rgba(255, 255, 255, 0.25)', marginHorizontal: 16 },
  split: {
    fontSize: 12,
    color: '#FFFFFF',
    fontFamily: 'Urbanist-SemiBold',
    marginTop: 2,
  },
  coinRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  coinValue: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#FFFFFF',
    fontFamily: 'Urbanist-Bold',
  },
  coinUnit: {
    fontSize: 16,
    color: '#FFFFFF',
    fontWeight: '600',
    fontFamily: 'Urbanist-SemiBold',
    marginLeft: 4,
  },
  badge: {
    backgroundColor: 'rgba(255, 255, 255, 0.2)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: 'bold',
    fontFamily: 'Urbanist-Bold',
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
    marginVertical: 20,
  },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
  },
  statValue: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#FFFFFF',
    fontFamily: 'Urbanist-Bold',
  },
  statLabel: {
    fontSize: 12,
    color: 'rgba(255, 255, 255, 0.8)',
    fontFamily: 'Urbanist-Medium',
    marginTop: 2,
  },
});
