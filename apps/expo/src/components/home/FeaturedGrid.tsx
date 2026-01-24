import React from 'react';
import { View, StyleSheet, Text, TouchableOpacity, useColorScheme, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

const { width } = Dimensions.get('window');

export default function FeaturedGrid() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const textColor = '#FFF';

  return (
    <View style={styles.container}>
      {/* Featured Card - Leaderboard (Redesigned as the main focus) */}
      <TouchableOpacity 
        style={styles.featuredCard}
        activeOpacity={0.8}
        onPress={() => router.push('/explore/leaderboard')}
      >
        <LinearGradient
            colors={['#FF4D67', '#FF8A9B']}
            start={{x: 0, y: 0}}
            end={{x: 1, y: 0}}
            style={styles.gradient}
        >
            <View style={styles.contentWrapper}>
                <View style={styles.textContainer}>
                    <Text style={styles.featuredTitle}>Arena Leaderboard</Text>
                    <Text style={styles.featuredSub}>Check out the top Hunters and current rankings</Text>
                </View>
                <View style={styles.actionButton}>
                    <Text style={styles.btnText}>View Rankings</Text>
                    <Ionicons name="arrow-forward" size={16} color="#FF4D67" />
                </View>
            </View>
            <Ionicons name="podium" size={80} color="rgba(255,255,255,0.2)" style={styles.bgIcon} />
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: 16,
    marginBottom: 20,
    marginTop: 10,
  },
  featuredCard: {
    height: 120,
    borderRadius: 24,
    overflow: 'hidden',
    shadowColor: "#FF4D67",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 5,
  },
  gradient: {
    flex: 1,
    padding: 20,
    justifyContent: 'center',
  },
  contentWrapper: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 2,
  },
  textContainer: {
    flex: 1,
    marginRight: 10,
  },
  featuredTitle: {
    color: '#FFF',
    fontFamily: 'Urbanist-Bold',
    fontSize: 22,
    marginBottom: 4,
  },
  featuredSub: {
    color: 'rgba(255,255,255,0.85)',
    fontFamily: 'Urbanist-Medium',
    fontSize: 13,
    lineHeight: 18,
  },
  actionButton: {
    backgroundColor: '#FFF',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  btnText: {
    color: '#FF4D67',
    fontFamily: 'Urbanist-Bold',
    fontSize: 14,
  },
  bgIcon: {
    position: 'absolute',
    right: -10,
    bottom: -20,
    zIndex: 1,
  }
});
