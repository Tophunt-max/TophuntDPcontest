import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, useColorScheme, Alert, Share, Modal, ActivityIndicator, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import { BackButton } from '@/src/components/ui/BackButton';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { WalletSkeleton } from '@/src/components/skeletons/WalletSkeleton';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInRight } from 'react-native-reanimated';

import { useAuth } from '@/src/services/auth';
import { Colors } from '@/constants/theme';
import { useProfile } from '@/src/hooks/useProfileData';
import { walletService } from '@/src/services/wallet/walletService';
import { useFeature, useAppConfig } from '@/src/services/appSettings';
import { readApi } from '@/src/services/api';
import { useQuery } from '@tanstack/react-query';

const { width, height } = Dimensions.get('window');

const DAILY_REWARDS = [10, 15, 20, 25, 30, 50, 100];
const FILTERS = ['All', 'Income', 'Expense'];

const taskIcon = (type: string) => (type === 'vote' ? 'stats-chart' : type === 'share' ? 'share-social' : 'videocam');

export default function WalletScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile, refetch: refetchProfile, isLoading: profileLoading } = useProfile(user?.uid || '');
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const topupsEnabled = useFeature('topups'); // admin feature flag
  const withdrawalsEnabled = useFeature('withdrawals'); // admin feature flag
  const { config: appCfg } = useAppConfig();
  // Route top-up to the manual QR screen when the gateway is manual/both.
  const gwMode = (appCfg?.paymentGateway as any)?.mode || 'auto';
  const topUpRoute = gwMode === 'manual' || gwMode === 'both' ? '/wallet/deposit' : '/wallet/store';

  // Theme Colors
  const backgroundColor = isDark ? Colors.dark.background : '#F8F9FA';
  const cardBg = isDark ? '#1F222A' : '#FFFFFF';
  const textColor = isDark ? Colors.dark.text : '#121212';
  const subTextColor = isDark ? '#A0A0A0' : '#757575';
  const primaryColor = '#FF4D67';

  // State
  const [currentDay, setCurrentDay] = useState(0);
  const [claimedToday, setClaimedToday] = useState(false);
  const [activeFilter, setActiveFilter] = useState('All');

  // Derive the daily check-in state from real server data (streak + last claim)
  // instead of hardcoding it, so the UI reflects what the user has actually claimed.
  useEffect(() => {
    if (!profile) return;
    const lastMs = (profile as any).lastDailyClaim ? Number((profile as any).lastDailyClaim) : 0;
    const d = new Date();
    const startOfTodayUTC = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
    const claimed = lastMs >= startOfTodayUTC;
    const streak = (profile as any).streak || 0;
    setClaimedToday(claimed);
    if (claimed) {
      // Today already claimed: highlight the last claimed day on the track.
      setCurrentDay(Math.max(0, Math.min(streak - 1, DAILY_REWARDS.length - 1)));
    } else {
      // Not claimed yet today: the next day in the streak is ready to claim.
      setCurrentDay(Math.min(streak, DAILY_REWARDS.length - 1));
    }
  }, [profile]);
  
  // Ad Simulation State
  const [isWatchingAd, setIsWatchingAd] = useState(false);
  const [adTimer, setAdTimer] = useState(5);

  // Real transaction history from the coin ledger (signed amounts).
  const { data: txnData } = useQuery({
    queryKey: ['transactions', user?.uid],
    queryFn: async () => {
      const res: any = await readApi('/read/transactions', { limit: 50 });
      return (res?.transactions || []).map((t: any) => ({
        id: t.id,
        type: t.type,
        amount: t.amount,
        description: t.description || t.type,
        date: t.createdAt ? new Date(Number(t.createdAt)).toLocaleDateString() : '',
      }));
    },
    enabled: !!user?.uid,
  });

  // Real daily tasks (progress + claim state from the server).
  const { data: tasksResp, refetch: refetchTasks } = useQuery({
    queryKey: ['daily-tasks', user?.uid],
    queryFn: () => walletService.getDailyTasks(),
    enabled: !!user?.uid,
  });
  const tasks = ((tasksResp as any)?.tasks || []).map((t: any) => ({ ...t, maxProgress: t.target, icon: taskIcon(t.type) }));

  const claimTask = async (taskId: string) => {
    try {
      const r: any = await walletService.claimDailyTask(taskId);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert('Reward earned!', `You got ${r.reward} Dpcoins!`);
      refetchProfile();
      refetchTasks();
    } catch (e: any) {
      Alert.alert('Cannot claim', e?.message || 'Task not completed yet.');
    }
  };

  // Filter Logic
  const filteredTransactions = (txnData || []).filter((t: any) => {
    if (activeFilter === 'All') return true;
    if (activeFilter === 'Income') return t.amount > 0;
    if (activeFilter === 'Expense') return t.amount < 0;
    return true;
  });

  const handleClaimBonus = async () => {
    if (claimedToday) {
        Alert.alert("Come back tomorrow", "You have already claimed your daily reward.");
        return;
    }
    if (!user) return;

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    try {
        // The Worker returns { success, coinsEarned, xpEarned, streak } — read the
        // coin amount off the object instead of stringifying the whole response.
        const res: any = await walletService.claimDailyBonus(user.uid, currentDay);
        const earned = res?.coinsEarned ?? 0;
        setClaimedToday(true);
        Alert.alert("Bonus Claimed!", `You received ${earned} Dpcoins.`);
        // refetch re-runs the derivation effect above with the new streak/lastClaim.
        refetchProfile();
    } catch (error: any) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        const alreadyClaimed = typeof error?.message === 'string' && error.message.toLowerCase().includes('already');
        setClaimedToday(alreadyClaimed ? true : claimedToday);
        Alert.alert("Error", alreadyClaimed ? "You have already claimed your daily reward today." : "Could not claim bonus.");
    }
  };

  const referralCode = (profile as any)?.referralCode || '';
  const handleRefer = async () => {
    Haptics.selectionAsync();
    try {
      const code = referralCode || 'TOPHUNT';
      await Share.share({
        message: `Join me on TopHunt and earn free Dpcoins! Use my referral code: ${code}`,
      });
    } catch (error) {
      Alert.alert('Error', 'Could not open share dialog');
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

  const finishAd = async () => {
    setIsWatchingAd(false);
    try {
      // Server credits the reward (with a daily cap) and returns the amount.
      const res: any = await walletService.claimAdReward();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Reward Earned!", `You earned ${res?.coinsEarned ?? 0} Dpcoins for watching the ad!`);
      refetchProfile();
      refetchTasks();
    } catch (error: any) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      const limitHit = typeof error?.message === 'string' && error.message.toLowerCase().includes('limit');
      Alert.alert(
        'Reward',
        limitHit
          ? "You've reached today's ad reward limit. Come back tomorrow!"
          : "Couldn't credit your reward right now. Please try again.",
      );
    }
  };

  const handleTaskAction = (task: any) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (task.claimed) return;
    if (task.claimable) { claimTask(task.id); return; }
    if (task.type === 'share') handleRefer();
    else if (task.type === 'vote') router.push('/');
    else if (task.type === 'ad') simulateWatchAd();
  };

  const renderFilter = (filter: string) => {
    const isActive = activeFilter === filter;
    return (
      <TouchableOpacity
        key={filter}
        onPress={() => {
            Haptics.selectionAsync();
            setActiveFilter(filter);
        }}
        style={[
          styles.filterChip,
          isActive && { backgroundColor: primaryColor },
          !isActive && { backgroundColor: isDark ? '#2A2D35' : '#ECECEC' }
        ]}
      >
        <Text style={[
          styles.filterText,
          { color: isActive ? '#FFF' : subTextColor, fontFamily: isActive ? 'Urbanist-Bold' : 'Urbanist-Medium' }
        ]}>
          {filter}
        </Text>
      </TouchableOpacity>
    );
  };

  const renderDailyItem = (amount: number, index: number) => {
    let status = 'locked'; 
    if (index < currentDay) status = 'claimed';
    else if (index === currentDay) status = claimedToday ? 'claimed' : 'ready';
    
    const isReady = status === 'ready';
    const isClaimed = status === 'claimed';
    
    return (
        <View key={index} style={styles.dayWrapper}>
            {/* Connecting Line */}
            {index < DAILY_REWARDS.length - 1 && (
                <View style={[
                    styles.connectorLine, 
                    { backgroundColor: index < currentDay ? '#4CAF50' : (isDark ? '#333' : '#E0E0E0') } 
                ]} />
            )}
            
            <TouchableOpacity 
                style={[
                    styles.dayCard, 
                    { backgroundColor: isDark ? '#2A2D35' : '#FFF' },
                    isReady && { borderColor: primaryColor, borderWidth: 1.5, shadowColor: primaryColor, shadowOpacity: 0.3, elevation: 4 },
                    isClaimed && { borderColor: '#4CAF50', borderWidth: 1 }
                ]}
                onPress={isReady ? handleClaimBonus : undefined}
                disabled={!isReady}
                activeOpacity={0.7}
            >
                <Text style={[styles.dayText, { color: subTextColor }]}>Day {index + 1}</Text>
                {isClaimed ? (
                    <View style={styles.checkCircle}>
                        <Ionicons name="checkmark" size={12} color="white" />
                    </View>
                ) : (
                    <View style={styles.coinIconWrapper}>
                        <Ionicons name="gift" size={20} color={isReady ? primaryColor : (isDark ? '#555' : '#CCC')} />
                    </View>
                )}
                <Text style={[
                    styles.dayAmount, 
                    { color: isReady ? primaryColor : (isClaimed ? '#4CAF50' : textColor) }
                ]}>+{amount}</Text>
            </TouchableOpacity>
        </View>
    );
  };

  const renderTaskItem = ({ item, index }: { item: any, index: number }) => {
    const progressPercent = Math.min((item.progress / item.maxProgress) * 100, 100);
    const label = item.claimed ? 'Done' : item.claimable ? 'Claim' : (item.type === 'vote' ? 'Vote' : item.type === 'share' ? 'Share' : 'Watch');
    return (
        <Animated.View entering={FadeInRight.delay(index * 100).duration(500)} style={[styles.taskCard, { backgroundColor: cardBg }]}>
            <View style={[styles.taskIconBox, { backgroundColor: isDark ? '#2A2D35' : '#F5F5F5' }]}>
                <Ionicons name={item.icon as any} size={24} color={primaryColor} />
            </View>
            <View style={{ flex: 1, paddingHorizontal: 12 }}>
                <Text style={[styles.taskTitle, { color: textColor }]}>{item.title}</Text>
                <View style={styles.progressBarBg}>
                    <View style={[styles.progressBarFill, { width: `${progressPercent}%` }]} />
                </View>
                <Text style={styles.taskProgressText}>{item.progress}/{item.maxProgress} completed</Text>
            </View>
            <TouchableOpacity 
                style={[styles.taskButton, item.claimed && { backgroundColor: isDark ? '#2A2D35' : '#EEE' }, item.claimable && { backgroundColor: '#4CAF50' }]}
                onPress={() => handleTaskAction(item)}
                disabled={item.claimed}
                activeOpacity={0.8}
            >
                <Text style={[styles.taskButtonText, item.claimable && { color: '#FFF' }, item.claimed && { color: 'gray' }]}>{label}</Text>
                {!item.claimed && (
                  <View style={styles.taskRewardBadge}>
                      <Text style={styles.taskRewardText}>+{item.reward}</Text>
                  </View>
                )}
            </TouchableOpacity>
        </Animated.View>
    );
  };

  const renderTransaction = ({ item, index }: { item: any, index: number }) => (
    <Animated.View entering={FadeInDown.delay(index * 100).duration(400)}>
        <View style={[styles.transactionItem, { backgroundColor: cardBg }]}>
        <View style={[styles.iconBox, { backgroundColor: item.amount > 0 ? 'rgba(76, 175, 80, 0.1)' : 'rgba(255, 77, 103, 0.1)' }]}>
            <Ionicons 
                name={item.amount > 0 ? "arrow-down" : "arrow-up"} 
                size={20} 
                color={item.amount > 0 ? "#4CAF50" : "#FF4D67"} 
            />
        </View>
        <View style={{ flex: 1, marginLeft: 14 }}>
            <Text style={[styles.transTitle, { color: textColor }]}>{item.description}</Text>
            <Text style={[styles.transDate, { color: subTextColor }]}>{item.date} • {item.type.replace('_', ' ').toUpperCase()}</Text>
        </View>
        <Text style={[styles.transAmount, { color: item.amount > 0 ? "#4CAF50" : "#FF4D67" }]}>
            {item.amount > 0 ? '+' : ''}{item.amount}
        </Text>
        </View>
    </Animated.View>
  );

  if (profileLoading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        <WalletSkeleton />
      </SafeAreaView>
    );
  }

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
                {/* Header */}
                <View style={styles.header}>
                    <BackButton size={26} color={textColor} style={styles.backButton} />
                    <Text style={[styles.title, { color: textColor }]}>My Wallet</Text>
                    <TouchableOpacity onPress={() => router.push('/wallet/store')}>
                        <Ionicons name="scan-outline" size={24} color={textColor} />
                    </TouchableOpacity>
                </View>

                {/* Balance Card */}
                <Animated.View entering={FadeInDown.duration(600)} style={styles.balanceContainer}>
                    <LinearGradient
                        colors={['#FF4D67', '#FF8A9B']}
                        start={{ x: 0, y: 0 }}
                        end={{ x: 1, y: 1 }}
                        style={styles.gradient}
                    >
                        {/* Background Decoration */}
                        <View style={styles.cardCircle1} />
                        <View style={styles.cardCircle2} />

                        <View style={styles.balanceHeader}>
                            <Text style={styles.balanceLabel}>Total Balance</Text>
                            <View style={styles.coinBadge}>
                                <CoinIcon size={14} color="#FFF" />
                                <Text style={styles.coinBadgeText}>Dpcoin</Text>
                            </View>
                        </View>
                        
                        <View style={styles.row}>
                            <Text style={styles.balanceValue}>{profile?.Dpcoin || 0}</Text>
                        </View>
                        
                        {topupsEnabled && (
                        <TouchableOpacity 
                            style={styles.topUpButton}
                            onPress={() => {
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                router.push(topUpRoute);
                            }}
                            activeOpacity={0.9}
                        >
                            <Ionicons name="add" size={20} color="#FF4D67" />
                            <Text style={styles.topUpText}>Top Up Balance</Text>
                        </TouchableOpacity>
                        )}
                        {withdrawalsEnabled && (
                        <TouchableOpacity
                            style={styles.withdrawButton}
                            onPress={() => {
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                router.push('/wallet/withdraw');
                            }}
                            activeOpacity={0.9}
                        >
                            <Ionicons name="cash-outline" size={18} color="#FFF" />
                            <Text style={styles.withdrawText}>Withdraw</Text>
                        </TouchableOpacity>
                        )}
                    </LinearGradient>
                </Animated.View>

                {/* Daily Bonus Section */}
                <View style={styles.sectionHeader}>
                    <View>
                        <Text style={[styles.sectionTitle, { color: textColor }]}>Daily Check-in</Text>
                        <Text style={[styles.sectionSubtitle, { color: subTextColor }]}>Earn rewards everyday!</Text>
                    </View>
                </View>
                <View style={styles.dailyScrollWrapper}>
                    <View style={styles.dailyContainer}>
                        {DAILY_REWARDS.map((amount, index) => renderDailyItem(amount, index))}
                    </View>
                </View>

                {/* Daily Tasks Section */}
                <View style={[styles.sectionHeader, { marginTop: 25 }]}>
                    <View>
                        <Text style={[styles.sectionTitle, { color: textColor }]}>Daily Tasks</Text>
                        <Text style={[styles.sectionSubtitle, { color: subTextColor }]}>Complete tasks to earn more!</Text>
                    </View>
                </View>
                <View style={{ paddingHorizontal: 20 }}>
                    {tasks.length === 0 ? (
                      <Text style={{ color: subTextColor, fontFamily: 'Urbanist-Medium', paddingHorizontal: 4 }}>No tasks right now. Check back later!</Text>
                    ) : (
                      tasks.map((item: any, index: number) => renderTaskItem({ item, index }))
                    )}
                </View>

                {/* Refer & Earn Banner */}
                <Animated.View entering={FadeInRight.delay(200).duration(500)}>
                    <TouchableOpacity 
                        onPress={handleRefer} 
                        style={[styles.referContainer, { backgroundColor: isDark ? '#2A2D35' : '#FFF' }]}
                        activeOpacity={0.9}
                    >
                        <LinearGradient
                            colors={isDark ? ['#2A2D35', '#2A2D35'] : ['#E8F5E9', '#FFFFFF']}
                            start={{x: 0, y: 0}} end={{x: 1, y: 0}}
                            style={[StyleSheet.absoluteFill, { borderRadius: 20 }]} 
                        />
                        <View style={styles.referContent}>
                            <View style={styles.referIconBox}>
                                <Ionicons name="gift-outline" size={28} color="#FF4D67" />
                            </View>
                            <View style={{ flex: 1, marginLeft: 12 }}>
                                <Text style={[styles.referTitle, { color: isDark ? '#fff' : '#101010' }]}>Refer & Earn</Text>
                                <Text style={styles.referDesc}>{referralCode ? <>Your code: <Text style={{fontWeight: '800', color: '#FF4D67'}}>{referralCode}</Text></> : 'Invite friends & earn bonus coins!'}</Text>
                            </View>
                            <Ionicons name="chevron-forward" size={20} color={subTextColor} />
                        </View>
                    </TouchableOpacity>
                </Animated.View>

                {/* Transactions Header & Filter */}
                <View style={[styles.sectionHeader, { marginTop: 25, marginBottom: 10 }]}>
                    <Text style={[styles.sectionTitle, { color: textColor }]}>Transactions</Text>
                </View>
                
                <View style={styles.filterContainer}>
                    {FILTERS.map(renderFilter)}
                </View>
            </View>
        }
        ListEmptyComponent={
            <View style={styles.emptyState}>
                <View style={[styles.emptyIconCircle, { backgroundColor: isDark ? '#2A2D35' : '#F5F5F5' }]}>
                    <Ionicons name="receipt-outline" size={40} color={subTextColor} />
                </View>
                <Text style={[styles.emptyText, { color: subTextColor }]}>No transactions found</Text>
            </View>
        }
      />

      {/* Fake Ad Modal */}
      <Modal visible={isWatchingAd} transparent animationType="fade">
        <View style={styles.adModalContainer}>
            <View style={[styles.adModalContent, { backgroundColor: isDark ? '#1F222A' : '#FFF' }]}>
                <Text style={[styles.adTitle, { color: textColor }]}>Watching Ad...</Text>
                <Text style={[styles.adSubtitle, { color: subTextColor }]}>Please wait {adTimer} seconds to get reward</Text>
                
                <ActivityIndicator size="large" color={primaryColor} style={{ marginVertical: 20 }} />
                
                <View style={styles.adProgressBar}>
                    <View style={[styles.adProgressFill, { width: `${((5-adTimer)/5)*100}%` }]} />
                </View>
            </View>
        </View>
      </Modal>

    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, marginBottom: 10 },
  backButton: { padding: 4 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  
  // Balance Card
  balanceContainer: { marginHorizontal: 20, marginBottom: 25, borderRadius: 28, overflow: 'hidden', elevation: 10, shadowColor: '#FF4D67', shadowOpacity: 0.4, shadowRadius: 15, shadowOffset: { width: 0, height: 8 } },
  gradient: { padding: 25, position: 'relative' },
  cardCircle1: { position: 'absolute', top: -50, right: -50, width: 150, height: 150, borderRadius: 75, backgroundColor: 'rgba(255,255,255,0.1)' },
  cardCircle2: { position: 'absolute', bottom: -30, left: -30, width: 100, height: 100, borderRadius: 50, backgroundColor: 'rgba(255,255,255,0.1)' },
  
  balanceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  balanceLabel: { color: 'rgba(255,255,255,0.9)', fontSize: 16, fontFamily: 'Urbanist-Medium' },
  coinBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.2)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 },
  coinBadgeText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold', marginLeft: 4 },
  
  row: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 25 },
  balanceValue: { color: 'white', fontSize: 42, fontFamily: 'Urbanist-Bold', letterSpacing: -1 },
  
  topUpButton: { backgroundColor: 'white', paddingHorizontal: 20, paddingVertical: 14, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', shadowColor: 'black', shadowOpacity: 0.1, shadowRadius: 5, shadowOffset: { width: 0, height: 2 } },
  topUpText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 16, marginLeft: 6 },
  withdrawButton: { marginTop: 10, paddingVertical: 12, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.6)' },
  withdrawText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 15, marginLeft: 6 },
  
  // Section Headers
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 15 },
  sectionTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  sectionSubtitle: { fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  
  // Daily Bonus
  dailyScrollWrapper: { paddingHorizontal: 20, marginBottom: 5 },
  dailyContainer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  dayWrapper: { alignItems: 'center', width: (width - 40) / 7 },
  connectorLine: { position: 'absolute', top: 25, right: -((width - 40) / 14), width: (width - 40) / 7, height: 3, zIndex: -1 },
  dayCard: { width: 44, height: 60, borderRadius: 22, alignItems: 'center', justifyContent: 'center', elevation: 2, paddingVertical: 5, marginBottom: 5, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 3, shadowOffset: {width: 0, height: 2} },
  dayText: { fontSize: 9, fontFamily: 'Urbanist-Bold', marginBottom: 4 },
  dayAmount: { fontSize: 11, fontFamily: 'Urbanist-Bold' },
  checkCircle: { width: 20, height: 20, borderRadius: 10, backgroundColor: '#4CAF50', justifyContent: 'center', alignItems: 'center', marginBottom: 2 },
  coinIconWrapper: { marginBottom: 2 },

  // Tasks
  taskCard: { flexDirection: 'row', alignItems: 'center', padding: 12, marginBottom: 12, borderRadius: 20, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  taskIconBox: { width: 48, height: 48, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  taskTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 6 },
  progressBarBg: { height: 6, backgroundColor: '#E0E0E0', borderRadius: 3, marginBottom: 6, overflow: 'hidden' },
  progressBarFill: { height: '100%', backgroundColor: '#FF4D67', borderRadius: 3 },
  taskProgressText: { fontSize: 12, fontFamily: 'Urbanist-Medium', color: 'gray' },
  taskButton: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#FFF0F3', paddingVertical: 8, paddingHorizontal: 16, borderRadius: 12 },
  taskButtonText: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 14 },
  taskRewardBadge: { position: 'absolute', top: -8, right: -8, backgroundColor: '#FFD700', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  taskRewardText: { fontSize: 10, fontFamily: 'Urbanist-Bold', color: '#000' },

  // Refer Banner
  referContainer: { marginHorizontal: 20, marginTop: 20, borderRadius: 20, padding: 16, overflow: 'hidden', elevation: 2, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 4 } },
  referContent: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%' },
  referIconBox: { width: 48, height: 48, borderRadius: 14, backgroundColor: 'rgba(255, 77, 103, 0.1)', justifyContent: 'center', alignItems: 'center' },
  referTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 2 },
  referDesc: { fontSize: 13, fontFamily: 'Urbanist-Medium', color: 'gray', lineHeight: 18 },

  // Filters
  filterContainer: { flexDirection: 'row', paddingHorizontal: 20, marginBottom: 15, gap: 10 },
  filterChip: { paddingHorizontal: 16, paddingVertical: 8, borderRadius: 20 },
  filterText: { fontSize: 14 },

  // Transactions
  transactionItem: { flexDirection: 'row', alignItems: 'center', padding: 16, marginBottom: 12, borderRadius: 20, marginHorizontal: 20 },
  iconBox: { width: 48, height: 48, borderRadius: 16, justifyContent: 'center', alignItems: 'center' },
  transTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 4 },
  transDate: { fontSize: 12, fontFamily: 'Urbanist-Medium' },
  transAmount: { fontSize: 16, fontFamily: 'Urbanist-Bold' },

  // Empty State
  emptyState: { alignItems: 'center', marginTop: 40, paddingBottom: 50 },
  emptyIconCircle: { width: 80, height: 80, borderRadius: 40, justifyContent: 'center', alignItems: 'center', marginBottom: 15 },
  emptyText: { fontFamily: 'Urbanist-Medium', fontSize: 16 },

  // Ad Modal
  adModalContainer: { flex: 1, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center' },
  adModalContent: { width: '80%', padding: 25, borderRadius: 24, alignItems: 'center' },
  adTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginBottom: 8 },
  adSubtitle: { fontSize: 14, fontFamily: 'Urbanist-Medium', textAlign: 'center' },
  adProgressBar: { width: '100%', height: 6, backgroundColor: '#E0E0E0', borderRadius: 3, marginTop: 10, overflow: 'hidden' },
  adProgressFill: { height: '100%', backgroundColor: '#FF4D67' },
});
