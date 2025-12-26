import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

interface WalletCardProps {
  fishCoins: number;
  stats: {
    contestsJoined: number;
    wins: number;
  };
  onPress?: () => void; // New Prop
}

export const WalletCard = ({ fishCoins, stats, onPress }: WalletCardProps) => {
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={onPress} style={styles.container}>
      <LinearGradient
        colors={['#FF4D67', '#FF8A9B']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 0 }}
        style={styles.card}
      >
        <View style={styles.topRow}>
          <View>
            <Text style={styles.label}>My Fish Coins</Text>
            <View style={styles.coinRow}>
              <Ionicons name="fish" size={24} color="white" />
              <Text style={styles.coinValue}>{fishCoins || 0}</Text>
            </View>
          </View>
          <View style={styles.topUpBtn}>
            <Text style={styles.topUpText}>+ Top Up</Text>
          </View>
        </View>

        <View style={styles.divider} />

        <View style={styles.bottomRow}>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Contests</Text>
            <Text style={styles.statValue}>{stats.contestsJoined || 0}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Total Wins</Text>
            <Text style={styles.statValue}>{stats.wins || 0}</Text>
          </View>
          <View style={styles.statBox}>
            <Text style={styles.statLabel}>Status</Text>
            <Text style={styles.statValue}>Pro</Text>
          </View>
        </View>
      </LinearGradient>
    </TouchableOpacity>
  );
};

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    marginTop: 20,
    marginBottom: 10,
  },
  card: {
    borderRadius: 24,
    padding: 20,
    elevation: 8,
    shadowColor: '#FF4D67',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  label: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 14,
    fontFamily: 'Urbanist-Medium',
  },
  coinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 5,
  },
  coinValue: {
    color: 'white',
    fontSize: 32,
    fontFamily: 'Urbanist-Bold',
    marginLeft: 8,
  },
  topUpBtn: {
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.4)'
  },
  topUpText: {
    color: 'white',
    fontFamily: 'Urbanist-Bold',
    fontSize: 14,
  },
  divider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.2)',
    marginVertical: 15,
  },
  bottomRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  statBox: {
    alignItems: 'center',
  },
  statLabel: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    fontFamily: 'Urbanist-Medium',
  },
  statValue: {
    color: 'white',
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
    marginTop: 4,
  },
});
