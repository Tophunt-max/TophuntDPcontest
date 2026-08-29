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
import { Ionicons } from '@/src/lib/icons';
import { contestService } from '@/src/services/contests/contestService';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData'; 
import { useThemeColor } from '@/hooks/use-theme-color';
import { PhotoContestSkeleton } from '@/src/components/contests/PhotoContestSkeleton';
import { BackButton } from '@/src/components/ui/BackButton';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { CoinIcon } from '@/src/components/ui/CoinIcon'; 
import { LinearGradient } from 'expo-linear-gradient';
import { ContestCountdownBadge, ContestEntryBadge } from '@/src/components/contests/ContestBadges';
import { useCountdown } from '@/src/hooks/useCountdown';
import { rewardCoins } from '@/src/lib/contestPricing';

const BRAND_PRIMARY = '#FF4D67'; 
const BRAND_SECONDARY = '#FF758C';

export default function PhotoContestsScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile } = useProfile(user?.uid || ''); 
  
  const backgroundColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const subTextColor = useThemeColor({ light: '#9E9E9E', dark: '#E0E0E0' }, 'text');
  const chipBg = useThemeColor({ light: '#FFF0F2', dark: '#2A1F24' }, 'background');

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

  const renderHeader = () => (
    <View style={styles.heroWrap}>
      <Text style={[styles.heroTitle, { color: textColor }]}>Pick your battle</Text>
      <Text style={[styles.heroSubtitle, { color: subTextColor }]}>
        Enter a photo contest, submit your best shot, and win coins.
      </Text>
      {contests.length > 0 && (
        <View style={[styles.countPill, { backgroundColor: chipBg }]}>
          <View style={styles.liveDot} />
          <Text style={[styles.countText, { color: BRAND_PRIMARY }]}>
            {contests.length} live {contests.length === 1 ? 'contest' : 'contests'}
          </Text>
        </View>
      )}
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={22} color={textColor} style={[styles.headerBack, { backgroundColor: cardBg }]} />
        <Text style={[styles.title, { color: textColor }]}>Photo Contests</Text>
        
        <View style={[styles.walletBadge, { backgroundColor: cardBg }]}>
           <CoinIcon size={18} />
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
          ListHeaderComponent={contests.length > 0 ? renderHeader : null}
          ListEmptyComponent={
            <View style={styles.emptyContainer}>
              <View style={[styles.emptyIconCircle, { backgroundColor: chipBg }]}>
                <Ionicons name="images-outline" size={54} color={BRAND_PRIMARY} />
              </View>
              <Text style={[styles.emptyText, { color: textColor }]}>No active contests</Text>
              <Text style={[styles.emptySubText, { color: subTextColor }]}>New battles drop regularly — check back soon.</Text>
            </View>
          }
          renderItem={({ item }) => (
            <ContestCard
              item={item}
              cardBg={cardBg}
              subTextColor={subTextColor}
              onEnter={() => navigateToSetup(item)}
            />
          )}
          contentContainerStyle={{ padding: 20, paddingBottom: 100, flexGrow: 1 }}
        />
      )}
    </SafeAreaView>
  );
}

/**
 * One photo contest in the list.
 *
 * Extracted from an inline `renderItem` because it runs `useCountdown`, and a
 * hook inside a per-item render helper would change hook order as the list
 * changes.
 *
 * Two fixes ride along:
 *  - the fee shown was `entryFishCoins`, which is the TOTAL pot for both
 *    players, so this screen advertised exactly double what a player is charged.
 *    `ContestEntryBadge` uses the per-player figure the Worker sends, and shows
 *    FREE instead of "0 Coins" when there is no fee.
 *  - the "LIVE" pill was unconditional. A contest with a closing time now shows
 *    the time left, and an expired one (still listable for up to 60s because of
 *    the response cache) refuses the tap instead of dead-ending at setup.
 */
function ContestCard({
  item,
  cardBg,
  subTextColor,
  onEnter,
}: {
  item: any;
  cardBg: string;
  subTextColor: string;
  onEnter: () => void;
}) {
  const { ended } = useCountdown(item?.endsAt);
  const reward = rewardCoins(item);

  return (
    <TouchableOpacity
      activeOpacity={0.92}
      style={[styles.contestCard, { backgroundColor: cardBg }, ended && styles.contestCardEnded]}
      disabled={ended}
      onPress={onEnter}
    >
      <ImageBackground
        // No banner -> no source; cardBanner's own background colour
        // is the placeholder (was a via.placeholder.com request).
        source={item.bannerUrl ? { uri: item.bannerUrl } : undefined}
        style={styles.cardBanner}
        imageStyle={styles.cardBannerImg}
      >
        <LinearGradient
          colors={['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.85)']}
          style={styles.bannerGradient}
        >
          <View style={styles.topRow}>
            {ended ? (
              <View style={[styles.livePill, styles.endedPill]}>
                <Ionicons name="lock-closed" size={10} color="#FFF" />
                <Text style={styles.livePillText}>CLOSED</Text>
              </View>
            ) : (
              <View style={styles.livePill}>
                <View style={styles.livePillDot} />
                <Text style={styles.livePillText}>LIVE</Text>
              </View>
            )}
            <View style={styles.badgeRow}>
              <ContestCountdownBadge endsAt={item.endsAt} />
              <ContestEntryBadge contest={item} />
            </View>
          </View>
          <Text style={styles.cardTitle} numberOfLines={2}>{item.title || item.name}</Text>
        </LinearGradient>
      </ImageBackground>

      <View style={styles.cardFooter}>
        <View style={styles.rewardInfo}>
          <Text style={[styles.rewardLabel, { color: subTextColor }]}>WINNER GETS</Text>
          <View style={styles.rewardValueRow}>
            <Ionicons name="trophy" size={16} color="#FFB800" />
            <Text style={styles.rewardValue}>{reward} Coins</Text>
          </View>
        </View>
        <LinearGradient
          colors={ended ? ['#9AA0AA', '#7E848E'] : [BRAND_PRIMARY, BRAND_SECONDARY]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.startBtn}
        >
          <Text style={styles.startBtnText}>{ended ? 'Closed' : 'Enter'}</Text>
          {!ended && <ArrowIcon size={16} color="#FFF" variant="arrow" />}
        </LinearGradient>
      </View>
    </TouchableOpacity>
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
  },
  headerBack: { 
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  walletBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 20,
    gap: 6,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  walletText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },

  heroWrap: {
    marginBottom: 20,
  },
  heroTitle: { fontSize: 26, fontFamily: 'Urbanist-Bold', letterSpacing: 0.2 },
  heroSubtitle: { fontSize: 14, fontFamily: 'Urbanist-Medium', marginTop: 6, lineHeight: 20 },
  countPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 20,
    marginTop: 14,
  },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: BRAND_PRIMARY },
  countText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },

  contestCard: { 
    borderRadius: 22, 
    marginBottom: 20,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    overflow: 'hidden',
  },
  cardBanner: { 
    width: '100%', 
    height: 190, 
    backgroundColor: '#2A2D36',
  },
  cardBannerImg: { 
    borderTopLeftRadius: 22, 
    borderTopRightRadius: 22,
  },
  bannerGradient: { 
    flex: 1, 
    justifyContent: 'flex-end', 
    padding: 16,
  },
  topRow: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,77,103,0.95)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  livePillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFF' },
  livePillText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Bold', letterSpacing: 0.5 },
  endedPill: { backgroundColor: 'rgba(75,85,99,0.95)' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  contestCardEnded: { opacity: 0.6 },
  cardTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold', color: '#FFF' },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
  },
  rewardInfo: { flex: 1 },
  rewardLabel: { fontSize: 11, fontFamily: 'Urbanist-Bold', letterSpacing: 0.6 },
  rewardValueRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  rewardValue: { fontSize: 17, fontFamily: 'Urbanist-Bold', color: '#FFB800' },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 14,
  },
  startBtnText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 15 },
  emptyContainer: { 
    flex: 1, 
    justifyContent: 'center', 
    alignItems: 'center', 
    paddingHorizontal: 40,
    paddingVertical: 80,
  },
  emptyIconCircle: {
    width: 110,
    height: 110,
    borderRadius: 55,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 24,
  },
  emptyText: { fontSize: 20, fontFamily: 'Urbanist-Bold', textAlign: 'center' },
  emptySubText: { fontSize: 14, fontFamily: 'Urbanist-Medium', marginTop: 10, textAlign: 'center', opacity: 0.8, lineHeight: 20 }
});
