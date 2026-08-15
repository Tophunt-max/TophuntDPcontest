import React, { useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator, useColorScheme } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { walletService } from '@/src/services/wallet/walletService';
import { useAuth } from '@/src/hooks/useAuth';
import { Colors } from '@/constants/theme';

const PACKAGES = [
  { id: '1', coins: 100, price: '$1.99', popular: false },
  { id: '2', coins: 500, price: '$4.99', popular: true }, // Best Value
  { id: '3', coins: 1200, price: '$9.99', popular: false },
  { id: '4', coins: 2500, price: '$19.99', popular: false },
];

export default function CoinStoreScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [loading, setLoading] = useState<string | null>(null);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;

  const handlePurchase = async (pkg: any) => {
    if (!user) return;
    setLoading(pkg.id);
    try {
      // A verified Razorpay payment proof is required by the server. Until the
      // checkout flow is wired up, this call will be rejected server-side — we
      // surface the real reason rather than pretending the purchase succeeded.
      await walletService.purchaseCoins(pkg.coins, pkg.price);
      Alert.alert("Success", `You purchased ${pkg.coins} Dpcoins!`);
      router.back();
    } catch (error: any) {
      const reason = error?.details || error?.message || "Transaction could not be completed. Please try again.";
      Alert.alert("Payment Failed", reason);
    } finally {
      setLoading(null);
    }
  };

  const renderItem = ({ item }: { item: any }) => (
    <TouchableOpacity 
      style={[styles.card, { backgroundColor: isDark ? '#1F222A' : '#FFF', borderColor: item.popular ? '#FF4D67' : (isDark ? '#35383F' : '#EEE') }, item.popular && styles.popularCard]}
      onPress={() => handlePurchase(item)}
      disabled={!!loading}
    >
      {item.popular && (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>BEST VALUE</Text>
        </View>
      )}
      
      <View style={styles.coinContainer}>
        <Ionicons name="flash" size={32} color="#FF4D67" />
        <Text style={[styles.coinText, { color: textColor }]}>{item.coins}</Text>
        <Text style={styles.coinLabel}>Dpcoins</Text>
      </View>

      <TouchableOpacity style={[styles.priceBtn, { backgroundColor: isDark ? '#FF4D67' : '#181A20' }]}>
        {loading === item.id ? (
          <ActivityIndicator color="white" size="small" />
        ) : (
          <Text style={styles.priceText}>{item.price}</Text>
        )}
      </TouchableOpacity>
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
        <LinearGradient
          colors={['#FF4D67', '#FF8A9B']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={styles.gradient}
        >
          <Text style={styles.balanceLabel}>Current Balance</Text>
          <View style={{flexDirection: 'row', alignItems: 'center'}}>
             <Ionicons name="flash" size={24} color="white" style={{marginRight: 8}} />
             <Text style={styles.balanceValue}>Top up to join battles!</Text>
          </View>
        </LinearGradient>
      </View>

      <Text style={[styles.sectionTitle, { color: textColor }]}>Select a Package</Text>

      <FlatList
        data={PACKAGES}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        numColumns={2}
        columnWrapperStyle={{ justifyContent: 'space-between' }}
        contentContainerStyle={{ paddingHorizontal: 20 }}
      />
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
  priceBtn: { width: '100%', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  priceText: { color: 'white', fontFamily: 'Urbanist-Bold' }
});
