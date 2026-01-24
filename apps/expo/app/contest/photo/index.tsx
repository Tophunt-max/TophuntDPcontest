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

const BRAND_PRIMARY = '#FF4D67'; 

const formatDate = (date: any) => {
    if (!date) return "";
    const d = date.toDate ? date.toDate() : new Date(date);
    return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
};

const TemplateCountdown = ({ expiresAt, textColor }: { expiresAt: any, textColor: string }) => {
    const [timeLeft, setTimeLeft] = useState("");

    useEffect(() => {
        if (!expiresAt) return;
        const target = expiresAt.toDate ? expiresAt.toDate().getTime() : new Date(expiresAt).getTime();

        const updateTimer = () => {
            const now = new Date().getTime();
            const distance = target - now;
            if (distance < 0) { setTimeLeft("Expired"); return; }

            const days = Math.floor(distance / (1000 * 60 * 60 * 24));
            const hours = Math.floor((distance % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((distance % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((distance % (1000 * 60)) / 1000);

            const h = hours.toString().padStart(2, '0');
            const m = minutes.toString().padStart(2, '0');
            const s = seconds.toString().padStart(2, '0');

            if (days > 0) {
                setTimeLeft(`${days}d ${h}:${m}:${s}`);
            } else {
                setTimeLeft(`${h}:${m}:${s}`);
            }
        };

        const timer = setInterval(updateTimer, 1000);
        updateTimer();
        return () => clearInterval(timer);
    }, [expiresAt]);

    return (
        <View style={styles.timerContainer}>
            <Ionicons name="time-outline" size={12} color={textColor} />
            <Text style={[styles.timerText, { color: textColor }]}>{timeLeft}</Text>
        </View>
    );
};

export default function PhotoContestsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile } = useProfile(user?.uid || ''); 
  
  const backgroundColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const subTextColor = useThemeColor({ light: '#9E9E9E', dark: '#E0E0E0' }, 'text');

  const [contests, setContests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => { 
    loadContests(); 
  }, []);

  const loadContests = async () => {
    setLoading(true);
    try {
      const data = await contestService.getAvailableContests('photo');
      setContests(data);
    } catch (error) { 
      console.error(error); 
    } finally { 
      setLoading(false); 
    }
  };

  const navigateToSetup = (contest: any) => {
    const joined = contest.joinedCount || 0;
    const max = contest.maxParticipants || 1000000;
    if (joined >= max) {
        Alert.alert("Contest Full", "This contest has reached its maximum participant limit.");
        return;
    }
    router.push({
      pathname: '/contest/photo/setup',
      params: { contestId: contest.id }
    });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBack}>
            <Left_Arrow width={24} height={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Photo Contests</Text>
        
        <View style={[styles.walletBadge, { backgroundColor: cardBg }]}>
           <Wallet_Color width={20} height={20} />
           <Text style={[styles.walletText, { color: textColor }]}>{profile?.Dpcoin || profile?.coins || 0}</Text>
        </View>
      </View>

      {loading ? (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <PhotoContestSkeleton />
        </ScrollView>
      ) : (
        <FlatList
          data={contests}
          keyExtractor={item => item.id}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <Camera_Icon width={80} height={80} color={subTextColor} />
              <Text style={[styles.emptyText, { color: textColor }]}>No active contests available</Text>
              <Text style={[styles.emptySubText, { color: subTextColor }]}>Check back later or create one from Admin panel</Text>
            </View>
          }
          renderItem={({ item }) => {
            const displayFee = item.entryFee || 0;
            const bannerUri = getOptimizedMediaUrl(item.bannerUrl || 'https://via.placeholder.com/400x200');
            const joined = item.joinedCount || 0;
            const max = item.maxParticipants || 100;
            const percent = Math.min((joined / max) * 100, 100);
            const isFull = joined >= max;
            
            const hasProduct = item.rewardType === 'product' || item.rewardType === 'both';
            const hasCoins = item.rewardType !== 'product';

            return (
              <TouchableOpacity 
                activeOpacity={isFull ? 1 : 0.9}
                style={[styles.contestCard, { backgroundColor: cardBg }, isFull && { opacity: 0.8 }]}
                onPress={() => navigateToSetup(item)}
              >
                <ImageBackground 
                  source={{ uri: bannerUri }} 
                  style={styles.cardBanner}
                  imageStyle={{ borderRadius: 15 }}
                >
                  <LinearGradient 
                    colors={['transparent', 'rgba(0,0,0,0.8)']} 
                    style={styles.bannerGradient}
                  >
                    <View style={styles.badgeContainer}>
                      <View style={[styles.feeBadge, isFull && { backgroundColor: BRAND_PRIMARY }]}>
                         <Text style={styles.feeText}>{isFull ? 'FULL' : `Entry: ${displayFee} Coins`}</Text>
                      </View>
                    </View>
                    <Text style={styles.cardTitle}>{item.title || item.name}</Text>
                    
                    <View style={styles.progressContainer}>
                        <View style={styles.progressLabelRow}>
                            <Text style={styles.progressLabel}>Capacity: {joined}/{max}</Text>
                            <Text style={styles.progressPercent}>{Math.round(percent)}%</Text>
                        </View>
                        <View style={styles.progressBarBg}>
                            <View style={[styles.progressBarFill, { width: `${percent}%`, backgroundColor: isFull ? BRAND_PRIMARY : '#4CAF50' }]} />
                        </View>
                    </View>
                  </LinearGradient>
                </ImageBackground>
                
                <View style={styles.cardFooter}>
                   <View style={styles.rewardInfo}>
                      <Text style={[styles.rewardLabel, { color: subTextColor }]}>Winner Reward</Text>
                      <View style={styles.rewardArea}>
                         {hasProduct && (
                             <View style={styles.productRow}>
                                {item.productImageUrl ? (
                                    <Image source={{ uri: getOptimizedMediaUrl(item.productImageUrl) }} style={styles.productImage} contentFit="contain" />
                                ) : (
                                    <Trophy_Icon width={16} height={16} color="#FFD700" />
                                )}
                                <Text style={styles.productText} numberOfLines={1}>{item.prizeDescription || "Exclusive Prize"}</Text>
                             </View>
                         )}
                         {hasCoins && (
                             <View style={[styles.coinBadge, hasProduct && { marginTop: 4 }]}>
                                <Text style={styles.rewardValue}>{hasProduct ? `+ ${item.winnerReward}` : item.winnerReward}</Text>
                                <Wallet_Color width={14} height={14} style={{ marginLeft: 4 }} />
                             </View>
                         )}
                      </View>
                   </View>
                   <View style={styles.rightInfo}>
                      <View style={styles.expiryBox}>
                        <Text style={[styles.endsOnText, { color: subTextColor }]}>Ends on {formatDate(item.expiresAt)}</Text>
                        <TemplateCountdown expiresAt={item.expiresAt} textColor={BRAND_PRIMARY} />
                      </View>
                      <View style={[styles.startBtn, { backgroundColor: isFull ? '#666' : BRAND_PRIMARY }]}>
                        <Text style={styles.startBtnText}>{isFull ? 'Full' : 'Start'}</Text>
                      </View>
                   </View>
                </View>
              </TouchableOpacity>
            );
          }}
          contentContainerStyle={{ padding: 20, paddingBottom: 100 }}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { 
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    paddingHorizontal: 15,
    paddingVertical: 10,
    borderBottomWidth: 0.5,
    borderBottomColor: 'rgba(0,0,0,0.05)'
  },
  headerBack: { padding: 5 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  walletBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    gap: 6,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)'
  },
  walletText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  contestCard: { 
    borderRadius: 20, 
    marginBottom: 20,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
  },
  cardBanner: { width: '100%', height: 180 },
  bannerGradient: { flex: 1, justifyContent: 'flex-end', padding: 15, borderRadius: 15 },
  badgeContainer: { position: 'absolute', top: 15, right: 15 },
  feeBadge: { backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)' },
  feeText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  cardTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', color: '#FFF' },
  progressContainer: { marginTop: 10, width: '100%' },
  progressLabelRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  progressLabel: { color: '#EEE', fontSize: 10, fontFamily: 'Urbanist-Medium' },
  progressPercent: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Bold' },
  progressBarBg: { height: 4, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 2, overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 2 },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 15 },
  rewardInfo: { flex: 1, marginRight: 10 },
  rewardLabel: { fontSize: 11, fontFamily: 'Urbanist-Medium', marginBottom: 6 },
  rewardArea: { minHeight: 40, justifyContent: 'center' },
  productRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  productImage: { width: 32, height: 32, borderRadius: 6, backgroundColor: '#f0f0f0' },
  productText: { fontSize: 14, fontFamily: 'Urbanist-Bold', color: '#B8860B', flex: 1 },
  coinBadge: { flexDirection: 'row', alignItems: 'center' },
  rewardValue: { fontSize: 16, fontFamily: 'Urbanist-Bold', color: '#FFD700' },
  rightInfo: { alignItems: 'flex-end', gap: 6 },
  expiryBox: { alignItems: 'flex-end' },
  endsOnText: { fontSize: 10, fontFamily: 'Urbanist-Medium', marginBottom: 2 },
  timerContainer: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  timerText: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  startBtn: { paddingHorizontal: 25, paddingVertical: 8, borderRadius: 10 },
  startBtnText: { color: '#FFF', fontFamily: 'Urbanist-Bold' },
  emptyContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', marginTop: 100, paddingHorizontal: 40 },
  emptyText: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginTop: 20, textAlign: 'center' },
  emptySubText: { fontSize: 14, fontFamily: 'Urbanist-Medium', marginTop: 10, textAlign: 'center', opacity: 0.7 }
});
