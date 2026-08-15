import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import { CoinStoreSkeleton } from '@/src/components/skeletons/CoinStoreSkeleton';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';
import { readApi } from '@/src/services/api';
import { purchasePackage } from '@/src/services/wallet/razorpayCheckout';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData';
import { Colors } from '@/constants/theme';

interface CoinPackage {
  id: string;
  name?: string;
  coins: number;
  bonusCoins: number;
  priceInr: number;
  totalCoins: number;
  popular?: boolean;
}

export default function CoinStoreScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile, refetch: refetchProfile } = useProfile(user?.uid || '');
  const [loading, setLoading] = useState<string | null>(null);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;

  // Real, server-priced packages (pricing lives in the coin_packages table).
  const { data: packages, isLoading, isError, refetch } = useQuery({
    queryKey: ['coin-packages'],
    queryFn: async () => {
      const rows = (await readApi('/read/coin-packages')) as CoinPackage[];
      // Flag the best-value package (highest coins-per-rupee) for the UI badge.
      if (rows && rows.length) {
        let bestIdx = 0;
        let bestRatio = 0;
        rows.forEach((p, i) => {
          const ratio = p.priceInr > 0 ? p.totalCoins / p.priceInr : 0;
          if (ratio > bestRatio) { bestRatio = ratio; bestIdx = i; }
        });
        rows[bestIdx].popular = true;
      }
      return rows;
    },
  });

  const formatInr = (v: number) => `₹${Number(v).toLocaleString('en-IN')}`;

  const handlePurchase = async (pkg: CoinPackage) => {
    if (!user) {
      router.push('/auth/login');
      return;
    }
    setLoading(pkg.id);
    try {
      const { coins } = await purchasePackage(
        { id: pkg.id, name: pkg.name },
        {
          email: profile?.email || undefined,
          name: profile?.fullName || undefined,
          contact: (profile as any)?.phone || undefined,
        },
      );
      await refetchProfile();
      Alert.alert('Success', `${coins} Dpcoins added to your wallet!`);
      router.back();
    } catch (error: any) {
      const msg = error?.message || error?.details || 'Transaction could not be completed. Please try again.';
      // "Payment cancelled." is a normal user action — keep it low-key.
      if (/cancel/i.test(msg)) {
        Alert.alert('Payment Cancelled', 'You cancelled the payment. No coins were charged.');
      } else {
        Alert.alert('Payment Failed', msg);
      }
    } finally {
      setLoading(null);
    }
  };

  const renderItem = ({ item }: { item: CoinPackage }) => (
    <TouchableOpacity
      style={[
        styles.card,
        { backgroundColor: isDark ? '#1F222A' : '#FFF', borderColor: item.popular ? '#FF4D67' : (isDark ? '#35383F' : '#EEE') },
        item.popular && styles.popularCard,
      ]}
      onPress={() => handlePurchase(item)}
      disabled={!!loading}
      activeOpacity={0.85}
    >
      {item.popular && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>BEST VALUE</Text>
        </View>
      )}

      <View style={styles.coinContainer}>
        <CoinIcon size={32} color="#FF4D67" />
        <Text style={[styles.coinText, { color: textColor }]}>{item.totalCoins}</Text>
        <Text style={styles.coinLabel}>Dpcoins</Text>
        {item.bonusCoins > 0 && (
          <Text style={styles.bonusLabel}>+{item.bonusCoins} bonus</Text>
        )}
      </View>

      <View style={[styles.priceBtn, { backgroundColor: isDark ? '#FF4D67' : '#181A20' }]}>
        {loading === item.id ? (
          <ActivityIndicator color="white" size="small" />
        ) : (
          <Text style={styles.priceText}>{formatInr(item.priceInr)}</Text>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="close" size={28} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Dpcoin Store</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.balanceContainer}>
        <LinearGradient colors={['#FF4D67', '#FF8A9B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.gradient}>
          <Text style={styles.balanceLabel}>Current Balance</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <CoinIcon size={24} color="white" style={{ marginRight: 8 }} />
            <Text style={styles.balanceValue}>{profile?.Dpcoin ?? 0} Dpcoins</Text>
          </View>
        </LinearGradient>
      </View>

      <Text style={[styles.sectionTitle, { color: textColor }]}>Select a Package</Text>

      {isLoading ? (
        <CoinStoreSkeleton />
      ) : isError ? (
        <View style={styles.stateBox}>
          <Ionicons name="cloud-offline-outline" size={40} color="#9E9E9E" />
          <Text style={styles.stateText}>Couldn't load packages.</Text>
          <TouchableOpacity onPress={() => refetch()}><Text style={styles.retryText}>Tap to retry</Text></TouchableOpacity>
        </View>
      ) : !packages || packages.length === 0 ? (
        <View style={styles.stateBox}>
          <Ionicons name="pricetags-outline" size={40} color="#9E9E9E" />
          <Text style={styles.stateText}>No packages available right now.</Text>
        </View>
      ) : (
        <FlatList
          data={packages}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          numColumns={2}
          columnWrapperStyle={{ justifyContent: 'space-between' }}
          contentContainerStyle={{ paddingHorizontal: 20 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  balanceContainer: { margin: 20, borderRadius: 20, overflow: 'hidden', elevation: 5 },
  gradient: { padding: 25, alignItems: 'center' },
  balanceLabel: { color: 'white', fontSize: 14, fontFamily: 'Urbanist-Medium', marginBottom: 5 },
  balanceValue: { color: 'white', fontSize: 18, fontFamily: 'Urbanist-Bold' },
  sectionTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', marginLeft: 20, marginBottom: 15 },
  card: { width: '47%', borderRadius: 20, padding: 20, alignItems: 'center', marginBottom: 20, elevation: 2, borderWidth: 1 },
  popularCard: { borderWidth: 2 },
  badge: { position: 'absolute', top: -12, backgroundColor: '#FF4D67', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10 },
  badgeText: { color: 'white', fontSize: 10, fontFamily: 'Urbanist-Bold' },
  coinContainer: { alignItems: 'center', marginBottom: 15, marginTop: 10 },
  coinText: { fontSize: 24, fontFamily: 'Urbanist-Bold', marginVertical: 5 },
  coinLabel: { color: '#999', fontSize: 12 },
  bonusLabel: { color: '#4CAF50', fontSize: 11, fontFamily: 'Urbanist-Bold', marginTop: 2 },
  priceBtn: { width: '100%', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  priceText: { color: 'white', fontFamily: 'Urbanist-Bold' },
  stateBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 50, gap: 10 },
  stateText: { color: '#9E9E9E', fontFamily: 'Urbanist-Medium', fontSize: 15 },
  retryText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', marginTop: 4 },
});
