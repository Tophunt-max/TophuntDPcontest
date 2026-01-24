import React, { useState, useEffect, useMemo } from 'react';
import { View, StyleSheet, SafeAreaView, Text, Button, ActivityIndicator, ScrollView, useColorScheme, TouchableOpacity, FlatList } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useAuth } from '@/src/services/auth';
import { useProfile, useUserPosts, useToggleFollow, useUserBookmarks } from '@/src/hooks/useProfileData';
import ProfileHeader from '@/src/components/profile/ProfileHeader';
import Highlights from '@/src/components/profile/Highlights';
import ProfileTabs from '@/src/components/profile/ProfileTabs';
import PostGrid from '@/src/components/profile/PostGrid';
import { ProfileHeaderSkeleton, PostGridSkeleton } from '@/src/components/profile/ProfileSkeleton';
import { WalletCard } from '@/src/components/profile/WalletCard';
import { BottomNav } from '@/src/components/home/BottomNav';
import { notificationService } from '@/src/services/notifications/notificationService';
import { Colors } from '@/constants/theme';
import { PostCard } from '@/src/components/home/PostCard';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { firestore } from '@/src/services/firebase/initFirebase';
import { ClaimPrizeModal } from '@/src/components/modals/ClaimPrizeModal';
import { StatsDetailModal } from '@/src/components/modals/StatsDetailModal';
import { Trophy_Icon } from '@/assets/svgs';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

const ProfilePage = () => {
  const router = useRouter();
  const { user: currentUser, loading: authLoading } = useAuth();
  const params = useLocalSearchParams();
  const userIdParam = params.userId as string | undefined;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  
  const [targetId, setTargetId] = useState<string | null>(null);
  const [isRedirecting, setIsRedirecting] = useState(false);

  useEffect(() => {
    if (!authLoading) {
        if (!currentUser) {
            setIsRedirecting(true);
            const encodedRedirect = encodeURIComponent(userIdParam ? `/profile?userId=${userIdParam}` : '/profile');
            router.replace(`/auth/login?redirect=${encodedRedirect}`);
            return;
        }
        const id = userIdParam || currentUser?.uid;
        if (id) {
            setTargetId(id);
            if (id !== currentUser?.uid) notificationService.notifyProfileVisit(id);
        }
    }
  }, [authLoading, userIdParam, currentUser]);

  if (authLoading || isRedirecting || (!targetId && !authLoading)) {
    return <SafeAreaView style={[styles.container, { backgroundColor }]}><ScrollView><ProfileHeaderSkeleton /><PostGridSkeleton /></ScrollView><BottomNav backgroundColor={backgroundColor} isDark={isDark} /></SafeAreaView>;
  }

  return <ProfileContent targetUserId={targetId!} />;
};

const ProfileContent = ({ targetUserId }: { targetUserId: string }) => {
  const router = useRouter();
  const { user: currentUser } = useAuth();
  const isOwnProfile = currentUser?.uid === targetUserId;
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const subTextColor = isDark ? '#A0A0A5' : '#8A8A8E';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;

  const { data: profile, isLoading: profileLoading, refetch: refetchProfile } = useProfile(targetUserId);
  const { data: myProfile } = useProfile(currentUser?.uid || '');

  const [pendingPrizes, setPendingPrizes] = useState<any[]>([]);
  const [selectedPrize, setSelectedPrize] = useState<any | null>(null);
  const [statsModalType, setStatsModalType] = useState<'wins' | 'battles' | 'votes' | null>(null);

  useEffect(() => {
    if (!isOwnProfile) return;
    const q = query(collection(firestore, 'contestMatches'), where('winnerId', '==', targetUserId), where('isPrizeClaimed', '==', false));
    const unsubscribe = onSnapshot(q, (snapshot) => {
        const prizes = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter((p: any) => p.rewardType === 'product' || p.rewardType === 'both');
        setPendingPrizes(prizes);
    });
    return () => unsubscribe();
  }, [isOwnProfile, targetUserId]);

  const { data: postsData, isLoading: postsLoading, fetchNextPage, hasNextPage, refetch: refetchPosts, isRefetching } = useUserPosts(targetUserId);
  const { data: bookmarks, isLoading: bookmarksLoading, refetch: refetchBookmarks } = useUserBookmarks(targetUserId);
  const { mutate: toggleFollow } = useToggleFollow();
  const [activeTab, setActiveTab] = useState<'posts' | 'reels' | 'tags'>('posts');

  const isFollowing = useMemo(() => myProfile?.following?.includes(targetUserId) || false, [myProfile, targetUserId]);
  const handleRefresh = async () => { await Promise.all([refetchProfile(), refetchPosts(), refetchBookmarks()]); };

  if (profileLoading && !profile) {
    return <SafeAreaView style={[styles.container, { backgroundColor }]}><ScrollView><ProfileHeaderSkeleton /><PostGridSkeleton /></ScrollView><BottomNav backgroundColor={backgroundColor} isDark={isDark} /></SafeAreaView>;
  }

  const posts = postsData?.pages.flatMap(page => page.posts) || [];

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <PostGrid
        posts={activeTab === 'posts' ? posts : []}
        onLoadMore={() => hasNextPage && fetchNextPage()}
        isLoading={postsLoading || (activeTab === 'tags' && bookmarksLoading)}
        refreshing={isRefetching}
        onRefresh={handleRefresh}
        ListHeaderComponent={
          <>
            <ProfileHeader user={profile!} isOwnProfile={isOwnProfile} onToggleFollow={() => !isOwnProfile && toggleFollow(targetUserId)} isFollowing={isFollowing} onRefresh={handleRefresh} />

            {isOwnProfile && pendingPrizes.length > 0 && (
                <TouchableOpacity activeOpacity={0.9} onPress={() => setSelectedPrize(pendingPrizes[0])} style={styles.claimBannerContainer}>
                    <LinearGradient colors={['#FFD700', '#FFA500']} start={{x:0, y:0}} end={{x:1, y:0}} style={styles.claimBanner}>
                        <View style={styles.claimIconCircle}><Trophy_Icon width={20} height={20} color="#FF4D67" /></View>
                        <View style={{flex: 1, marginLeft: 12}}><Text style={styles.claimTitle}>You have prizes to Claim! 🎁</Text><Text style={styles.claimSubtitle}>Tap to enter shipping details</Text></View>
                        <Ionicons name="chevron-forward" size={20} color="#FFF" />
                    </LinearGradient>
                </TouchableOpacity>
            )}

            {isOwnProfile && (
                <WalletCard 
                    Dpcoin={profile?.Dpcoin || 0} 
                    stats={profile?.stats || { contestsJoined: 0, wins: 0 }} 
                    onPress={() => router.push('/wallet')}
                    onStatPress={(type) => setStatsModalType(type)}
                />
            )}
            
            <Highlights userId={targetUserId} />
            <ProfileTabs activeTab={activeTab} onChangeTab={setActiveTab} isPrivate={profile?.isPrivate} />
            
            {activeTab === 'tags' && (
              <View style={{ paddingBottom: 20 }}>
                {bookmarks?.map((match: any) => <PostCard key={match.id} item={match} isDark={isDark} />)}
                {(!bookmarks || bookmarks.length === 0) && !bookmarksLoading && <View style={{ alignItems: 'center', marginTop: 40 }}><Text style={{ color: subTextColor, fontFamily: 'Urbanist-Medium' }}>No bookmarked battles yet.</Text></View>}
              </View>
            )}
          </>
        }
      />
      
      {/* STATS DETAIL MODAL */}
      <StatsDetailModal 
        visible={!!statsModalType} 
        onClose={() => setStatsModalType(null)} 
        type={statsModalType} 
        userId={targetUserId}
        onClaimPress={(prize) => {
            setStatsModalType(null);
            setSelectedPrize(prize);
        }}
      />

      {/* PRIZE CLAIM MODAL */}
      <ClaimPrizeModal 
        visible={!!selectedPrize} 
        onClose={() => setSelectedPrize(null)} 
        matchId={selectedPrize?.id || ''} 
        prizeName={selectedPrize?.prizeDescription || 'Contest Reward'} 
      />

      <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  errorText: { fontSize: 18, fontWeight: 'bold', marginBottom: 5, textAlign: 'center' },
  claimBannerContainer: { paddingHorizontal: 20, marginBottom: 15 },
  claimBanner: { flexDirection: 'row', alignItems: 'center', padding: 16, borderRadius: 20, shadowColor: '#FFD700', shadowOpacity: 0.3, shadowRadius: 10, elevation: 5 },
  claimIconCircle: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#FFF', justifyContent: 'center', alignItems: 'center' },
  claimTitle: { color: '#FFF', fontSize: 15, fontFamily: 'Urbanist-Bold' },
  claimSubtitle: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontFamily: 'Urbanist-Medium' }
});

export default ProfilePage;
