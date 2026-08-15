import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, SafeAreaView, useColorScheme, FlatList, Image, TouchableOpacity, ScrollView, ActivityIndicator, Dimensions, TextInput, Animated as RNAnimated } from 'react-native';
import { BottomNav } from '@/src/components/home/BottomNav';
import { Ionicons, MaterialCommunityIcons, FontAwesome5 } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { contestService } from '@/src/services/contests/contestService';
import { fetchSuggestedUsers, toggleFollowService } from '@/src/services/users';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData';
import { LinearGradient } from 'expo-linear-gradient';
import { useToast } from '@/src/components/toast/ToastProvider';
import { Colors } from '@/constants/theme';
import FeaturedGrid from '@/src/components/home/FeaturedGrid';

const { width } = Dimensions.get('window');
const CARD_MARGIN = 20;
const TAB_CONTAINER_PADDING = 4;
const TAB_INNER_WIDTH = width - CARD_MARGIN * 2 - TAB_CONTAINER_PADDING * 2;
const TAB_WIDTH = TAB_INNER_WIDTH / 3;

type TabKey = 'photo' | 'video' | 'users';

const TABS: { key: TabKey; label: string; icon: keyof typeof Ionicons.glyphMap; color: string }[] = [
  { key: 'photo', label: 'Photos', icon: 'camera', color: '#FF4D67' },
  { key: 'video', label: 'Videos', icon: 'videocam', color: '#6A5AE0' },
  { key: 'users', label: 'People', icon: 'people', color: '#22C55E' },
];

export default function DiscoverScreen() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { data: currentUserProfile } = useProfile(user?.uid || '');
  const { addToast } = useToast();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  // --- Palette (aligned to app theme) ---
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const cardBg = isDark ? '#17181F' : '#FFFFFF';
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subTextColor = isDark ? '#8E9099' : '#8A8A8E';
  const inputBg = isDark ? '#1C1D25' : '#FFFFFF';
  const borderColor = isDark ? '#262A35' : '#EEEEEE';

  const [loading, setLoading] = useState(true);
  const [availableContests, setAvailableContests] = useState<any[]>([]);
  const [waitingMatches, setWaitingMatches] = useState<any[]>([]);
  const [suggestedUsers, setSuggestedUsers] = useState<any[]>([]);
  const [followedUsers, setFollowedUsers] = useState<Set<string>>(new Set());

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('photo');

  const activeColor = TABS.find(t => t.key === activeTab)?.color || '#FF4D67';

  // Animated sliding tab indicator
  const indicatorX = useRef(new RNAnimated.Value(0)).current;

  const switchTab = (key: TabKey) => {
    const index = TABS.findIndex(t => t.key === key);
    setActiveTab(key);
    RNAnimated.spring(indicatorX, {
      toValue: index * TAB_WIDTH,
      useNativeDriver: true,
      friction: 9,
      tension: 80,
    }).start();
  };

  useEffect(() => {
    if (currentUserProfile && currentUserProfile.following) {
      setFollowedUsers(new Set(currentUserProfile.following));
    }
  }, [currentUserProfile]);

  useEffect(() => {
    if (!authLoading) {
      fetchExploreData();
    }
  }, [authLoading, user]);

  const fetchExploreData = async () => {
    setLoading(true);
    try {
      const [contests, waiting, usersData] = await Promise.all([
        contestService.getAvailableContests(),
        contestService.getWaitingMatches(),
        fetchSuggestedUsers(),
      ]);
      setAvailableContests(contests);
      setWaitingMatches(waiting);
      setSuggestedUsers(usersData);
    } catch (error) {
      console.error('Explore error:', error);
      addToast('Failed to load explore data', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleAction = (action: () => void) => {
    if (!user) {
      const redirect = encodeURIComponent('/explore');
      router.push(`/auth/login?redirect=${redirect}`);
    } else {
      action();
    }
  };

  const handleFollow = async (targetId: string) => {
    handleAction(async () => {
      const isFollowing = followedUsers.has(targetId);
      setFollowedUsers(prev => {
        const newSet = new Set(prev);
        if (isFollowing) newSet.delete(targetId);
        else newSet.add(targetId);
        return newSet;
      });

      try {
        await toggleFollowService(targetId);
      } catch (error) {
        setFollowedUsers(prev => {
          const newSet = new Set(prev);
          if (isFollowing) newSet.add(targetId);
          else newSet.delete(targetId);
          return newSet;
        });
        addToast('Failed to update follow status.', 'error');
      }
    });
  };

  // --- Filtering ---
  const filteredContests = availableContests.filter(c =>
    (c.type === activeTab || (!c.type && activeTab === 'photo')) &&
    (c.title?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredMatches = waitingMatches.filter(m =>
    (m.type === activeTab || (!m.type && activeTab === 'photo')) &&
    (m.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      m.userA?.username?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const filteredUsers = suggestedUsers.filter(u =>
    u.name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
    u.username?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  // ------------------------------------------------------------------
  // RENDER: HEADER
  // ------------------------------------------------------------------
  const renderHeader = () => (
    <View>
      {/* Gradient hero */}
      <LinearGradient
        colors={isDark ? ['#2A0E17', '#17181F', backgroundColor] : ['#FFE9ED', '#FFF5F6', backgroundColor]}
        start={{ x: 0, y: 0 }}
        end={{ x: 0, y: 1 }}
        style={styles.hero}
      >
        <View style={styles.headerTop}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.greeting, { color: subTextColor }]}>Discover & Compete</Text>
            <Text style={[styles.headerTitle, { color: textColor }]}>Explore Arena</Text>
          </View>
          <TouchableOpacity
            activeOpacity={0.85}
            style={styles.leaderboardBtn}
            onPress={() => handleAction(() => router.push('/explore/leaderboard'))}
          >
            <LinearGradient
              colors={['#FFB300', '#FF7A00']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.leaderboardGradient}
            >
              <Ionicons name="trophy" size={20} color="#FFF" />
            </LinearGradient>
          </TouchableOpacity>
        </View>

        {/* Search */}
        <View style={[styles.searchBox, { backgroundColor: inputBg, borderColor, borderWidth: isDark ? 0 : 1 }]}>
          <Ionicons name="search" size={20} color={activeColor} style={{ marginRight: 10 }} />
          <TextInput
            style={[styles.searchInput, { color: textColor }]}
            placeholder={`Search ${activeTab === 'users' ? 'people' : activeTab + ' contests'}...`}
            placeholderTextColor={subTextColor}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color={subTextColor} />
            </TouchableOpacity>
          )}
        </View>
      </LinearGradient>

      {/* Featured shortcuts */}
      <View style={{ marginTop: 4 }}>
        <FeaturedGrid />
      </View>
    </View>
  );

  // ------------------------------------------------------------------
  // RENDER: ANIMATED SEGMENTED TABS
  // ------------------------------------------------------------------
  const renderTabs = () => (
    <View style={[styles.tabSection, { backgroundColor }]}>
      <View style={[styles.pillContainer, { backgroundColor: isDark ? '#1C1D25' : '#F0F1F5' }]}>
        <RNAnimated.View
          style={[
            styles.tabIndicator,
            {
              width: TAB_WIDTH,
              backgroundColor: activeColor,
              transform: [{ translateX: indicatorX }],
              shadowColor: activeColor,
            },
          ]}
        />
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          return (
            <TouchableOpacity
              key={tab.key}
              style={styles.pill}
              onPress={() => switchTab(tab.key)}
              activeOpacity={0.8}
            >
              <Ionicons
                name={tab.icon}
                size={16}
                color={isActive ? '#FFF' : subTextColor}
                style={{ marginRight: 6 }}
              />
              <Text style={[styles.pillText, { color: isActive ? '#FFF' : subTextColor }]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );

  // ------------------------------------------------------------------
  // RENDER: CREATE TEMPLATE CARD
  // ------------------------------------------------------------------
  const renderContestTemplate = ({ item }: { item: any }) => {
    if (!item || !item.title) return null;
    const isVideo = item.type === 'video';
    return (
      <TouchableOpacity
        activeOpacity={0.9}
        onPress={() => handleAction(() => {
          router.push({
            pathname: isVideo ? '/contest/video' : '/contest/photo',
            params: { contestId: item.id },
          });
        })}
        style={styles.templateCard}
      >
        <LinearGradient
          colors={isVideo ? ['#6A5AE0', '#8B5CF6'] : ['#FF4D67', '#FF7A45']}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.templateGradient}
        >
          <MaterialCommunityIcons
            name={isVideo ? 'movie-open-star' : 'image-filter-hdr'}
            size={64}
            color="rgba(255,255,255,0.15)"
            style={styles.templateWatermark}
          />
          <View style={styles.templateIconCircle}>
            <MaterialCommunityIcons name={isVideo ? 'movie-open-play' : 'image-multiple'} size={22} color="#FFF" />
          </View>
          <View style={{ flex: 1, justifyContent: 'flex-end' }}>
            <Text style={styles.templateTitle} numberOfLines={2}>{item.title}</Text>
            <View style={styles.templateCta}>
              <Text style={styles.templateCtaText}>Start Battle</Text>
              <Ionicons name="arrow-forward" size={13} color="#FFF" />
            </View>
          </View>
        </LinearGradient>
      </TouchableOpacity>
    );
  };

  // ------------------------------------------------------------------
  // RENDER: VERSUS MATCH CARD
  // ------------------------------------------------------------------
  const renderVersusCard = ({ item }: { item: any }) => {
    const isMyMatch = user && item.userA && item.userA.uid === user.uid;
    const entryFee = item.entryFee ? item.entryFee / 2 : 0;
    const prize = item.entryFee || 0;
    const isVideo = item.type === 'video';

    return (
      <View style={[styles.matchCardContainer, { backgroundColor: cardBg, borderColor }]}>
        <View style={[styles.matchHeader, { borderBottomColor: borderColor }]}>
          <View style={styles.badgeContainer}>
            <View style={styles.liveDot} />
            <Text style={[styles.matchStatus, { color: textColor }]}>Waiting for Opponent</Text>
          </View>
          <View style={[styles.prizePill, { flexDirection: 'row', alignItems: 'center', gap: 5 }]}>
            <FontAwesome5 name="coins" size={11} color="#FFB300" />
            <Text style={styles.prizeValue}>{prize}</Text>
          </View>
        </View>

        <View style={styles.matchBody}>
          <View style={styles.playerSide}>
            <Image source={{ uri: item.userA?.mediaUrl }} style={styles.mediaPreview} />
            <LinearGradient colors={['transparent', 'rgba(0,0,0,0.85)']} style={styles.mediaOverlay}>
              <View style={styles.userInfo}>
                <Image source={{ uri: item.userA?.avatar || 'https://via.placeholder.com/50' }} style={styles.miniAvatar} />
                <Text style={styles.miniUsername} numberOfLines={1}>{item.userA?.username}</Text>
              </View>
            </LinearGradient>
          </View>

          <View style={styles.vsDivider}>
            <LinearGradient colors={isVideo ? ['#6A5AE0', '#8B5CF6'] : ['#FF4D67', '#FF7A45']} style={styles.vsCircle}>
              <Text style={styles.vsText}>VS</Text>
            </LinearGradient>
          </View>

          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.playerSide, styles.emptySide, { borderColor: isDark ? '#2C2F3A' : '#EEE' }]}
            onPress={() => handleAction(() => {
              if (isMyMatch) {
                addToast('This is your own contest! Wait for someone to join.', 'info');
                return;
              }
              router.push({
                pathname: isVideo ? '/contest/video/setup' : '/contest/photo/setup',
                params: { matchId: item.id, mode: 'join' },
              });
            })}
          >
            <View style={[styles.joinCircle, { borderColor: activeColor }]}>
              <Ionicons name="add" size={30} color={activeColor} />
            </View>
            <Text style={[styles.joinText, { color: subTextColor }]}>{isMyMatch ? 'Waiting...' : 'Tap to Join'}</Text>
            {!isMyMatch && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 }}>
                <Text style={[styles.entryFeeText, { color: activeColor, marginTop: 0 }]}>Pay {entryFee}</Text>
                <FontAwesome5 name="coins" size={11} color={activeColor} />
              </View>
            )}
          </TouchableOpacity>
        </View>

        <View style={[styles.matchFooter, { borderTopColor: borderColor }]}>
          <Text style={[styles.matchTitle, { color: textColor }]} numberOfLines={1}>{item.title || 'Untitled Battle'}</Text>
          {!isMyMatch && (
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => handleAction(() => {
                router.push({
                  pathname: isVideo ? '/contest/video/setup' : '/contest/photo/setup',
                  params: { matchId: item.id, mode: 'join' },
                });
              })}
            >
              <LinearGradient
                colors={isVideo ? ['#6A5AE0', '#8B5CF6'] : ['#FF4D67', '#FF7A45']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0 }}
                style={styles.joinBtn}
              >
                <Text style={styles.joinBtnText}>Battle Now</Text>
              </LinearGradient>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  };

  // ------------------------------------------------------------------
  // RENDER: USER CARD
  // ------------------------------------------------------------------
  const renderUserCard = ({ item }: { item: any }) => {
    const isFollowed = followedUsers.has(item.id);
    return (
      <TouchableOpacity
        style={[styles.userCard, { backgroundColor: cardBg, borderColor }]}
        activeOpacity={0.8}
        onPress={() => handleAction(() => router.push(`/profile?userId=${item.id}`))}
      >
        <View style={styles.avatarRing}>
          <Image source={{ uri: item.avatar }} style={styles.userAvatar} />
        </View>
        <View style={styles.userDetails}>
          <Text style={[styles.userName, { color: textColor }]} numberOfLines={1}>{item.name}</Text>
          <Text style={[styles.userHandle, { color: subTextColor }]} numberOfLines={1}>@{item.username}</Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.85}
          style={[
            styles.followBtn,
            isFollowed
              ? { backgroundColor: isDark ? '#262A35' : '#F0F1F5' }
              : { backgroundColor: '#22C55E' },
          ]}
          onPress={() => handleFollow(item.id)}
        >
          {!isFollowed && <Ionicons name="add" size={15} color="#FFF" style={{ marginRight: 2 }} />}
          <Text style={[styles.followText, { color: isFollowed ? textColor : '#FFF' }]}>
            {isFollowed ? 'Following' : 'Follow'}
          </Text>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  const sectionCount =
    activeTab === 'users' ? filteredUsers.length : filteredMatches.length;

  // ------------------------------------------------------------------
  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 110 }}
        stickyHeaderIndices={[1]}
      >
        {renderHeader()}

        {/* Sticky Tabs */}
        {renderTabs()}

        {loading ? (
          <View style={{ height: 320, justifyContent: 'center' }}>
            <ActivityIndicator size="large" color={activeColor} />
          </View>
        ) : (
          <View style={styles.contentSection}>
            {activeTab === 'users' ? (
              <View style={{ paddingHorizontal: CARD_MARGIN }}>
                <View style={styles.sectionHeader}>
                  <Text style={[styles.sectionTitle, { color: textColor }]}>Suggested People</Text>
                  {sectionCount > 0 && (
                    <Text style={[styles.countPill, { color: subTextColor, backgroundColor: isDark ? '#1C1D25' : '#F0F1F5' }]}>
                      {sectionCount}
                    </Text>
                  )}
                </View>
                {filteredUsers.length === 0 ? (
                  <View style={[styles.emptyState, { borderColor }]}>
                    <Ionicons name="people-outline" size={44} color={subTextColor} style={{ opacity: 0.5 }} />
                    <Text style={[styles.emptyText, { color: subTextColor }]}>No people found.</Text>
                  </View>
                ) : (
                  filteredUsers.map(item => (
                    <View key={item.id} style={{ marginBottom: 12 }}>
                      {renderUserCard({ item })}
                    </View>
                  ))
                )}
              </View>
            ) : (
              <>
                {/* Create Section */}
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionTitleRow}>
                    <MaterialCommunityIcons name="rocket-launch" size={18} color={activeColor} />
                    <Text style={[styles.sectionTitle, { color: textColor }]}>Start a New Battle</Text>
                  </View>
                </View>

                <FlatList
                  horizontal
                  data={filteredContests}
                  renderItem={renderContestTemplate}
                  keyExtractor={item => item.id}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ paddingHorizontal: CARD_MARGIN, paddingBottom: 24 }}
                  ListEmptyComponent={
                    <Text style={{ marginLeft: 4, color: subTextColor, fontFamily: 'Urbanist-Medium' }}>
                      No templates available.
                    </Text>
                  }
                />

                {/* Join Section */}
                <View style={styles.sectionHeader}>
                  <View style={styles.sectionTitleRow}>
                    <View style={styles.liveBadge}>
                      <View style={styles.liveDotSmall} />
                      <Text style={styles.liveBadgeText}>LIVE</Text>
                    </View>
                    <Text style={[styles.sectionTitle, { color: textColor }]}>Live Arena</Text>
                  </View>
                  <TouchableOpacity onPress={fetchExploreData} style={styles.refreshBtn}>
                    <Ionicons name="refresh" size={18} color={activeColor} />
                  </TouchableOpacity>
                </View>

                <View style={{ paddingHorizontal: CARD_MARGIN }}>
                  {filteredMatches.length === 0 ? (
                    <View style={[styles.emptyState, { borderColor }]}>
                      <MaterialCommunityIcons name="sword-cross" size={48} color={subTextColor} style={{ opacity: 0.5 }} />
                      <Text style={[styles.emptyText, { color: subTextColor }]}>No active battles found.</Text>
                      <TouchableOpacity onPress={() => handleAction(() => router.push('/explore/leaderboard'))}>
                        <Text style={{ color: activeColor, fontFamily: 'Urbanist-Bold', marginTop: 10 }}>Check Leaderboard</Text>
                      </TouchableOpacity>
                    </View>
                  ) : (
                    filteredMatches.map(item => (
                      <View key={item.id} style={{ marginBottom: 16 }}>
                        {renderVersusCard({ item })}
                      </View>
                    ))
                  )}
                </View>
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

  // Hero
  hero: {
    paddingHorizontal: CARD_MARGIN,
    paddingTop: 12,
    paddingBottom: 18,
  },
  headerTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
  },
  greeting: { fontSize: 14, fontFamily: 'Urbanist-SemiBold', marginBottom: 2 },
  headerTitle: { fontSize: 30, fontFamily: 'Urbanist-Bold', letterSpacing: -0.5 },
  leaderboardBtn: {
    borderRadius: 16,
    shadowColor: '#FF7A00',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 8,
    elevation: 6,
  },
  leaderboardGradient: {
    width: 46,
    height: 46,
    borderRadius: 16,
    justifyContent: 'center',
    alignItems: 'center',
  },

  // Search
  searchBox: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 52,
    borderRadius: 16,
    paddingHorizontal: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 3,
  },
  searchInput: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Urbanist-Medium',
  },

  // Tabs
  tabSection: {
    paddingHorizontal: CARD_MARGIN,
    paddingBottom: 10,
    paddingTop: 6,
    zIndex: 10,
  },
  pillContainer: {
    flexDirection: 'row',
    padding: TAB_CONTAINER_PADDING,
    borderRadius: 18,
    position: 'relative',
  },
  tabIndicator: {
    position: 'absolute',
    top: TAB_CONTAINER_PADDING,
    left: TAB_CONTAINER_PADDING,
    bottom: TAB_CONTAINER_PADDING,
    borderRadius: 14,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 5,
    elevation: 4,
  },
  pill: {
    width: TAB_WIDTH,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 11,
    borderRadius: 14,
  },
  pillText: {
    fontSize: 14,
    fontFamily: 'Urbanist-Bold',
  },

  // Content
  contentSection: { marginTop: 12 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: CARD_MARGIN,
    marginBottom: 14,
  },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sectionTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  countPill: {
    fontSize: 12,
    fontFamily: 'Urbanist-Bold',
    paddingHorizontal: 10,
    paddingVertical: 3,
    borderRadius: 10,
    overflow: 'hidden',
  },
  refreshBtn: { padding: 4 },
  liveBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FF4D67',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
    gap: 4,
  },
  liveDotSmall: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#FFF' },
  liveBadgeText: { color: '#FFF', fontSize: 9, fontFamily: 'Urbanist-Black', letterSpacing: 0.5 },

  // Template cards
  templateCard: {
    width: 150,
    height: 190,
    borderRadius: 22,
    marginRight: 14,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 10,
    elevation: 5,
  },
  templateGradient: {
    flex: 1,
    padding: 14,
  },
  templateWatermark: {
    position: 'absolute',
    right: -8,
    top: -6,
  },
  templateIconCircle: {
    width: 40,
    height: 40,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.22)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  templateTitle: {
    color: '#FFF',
    fontSize: 17,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 10,
    lineHeight: 20,
  },
  templateCta: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: 'rgba(255,255,255,0.25)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 100,
    gap: 5,
  },
  templateCtaText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },

  // Match cards
  matchCardContainer: {
    borderRadius: 24,
    overflow: 'hidden',
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 4,
  },
  matchHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  badgeContainer: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#FF4D67' },
  matchStatus: { fontSize: 13, fontFamily: 'Urbanist-Bold' },
  prizePill: {
    backgroundColor: 'rgba(255,179,0,0.15)',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 100,
  },
  prizeValue: { fontSize: 13, fontFamily: 'Urbanist-Black', color: '#FFB300' },

  matchBody: {
    flexDirection: 'row',
    height: 156,
    alignItems: 'center',
  },
  playerSide: {
    flex: 1,
    height: '100%',
    justifyContent: 'center',
    alignItems: 'center',
  },
  mediaPreview: { width: '100%', height: '100%', resizeMode: 'cover' },
  mediaOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    padding: 10,
  },
  userInfo: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  miniAvatar: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: '#FFF' },
  miniUsername: {
    color: '#FFF',
    fontSize: 12,
    fontFamily: 'Urbanist-Bold',
    flexShrink: 1,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },

  vsDivider: {
    width: 44,
    zIndex: 10,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'absolute',
    left: '50%',
    marginLeft: -22,
  },
  vsCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 3,
    borderColor: '#FFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.3,
    shadowRadius: 4,
    elevation: 5,
  },
  vsText: { color: '#FFF', fontFamily: 'Urbanist-Black', fontSize: 13, fontStyle: 'italic' },

  emptySide: {
    borderLeftWidth: 1,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
  },
  joinCircle: {
    width: 50,
    height: 50,
    borderRadius: 25,
    borderWidth: 2,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
  },
  joinText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  entryFeeText: { fontSize: 12, fontFamily: 'Urbanist-Bold', marginTop: 4 },

  matchFooter: {
    padding: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderTopWidth: 1,
  },
  matchTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', flex: 1, marginRight: 10 },
  joinBtn: {
    paddingVertical: 9,
    paddingHorizontal: 20,
    borderRadius: 12,
  },
  joinBtnText: { color: '#FFF', fontSize: 13, fontFamily: 'Urbanist-Bold' },

  // User cards
  userCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 18,
    borderWidth: 1,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 2,
  },
  avatarRing: {
    padding: 2,
    borderRadius: 29,
    borderWidth: 2,
    borderColor: 'rgba(34,197,94,0.4)',
    marginRight: 12,
  },
  userAvatar: { width: 50, height: 50, borderRadius: 25 },
  userDetails: { flex: 1 },
  userName: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  userHandle: { fontSize: 14, fontFamily: 'Urbanist-Medium' },
  followBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 9,
    paddingHorizontal: 18,
    borderRadius: 100,
  },
  followText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },

  emptyState: {
    borderWidth: 2,
    borderStyle: 'dashed',
    borderRadius: 20,
    padding: 34,
    alignItems: 'center',
    marginTop: 6,
  },
  emptyText: { marginTop: 12, fontFamily: 'Urbanist-Medium', fontSize: 14 },
});
