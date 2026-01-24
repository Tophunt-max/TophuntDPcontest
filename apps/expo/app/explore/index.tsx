import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, SafeAreaView, useColorScheme, FlatList, TouchableOpacity, ScrollView, ActivityIndicator, Dimensions, TextInput, RefreshControl } from 'react-native';
import { Image } from 'expo-image';
import { BottomNav } from '@/src/components/home/BottomNav';
import { useRouter } from 'expo-router';
import { collection, query, where, onSnapshot } from 'firebase/firestore';
import { firestore } from '@/src/services/firebase/initFirebase';
import { contestService } from '@/src/services/contests/contestService';
import { fetchSuggestedUsers, toggleFollowService } from '@/src/services/users';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData'; 
import { LinearGradient } from 'expo-linear-gradient';
import { useToast } from '@/src/components/toast/ToastProvider';
import { Colors } from '@/constants/theme';
import { getOptimizedMediaUrl } from '@/src/utils/media';
import {
    Search_Icon_New,
    Close_Circle_Icon,
    Camera_Icon,
    Video_Icon,
    People_Icon,
    Movie_Icon,
    Image_Icon,
    Add_Icon,
    Refresh_Icon,
    Trophy_Icon
} from '@/assets/svgs';

const { width } = Dimensions.get('window');
const CARD_MARGIN = 16;

export default function DiscoverScreen() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { data: currentUserProfile } = useProfile(user?.uid || ''); 
  const { addToast } = useToast();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background; 
  const cardBg = isDark ? '#1C1C1E' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subTextColor = isDark ? '#A0A0A5' : '#8A8A8E';
  const primaryColor = '#FF3B30'; 
  const secondaryColor = '#5856D6'; 
  
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [availableContests, setAvailableContests] = useState<any[]>([]);
  const [waitingMatches, setWaitingMatches] = useState<any[]>([]);
  const [suggestedUsers, setSuggestedUsers] = useState<any[]>([]);
  const [followedUsers, setFollowedUsers] = useState<Set<string>>(new Set());
  
  const [searchQuery, setSearchQuery] = useState('');
  const [isFocused, setIsFocused] = useState(false);
  const [activeTab, setActiveTab] = useState<'photo' | 'video' | 'users'>('photo');

  const handleTabChange = (tab: 'photo' | 'video' | 'users') => {
      setActiveTab(tab);
      setSearchQuery('');
  };

  useEffect(() => {
    if (currentUserProfile && currentUserProfile.following) {
      setFollowedUsers(new Set(currentUserProfile.following));
    }
  }, [currentUserProfile]);

  // Real-time listener for Waiting Matches
  useEffect(() => {
    if (authLoading) return;
    const q = query(collection(firestore, 'contestMatches'), where('status', '==', 'waiting_for_opponent'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
        const matches = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        setWaitingMatches(matches);
        setLoading(false);
    });
    return () => unsubscribe();
  }, [authLoading]);

  // Real-time listener for Contest Templates
  useEffect(() => {
      if (authLoading) return;
      const q = query(collection(firestore, 'contests'), where('status', '==', 'live'));
      const unsubscribe = onSnapshot(q, (snapshot) => {
          const contests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
          setAvailableContests(contests);
      });
      return () => unsubscribe();
  }, [authLoading]);

  const fetchStaticData = async () => {
    try {
      const userCoords = currentUserProfile?.coordinates;
      const usersData = await fetchSuggestedUsers(userCoords);
      setSuggestedUsers(usersData);
    } catch (error) { console.error(error); }
  };

  useEffect(() => { if (!authLoading && currentUserProfile) fetchStaticData(); }, [authLoading, currentUserProfile]);
  const onRefresh = async () => { setRefreshing(true); await fetchStaticData(); setRefreshing(false); };

  const handleAction = (action: () => void, redirectUrl?: string) => {
      if (!user) {
          const redirect = encodeURIComponent(redirectUrl || '/explore');
          router.push(`/auth/login?redirect=${redirect}`);
      } else action();
  };

  const handleFollow = async (targetId: string) => {
      handleAction(async () => {
          const isFollowing = followedUsers.has(targetId);
          setFollowedUsers(prev => {
              const newSet = new Set(prev);
              if (isFollowing) newSet.delete(targetId); else newSet.add(targetId);
              return newSet;
          });
          try { await toggleFollowService(targetId); } catch (error) {
            setFollowedUsers(prev => {
                const newSet = new Set(prev);
                if (isFollowing) newSet.add(targetId); else newSet.delete(targetId);
                return newSet;
            });
            addToast("Failed to update follow.", "error");
          }
      });
  };

  const filteredContests = useMemo(() => availableContests.filter(c => {
    const type = (c.type || 'photo').toLowerCase();
    return type === activeTab && (c.title?.toLowerCase().includes(searchQuery.toLowerCase()));
  }), [availableContests, activeTab, searchQuery]);

  const filteredMatches = useMemo(() => waitingMatches.filter(m => {
    const type = (m.type || 'photo').toLowerCase();
    return type === activeTab && (m.title?.toLowerCase().includes(searchQuery.toLowerCase()) || m.userA?.username?.toLowerCase().includes(searchQuery.toLowerCase()));
  }), [waitingMatches, activeTab, searchQuery]);

  const filteredUsers = useMemo(() => suggestedUsers.filter(u => u.name?.toLowerCase().includes(searchQuery.toLowerCase()) || u.username?.toLowerCase().includes(searchQuery.toLowerCase())), [suggestedUsers, searchQuery]);

  const renderContestTemplate = ({ item }: { item: any }) => {
    if (!item || !item.title) return null;
    const joined = item.joinedCount || 0;
    const max = item.maxParticipants || 100;
    const percent = Math.min((joined / max) * 100, 100);
    const isFull = joined >= max;
    return (
      <TouchableOpacity activeOpacity={isFull ? 1 : 0.9} onPress={() => { if (isFull) { addToast("Contest full!", "error"); return; } handleAction(() => router.push({ pathname: (item.type || '').toLowerCase() === 'video' ? '/contest/video' : '/contest/photo', params: { contestId: item.id } })); }} style={[styles.templateCard, { backgroundColor: cardBg }]}>
         <LinearGradient colors={(item.type || '').toLowerCase() === 'video' ? ['#6A11CB', '#2575FC'] : ['#FF416C', '#FF4B2B']} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={styles.templateImage}>{(item.type || '').toLowerCase() === 'video' ? <Movie_Icon width={32} height={32} color="rgba(255,255,255,0.8)" /> : <Image_Icon width={32} height={32} color="rgba(255,255,255,0.8)" />}</LinearGradient>
         <View style={styles.templateInfo}><Text style={[styles.templateTitle, { color: textColor }]} numberOfLines={1}>{item.title}</Text><View style={styles.progressSection}><View style={styles.progressTextRow}><Text style={[styles.progressText, { color: subTextColor }]}>{joined}/{max}</Text>{isFull && <Text style={styles.fullLabel}>FULL</Text>}</View><View style={[styles.progressBarBg, { backgroundColor: isDark ? '#333' : '#EEE' }]}><View style={[styles.progressBarFill, { width: `${percent}%`, backgroundColor: isFull ? '#FF3B30' : '#4CAF50' }]} /></View></View></View>
         {!isFull && <View style={styles.templateAction}><Add_Icon width={20} height={20} color="#FFF" /></View>}
      </TouchableOpacity>
    );
  };

  const renderVersusCard = ({ item }: { item: any }) => {
    const isMyMatch = user && item.userA && item.userA.uid === user.uid;
    const entryFee = item.entryFee ? Math.ceil(item.entryFee / 2) : 0;
    
    // REWARD LOGIC FIX
    const hasProduct = item.rewardType === 'product' || item.rewardType === 'both';
    const hasCoins = item.rewardType !== 'product';
    const coinReward = item.winnerReward || item.winningCoins || item.entryFee || 0;

    return (
      <View style={[styles.matchCardContainer, { backgroundColor: cardBg }]}>
        <View style={styles.matchHeader}>
            <View style={styles.badgeContainer}><View style={[styles.liveIndicator, { backgroundColor: '#FF3B30' }]} /><Text style={[styles.matchStatus, { color: textColor }]}>Waiting for Opponent</Text></View>
            <View style={styles.prizeContainer}>
                <Text style={styles.prizeLabel}>Prize Pool:</Text>
                {hasProduct ? (
                    <View style={styles.inlinePrize}>
                        <Trophy_Icon width={12} height={12} color="#FFD700" />
                        <Text style={[styles.prizeValue, { color: '#FFD700' }]} numberOfLines={1}> {item.prizeDescription}</Text>
                        {hasCoins && <Text style={[styles.prizeValue, { color: '#FFD700' }]}> +{coinReward}</Text>}
                    </View>
                ) : (
                    <Text style={[styles.prizeValue, { color: '#FFD700' }]}>{coinReward} 🪙</Text>
                )}
            </View>
        </View>

        <View style={styles.matchBody}>
             <View style={styles.playerSide}>
                 <Image source={{ uri: getOptimizedMediaUrl(item.userA?.mediaUrl) }} style={styles.mediaPreview} contentFit="cover" />
                 <LinearGradient colors={['transparent', 'rgba(0,0,0,0.8)']} style={styles.mediaOverlay}><View style={styles.userInfo}><Image source={{ uri: getOptimizedMediaUrl(item.userA?.avatar || 'https://via.placeholder.com/50') }} style={styles.miniAvatar} /><Text style={styles.miniUsername} numberOfLines={1}>{item.userA?.username}</Text></View></LinearGradient>
             </View>
             <View style={styles.vsDivider}><LinearGradient colors={['#FF416C', '#FF4B2B']} style={styles.vsCircle}><Text style={styles.vsText}>VS</Text></LinearGradient></View>
             <TouchableOpacity activeOpacity={0.8} style={[styles.playerSide, styles.emptySide, { borderColor: isDark ? '#333' : '#EEE' }]} onPress={() => handleAction(() => { if (isMyMatch) return; router.push({ pathname: '/contest/photo/setup', params: { matchId: item.id, mode: 'join' } }); })}><View style={styles.joinCircle}><Add_Icon width={40} height={40} color={isDark ? '#555' : '#CCC'} /></View><Text style={[styles.joinText, { color: subTextColor }]}>{isMyMatch ? 'Waiting...' : 'Tap to Join'}</Text>{ !isMyMatch && <Text style={[styles.entryFeeText, { color: '#FF3B30' }]}>Pay {entryFee} 🪙</Text> }</TouchableOpacity>
        </View>
        <View style={styles.matchFooter}><Text style={[styles.matchTitle, { color: textColor }]} numberOfLines={1}>{item.title || 'Untitled Battle'}</Text>{!isMyMatch && <TouchableOpacity style={[styles.joinBtn, { backgroundColor: (item.type || '').toLowerCase() === 'video' ? '#5856D6' : '#FF3B30' }]} onPress={() => handleAction(() => router.push({ pathname: '/contest/photo/setup', params: { matchId: item.id, mode: 'join' } }))}><Text style={styles.joinBtnText}>Battle Now</Text></TouchableOpacity>}</View>
      </View>
    );
  };

  const renderUserCard = (item: any) => {
    const isFollowed = followedUsers.has(item.id);
    const isNear = currentUserProfile?.coordinates && item.coords && !item.isCurrentUser;
    return (
    <TouchableOpacity key={item.id} style={[styles.userCard, { backgroundColor: cardBg }]} activeOpacity={0.7} onPress={() => handleAction(() => router.push(`/profile?userId=${item.id}`))}>
        <View style={styles.avatarWrapper}><Image source={{ uri: getOptimizedMediaUrl(item.avatar) }} style={styles.userAvatar} />{isNear && <View style={styles.nearBadge}><Text style={styles.nearBadgeText}>📍 Near You</Text></View>}</View>
        <View style={styles.userDetails}><Text style={[styles.userName, { color: textColor }]} numberOfLines={1}>{item.name}</Text><Text style={[styles.userHandle, { color: subTextColor }]} numberOfLines={1}>@{item.username}</Text></View>
        <TouchableOpacity style={[styles.followBtn, { backgroundColor: isFollowed ? (isDark ? '#333' : '#EEE') : '#FF3B30' }]} onPress={() => handleFollow(item.id)}><Text style={[styles.followText, { color: isFollowed ? textColor : '#FFF' }]}>{isFollowed ? 'Following' : 'Follow'}</Text></TouchableOpacity>
    </TouchableOpacity>
  )};

  const renderTabs = () => (
    <View style={styles.tabSection}>
        <View style={[styles.pillContainer, { backgroundColor: isDark ? '#1C1C1E' : '#F2F2F7' }]}>
            <TouchableOpacity 
                style={[styles.pill, activeTab === 'photo' && styles.activePill]} 
                onPress={() => handleTabChange('photo')}
            >
                <Image_Icon width={18} height={18} color={activeTab === 'photo' ? '#FFF' : subTextColor} style={{ marginRight: 6 }} />
                <Text style={[styles.pillText, { color: activeTab === 'photo' ? '#FFF' : subTextColor }]}>Photos</Text>
            </TouchableOpacity>
            
            <TouchableOpacity 
                style={[styles.pill, activeTab === 'video' && styles.activePillVideo]} 
                onPress={() => handleTabChange('video')}
            >
                <Video_Icon width={18} height={18} color={activeTab === 'video' ? '#FFF' : subTextColor} style={{ marginRight: 6 }} />
                <Text style={[styles.pillText, { color: activeTab === 'video' ? '#FFF' : subTextColor }]}>Videos</Text>
            </TouchableOpacity>

            <TouchableOpacity 
                style={[styles.pill, activeTab === 'users' && styles.activePillUsers]} 
                onPress={() => handleTabChange('users')}
            >
                <People_Icon width={18} height={18} color={activeTab === 'users' ? '#FFF' : subTextColor} style={{ marginRight: 6 }} />
                <Text style={[styles.pillText, { color: activeTab === 'users' ? '#FFF' : subTextColor }]}>Users</Text>
            </TouchableOpacity>
        </View>
    </View>
  );

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingBottom: 100 }} stickyHeaderIndices={[1]} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#FF3B30']} />}>
            <View style={styles.headerContainer}><View style={styles.headerTop}><Text style={[styles.headerTitle, { color: textColor }]}>Explore Arena</Text></View><View style={[styles.searchBox, { backgroundColor: isFocused ? (isDark ? '#262933' : '#FFEBEE') : (isDark ? '#1C1C1E' : '#FAFAFA'), borderColor: isFocused ? '#FF4D67' : (isDark ? '#35383F' : '#eee') }]}><Search_Icon_New width={20} height={20} color={isFocused ? '#FF4D67' : subTextColor} style={{ marginRight: 10 }} /><TextInput style={[styles.searchInput, { color: textColor }]} placeholder={`Search ${activeTab === 'users' ? 'people' : activeTab + ' contests'}...`} placeholderTextColor={subTextColor} value={searchQuery} onChangeText={setSearchQuery} onFocus={() => setIsFocused(true)} onBlur={() => setIsFocused(false)} returnKeyType="search" />{searchQuery.length > 0 && <TouchableOpacity onPress={() => setSearchQuery('')}><Close_Circle_Icon width={18} height={18} color={subTextColor} /></TouchableOpacity>}</View></View>
            {renderTabs()}
            {loading ? (<View style={{ height: 300, justifyContent: 'center' }}><ActivityIndicator size="large" color="#FF3B30" /></View>) : (
                <View style={styles.contentSection}>
                    {activeTab === 'users' ? (
                        <View style={{ paddingHorizontal: CARD_MARGIN }}><View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: textColor }]}>Discover People</Text></View>{filteredUsers.length === 0 ? (<View style={styles.emptyState}><People_Icon width={48} height={48} color={subTextColor} /><Text style={{ color: subTextColor, textAlign:'center', marginTop: 10 }}>No users found.</Text></View>) : (filteredUsers.map((item) => renderUserCard({ ...item, isCurrentUser: item.id === user?.uid })))}</View>
                    ) : (
                        <>
                            <View style={styles.sectionHeader}><Text style={[styles.sectionTitle, { color: textColor }]}>Start a New Battle</Text></View>
                            <FlatList horizontal data={filteredContests} renderItem={renderContestTemplate} keyExtractor={(item) => item.id} showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: CARD_MARGIN, paddingBottom: 20 }} ListEmptyComponent={<Text style={{marginLeft: 16, color: subTextColor}}>No templates available.</Text>} />
                            <View style={styles.sectionHeader}><View style={{flexDirection:'row', alignItems:'center', gap: 6}}><Text style={[styles.sectionTitle, { color: textColor }]}>Live Arena</Text><View style={{backgroundColor: '#FF3B30', borderRadius: 4, paddingHorizontal: 4}}><Text style={{color:'#FFF', fontSize: 10, fontWeight:'bold'}}>LIVE</Text></View></View><TouchableOpacity onPress={onRefresh}><Refresh_Icon width={20} height={20} color={subTextColor} /></TouchableOpacity></View>
                            <View style={{ paddingHorizontal: CARD_MARGIN }}>{filteredMatches.length === 0 ? (<View style={[styles.emptyState, { borderColor: isDark ? '#333' : '#EEE' }]}><People_Icon width={48} height={48} color={subTextColor} style={{opacity: 0.5}} /><Text style={[styles.emptyText, { color: subTextColor }]}>No active battles found.</Text></View>) : (filteredMatches.map((item) => (<View key={item.id} style={{ marginBottom: 16 }}>{renderVersusCard({ item })}</View>)))}</View>
                        </>
                    )}
                </View>
            )}
        </ScrollView>
        <BottomNav backgroundColor={backgroundColor} isDark={isDark} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  headerContainer: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: 10 },
  headerTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 5 },
  headerTitle: { fontSize: 32, fontFamily: 'Urbanist-Bold' },
  searchBox: { flexDirection: 'row', alignItems: 'center', height: 56, borderRadius: 16, paddingHorizontal: 16, borderWidht: 1, borderColor: '#eee' },
  searchInput: { flex: 1, fontSize: 16, fontFamily: 'Urbanist-Medium' },
  tabSection: { paddingHorizontal: 20, paddingBottom: 10, backgroundColor: 'transparent', zIndex: 10 },
  pillContainer: { flexDirection: 'row', padding: 4, borderRadius: 20 },
  pill: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', paddingVertical: 10, borderRadius: 16 },
  activePill: { backgroundColor: '#FF3B30' },
  activePillVideo: { backgroundColor: '#5856D6' },
  activePillUsers: { backgroundColor: '#32D74B' },
  pillText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  contentSection: { marginTop: 10 },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 },
  sectionTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  templateCard: { width: 150, minHeight: 180, borderRadius: 24, marginRight: 12, padding: 12, shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 4 },
  templateImage: { width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  templateInfo: { flex: 1 },
  templateTitle: { fontSize: 15, fontFamily: 'Urbanist-Bold', marginBottom: 8 },
  progressSection: { marginTop: 4 },
  progressTextRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  progressText: { fontSize: 10, fontFamily: 'Urbanist-Bold' },
  fullLabel: { fontSize: 9, fontFamily: 'Urbanist-Black', color: '#FF3B30' },
  progressBarBg: { height: 4, borderRadius: 2, overflow: 'hidden' },
  progressBarFill: { height: '100%', borderRadius: 2 },
  templateAction: { position: 'absolute', bottom: 12, right: 12, backgroundColor: '#121212', borderRadius: 12, width: 28, height: 28, justifyContent: 'center', alignItems: 'center' },
  matchCardContainer: { borderRadius: 24, overflow: 'hidden', marginBottom: 16 },
  matchHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  badgeContainer: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  liveIndicator: { width: 8, height: 8, borderRadius: 4 },
  matchStatus: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  prizeContainer: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  prizeLabel: { fontSize: 12, fontFamily: 'Urbanist-Medium', color: '#888' },
  prizeValue: { fontSize: 14, fontFamily: 'Urbanist-Black' },
  inlinePrize: { flexDirection: 'row', alignItems: 'center' },
  matchBody: { flexDirection: 'row', height: 150 },
  playerSide: { flex: 1, position: 'relative' },
  mediaPreview: { width: '100%', height: '100%' },
  mediaOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'flex-end', padding: 10 },
  userInfo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  miniAvatar: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: '#FFF' },
  miniUsername: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Bold' },
  vsDivider: { width: 30, position: 'absolute', left: '50%', marginLeft: -15, top: '40%', zIndex: 10 },
  vsCircle: { width: 30, height: 30, borderRadius: 15, justifyContent: 'center', alignItems: 'center', borderWidth: 2, borderColor: '#FFF' },
  vsText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Black' },
  emptySide: { borderLeftWidth: 1, borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center' },
  joinCircle: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderStyle: 'dashed', borderColor: '#CCC', justifyContent: 'center', alignItems: 'center', marginBottom: 4 },
  joinText: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  entryFeeText: { fontSize: 10, fontFamily: 'Urbanist-Bold' },
  matchFooter: { padding: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  matchTitle: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  joinBtn: { paddingVertical: 6, paddingHorizontal: 12, borderRadius: 10 },
  joinBtnText: { color: '#FFF', fontSize: 11, fontFamily: 'Urbanist-Bold' },
  userCard: { flexDirection: 'row', alignItems: 'center', padding: 12, borderRadius: 20, marginBottom: 12 },
  avatarWrapper: { position: 'relative' },
  userAvatar: { width: 52, height: 52, borderRadius: 26, marginRight: 12 },
  nearBadge: { position: 'absolute', bottom: -4, left: -4, backgroundColor: '#32D74B', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, borderColor: '#FFF' },
  nearBadgeText: { color: '#FFF', fontSize: 7, fontFamily: 'Urbanist-Bold' },
  userDetails: { flex: 1 },
  userName: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  userHandle: { fontSize: 14, fontFamily: 'Urbanist-Medium' },
  followBtn: { paddingVertical: 8, paddingHorizontal: 16, borderRadius: 20 },
  followText: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  emptyState: { padding: 40, alignItems: 'center' },
  emptyText: { marginTop: 10, fontSize: 14 },
});
