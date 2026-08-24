import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, ActivityIndicator, useColorScheme } from 'react-native';
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
import { useToast } from '@/src/components/toast/ToastProvider';
import { Colors } from '@/constants/theme';
import { CloseIcon } from '@/src/components/ui/CloseIcon';

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
  const { addToast } = useToast();
  const [loading, setLoading] = useState<string | null>(null);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const cardBorder = isDark ? '#35383F' : '#EEEEEE';
  const subText = isDark ? '#9BA1A6' : '#8A8A8E';

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
    if (loading) return;
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
      addToast({ text: `${coins} Dpcoins added to your wallet!`, type: 'success', icon: 'coins' });
      router.back();
    } catch (error: any) {
      const msg = error?.message || error?.details || 'Transaction could not be completed. Please try again.';
      // "Payment cancelled." is a normal user action — keep it low-key (info).
      if (/cancel/i.test(msg)) {
        addToast({ text: 'Payment cancelled — no coins were charged.', type: 'info' });
      } else {
        addToast({ text: msg, type: 'error' });
      }
    } finally {
      setLoading(null);
    }
  };

  const renderItem = ({ item }: { item: CoinPackage }) => {
    const isBusy = loading === item.id;
    return (
      <TouchableOpacity
        style={[
          styles.card,
          { backgroundColor: cardBg, borderColor: item.popular ? '#FF4D67' : cardBorder },
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
          <View style={[styles.coinCircle, { backgroundColor: isDark ? '#2A2D36' : '#FFF0F2' }]}>
            <CoinIcon size={30} color="#FF4D67" />
          </View>
          <Text style={[styles.coinText, { color: textColor }]}>{item.totalCoins}</Text>
          <Text style={[styles.coinLabel, { color: subText }]}>Dpcoins</Text>
          {item.bonusCoins > 0 ? (
            <View style={styles.bonusPill}>
              <Text style={styles.bonusLabel}>+{item.bonusCoins} bonus</Text>
            </View>
          ) : (
            <View style={styles.bonusPillPlaceholder} />
          )}
        </View>

        <View style={[styles.priceBtn, { backgroundColor: isDark ? '#FF4D67' : '#181A20', opacity: loading && !isBusy ? 0.5 : 1 }]}>
          {isBusy ? (
            <ActivityIndicator color="white" size="small" />
          ) : (
            <Text style={styles.priceText}>{formatInr(item.priceInr)}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity
          onPress={() => router.back()}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Close store"
        >
          <CloseIcon size={28} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Dpcoin Store</Text>
        <View style={{ width: 28 }} />
      </View>

      <View style={styles.balanceContainer}>
        <LinearGradient colors={['#FF4D67', '#FF8A9B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.gradient}>
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
          columnWrapperStyle={styles.columnWrapper}
          contentContainerStyle={styles.listContent}
          showsVerticalScrollIndicator={false}
          ListFooterComponent={
            <View style={styles.secureRow}>
              <Ionicons name="shield-checkmark-outline" size={16} color={subText} />
              <Text style={[styles.secureText, { color: subText }]}>Secure payment via Razorpay</Text>
            </View>
          }
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  balanceContainer: { marginHorizontal: 20, marginTop: 4, marginBottom: 16, borderRadius: 20, overflow: 'hidden', elevation: 5 },
  gradient: { padding: 24, alignItems: 'center' },
  balanceLabel: { color: 'white', fontSize: 14, fontFamily: 'Urbanist-Medium', marginBottom: 6, opacity: 0.9 },
  balanceValue: { color: 'white', fontSize: 20, fontFamily: 'Urbanist-Bold' },
  sectionTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold', marginLeft: 20, marginBottom: 8 },

  // extra top padding so the -12 "BEST VALUE" badge is never clipped
  listContent: { paddingHorizontal: 20, paddingTop: 18, paddingBottom: 30 },
  columnWrapper: { justifyContent: 'space-between' },

  card: { width: '47%', borderRadius: 20, padding: 18, alignItems: 'center', marginBottom: 22, borderWidth: 1.5, elevation: 2 },
  popularCard: { borderWidth: 2 },
  badge: { position: 'absolute', top: -12, alignSelf: 'center', backgroundColor: '#FF4D67', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 10, elevation: 3 },
  badgeText: { color: 'white', fontSize: 10, fontFamily: 'Urbanist-Bold', letterSpacing: 0.4 },
  coinContainer: { alignItems: 'center', marginBottom: 16, marginTop: 6 },
  coinCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  coinText: { fontSize: 26, fontFamily: 'Urbanist-Bold' },
  coinLabel: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  bonusPill: { marginTop: 8, backgroundColor: 'rgba(76,175,80,0.12)', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 20 },
  bonusPillPlaceholder: { marginTop: 8, height: 22 },
  bonusLabel: { color: '#4CAF50', fontSize: 11, fontFamily: 'Urbanist-Bold' },
  priceBtn: { width: '100%', paddingVertical: 13, borderRadius: 12, alignItems: 'center', justifyContent: 'center', minHeight: 46 },
  priceText: { color: 'white', fontFamily: 'Urbanist-Bold', fontSize: 15 },

  stateBox: { alignItems: 'center', justifyContent: 'center', paddingVertical: 50, gap: 10 },
  stateText: { color: '#9E9E9E', fontFamily: 'Urbanist-Medium', fontSize: 15 },
  retryText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', marginTop: 4 },
  secureRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8 },
  secureText: { fontSize: 12, fontFamily: 'Urbanist-Medium' },
});
