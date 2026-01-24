import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, useColorScheme, Share, Modal, ActivityIndicator, Dimensions, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInRight, FadeInUp, useSharedValue, useAnimatedStyle, withSpring, withTiming, withSequence, runOnJS } from 'react-native-reanimated';

import { useAuth } from '@/src/services/auth';
import { Colors } from '@/constants/theme';
import { useProfile } from '@/src/hooks/useProfileData';
import { walletService } from '@/src/services/wallet/walletService';
import { useToast } from '@/src/components/toast/ToastProvider';
import { collection, query, where, onSnapshot, orderBy } from 'firebase/firestore';
import { firestore } from '@/src/services/firebase/initFirebase';
import { Trophy_Icon, Wallet_Color } from '@/assets/svgs';

const { width, height } = Dimensions.get('window');

// Mock transactions
const MOCK_TRANSACTIONS = [
  { id: '1', type: 'deposit', amount: 500, date: '2023-10-25', description: 'Top Up', category: 'Income' },
  { id: '2', type: 'contest_entry', amount: -50, date: '2023-10-24', description: 'Photo Battle Entry', category: 'Expense' },
  { id: '3', type: 'win', amount: 200, date: '2023-10-22', description: 'Contest Win', category: 'Income' },
  { id: '4', type: 'bonus', amount: 20, date: '2023-10-20', description: 'Daily Bonus', category: 'Income' },
  { id: '5', type: 'gift', amount: -10, date: '2023-10-19', description: 'Sent Gift', category: 'Expense' },
];

const DAILY_REWARDS = [10, 15, 20, 25, 30, 50, 100];
const FILTERS = ['All', 'Income', 'Expense'];

const TASKS = [
  { id: '1', title: 'Watch a Video Ad', reward: 5, progress: 0, maxProgress: 5, icon: 'videocam', action: 'Watch' },
  { id: '2', title: 'Vote in 5 Battles', reward: 15, progress: 2, maxProgress: 5, icon: 'stats-chart', action: 'Vote' },
  { id: '3', title: 'Share your Profile', reward: 10, progress: 0, maxProgress: 1, icon: 'share-social', action: 'Share' },
];

export default function WalletScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile, refetch: refetchProfile } = useProfile(user?.uid || '');
  const colorScheme = useColorScheme();
  const { addToast } = useToast();
  const isDark = colorScheme === 'dark';
  
  // Theme Colors
  const backgroundColor = isDark ? Colors.dark.background : '#F8F9FA';
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : '#121212';
  const subTextColor = isDark ? '#A0A0A0' : '#757575';
  const primaryColor = '#FF4D67';

  // State
  const [currentDay, setCurrentDay] = useState(2);
  const [claimedToday, setClaimedToday] = useState(false);
  const [activeFilter, setActiveFilter] = useState('All');
  const [myPrizes, setMyPrizes] = useState<any[]>([]);
  const [loadingPrizes, setLoadingPrizes] = useState(true);
  
  // Ad Simulation State
  const [isWatchingAd, setIsWatchingAd] = useState(false);
  const [adTimer, setAdTimer] = useState(5);

  // Coin Animation State
  const [animatingCoins, setAnimatingCoins] = useState<any[]>([]);
  const balanceScale = useSharedValue(1);

  // Real-time listener for Prizes
  useEffect(() => {
    if (!user) return;
    const q = query(
        collection(firestore, 'prizeClaims'),
        where('uid', '==', user.uid),
        orderBy('updatedAt', 'desc')
    );
    const unsubscribe = onSnapshot(q, (snapshot) => {
        setMyPrizes(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
        setLoadingPrizes(false);
    });
    return () => unsubscribe();
  }, [user]);

  const balanceAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: balanceScale.value }]
  }));

  const triggerBalancePop = () => {
    balanceScale.value = withSequence(
      withSpring(1.2),
      withSpring(1)
    );
  };

  const spawnCoinAnimation = (startX: number, startY: number) => {
    const id = Math.random().toString();
    setAnimatingCoins(prev => [...prev, { id, startX, startY }]);
  };

  const removeCoin = (id: string) => {
    setAnimatingCoins(prev => prev.filter(c => c.id !== id));
  };

  const filteredTransactions = MOCK_TRANSACTIONS.filter(t => {
    if (activeFilter === 'All') return true;
    if (activeFilter === 'Income') return t.amount > 0;
    if (activeFilter === 'Expense') return t.amount < 0;
    return true;
  });

  const handleClaimBonus = async (event: any, index: number) => {
    if (claimedToday) {
        addToast("Come back tomorrow!", "info");
        return;
    }
    if (!user) return;

    const { pageX, pageY } = event.nativeEvent;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    try {
        const amount = await walletService.claimDailyBonus(user.uid, index);
        spawnCoinAnimation(pageX, pageY);
        setClaimedToday(true);
        refetchProfile();
        if(currentDay < 6) setCurrentDay(currentDay + 1);
        setTimeout(() => {
          addToast(`🎉 Received ${amount} Dpcoins!`, "success");
        }, 800);
    } catch (error) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        addToast("Could not claim bonus.", "error");
    }
  };

  const handleRefer = async () => {
    Haptics.selectionAsync();
    try {
      await Share.share({
        message: 'Join me on Tophunt and earn free Dpcoins! Use my invite code: ' + (user?.uid?.substring(0, 6) || 'TOPHUNT'),
      });
    } catch (error) {
      addToast('Could not open share dialog', "error");
    }
  };

  const simulateWatchAd = () => {
    setIsWatchingAd(true);
    setAdTimer(5);
    const interval = setInterval(() => {
        setAdTimer((prev) => {
            if (prev <= 1) {
                clearInterval(interval);
                finishAd();
                return 0;
            }
            return prev - 1;
        });
    }, 1000);
  };

  const finishAd = () => {
    setIsWatchingAd(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    addToast("Reward Earned! +5 Dpcoins 🪙", "success");
  };

  const handleTaskAction = (task: any) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (task.action === 'Share') handleRefer();
    else if (task.action === 'Watch') simulateWatchAd();
    else if (task.action === 'Vote') router.push('/home'); 
  };

  const renderPrizeItem = ({ item }: { item: any }) => {
    const statusColors: any = { pending: '#FFA500', shipped: '#007AFF', delivered: '#4CAF50' };
    return (
        <View style={[styles.prizeItemCard, { backgroundColor: cardBg }]}>
            <LinearGradient colors={['#FFD700', '#FFB800']} style={styles.prizeIconBox}>
                <Trophy_Icon width={24} height={24} color="#FFF" />
            </LinearGradient>
            <View style={{ flex: 1, marginLeft: 12 }}>
                <Text style={[styles.prizeName, { color: textColor }]} numberOfLines={1}>{item.prizeName}</Text>
                <View style={styles.statusRow}>
                    <View style={[styles.statusDot, { backgroundColor: statusColors[item.status] || '#888' }]} />
                    <Text style={[styles.statusText, { color: statusColors[item.status] || '#888' }]}>{item.status.toUpperCase()}</Text>
                </View>
                {item.trackingId && <Text style={styles.trackingText}>ID: {item.trackingId}</Text>}
            </View>
        </View>
    );
  };

  const renderDailyItem = (amount: number, index: number) => {
    let status = index < currentDay ? 'claimed' : (index === currentDay ? (claimedToday ? 'claimed' : 'ready') : 'locked');
    const isReady = status === 'ready';
    const isClaimed = status === 'claimed';
    return (
        <View key={index} style={styles.dayWrapper}>
            <TouchableOpacity 
                style={[styles.dayCard, { backgroundColor: isDark ? '#1F222A' : '#FFF' }, isReady && { borderColor: primaryColor, borderWidth: 1.5, backgroundColor: isDark ? '#2A1D20' : '#FFF0F3' }, isClaimed && { opacity: 0.6 }]}
                onPress={(e) => isReady ? handleClaimBonus(e, index) : undefined}
                disabled={!isReady}
                activeOpacity={0.7}
            >
                <Text style={[styles.dayText, { color: isReady ? primaryColor : subTextColor }]}>Day {index + 1}</Text>
                {isClaimed ? (
                    <View style={styles.checkCircle}><Ionicons name="checkmark" size={12} color="white" /></View>
                ) : (
                    <View style={styles.coinIconWrapper}><Ionicons name="gift" size={24} color={isReady ? primaryColor : (isDark ? '#333' : '#CCC')} /></View>
                )}
                <Text style={[styles.dayAmount, { color: isReady ? primaryColor : (isClaimed ? '#4CAF50' : textColor) }]}>+{amount}</Text>
            </TouchableOpacity>
        </View>
    );
  };

  const renderTaskItem = ({ item, index }: { item: any, index: number }) => {
    const progressPercent = (item.progress / item.maxProgress) * 100;
    return (
        <Animated.View entering={FadeInRight.delay(index * 100).duration(500)} style={[styles.taskCard, { backgroundColor: cardBg }]}>
            <View style={[styles.taskIconBox, { backgroundColor: isDark ? '#2A2D35' : '#F5F5F5' }]}>
                <Ionicons name={item.icon as any} size={24} color={primaryColor} />
            </View>
            <View style={{ flex: 1, paddingHorizontal: 12 }}>
                <Text style={[styles.taskTitle, { color: textColor }]}>{item.title}</Text>
                <View style={styles.progressBarBg}><View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} /></View>
                <Text style={styles.taskProgressText}>{item.progress}/{item.maxProgress} completed</Text>
            </View>
            <TouchableOpacity style={styles.taskButton} onPress={() => handleTaskAction(item)}>
                <Text style={styles.taskButtonText}>{item.action}</Text>
            </TouchableOpacity>
        </Animated.View>
    );
  };

  const renderTransaction = ({ item, index }: { item: any, index: number }) => (
    <Animated.View entering={FadeInDown.delay(index * 100).duration(400)} style={[styles.transactionItem, { backgroundColor: cardBg }]}>
        <View style={[styles.iconBox, { backgroundColor: item.amount > 0 ? 'rgba(76, 175, 80, 0.1)' : 'rgba(255, 77, 103, 0.1)' }]}>
            <Ionicons name={item.amount > 0 ? "arrow-down" : "arrow-up"} size={20} color={item.amount > 0 ? "#4CAF50" : "#FF4D67"} />
        </View>
        <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={[styles.transTitle, { color: textColor }]}>{item.description}</Text>
            <Text style={[styles.transDate, { color: subTextColor }]}>{item.date} • {item.type.replace('_', ' ').toUpperCase()}</Text>
        </View>
        <Text style={[styles.transAmount, { color: item.amount > 0 ? "#4CAF50" : "#FF4D67" }]}>{item.amount > 0 ? '+' : ''}{item.amount}</Text>
    </Animated.View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <FlatList
        data={filteredTransactions}
        keyExtractor={item => item.id}
        renderItem={renderTransaction}
        contentContainerStyle={{ paddingBottom: 40 }}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
            <View>
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => router.back()} style={styles.backButton}><Ionicons name="chevron-back" size={28} color={textColor} /></TouchableOpacity>
                    <Text style={[styles.title, { color: textColor }]}>My Wallet</Text>
                    <TouchableOpacity onPress={() => router.push('/wallet/store')}><Wallet_Color width={24} height={24} color={primaryColor} /></TouchableOpacity>
                </View>

                <Animated.View entering={FadeInDown.duration(600)} style={[styles.balanceContainer, balanceAnimatedStyle]}>
                    <LinearGradient colors={['#FF4D67', '#FF8A9B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.gradient}>
                        <View style={styles.cardCircle1} /><View style={styles.cardCircle2} />
                        <View style={styles.balanceHeader}>
                            <Text style={styles.balanceLabel}>Total Balance</Text>
                            <View style={styles.coinBadge}><Text style={styles.coinBadgeText}>Dpcoin</Text></View>
                        </View>
                        <Text style={styles.balanceValue}>{profile?.Dpcoin || 0}</Text>
                        <TouchableOpacity style={styles.topUpButton} onPress={() => router.push('/wallet/store')}>
                            <Ionicons name="add" size={20} color="#FF4D67" /><Text style={styles.topUpText}>Top Up Balance</Text>
                        </TouchableOpacity>
                    </LinearGradient>
                </Animated.View>

                {myPrizes.length > 0 && (
                    <View style={styles.prizesSection}>
                        <View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: textColor }]}>Won Prizes 🎁</Text><Text style={styles.prizeCount}>{myPrizes.length}</Text></View>
                        <FlatList horizontal data={myPrizes} renderItem={renderPrizeItem} keyExtractor={item => item.id} showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 20 }} />
                    </View>
                )}

                <View style={styles.bonusWrapper}>
                    <View style={styles.sectionHeader}><View><Text style={[styles.sectionTitle, { color: textColor }]}>Daily Check-in</Text><Text style={[styles.sectionSubtitle, { color: subTextColor }]}>Earn rewards everyday!</Text></View></View>
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.dailyScrollContent}>{DAILY_REWARDS.map((amount, index) => renderDailyItem(amount, index))}</ScrollView>
                </View>

                <View style={[styles.sectionHeader, { marginTop: 25 }]}><View><Text style={[styles.sectionTitle, { color: textColor }]}>Daily Tasks</Text><Text style={[styles.sectionSubtitle, { color: subTextColor }]}>Complete tasks to earn more!</Text></View></View>
                <View style={{ paddingHorizontal: 20 }}>{TASKS.map((item, index) => renderTaskItem({ item, index }))}</View>

                <TouchableOpacity onPress={handleRefer} style={styles.referContainer}>
                    <LinearGradient colors={['#FF4D67', '#FF8A9B']} start={{x: 0, y: 0}} end={{x: 1, y: 0}} style={styles.referContent}>
                        <Ionicons name="gift-outline" size={28} color="#FFF" /><View style={{ flex: 1, marginLeft: 12 }}><Text style={styles.referTitle}>Refer & Earn</Text><Text style={styles.referDesc}>Get 50 Dpcoins for each friend!</Text></View><Ionicons name="chevron-forward" size={20} color="#FFF" />
                    </LinearGradient>
                </TouchableOpacity>

                <View style={[styles.sectionHeader, { marginTop: 25, marginBottom: 10 }]}><Text style={[styles.sectionTitle, { color: textColor }]}>Transactions</Text></View>
                <View style={styles.filterContainer}>{FILTERS.map((f) => (
                    <TouchableOpacity key={f} onPress={() => setActiveFilter(f)} style={[styles.filterChip, activeFilter === f ? { backgroundColor: primaryColor } : { backgroundColor: isDark ? '#2A2D35' : '#ECECEC' }]}><Text style={[styles.filterText, { color: activeFilter === f ? '#FFF' : subTextColor }]}>{f}</Text></TouchableOpacity>
                ))}</View>
            </View>
        }
      />

      {animatingCoins.map(coin => <CoinAnimation key={coin.id} startX={coin.startX} startY={coin.startY} onFinished={() => { removeCoin(coin.id); triggerBalancePop(); }} />)}

      <Modal visible={isWatchingAd} transparent animationType="fade">
        <View style={styles.adModalContainer}><View style={[styles.adModalContent, { backgroundColor: isDark ? '#1F222A' : '#FFF' }]}><Text style={[styles.adTitle, { color: textColor }]}>Watching Ad...</Text><Text style={[styles.adSubtitle, { color: subTextColor }]}>Please wait {adTimer} seconds</Text><ActivityIndicator size="large" color={primaryColor} style={{ marginVertical: 20 }} /></View></View>
      </Modal>
    </SafeAreaView>
  );
}

const CoinAnimation = ({ startX, startY, onFinished }: { startX: number, startY: number, onFinished: () => void }) => {
  const progress = useSharedValue(0);
  useEffect(() => { progress.value = withTiming(1, { duration: 800 }, (f) => { if (f) runOnJS(onFinished)(); }); }, []);
  const animatedStyle = useAnimatedStyle(() => {
    const translateX = startX + (width/2 - startX) * progress.value;
    const translateY = startY + (150 - startY) * progress.value - (Math.sin(progress.value * Math.PI) * 100);
    return { position: 'absolute', transform: [{ translateX: translateX - 15 }, { translateY: translateY - 15 }, { scale: 1 + Math.sin(progress.value * Math.PI) * 0.5 }], opacity: 1 - (progress.value > 0.8 ? (progress.value - 0.8) * 5 : 0) };
  });
  return <Animated.View style={[animatedStyle, { zIndex: 9999 }]}><LinearGradient colors={['#FFD700', '#FFA500']} style={styles.floatingCoin}><Ionicons name="logo-bitcoin" size={20} color="#FFF" /></LinearGradient></Animated.View>;
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10 },
  backButton: { padding: 4 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  balanceContainer: { marginHorizontal: 20, marginVertical: 20, borderRadius: 28, overflow: 'hidden', elevation: 10 },
  gradient: { padding: 25 },
  cardCircle1: { position: 'absolute', top: -50, right: -50, width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(255,255,255,0.1)' },
  cardCircle2: { position: 'absolute', bottom: -30, left: -30, width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(255,255,255,0.1)' },
  balanceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  balanceLabel: { color: '#FFF', opacity: 0.9, fontSize: 16, fontFamily: 'Urbanist-Medium' },
  coinBadge: { backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  coinBadgeText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  balanceValue: { color: 'white', fontSize: 42, fontFamily: 'Urbanist-Bold', marginBottom: 20 },
  topUpButton: { backgroundColor: 'white', padding: 14, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  topUpText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 16, marginLeft: 6 },
  prizesSection: { marginTop: 10 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, marginBottom: 15, gap: 8 },
  sectionTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  sectionSubtitle: { fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  prizeCount: { backgroundColor: '#FF4D67', color: '#FFF', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, fontSize: 12, overflow: 'hidden', fontFamily: 'Urbanist-Bold' },
  prizeItemCard: { width: 220, padding: 16, borderRadius: 20, marginRight: 15, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 2, flexDirection: 'row', alignItems: 'center' },
  prizeIconBox: { width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  prizeName: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginBottom: 4 },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 10, fontFamily: 'Urbanist-Black' },
  trackingText: { fontSize: 10, color: '#888', marginTop: 4, fontFamily: 'Urbanist-Medium' },
  bonusWrapper: { marginTop: 10 },
  dailyScrollContent: { paddingHorizontal: 15, paddingBottom: 5 },
  dayWrapper: { alignItems: 'center', marginHorizontal: 5 },
  dayCard: { width: 75, height: 100, borderRadius: 20, alignItems: 'center', justifyContent: 'center', elevation: 2, paddingVertical: 10 },
  dayText: { fontSize: 12, fontFamily: 'Urbanist-Bold', marginBottom: 8 },
  dayAmount: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginTop: 8 },
  checkCircle: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#4CAF50', justifyContent: 'center', alignItems: 'center', marginBottom: 2 },
  coinIconWrapper: { marginBottom: 2 },
  taskCard: { flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 12, borderRadius: 20, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 5, elevation: 1 },
  taskIconBox: { width: 48, height: 48, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  taskTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 4 },
  progressBarBg: { height: 6, backgroundColor: '#E0E0E0', borderRadius: 3, marginBottom: 6, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: '#FF4D67', borderRadius: 3 },
  taskProgressText: { fontSize: 11, color: 'gray' },
  taskButton: { backgroundColor: '#FFF0F3', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 12 },
  taskButtonText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 12 },
  referContainer: { marginHorizontal: 20, marginTop: 20, borderRadius: 20, overflow: 'hidden' },
  referContent: { flexDirection: 'row', alignItems: 'center', padding: 16 },
  referTitle: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  referDesc: { color: '#FFF', fontSize: 13, opacity: 0.9 },
  filterContainer: { flexDirection: 'row', paddingHorizontal: 20, marginBottom: 15, gap: 10 },
  filterChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  filterText: { fontSize: 14, fontFamily: 'Urbanist-Medium' },
  transactionItem: { flexDirection: 'row', alignItems: 'center', padding: 16, marginBottom: 12, borderRadius: 20, marginHorizontal: 20 },
  iconBox: { width: 48, height: 48, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  transTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 4 },
  transDate: { fontSize: 12, fontFamily: 'Urbanist-Medium' },
  transAmount: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  floatingCoin: { width: 30, height: 30, borderRadius: 15, justifyContent: 'center', alignItems: 'center', shadowColor: '#FFA500', shadowOpacity: 0.5, shadowRadius: 5, elevation: 5, borderWidth: 1, borderColor: '#FFF' },
  adModalContainer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center' },
  adModalContent: { width: '80%', padding: 25, borderRadius: 24, alignItems: 'center' },
  adTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginBottom: 8 },
  adSubtitle: { fontSize: 14, fontFamily: 'Urbanist-Medium', textAlign: 'center' }
});
