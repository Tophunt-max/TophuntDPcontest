import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  FlatList,
  ImageBackground,
  ScrollView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { contestService } from '@/src/services/contests/contestService';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData'; 
import { useThemeColor } from '@/hooks/use-theme-color';
import { PhotoContestSkeleton } from '@/src/components/contests/PhotoContestSkeleton';
import { Wallet_Icon, Left_Arrow } from '@/assets/svgs'; 
import { LinearGradient } from 'expo-linear-gradient';

const BRAND_PRIMARY = '#FF4D67'; 

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
    router.push({
      pathname: '/contest/photo/setup',
      params: { contestId: contest.id }
    });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top']}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBack}>
            <Left_Arrow width={24} height={24} fill={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Photo Contests</Text>
        
        <View style={[styles.walletBadge, { backgroundColor: cardBg }]}>
           <Wallet_Icon width={20} height={20} />
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
              <Ionicons name="images-outline" size={80} color={subTextColor} />
              <Text style={[styles.emptyText, { color: textColor }]}>No active contests available</Text>
              <Text style={[styles.emptySubText, { color: subTextColor }]}>Check back later or create one from Admin panel</Text>
            </View>
          }
          renderItem={({ item }) => {
            const displayFee = item.entryFishCoins || 0;
            return (
              <TouchableOpacity 
                activeOpacity={0.9}
                style={[styles.contestCard, { backgroundColor: cardBg }]}
                onPress={() => navigateToSetup(item)}
              >
                <ImageBackground 
                  source={{ uri: item.bannerUrl || 'https://via.placeholder.com/400x200' }} 
                  style={styles.cardBanner}
                  imageStyle={{ borderRadius: 15 }}
                >
                  <LinearGradient 
                    colors={['transparent', 'rgba(0,0,0,0.8)']} 
                    style={styles.bannerGradient}
                  >
                    <View style={styles.badgeContainer}>
                      <View style={styles.feeBadge}>
                         <Text style={styles.feeText}>Entry: {displayFee} Coins</Text>
                      </View>
                    </View>
                    <Text style={styles.cardTitle}>{item.title || item.name}</Text>
                  </LinearGradient>
                </ImageBackground>
                
                <View style={styles.cardFooter}>
                   <View style={styles.rewardInfo}>
                      <Text style={[styles.rewardLabel, { color: subTextColor }]}>Winner Reward</Text>
                      <Text style={styles.rewardValue}>🏆 {item.rewardCoins || item.winningCoins || 0} Coins</Text>
                   </View>
                   <View style={[styles.startBtn, { backgroundColor: BRAND_PRIMARY }]}>
                      <Text style={styles.startBtnText}>Start</Text>
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
  cardBanner: { 
    width: '100%', 
    height: 180, 
  },
  bannerGradient: { 
    flex: 1, 
    justifyContent: 'flex-end', 
    padding: 15,
    borderRadius: 15
  },
  badgeContainer: {
    position: 'absolute',
    top: 15,
    right: 15,
  },
  feeBadge: {
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)'
  },
  feeText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  cardTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', color: '#FFF' },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 15,
  },
  rewardInfo: { flex: 1 },
  rewardLabel: { fontSize: 12, fontFamily: 'Urbanist-Medium' },
  rewardValue: { fontSize: 16, fontFamily: 'Urbanist-Bold', color: '#FFD700', marginTop: 2 },
  startBtn: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 10,
  },
  startBtnText: { color: '#FFF', fontFamily: 'Urbanist-Bold' },
  emptyContainer: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    marginTop: 100,
    paddingHorizontal: 40
  },
  emptyText: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginTop: 20, textAlign: 'center' },
  emptySubText: { fontSize: 14, fontFamily: 'Urbanist-Medium', marginTop: 10, textAlign: 'center', opacity: 0.7 }
});
