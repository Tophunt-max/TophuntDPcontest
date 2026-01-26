import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ImageBackground,
  ScrollView,
  Alert,
  Dimensions,
} from 'react-native';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { contestService } from '@/src/services/contests/contestService';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData'; 
import { useThemeColor } from '@/hooks/use-theme-color';
import { PhotoContestSkeleton } from '@/src/components/contests/PhotoContestSkeleton';
import { Wallet_Color, Left_Arrow, Camera_Icon, Trophy_Icon } from '@/assets/svgs'; 
import { LinearGradient } from 'expo-linear-gradient';
import { getOptimizedMediaUrl } from '@/src/utils/media';

const { width } = Dimensions.get('window');
const BRAND_PRIMARY = '#FF4D67'; 

const TemplateCountdown = ({ expiresAt, isDark, label }: { expiresAt: any, isDark: boolean, label: string }) => {
    const [timeLeft, setTimeLeft] = useState("");

    useEffect(() => {
        if (!expiresAt) return;
        const target = expiresAt.toDate ? expiresAt.toDate().getTime() : new Date(expiresAt).getTime();
        const updateTimer = () => {
            const now = new Date().getTime();
            const distance = target - now;
            if (distance < 0) { setTimeLeft("Ended"); return; }
            
            const hours = Math.floor(distance / (1000 * 60 * 60));
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((distance % (1000 * 60)) / 1000);
            
            setTimeLeft(`${hours}h ${minutes}m ${seconds}s`);
        };
        const timer = setInterval(updateTimer, 1000);
        updateTimer();
        return () => clearInterval(timer);
    }, [expiresAt]);

    return (
        <View style={[styles.timerBadge, { backgroundColor: isDark ? 'rgba(255,77,103,0.1)' : '#FFF5F6' }]}>
            <Ionicons name="time" size={12} color={BRAND_PRIMARY} />
            <Text style={styles.timerText}>{label}: {timeLeft}</Text>
        </View>
    );
};

export default function PhotoContestsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile } = useProfile(user?.uid || ''); 
  
  const backgroundColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const isDark = useThemeColor({}, 'background') === '#121212';
  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const subTextColor = useThemeColor({ light: '#9E9E9E', dark: '#BDBDBD' }, 'text');

  const [contests, setContests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { loadContests(); }, []);

  const loadContests = async () => {
    setLoading(true);
    try {
      const data = await contestService.getAvailableContests('photo');
      setContests(data);
    } catch (error) { console.error(error); } 
    finally { setLoading(false); }
  };

  const navigateToSetup = (contest: any) => {
    if ((contest.joinedCount || 0) >= (contest.maxParticipants || 1000000)) {
        Alert.alert("Contest Full", "This contest has reached its limit.");
        return;
    }
    router.push({ pathname: '/contest/photo/setup', params: { contestId: contest.id } });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBack}>
            <Left_Arrow width={24} height={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Photo Battles</Text>
        <View style={styles.headerRight}>
            <LinearGradient colors={['#FF4D67', '#FF8A4D']} start={{x:0, y:0}} end={{x:1, y:0}} style={styles.walletBadge}>
                <Wallet_Color width={16} height={16} color="#FFF" />
                <Text style={styles.walletText}>{profile?.Dpcoin || 0}</Text>
            </LinearGradient>
        </View>
      </View>

      {loading ? (
        <ScrollView contentContainerStyle={{ padding: 20 }}><PhotoContestSkeleton /></ScrollView>
      ) : (
        <FlatList
          data={contests}
          keyExtractor={item => item.id}
          showsVerticalScrollIndicator={false}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Camera_Icon width={80} height={80} color={subTextColor} />
              <Text style={[styles.emptyText, { color: textColor }]}>No Battles Today</Text>
              <Text style={[styles.emptySubText, { color: subTextColor }]}>New contests are added every 24 hours. Stay tuned!</Text>
            </View>
          }
          renderItem={({ item }) => {
            const joined = item.joinedCount || 0;
            const max = item.maxParticipants || 100;
            const isFull = joined >= max;
            const bannerUri = getOptimizedMediaUrl(item.bannerUrl || 'https://via.placeholder.com/600x300');
            
            const hasProduct = item.rewardType === 'product' || item.rewardType === 'both';
            const hasCoins = item.rewardType !== 'product';

            return (
              <TouchableOpacity 
                activeOpacity={0.95}
                style={[styles.card, { backgroundColor: cardBg }]}
                onPress={() => navigateToSetup(item)}
              >
                <View style={styles.imageContainer}>
                    <Image source={{ uri: bannerUri }} style={styles.bannerImage} contentFit="cover" transition={300} />
                    <LinearGradient colors={['rgba(0,0,0,0.1)', 'rgba(0,0,0,0.8)']} style={styles.imageOverlay} />
                    
                    <View style={styles.topRow}>
                        <View style={styles.entryBadge}>
                            <Text style={styles.entryLabel}>Entry</Text>
                            <Text style={styles.entryValue}>{item.entryFee} Dp</Text>
                        </View>
                        <TemplateCountdown label="End" expiresAt={item.expiresAt} isDark={isDark} />
                    </View>

                    <View style={styles.bottomContent}>
                        <Text style={styles.contestName}>{item.title || item.name}</Text>
                        <View style={styles.battleInfoRow}>
                            <View style={styles.infoBadge}>
                                <Ionicons name="people" size={12} color="#FFF" />
                                <Text style={styles.infoText}>{joined}/{max}</Text>
                            </View>
                            <View style={styles.infoBadge}>
                                <Ionicons name="stopwatch" size={12} color="#FFF" />
                                <Text style={styles.infoText}>{item.battleDurationHours}h Battle</Text>
                            </View>
                        </View>
                    </View>
                </View>

                <View style={styles.footer}>
                    <View style={styles.rewardSection}>
                        <Text style={[styles.rewardLabel, { color: subTextColor }]}>WINNER REWARD</Text>
                        
                        {hasProduct && (
                            <View style={styles.productRewardRow}>
                                {item.productImageUrl ? (
                                    <Image source={{ uri: getOptimizedMediaUrl(item.productImageUrl) }} style={styles.rewardIcon} contentFit="cover" />
                                ) : (
                                    <View style={styles.defaultRewardIcon}><Trophy_Icon width={16} height={16} color="#FFF" /></View>
                                )}
                                <Text style={[styles.rewardTitle, { color: textColor }]} numberOfLines={1}>
                                    {item.prizeDescription || "Physical Gift"}
                                </Text>
                            </View>
                        )}

                        {hasCoins && (
                            <View style={[styles.prizeRow, hasProduct && { marginTop: 4 }]}>
                                <Wallet_Color width={18} height={18} />
                                <Text style={[styles.prizeAmount, { color: textColor }]}>
                                    {item.winnerReward} <Text style={styles.prizeCoin}>Dpcoins</Text>
                                </Text>
                            </View>
                        )}
                    </View>
                    
                    <TouchableOpacity 
                        style={[styles.joinBtn, isFull && styles.fullBtn]} 
                        onPress={() => navigateToSetup(item)}
                        disabled={isFull}
                    >
                        <LinearGradient 
                            colors={isFull ? ['#9E9E9E', '#757575'] : ['#FF4D67', '#FF8A4D']} 
                            start={{x:0, y:0}} end={{x:1, y:0}}
                            style={styles.joinBtnGradient}
                        >
                            <Text style={styles.joinBtnText}>{isFull ? 'FULL' : 'JOIN'}</Text>
                        </LinearGradient>
                    </TouchableOpacity>
                </View>
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={{ padding: 16, paddingBottom: 100 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 15 },
  headerBack: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center' },
  headerRight: { flexDirection: 'row', alignItems: 'center' },
  title: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  walletBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, gap: 6 },
  walletText: { fontSize: 14, fontFamily: 'Urbanist-Bold', color: '#FFF' },
  card: { borderRadius: 24, marginBottom: 20, overflow: 'hidden', elevation: 8, shadowColor: '#000', shadowOffset: { width: 0, height: 5 }, shadowOpacity: 0.15, shadowRadius: 12 },
  imageContainer: { height: 210, width: '100%', position: 'relative' },
  bannerImage: { width: '100%', height: '100%' },
  imageOverlay: { ...StyleSheet.absoluteFillObject },
  topRow: { position: 'absolute', top: 15, left: 15, right: 15, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  entryBadge: { backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)' },
  entryLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 9, fontFamily: 'Urbanist-Medium' },
  entryValue: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  timerBadge: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 10, gap: 5 },
  timerText: { fontSize: 10, fontFamily: 'Urbanist-Bold', color: BRAND_PRIMARY },
  bottomContent: { position: 'absolute', bottom: 15, left: 20, right: 20 },
  contestName: { color: '#FFF', fontSize: 24, fontFamily: 'Urbanist-Bold' },
  battleInfoRow: { flexDirection: 'row', gap: 10, marginTop: 6 },
  infoBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.15)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6, gap: 4 },
  infoText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Bold' },
  footer: { padding: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  rewardSection: { flex: 1, marginRight: 10 },
  rewardLabel: { fontSize: 9, fontFamily: 'Urbanist-Black', letterSpacing: 1, marginBottom: 6 },
  productRewardRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  rewardIcon: { width: 32, height: 32, borderRadius: 8, backgroundColor: '#f5f5f5' },
  defaultRewardIcon: { width: 32, height: 32, borderRadius: 8, backgroundColor: BRAND_PRIMARY, justifyContent: 'center', alignItems: 'center' },
  rewardTitle: { fontSize: 14, fontFamily: 'Urbanist-Bold', flex: 1 },
  prizeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  prizeAmount: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  prizeCoin: { fontSize: 11, fontFamily: 'Urbanist-Medium', opacity: 0.6 },
  joinBtn: { width: 100 },
  fullBtn: { opacity: 0.6 },
  joinBtnGradient: { paddingVertical: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  joinBtnText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Black' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 100, paddingHorizontal: 40 },
  emptyText: { fontSize: 22, fontFamily: 'Urbanist-Bold', marginTop: 20 },
  emptySubText: { fontSize: 14, fontFamily: 'Urbanist-Medium', marginTop: 10, textAlign: 'center', opacity: 0.6 }
});
