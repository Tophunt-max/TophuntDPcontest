import React from 'react';
import { View, StyleSheet, Text, TouchableOpacity, useColorScheme, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@/src/lib/icons';

const { width } = Dimensions.get('window');

export default function FeaturedGrid() {
  const router = useRouter();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const cardBg = isDark ? '#1F222A' : '#F5F5F5';
  const textColor = isDark ? '#FFF' : '#212121';

  return (
    <View style={styles.container}>
      {/* Big Card - Contest */}
      <TouchableOpacity 
        style={[styles.bigCard, { backgroundColor: '#FF4D67' }]}
        activeOpacity={0.8}
        onPress={() => router.push('/contests' as any)}
      >
        <View style={styles.textWrapper}>
            <Text style={styles.bigTitle}>Mega Contest</Text>
            <Text style={styles.subTitle}>Win 10,000 Coins!</Text>
            <View style={styles.btn}>
                <Text style={styles.btnText}>Join Now</Text>
            </View>
        </View>
        <Ionicons name="trophy" size={60} color="rgba(255,255,255,0.3)" style={styles.iconBig} />
      </TouchableOpacity>

      <View style={styles.rightCol}>
        {/* Top Small Card - Leaderboard */}
        <TouchableOpacity 
            style={[styles.smallCard, { backgroundColor: '#4CAF50' }]}
            activeOpacity={0.8}
            onPress={() => router.push('/explore/leaderboard')}
        >
             <View>
                <Text style={styles.smallTitle}>Leaderboard</Text>
                <Text style={styles.smallSub}>Top Hunters</Text>
             </View>
             <Ionicons name="podium" size={32} color="rgba(255,255,255,0.3)" style={styles.iconSmall} />
        </TouchableOpacity>

        {/* Bottom Small Card - Rewards */}
        <TouchableOpacity 
            style={[styles.smallCard, { backgroundColor: '#FFB300' }]}
            activeOpacity={0.8}
            onPress={() => router.push('/wallet/store' as any)}
        >
             <View>
                <Text style={styles.smallTitle}>Rewards</Text>
                <Text style={styles.smallSub}>Claim Daily</Text>
             </View>
             <Ionicons name="gift" size={32} color="rgba(255,255,255,0.3)" style={styles.iconSmall} />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    paddingHorizontal: 16,
    gap: 12,
    marginBottom: 20,
    marginTop: 10,
    height: 150,
  },
  bigCard: {
    flex: 1.4,
    borderRadius: 16,
    padding: 16,
    justifyContent: 'space-between',
    overflow: 'hidden',
    position: 'relative',
  },
  rightCol: {
    flex: 1,
    flexDirection: 'column',
    gap: 10,
  },
  smallCard: {
    flex: 1,
    borderRadius: 16,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    overflow: 'hidden',
    position: 'relative',
  },
  textWrapper: {
    zIndex: 2,
  },
  bigTitle: {
    color: '#FFF',
    fontFamily: 'Urbanist-Bold',
    fontSize: 20,
    lineHeight: 24,
  },
  subTitle: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: 'Urbanist-Medium',
    fontSize: 12,
    marginBottom: 10,
  },
  btn: {
    backgroundColor: '#FFF',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    alignSelf: 'flex-start',
  },
  btnText: {
    color: '#FF4D67',
    fontFamily: 'Urbanist-Bold',
    fontSize: 12,
  },
  smallTitle: {
    color: '#FFF',
    fontFamily: 'Urbanist-Bold',
    fontSize: 14,
  },
  smallSub: {
    color: 'rgba(255,255,255,0.9)',
    fontFamily: 'Urbanist-Regular',
    fontSize: 10,
  },
  iconBig: {
    position: 'absolute',
    right: -10,
    bottom: -10,
  },
  iconSmall: {
    position: 'absolute',
    right: -5,
    bottom: -5,
  }
});
