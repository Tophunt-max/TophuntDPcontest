import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import { CoinStoreSkeleton } from '@/src/components/skeletons/CoinStoreSkeleton';
import { DiamondIcon } from '@/src/components/ui/DiamondIcon';
import { balancesOf, hasLiveBalance } from '@/src/lib/balances';
import { LinearGradient } from 'expo-linear-gradient';
import { useCoinPackages } from '@/src/hooks/useCoinPackages';
import { type CoinPackage } from '@/src/lib/coinValue';
import { purchasePackage } from '@/src/services/wallet/razorpayCheckout';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData';
import { useToast } from '@/src/components/toast/ToastProvider';
import { Colors } from '@/constants/theme';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { useAppConfig } from '@/src/services/appSettings';


export default function CoinStoreScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile, refetch: refetchProfile } = useProfile(user?.uid || '');
  const { addToast } = useToast();
  // ₹ per coin (live from App Control).
  const [loading, setLoading] = useState<string | null>(null);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  // Which gateway the admin has configured: 'auto' (Razorpay), 'manual'
  // (QR/UPI) or 'both'. This screen only sells through Razorpay, so in 'manual'
  // mode it must hand off to /wallet/deposit instead of attempting a checkout
  // that the server will refuse.
  const { config } = useAppConfig();
  const gwMode = (config?.paymentGateway as any)?.mode || 'auto';
  const manualOnly = gwMode === 'manual';
  const manualAvailable = gwMode === 'manual' || gwMode === 'both';

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const cardBorder = isDark ? '#35383F' : '#EEEEEE';
  const subText = isDark ? '#9BA1A6' : '#8A8A8E';

  // Real, server-priced packages (coin_packages table). Live: an admin edit is
  // pushed over realtime, so a price on screen is never a stale one.
  const { data: packages, isLoading, isError, refetch } = useCoinPackages();

  // Prices are base coins × coin value, so paise are common: ₹7.50, not ₹7.5.
  const formatInr = (v: number) => {
    const n = Number(v) || 0;
    const frac = Math.round(n * 100) % 100 !== 0;
    return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 })}`;
  };

  const handlePurchase = async (pkg: CoinPackage) => {
    if (loading) return;
    if (!user) {
      router.push('/auth/login');
      return;
    }
    // Manual gateway: there is no card checkout to open. Carry the chosen
    // package to the QR/UPI screen, which prices it from the same row.
    if (manualOnly) {
      router.push(`/wallet/deposit?packageId=${encodeURIComponent(pkg.id)}` as any);
      return;
    }
    setLoading(pkg.id);
    try {
      const { coins, pending } = await purchasePackage(
        { id: pkg.id, name: pkg.name ?? undefined },
        {
          email: profile?.email || undefined,
          name: profile?.fullName || undefined,
          contact: (profile as any)?.phone || undefined,
        },
      );
      await refetchProfile();
      if (pending) {
        addToast({ text: 'Payment received — aapke Diamond bank confirm hote hi aa jayenge.', type: 'info' });
      } else {
        addToast({ text: `${coins} Diamond aapke wallet me aa gaye!`, type: 'success', icon: 'reward' });
      }
      router.back();
    } catch (error: any) {
      const msg = error?.message || error?.details || 'Transaction could not be completed. Please try again.';
      // "Payment cancelled." is a normal user action — keep it low-key (info).
      if (/cancel/i.test(msg)) {
        addToast({ text: 'Payment cancelled — kuch nahi kata.', type: 'info' });
      } else if (error?.code === 'functions/failed-precondition' && /not configured/i.test(msg)) {
        // The gateway keys aren't set server-side. Surfacing the raw server
        // string ("Payments are not configured on the server.") dead-ends the
        // user, so route them to QR/UPI when that is an option.
        if (manualAvailable) {
          addToast({ text: 'Card / UPI checkout is unavailable — pay via QR instead.', type: 'info' });
          router.push(`/wallet/deposit?packageId=${encodeURIComponent(pkg.id)}` as any);
        } else {
          addToast({ text: 'Payments are temporarily unavailable. Please try again later.', type: 'error' });
        }
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
        // Price = base coins × coin value; under ₹1 cannot be paid for.
        disabled={!!loading || item.purchasable === false}
        activeOpacity={0.85}
      >
        {item.popular && (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>BEST VALUE</Text>
          </View>
        )}

        <View style={styles.coinContainer}>
          <View style={[styles.coinCircle, { backgroundColor: isDark ? '#2A2D36' : '#FFF0F2' }]}>
            <DiamondIcon size={30} />
          </View>
          <Text style={[styles.coinText, { color: textColor }]}>{item.totalCoins}</Text>
          <Text style={[styles.coinLabel, { color: subText }]}>Diamond</Text>
          {item.bonusCoins > 0 ? (
            <View style={styles.bonusPill}>
              <Text style={styles.bonusLabel}>+{item.bonusCoins} bonus Diamond</Text>
            </View>
          ) : (
            <View style={styles.bonusPillPlaceholder} />
          )}
        </View>

        <View style={[styles.priceBtn, { backgroundColor: isDark ? '#FF4D67' : '#181A20', opacity: loading && !isBusy ? 0.5 : 1 }]}>
          {isBusy ? (
            <ActivityIndicator color="white" size="small" />
          ) : (
            <Text style={styles.priceText}>{item.purchasable === false ? (item.priceInr < 1 ? 'Min ₹1' : 'Unavailable') : formatInr(item.priceInr)}</Text>
          )}
        </View>
      </TouchableOpacity>
    );
  };

  const header = (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={() => router.back()}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel="Close store"
      >
        <CloseIcon size={28} color={textColor} />
      </TouchableOpacity>
      <Text style={[styles.title, { color: textColor }]}>Diamond Store</Text>
      <View style={{ width: 28 }} />
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {header}

      <View style={styles.balanceContainer}>
        <LinearGradient colors={['#FF4D67', '#FF8A9B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.gradient}>
          {/* The store sells Diamonds: contest entry only, never withdrawn. */}
          <Text style={styles.balanceLabel}>Aapke Diamond</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center' }}>
            <DiamondIcon size={24} color="white" style={{ marginRight: 8 }} />
            <Text style={styles.balanceValue}>{hasLiveBalance(profile) ? balancesOf(profile).diamonds : '—'} Diamond</Text>
          </View>
          <Text style={[styles.balanceLabel, { marginTop: 4 }]}>Diamond se contest me entry hoti hai. Jeet kar DP coin milte hain.</Text>
        </LinearGradient>
      </View>

      <Text style={[styles.sectionTitle, { color: textColor }]}>Select a Package</Text>

      {isLoading ? (
        <CoinStoreSkeleton />
      ) : isError ? (
        <View style={styles.stateBox}>
          <Ionicons name="cloud-offline-outline" size={40} color="#9E9E9E" />
          <Text style={styles.stateText}>Couldn&apos;t load packages.</Text>
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
            <View>
              <View style={styles.secureRow}>
                <Ionicons name={manualOnly ? 'qr-code-outline' : 'shield-checkmark-outline'} size={16} color={subText} />
                <Text style={[styles.secureText, { color: subText }]}>
                  {manualOnly ? 'Pick a package, then pay via QR / UPI' : 'Secure payment via Razorpay'}
                </Text>
              </View>
              {/* A pending manual deposit isn't in the coin ledger yet (coins are
                  credited on approval), so keep its status one tap away. */}
              {manualAvailable && (
                <TouchableOpacity
                  onPress={() => router.push('/wallet/deposit' as any)}
                  style={styles.depositsRow}
                  accessibilityRole="button"
                  accessibilityLabel="View my deposit requests"
                >
                  <Ionicons name="receipt-outline" size={14} color="#FF4D67" />
                  <Text style={styles.depositsText}>My deposit requests</Text>
                </TouchableOpacity>
              )}
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
  depositsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 14 },
  depositsText: { color: '#FF4D67', fontSize: 13, fontFamily: 'Urbanist-Bold' },

});
