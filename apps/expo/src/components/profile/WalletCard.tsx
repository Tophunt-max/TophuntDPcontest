import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { UserProfile } from '../../types/user';
import { LinearGradient } from 'expo-linear-gradient';

interface WalletCardProps {
  Dpcoin: number;
  stats: UserProfile['stats'];
  onPress?: () => void;
}

export const WalletCard = ({ Dpcoin, stats, onPress }: WalletCardProps) => {
  return (
    <TouchableOpacity 
      onPress={onPress}
      activeOpacity={0.9}
    >
      <LinearGradient
        colors={['#FF4D67', '#FF8A9B']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.container}
      >
        <View style={styles.header}>
          <View>
            <Text style={styles.label}>Wallet Balance</Text>
            <View style={styles.coinRow}>
              <Text style={styles.coinValue}>{Dpcoin || 0}</Text>
              <Text style={styles.coinUnit}> Dpcoins</Text>
            </View>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Active</Text>
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.statsRow}>
          <View style={styles.statItem}>
            <Text style={styles.statValue}>{stats.wins || 0}</Text>
            <Text style={styles.statLabel}>Wins</Text>
          </View>
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
    </TouchableOpacity>
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
  coinRow: {
    flexDirection: 'row',
    alignItems: 'baseline',
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
