import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { UserStats } from '../../types/user';
import { LinearGradient } from 'expo-linear-gradient';

interface WalletCardProps {
  Dpcoin: number;
  stats: UserStats;
  onPress?: () => void;
  onStatPress?: (type: 'wins' | 'battles' | 'votes') => void;
}

export const WalletCard = ({ Dpcoin, stats, onPress, onStatPress }: WalletCardProps) => {
  return (
    <View style={styles.outerContainer}>
      <LinearGradient
        colors={['#FF4D67', '#FF8A9B']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.container}
      >
        <TouchableOpacity onPress={onPress} activeOpacity={0.8} style={styles.header}>
          <View>
            <Text style={styles.label}>Wallet Balance</Text>
            <div style={{ flexDirection: 'row', alignItems: 'baseline' }}>
              <Text style={styles.coinValue}>{Dpcoin || 0}</Text>
              <Text style={styles.coinUnit}> Dpcoins</Text>
            </div>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Active</Text>
          </View>
        </TouchableOpacity>

        <View style={styles.divider} />

        <View style={styles.statsRow}>
          <TouchableOpacity 
            style={styles.statItem} 
            onPress={() => onStatPress?.('wins')}
            activeOpacity={0.7}
          >
            <Text style={styles.statValue}>{stats.wins || 0}</Text>
            <Text style={styles.statLabel}>Wins</Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={styles.statItem} 
            onPress={() => onStatPress?.('battles')}
            activeOpacity={0.7}
          >
            <Text style={styles.statValue}>{stats.contestsJoined || 0}</Text>
            <Text style={styles.statLabel}>Battles</Text>
          </TouchableOpacity>
          
          <TouchableOpacity 
            style={styles.statItem} 
            onPress={() => onStatPress?.('votes')}
            activeOpacity={0.7}
          >
            <Text style={styles.statValue}>{stats.totalVotesReceived || 0}</Text>
            <Text style={styles.statLabel}>Votes</Text>
          </TouchableOpacity>
        </View>
      </LinearGradient>
    </View>
  );
};

const styles = StyleSheet.create({
  outerContainer: {
    margin: 16,
    borderRadius: 24,
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#FF4D67',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
  },
  container: {
    padding: 24,
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
  coinValue: {
    fontSize: 36,
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
    paddingVertical: 5,
    paddingHorizontal: 15,
    borderRadius: 12,
  },
  statValue: {
    fontSize: 22,
    fontWeight: 'bold',
    color: '#FFFFFF',
    fontFamily: 'Urbanist-Bold',
  },
  statLabel: {
    fontSize: 13,
    color: 'rgba(255, 255, 255, 0.8)',
    fontFamily: 'Urbanist-Medium',
    marginTop: 2,
  },
});
