import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, useColorScheme, Alert, Share, Modal, ActivityIndicator, Dimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import Animated, { FadeInDown, FadeInRight } from 'react-native-reanimated';

import { useAuth } from '@/src/services/auth';
import { Colors } from '@/constants/theme';
import { useProfile } from '@/src/hooks/useProfileData';
import { walletService } from '@/src/services/wallet/walletService';

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
  
  // Ad Simulation State
  const [isWatchingAd, setIsWatchingAd] = useState(false);
  const [adTimer, setAdTimer] = useState(5);

  // Filter Logic
  const filteredTransactions = MOCK_TRANSACTIONS.filter(t => {
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
        const amount = await walletService.claimDailyBonus(user.uid, currentDay);
        setClaimedToday(true);
        Alert.alert("🎉 Bonus Claimed!", `You received ${amount} Dpcoins.`);
        refetchProfile();
        if(currentDay < 6) setCurrentDay(currentDay + 1);
    } catch (error) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
        Alert.alert("Error", "Could not claim bonus.");
    }
  };

  const handleRefer = async () => {
    Haptics.selectionAsync();
    try {
      await Share.share({
        message: 'Join me on Tophunt and earn free Dpcoins! Use my invite code: ' + (user?.uid?.substring(0, 6) || 'TOPHUNT'),
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

  const finishAd = () => {
    setIsWatchingAd(false);
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    Alert.alert("Reward Earned! 🪙", "You watched the ad and earned 5 Dpcoins!");
    // In a real app, you would call walletService.addCoins(5) here
  };

  const handleTaskAction = (task: any) => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (task.action === 'Share') {
        handleRefer();
    } else if (task.action === 'Watch') {
        simulateWatchAd();
    } else if (task.action === 'Vote') {
        // Navigate to Battles or Home
        router.push('/'); 
    } else {
        Alert.alert(task.title, `This action will open the ${task.action.toLowerCase()} flow.`);
    }
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
    const progressPercent = (item.progress / item.maxProgress) * 100;
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
                style={styles.taskButton} 
                onPress={() => handleTaskAction(item)}
                activeOpacity={0.8}
            >
                <Text style={styles.taskButtonText}>{item.action}</Text>
                <View style={styles.taskRewardBadge}>
                    <Text style={styles.taskRewardText}>+{item.reward}</Text>
                </View>
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
                    <TouchableOpacity onPress={() => router.back()} style={styles.backButton}>
                        <Ionicons name="chevron-back" size={28} color={textColor} />
                    </TouchableOpacity>
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
                                <Ionicons name="wallet-outline" size={14} color="#FFF" />
                                <Text style={styles.coinBadgeText}>Dpcoin</Text>
                            </View>
                        </View>
                        
                        <View style={styles.row}>
                            <Text style={styles.balanceValue}>{profile?.Dpcoin || 0}</Text>
                        </View>
                        
                        <TouchableOpacity 
                            style={styles.topUpButton}
                            onPress={() => {
                                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                                router.push('/wallet/store');
                            }}
                            activeOpacity={0.9}
                        >
                            <Ionicons name="add" size={20} color="#FF4D67" />
                            <Text style={styles.topUpText}>Top Up Balance</Text>
                        </TouchableOpacity>
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
                    {TASKS.map((item, index) => renderTaskItem({ item, index }))}
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
                                <Text style={styles.referDesc}>Get <Text style={{fontWeight: '800', color: '#FF4D67'}}>50 Dpcoins</Text> for each friend!</Text>
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
