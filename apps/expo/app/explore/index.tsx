import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  Image,
  TouchableOpacity,
  ScrollView,
  Dimensions,
  TextInput,
  Animated as RNAnimated,
  FlatList,
  RefreshControl,
  Platform,
  Pressable,
  ActivityIndicator,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { BottomNav } from '@/src/components/home/BottomNav';
import { Ionicons, MaterialCommunityIcons } from '@/src/lib/icons';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { Skeleton, SkeletonCircle } from '@/src/components/ui/Skeleton';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { contestService } from '@/src/services/contests/contestService';
import { fetchSuggestedUsers, toggleFollowService, searchUsers } from '@/src/services/users';
import { Avatar } from '@/src/components/ui/Avatar';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData';
import { LinearGradient } from 'expo-linear-gradient';
import { useToast } from '@/src/components/toast/ToastProvider';
import { Colors } from '@/constants/theme';
import { CloseIcon } from '@/src/components/ui/CloseIcon';

const { width } = Dimensions.get('window');
const PAD = 20;
const CONTENT_W = width - PAD * 2;
const GRID_GAP = 14;
const PEOPLE_CARD_W = (CONTENT_W - GRID_GAP) / 2;
const TEMPLATE_W = 168;

type TabKey = 'all' | 'photo' | 'video' | 'users';

const TABS: {
  key: TabKey;
  label: string;
  icon: string;
  color: string;
  grad: [string, string];
}[] = [
  { key: 'all', label: 'All', icon: 'apps', color: '#FF4D67', grad: ['#FF4D67', '#8B5CF6'] },
  { key: 'photo', label: 'Photos', icon: 'image', color: '#FF4D67', grad: ['#FF4D67', '#FF7A45'] },
  { key: 'video', label: 'Videos', icon: 'videocam', color: '#6A5AE0', grad: ['#6A5AE0', '#8B5CF6'] },
  { key: 'users', label: 'People', icon: 'people', color: '#22C55E', grad: ['#22C55E', '#16A34A'] },
];

const QUICK_ACTIONS: {
  key: string;
  label: string;
  icon: string;
  grad: [string, string];
  route: string;
}[] = [
  { key: 'leaderboard', label: 'Ranks', icon: 'trophy', grad: ['#FFB300', '#FF7A00'], route: '/explore/leaderboard' },
  { key: 'contests', label: 'Contests', icon: 'flame', grad: ['#FF4D67', '#FF7A45'], route: '/contests' },
  // Points at the profile, where the user's own photo/video battles are listed.
  // This used to point at '/contest/joined', which is the post-entry
  // congratulations screen — so tapping "My Battles" told people they had
  // "successfully joined" a contest they had not entered.
  { key: 'joined', label: 'My Battles', icon: 'game-controller', grad: ['#0EA5E9', '#2563EB'], route: '/profile' },
  { key: 'rewards', label: 'Rewards', icon: 'gift', grad: ['#22C55E', '#16A34A'], route: '/wallet/store' },
  { key: 'wallet', label: 'Wallet', icon: 'wallet', grad: ['#6A5AE0', '#8B5CF6'], route: '/wallet' },
];

const gradForType = (t?: string): [string, string] =>
  t === 'video' ? ['#6A5AE0', '#8B5CF6'] : ['#FF4D67', '#FF7A45'];
const colorForType = (t?: string): string => (t === 'video' ? '#6A5AE0' : '#FF4D67');

export default function DiscoverScreen() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const { data: currentUserProfile } = useProfile(user?.uid || '');
  const { addToast } = useToast();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';

  // --- Palette ---
  const bg = isDark ? Colors.dark.background : Colors.light.background;
  const cardBg = isDark ? '#16171E' : '#FFFFFF';
  const chipBg = isDark ? '#1B1D26' : '#F1F2F6';
  const textColor = isDark ? '#FFFFFF' : '#121212';
  const subText = isDark ? '#8B8F9A' : '#8A8A8E';
  const borderColor = isDark ? '#23262F' : '#EEEEF2';

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [availableContests, setAvailableContests] = useState<any[]>([]);
  const [waitingMatches, setWaitingMatches] = useState<any[]>([]);
  const [suggestedUsers, setSuggestedUsers] = useState<any[]>([]);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [searching, setSearching] = useState(false);
  const [followedUsers, setFollowedUsers] = useState<Set<string>>(new Set());

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('all');

  const activeMeta = TABS.find(t => t.key === activeTab)!;
  const activeColor = activeMeta.color;

  const profileAny = currentUserProfile as any;
  const coins = Number(profileAny?.Dpcoin ?? profileAny?.dpcoin ?? 0);
  // Null when unset — <Avatar> renders local initials instead of fetching a
  // name-bearing URL from a third party.
  const avatarUri = profileAny?.profileImageUrl || null;
  const avatarName = profileAny?.fullName || profileAny?.username || null;

  useEffect(() => {
    if (currentUserProfile && (currentUserProfile as any).following) {
      setFollowedUsers(new Set((currentUserProfile as any).following));
    }
  }, [currentUserProfile]);

  useEffect(() => {
    if (!authLoading) fetchExploreData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

  // Debounced server-side people search (min 2 chars, only on the People tab).
  useEffect(() => {
    if (activeTab !== 'users') return;
    const query = searchQuery.trim();
    if (query.length < 2) { setSearchResults([]); setSearching(false); return; }
    setSearching(true);
    const t = setTimeout(async () => {
      const res = await searchUsers(query);
      setSearchResults(res);
      setSearching(false);
    }, 350);
    return () => clearTimeout(t);
  }, [searchQuery, activeTab]);

  const fetchExploreData = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
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
      setRefreshing(false);
    }
  };

  const switchTab = (key: TabKey) => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    setActiveTab(key);
  };

  const handleAction = (action: () => void) => {
    if (!user) router.push(`/auth/login?redirect=${encodeURIComponent('/explore')}`);
    else action();
  };

  const handleFollow = async (targetId: string) => {
    handleAction(async () => {
      if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
      const isFollowing = followedUsers.has(targetId);
      setFollowedUsers(prev => {
        const s = new Set(prev);
        isFollowing ? s.delete(targetId) : s.add(targetId);
        return s;
      });
      try {
        await toggleFollowService(targetId);
      } catch {
        setFollowedUsers(prev => {
          const s = new Set(prev);
          isFollowing ? s.add(targetId) : s.delete(targetId);
          return s;
        });
        addToast('Failed to update follow status.', 'error');
      }
    });
  };

  // --- Filtering ---
  const q = searchQuery.trim().toLowerCase();
  const matchType = (t?: string) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'photo') return t === 'photo' || !t;
    if (activeTab === 'video') return t === 'video';
    return false;
  };
  const filteredContests = availableContests.filter(c =>
    matchType(c.type) && (!q || c.title?.toLowerCase().includes(q))
  );
  const filteredMatches = waitingMatches.filter(m =>
    matchType(m.type) && (!q || m.title?.toLowerCase().includes(q) || m.userA?.username?.toLowerCase().includes(q))
  );
  const filteredUsers = q.length >= 2
    ? searchResults
    : suggestedUsers.filter(u => !q || u.name?.toLowerCase().includes(q) || u.username?.toLowerCase().includes(q));

  // ================================================================
  // HEADER (non-sticky)
  // ================================================================
  const renderHeader = () => (
    <View style={{ backgroundColor: bg }}>
      {/* Top bar: avatar + title + coin balance + notifications */}
      <View style={styles.topBar}>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => handleAction(() => router.push('/profile'))}
        >
          <Avatar
            uri={avatarUri}
            name={avatarName}
            size={46}
            style={[styles.headerAvatar, { borderColor: activeColor }]}
          />
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[styles.kicker, { color: activeColor }]}>DISCOVER</Text>
          <Text style={[styles.title, { color: textColor }]}>Explore</Text>
        </View>

        {user && (
          <TouchableOpacity
            activeOpacity={0.85}
            style={[styles.coinChip, { backgroundColor: chipBg }]}
            onPress={() => router.push('/wallet/store' as any)}
          >
            <CoinIcon size={14} color="#FFB300" />
            <Text style={[styles.coinText, { color: textColor }]}>{coins.toLocaleString()}</Text>
            <View style={styles.coinPlus}>
              <Ionicons name="add" size={13} color="#FFF" />
            </View>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.iconBtn, { backgroundColor: chipBg, marginLeft: 10 }]}
          onPress={() => handleAction(() => router.push('/notifications' as any))}
        >
          <Ionicons name="notifications" size={20} color={activeColor} />
        </TouchableOpacity>
      </View>

      {/* Search */}
      <View style={styles.searchWrap}>
        <View style={[styles.searchBox, { backgroundColor: cardBg, borderColor, borderWidth: 1 }]}>
          <Ionicons name="search" size={20} color={activeColor} />
          <TextInput
            style={[styles.searchInput, { color: textColor }]}
            placeholder={activeTab === 'users' ? 'Search people by @username...' : 'Search battles...'}
            placeholderTextColor={subText}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
            autoCapitalize="none"
          />
          {searching && activeTab === 'users' && <ActivityIndicator size="small" color={activeColor} />}
          {searchQuery.length > 0 && !searching && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <CloseIcon variant="circle" size={18} color={subText} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Quick action shortcuts */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickRow}>
        {QUICK_ACTIONS.map(a => (
          <ScaleTouchable key={a.key} style={styles.quickItem} onPress={() => handleAction(() => router.push(a.route as any))}>
            <LinearGradient colors={a.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.quickCircle}>
              <Ionicons name={a.icon} size={22} color="#FFF" />
            </LinearGradient>
            <Text style={[styles.quickLabel, { color: subText }]}>{a.label}</Text>
          </ScaleTouchable>
        ))}
      </ScrollView>
    </View>
  );

  // ================================================================
  // CATEGORY CHIPS (sticky)
  // ================================================================
  const renderChips = () => (
    <View style={[styles.chipBar, { backgroundColor: bg }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: PAD, gap: 10 }}>
        {TABS.map(tab => {
          const isActive = activeTab === tab.key;
          const count = tab.key === 'users' ? filteredUsers.length : filteredMatches.length;
          if (isActive) {
            return (
              <TouchableOpacity key={tab.key} activeOpacity={0.9} onPress={() => switchTab(tab.key)}>
                <LinearGradient colors={tab.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.chipActive}>
                  <Ionicons name={tab.icon} size={16} color="#FFF" />
                  <Text style={styles.chipActiveText}>{tab.label}</Text>
                  {count > 0 && (
                    <View style={styles.chipCount}><Text style={styles.chipCountText}>{count}</Text></View>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity key={tab.key} activeOpacity={0.85} style={[styles.chip, { backgroundColor: chipBg }]} onPress={() => switchTab(tab.key)}>
              <Ionicons name={tab.icon} size={16} color={subText} />
              <Text style={[styles.chipText, { color: subText }]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );

  // ================================================================
  // TEMPLATE CARD (start a battle)
  // ================================================================
  const renderTemplate = (item: any) => {
    if (!item || !item.title) return null;
    const isVideo = item.type === 'video';
    const prize = Number(item.rewardCoins ?? item.winningCoins ?? 0);
    const entry = item.totalEntryFee ? Math.round(Number(item.totalEntryFee) / 2) : 0;
    return (
      <ScaleTouchable
        style={styles.templateCard}
        onPress={() => handleAction(() => router.push({
          pathname: isVideo ? '/contest/video' : '/contest/photo',
          params: { contestId: item.id },
        }))}
      >
        <LinearGradient colors={gradForType(item.type)} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.templateInner}>
          <MaterialCommunityIcons
            name={isVideo ? 'movie-open-star' : 'image-filter-hdr'}
            size={72} color="rgba(255,255,255,0.14)" style={styles.templateWm}
          />
          <View style={styles.templateIcon}>
            <MaterialCommunityIcons name={isVideo ? 'movie-open-play' : 'image-multiple'} size={20} color="#FFF" />
          </View>
          {prize > 0 && (
            <View style={styles.templatePrize}>
              <CoinIcon size={11} color="#FFF" />
              <Text style={styles.templatePrizeText}>{prize}</Text>
            </View>
          )}
          <View style={{ flex: 1, justifyContent: 'flex-end' }}>
            <Text style={styles.templateTitle} numberOfLines={2}>{item.title}</Text>
            {entry > 0 && (
              <View style={styles.templateEntry}>
                <CoinIcon size={11} color="#FFF" />
                <Text style={styles.templateEntryText}>Entry {entry}</Text>
              </View>
            )}
            <View style={styles.templateCta}>
              <Text style={styles.templateCtaText}>Start Battle</Text>
              <ArrowIcon size={12} color={colorForType(item.type)} variant="arrow" />
            </View>
          </View>
        </LinearGradient>
      </ScaleTouchable>
    );
  };

  // ================================================================
  // VERSUS / LIVE BATTLE CARD
  // ================================================================
  const renderVersus = (item: any) => {
    const isMyMatch = user && item.userA && item.userA.uid === user.uid;
    const entryFee = item.entryFee ? item.entryFee / 2 : 0;
    const prize = item.entryFee || 0;
    const isVideo = item.type === 'video';
    const grad = gradForType(item.type);
    const accent = colorForType(item.type);

    const goJoin = () => handleAction(() => {
      if (isMyMatch) { addToast('This is your own contest! Wait for someone to join.', 'info'); return; }
      router.push({
        // '/contest/video' — NOT '/contest/video/setup', which does not exist and
        // silently dead-ended every video join on Expo Router's unmatched-route
        // screen. The video screen handles both picking and setup in one file.
        pathname: isVideo ? '/contest/video' : '/contest/photo/setup',
        params: { matchId: item.id, mode: 'join' },
      });
    });

    const creatorPhoto = item.userA?.mediaUrl || item.userA?.avatar;

    return (
      <ScaleTouchable key={item.id} style={[styles.arenaCard, { backgroundColor: cardBg, borderColor }]} onPress={goJoin}>
        {/* Status strip */}
        <View style={styles.arenaTopRow}>
          <View style={styles.arenaStatusPill}>
            <View style={styles.liveDot} />
            <Text style={styles.arenaStatusText}>LIVE · WAITING</Text>
          </View>
          <View style={styles.arenaPrizePill}>
            <MaterialCommunityIcons name="trophy" size={12} color="#F59E0B" />
            <Text style={styles.arenaPrizeText}>Win {prize}</Text>
            <CoinIcon size={12} color="#F59E0B" />
          </View>
        </View>

        {/* Versus arena: creator vs empty challenger slot */}
        <View style={styles.arenaBody}>
          {/* Player 1 — creator */}
          <View style={styles.arenaSide}>
            <View style={styles.arenaPhotoWrap}>
              <Image source={{ uri: creatorPhoto }} style={styles.arenaPhoto} />
              <LinearGradient colors={['transparent', 'rgba(0,0,0,0.5)']} style={StyleSheet.absoluteFill as any} />
              <View style={[styles.arenaCorner, { backgroundColor: accent }]}>
                <Text style={styles.arenaCornerText}>P1</Text>
              </View>
            </View>
            <View style={styles.arenaNameRow}>
              <Avatar
                uri={item.userA?.avatar}
                name={item.userA?.username}
                size={22}
                style={styles.arenaNameAvatar}
              />
              <Text style={[styles.arenaName, { color: textColor }]} numberOfLines={1}>@{item.userA?.username || 'user'}</Text>
            </View>
          </View>

          {/* Center VS */}
          <View style={styles.arenaVsCol}>
            <View style={[styles.arenaVsLine, { backgroundColor: borderColor }]} />
            <LinearGradient colors={grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.arenaVsBadge}>
              <Text style={styles.arenaVsText}>VS</Text>
            </LinearGradient>
            <View style={[styles.arenaVsLine, { backgroundColor: borderColor }]} />
          </View>

          {/* Player 2 — empty challenger slot */}
          <View style={styles.arenaSide}>
            <View style={[styles.arenaPhotoWrap, styles.arenaEmptySlot, { borderColor: accent, backgroundColor: isDark ? '#1B1D26' : '#FFF4F5' }]}>
              <MaterialCommunityIcons name="sword-cross" size={26} color={accent} />
              <Text style={[styles.arenaEmptyText, { color: accent }]}>{isMyMatch ? 'Awaiting\nchallenger' : 'Your spot\nawaits'}</Text>
            </View>
            <View style={styles.arenaNameRow}>
              <View style={[styles.arenaNameAvatar, styles.arenaNameAvatarEmpty, { borderColor }]}>
                <Ionicons name="help" size={12} color={subText} />
              </View>
              <Text style={[styles.arenaName, { color: subText }]} numberOfLines={1}>Waiting…</Text>
            </View>
          </View>
        </View>

        {/* Info + CTA */}
        <View style={styles.arenaFooterWrap}>
          <Text style={[styles.arenaTitle, { color: textColor }]} numberOfLines={1}>{item.title || (isVideo ? 'Video Battle' : 'Photo Battle')}</Text>
          <View style={styles.arenaMetaRow}>
            <CoinIcon size={12} color={accent} />
            <Text style={[styles.arenaMetaText, { color: subText }]}>Entry {entryFee}</Text>
            <Text style={[styles.arenaMetaDot, { color: subText }]}>·</Text>
            <MaterialCommunityIcons name="vote-outline" size={14} color={subText} />
            <Text style={[styles.arenaMetaText, { color: subText }]}>Fans vote the winner</Text>
          </View>

          <LinearGradient colors={isMyMatch ? ['#9AA0AA', '#7E848E'] : grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.arenaCta}>
            <Ionicons name={isMyMatch ? 'hourglass' : 'flash'} size={16} color="#FFF" />
            <Text style={styles.arenaCtaText}>{isMyMatch ? 'Waiting for a rival' : 'Join Battle'}</Text>
            {!isMyMatch && <ArrowIcon size={16} color="#FFF" variant="arrow" />}
          </LinearGradient>
        </View>
      </ScaleTouchable>
    );
  };

  // ================================================================
  // PEOPLE CARD (2-col grid)
  // ================================================================
  const renderPerson = (item: any) => {
    const isFollowed = followedUsers.has(item.id);
    return (
      <View key={item.id} style={[styles.personCard, { backgroundColor: cardBg, borderColor, width: PEOPLE_CARD_W }]}>
        <TouchableOpacity activeOpacity={0.85} onPress={() => handleAction(() => router.push(`/profile?userId=${item.id}`))} style={{ alignItems: 'center' }}>
          <LinearGradient colors={['#22C55E', '#16A34A']} style={styles.personRing}>
            <Image source={{ uri: item.avatar }} style={styles.personAvatar} />
          </LinearGradient>
          <Text style={[styles.personName, { color: textColor }]} numberOfLines={1}>{item.name}</Text>
          <Text style={[styles.personHandle, { color: subText }]} numberOfLines={1}>@{item.username}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => handleFollow(item.id)}
          style={[styles.personFollow, isFollowed ? { backgroundColor: chipBg } : { backgroundColor: '#22C55E' }]}
        >
          {!isFollowed && <Ionicons name="add" size={15} color="#FFF" />}
          <Text style={[styles.personFollowText, { color: isFollowed ? textColor : '#FFF' }]}>
            {isFollowed ? 'Following' : 'Follow'}
          </Text>
        </TouchableOpacity>
      </View>
    );
  };

  // ================================================================
  // BODY
  // ================================================================
  const renderBody = () => {
    if (loading) return <SkeletonBody isDark={isDark} activeTab={activeTab} cardBg={cardBg} borderColor={borderColor} />;

    if (activeTab === 'users') {
      return (
        <View style={{ paddingHorizontal: PAD, marginTop: 18 }}>
          <SectionHeader icon="people" color={activeColor} title={q.length >= 2 ? 'Search Results' : 'Suggested People'} textColor={textColor} />
          {filteredUsers.length === 0 ? (
            <EmptyState
              icon="people-outline"
              text={q.length >= 2 ? `No people found for "${searchQuery.trim()}".` : 'No people to show yet.'}
              border={borderColor} sub={subText}
            />
          ) : (
            <View style={styles.peopleGrid}>{filteredUsers.map(renderPerson)}</View>
          )}
        </View>
      );
    }

    return (
      <View style={{ marginTop: 18 }}>
        <View style={{ paddingHorizontal: PAD }}>
          <SectionHeader iconLib="mci" mci="rocket-launch" color={activeColor} title="Start a New Battle" textColor={textColor} />
        </View>
        {filteredContests.length === 0 ? (
          <View style={{ paddingHorizontal: PAD }}>
            <EmptyState icon="albums-outline" text="No templates available." border={borderColor} sub={subText} compact />
          </View>
        ) : (
          <FlatList
            horizontal
            data={filteredContests}
            keyExtractor={(i) => i.id}
            renderItem={({ item }) => renderTemplate(item)}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: PAD, paddingVertical: 4, gap: 14 }}
          />
        )}

        <View style={[styles.liveHeader, { paddingHorizontal: PAD }]}>
          <View style={styles.rowCenter}>
            <View style={styles.liveBadge}>
              <View style={styles.liveDotSm} />
              <Text style={styles.liveBadgeText}>LIVE</Text>
            </View>
            <Text style={[styles.sectionTitle, { color: textColor }]}>Live Arena</Text>
          </View>
          <TouchableOpacity onPress={() => fetchExploreData(true)} style={styles.refreshBtn}>
            <Ionicons name="refresh" size={18} color={activeColor} />
          </TouchableOpacity>
        </View>

        <View style={{ paddingHorizontal: PAD, gap: 16 }}>
          {filteredMatches.length === 0 ? (
            <View style={[styles.emptyBattle, { backgroundColor: cardBg, borderColor }]}>
              <View style={[styles.emptyBattleIcon, { backgroundColor: isDark ? '#20222B' : '#F4F5F8' }]}>
                <MaterialCommunityIcons name="sword-cross" size={30} color={activeColor} />
              </View>
              <Text style={[styles.emptyBattleTitle, { color: textColor }]}>No active battles right now</Text>
              <Text style={[styles.emptyBattleSub, { color: subText }]}>Be the first to step into the arena!</Text>
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => handleAction(() => router.push(activeTab === 'video' ? '/contest/video' : '/contest/photo'))}
              >
                <LinearGradient colors={activeMeta.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }} style={styles.emptyBattleBtn}>
                  <Ionicons name="flash" size={16} color="#FFF" />
                  <Text style={styles.emptyBattleBtnText}>Start a Battle</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          ) : (
            filteredMatches.map(renderVersus)
          )}
        </View>
      </View>
    );
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 120 }}
        stickyHeaderIndices={[1]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => fetchExploreData(true)}
            tintColor={activeColor}
            colors={[activeColor]}
          />
        }
      >
        {renderHeader()}
        {renderChips()}
        {renderBody()}
      </ScrollView>
      <BottomNav backgroundColor={bg} isDark={isDark} />
    </SafeAreaView>
  );
}

// ================================================================
// Reusable helpers
// ================================================================

/** Pressable that gently scales down on press for a tactile, premium feel. */
function ScaleTouchable({ children, onPress, style, disabled }: any) {
  const scale = useRef(new RNAnimated.Value(1)).current;
  return (
    <RNAnimated.View style={[style, { transform: [{ scale }] }]}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        onPressIn={() => RNAnimated.spring(scale, { toValue: 0.95, useNativeDriver: true, speed: 50, bounciness: 0 }).start()}
        onPressOut={() => RNAnimated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 50, bounciness: 4 }).start()}
        style={{ flex: 1 }}
      >
        {children}
      </Pressable>
    </RNAnimated.View>
  );
}

function SectionHeader({ icon, iconLib, mci, color, title, textColor }: any) {
  return (
    <View style={styles.sectionHeader}>
      {iconLib === 'mci'
        ? <MaterialCommunityIcons name={mci} size={18} color={color} />
        : <Ionicons name={icon} size={18} color={color} />}
      <Text style={[styles.sectionTitle, { color: textColor }]}>{title}</Text>
    </View>
  );
}

function EmptyState({ icon, iconLib, mci, text, border, sub, actionText, actionColor, onAction, compact }: any) {
  return (
    <View style={[styles.emptyState, { borderColor: border, paddingVertical: compact ? 22 : 34 }]}>
      {iconLib === 'mci'
        ? <MaterialCommunityIcons name={mci} size={44} color={sub} style={{ opacity: 0.5 }} />
        : <Ionicons name={icon} size={44} color={sub} style={{ opacity: 0.5 }} />}
      <Text style={[styles.emptyText, { color: sub }]}>{text}</Text>
      {actionText && (
        <TouchableOpacity onPress={onAction}>
          <Text style={{ color: actionColor, fontFamily: 'Urbanist-Bold', marginTop: 10 }}>{actionText}</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/** Pulsing skeleton placeholders shown while data loads. */
function SkeletonBody({ activeTab, cardBg, borderColor }: any) {
  if (activeTab === 'users') {
    return (
      <View style={{ paddingHorizontal: PAD, marginTop: 18 }}>
        <Skeleton width={160} height={20} style={{ marginBottom: 16 }} />
        <View style={styles.peopleGrid}>
          {[0, 1, 2, 3].map(i => (
            <View key={i} style={[styles.personCard, { backgroundColor: cardBg, borderColor, width: PEOPLE_CARD_W, alignItems: 'center' }]}>
              <SkeletonCircle size={76} />
              <Skeleton width="70%" height={13} style={{ marginTop: 12 }} />
              <Skeleton width="45%" height={9} style={{ marginTop: 6 }} />
              <Skeleton width="100%" height={34} borderRadius={100} style={{ marginTop: 14 }} />
            </View>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={{ marginTop: 18 }}>
      <View style={{ paddingHorizontal: PAD }}>
        <Skeleton width={180} height={20} style={{ marginBottom: 16 }} />
      </View>
      <View style={{ flexDirection: 'row', paddingHorizontal: PAD, gap: 14 }}>
        {[0, 1].map(i => (<Skeleton key={i} width={TEMPLATE_W} height={208} borderRadius={24} />))}
      </View>
      <View style={{ paddingHorizontal: PAD, marginTop: 28, gap: 16 }}>
        {[0, 1].map(i => (
          <View key={i} style={[styles.battleCard, { backgroundColor: cardBg, borderColor }]}>
            <Skeleton width="100%" height={210} borderRadius={0} />
            <View style={styles.battleFooter}>
              <View style={{ flex: 1 }}>
                <Skeleton width="60%" height={14} />
                <Skeleton width="30%" height={9} style={{ marginTop: 8 }} />
              </View>
              <Skeleton width={110} height={40} borderRadius={14} />
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Top bar
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, paddingTop: 10, paddingBottom: 4 },
  headerAvatar: { width: 46, height: 46, borderRadius: 23, borderWidth: 2 },
  kicker: { fontSize: 12, fontFamily: 'Urbanist-Bold', letterSpacing: 1.5, marginBottom: 2 },
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', letterSpacing: -0.5 },
  coinChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 4, height: 40, borderRadius: 20 },
  coinText: { fontSize: 14, fontFamily: 'Urbanist-Black' },
  coinPlus: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFB300', justifyContent: 'center', alignItems: 'center' },
  iconBtn: { width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },

  // Search
  searchWrap: { paddingHorizontal: PAD, marginTop: 14 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', height: 52, borderRadius: 16, paddingHorizontal: 16, gap: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 10, elevation: 2,
  },
  searchInput: { flex: 1, fontSize: 16, fontFamily: 'Urbanist-Medium' },

  // Quick actions
  quickRow: { paddingHorizontal: PAD, gap: 18, paddingTop: 18, paddingBottom: 6 },
  quickItem: { alignItems: 'center', width: 64 },
  quickCircle: {
    width: 58, height: 58, borderRadius: 20, justifyContent: 'center', alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.18, shadowRadius: 8, elevation: 4,
  },
  quickLabel: { fontSize: 12, fontFamily: 'Urbanist-SemiBold', marginTop: 7 },

  // Chip bar (sticky)
  chipBar: { paddingTop: 12, paddingBottom: 12, zIndex: 10 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14 },
  chipText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  chipActive: {
    flexDirection: 'row', alignItems: 'center', gap: 7, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 14,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 6, elevation: 4,
  },
  chipActiveText: { fontSize: 14, fontFamily: 'Urbanist-Bold', color: '#FFF' },
  chipCount: { backgroundColor: 'rgba(255,255,255,0.28)', minWidth: 20, height: 20, borderRadius: 10, paddingHorizontal: 6, alignItems: 'center', justifyContent: 'center' },
  chipCountText: { color: '#FFF', fontSize: 11, fontFamily: 'Urbanist-Black' },

  // Section header
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 14 },
  sectionTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  rowCenter: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  liveHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 26, marginBottom: 14 },
  refreshBtn: { padding: 4 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FF4D67', borderRadius: 6, paddingHorizontal: 7, paddingVertical: 3, gap: 4 },
  liveDotSm: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#FFF' },
  liveBadgeText: { color: '#FFF', fontSize: 9, fontFamily: 'Urbanist-Black', letterSpacing: 0.5 },

  // Template card
  templateCard: {
    width: TEMPLATE_W, height: 208, borderRadius: 24, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 10, elevation: 5,
  },
  templateInner: { flex: 1, padding: 16 },
  templateWm: { position: 'absolute', right: -10, top: -8 },
  templateIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.22)', justifyContent: 'center', alignItems: 'center' },
  templatePrize: { position: 'absolute', top: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.28)', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 100 },
  templatePrizeText: { color: '#FFF', fontSize: 11, fontFamily: 'Urbanist-Black' },
  templateTitle: { color: '#FFF', fontSize: 17, fontFamily: 'Urbanist-Bold', marginBottom: 6, lineHeight: 20 },
  templateEntry: { flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 10 },
  templateEntryText: { color: 'rgba(255,255,255,0.9)', fontSize: 11, fontFamily: 'Urbanist-Bold' },
  templateCta: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', backgroundColor: '#FFF', paddingHorizontal: 14, paddingVertical: 7, borderRadius: 100, gap: 6 },
  templateCtaText: { fontSize: 12, fontFamily: 'Urbanist-Bold', color: '#121212' },

  // Battle card
  battleCard: {
    borderRadius: 26, overflow: 'hidden', borderWidth: 1,
    shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.08, shadowRadius: 16, elevation: 4,
  },
  battleMedia: { height: 210, width: '100%', position: 'relative' },
  battleImg: { ...StyleSheet.absoluteFillObject, width: '100%', height: '100%', resizeMode: 'cover' },
  battleTopRow: { position: 'absolute', top: 14, left: 14, right: 14, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#FF4D67' },
  statusText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Black', letterSpacing: 0.5 },
  prizePill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(0,0,0,0.4)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100 },
  prizeText: { color: '#FFB300', fontSize: 12, fontFamily: 'Urbanist-Black' },
  creatorChip: { position: 'absolute', bottom: 14, left: 14, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.35)', paddingHorizontal: 8, paddingVertical: 5, borderRadius: 100, maxWidth: '60%' },
  creatorAvatar: { width: 26, height: 26, borderRadius: 13, borderWidth: 1.5, borderColor: '#FFF' },
  creatorName: { color: '#FFF', fontSize: 13, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  vsWrap: { position: 'absolute', right: 16, bottom: 14 },
  vsCircle: { width: 48, height: 48, borderRadius: 24, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#FFF', shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 4, elevation: 5 },
  vsText: { color: '#FFF', fontFamily: 'Urbanist-Black', fontSize: 14, fontStyle: 'italic' },
  battleFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16 },
  battleTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  entryRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 4 },
  entryLabel: { fontSize: 13, fontFamily: 'Urbanist-Medium' },
  entryVal: { fontSize: 14, fontFamily: 'Urbanist-Black' },
  joinBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 11, paddingHorizontal: 20, borderRadius: 14 },
  joinBtnText: { color: '#FFF', fontSize: 14, fontFamily: 'Urbanist-Bold' },

  // Live Arena — VS battle card (redesigned)
  arenaCard: {
    borderRadius: 26, borderWidth: 1, padding: 16,
    shadowColor: '#000', shadowOffset: { width: 0, height: 10 }, shadowOpacity: 0.09, shadowRadius: 20, elevation: 5,
  },
  arenaTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  arenaStatusPill: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#FF4D67', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100 },
  arenaStatusText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Black', letterSpacing: 0.5 },
  arenaPrizePill: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(245,158,11,0.14)', paddingHorizontal: 11, paddingVertical: 5, borderRadius: 100 },
  arenaPrizeText: { color: '#F59E0B', fontSize: 12, fontFamily: 'Urbanist-Black' },

  arenaBody: { flexDirection: 'row', alignItems: 'center' },
  arenaSide: { flex: 1, alignItems: 'center' },
  arenaPhotoWrap: { width: '100%', aspectRatio: 0.82, borderRadius: 18, overflow: 'hidden', position: 'relative' },
  arenaPhoto: { width: '100%', height: '100%', resizeMode: 'cover' },
  arenaCorner: { position: 'absolute', top: 8, left: 8, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  arenaCornerText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Black', letterSpacing: 0.5 },
  arenaEmptySlot: { borderWidth: 2, borderStyle: 'dashed', justifyContent: 'center', alignItems: 'center', gap: 8, padding: 8 },
  arenaEmptyText: { fontSize: 11, fontFamily: 'Urbanist-Bold', textAlign: 'center', lineHeight: 14 },
  arenaNameRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, maxWidth: '100%', paddingHorizontal: 2 },
  arenaNameAvatar: { width: 22, height: 22, borderRadius: 11, borderWidth: 1.5, borderColor: '#FFF' },
  arenaNameAvatarEmpty: { justifyContent: 'center', alignItems: 'center' },
  arenaName: { fontSize: 13, fontFamily: 'Urbanist-Bold', flexShrink: 1 },

  arenaVsCol: { width: 52, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', gap: 6 },
  arenaVsLine: { width: 2, flex: 1, borderRadius: 1, opacity: 0.7 },
  arenaVsBadge: {
    width: 46, height: 46, borderRadius: 23, justifyContent: 'center', alignItems: 'center', borderWidth: 3, borderColor: '#FFF',
    shadowColor: '#FF4D67', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.4, shadowRadius: 8, elevation: 6,
  },
  arenaVsText: { color: '#FFF', fontFamily: 'Urbanist-Black', fontSize: 15, fontStyle: 'italic' },

  arenaFooterWrap: { marginTop: 16 },
  arenaTitle: { fontSize: 17, fontFamily: 'Urbanist-Bold' },
  arenaMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' },
  arenaMetaText: { fontSize: 12, fontFamily: 'Urbanist-SemiBold' },
  arenaMetaDot: { fontSize: 12, fontFamily: 'Urbanist-Black' },
  arenaCta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 14, borderRadius: 16, marginTop: 16 },
  arenaCtaText: { color: '#FFF', fontSize: 15, fontFamily: 'Urbanist-Bold' },

  // Empty battle state (actionable)
  emptyBattle: { borderRadius: 24, borderWidth: 1, alignItems: 'center', paddingVertical: 30, paddingHorizontal: 20 },
  emptyBattleIcon: { width: 64, height: 64, borderRadius: 22, justifyContent: 'center', alignItems: 'center', marginBottom: 14 },
  emptyBattleTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  emptyBattleSub: { fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 4, marginBottom: 18 },
  emptyBattleBtn: { flexDirection: 'row', alignItems: 'center', gap: 7, paddingVertical: 12, paddingHorizontal: 26, borderRadius: 14 },
  emptyBattleBtnText: { color: '#FFF', fontSize: 14, fontFamily: 'Urbanist-Bold' },

  // People grid
  peopleGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: GRID_GAP },
  personCard: {
    borderRadius: 22, borderWidth: 1, padding: 16, alignItems: 'center',
    shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.05, shadowRadius: 8, elevation: 2,
  },
  personRing: { width: 76, height: 76, borderRadius: 38, justifyContent: 'center', alignItems: 'center', padding: 3 },
  personAvatar: { width: '100%', height: '100%', borderRadius: 36, borderWidth: 2, borderColor: '#FFF' },
  personName: { fontSize: 15, fontFamily: 'Urbanist-Bold', marginTop: 12 },
  personHandle: { fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 1 },
  personFollow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingVertical: 9, borderRadius: 100, marginTop: 14, width: '100%' },
  personFollowText: { fontSize: 13, fontFamily: 'Urbanist-Bold' },

  // Empty state
  emptyState: { borderWidth: 2, borderStyle: 'dashed', borderRadius: 20, padding: 20, alignItems: 'center', marginTop: 6 },
  emptyText: { marginTop: 12, fontFamily: 'Urbanist-Medium', fontSize: 14, textAlign: 'center' },

  // Skeleton
  skLine: { height: 12, borderRadius: 6 },
  skCircle: { width: 76, height: 76, borderRadius: 38 },
  skBtn: { height: 34, borderRadius: 100, width: '100%', marginTop: 14 },
});
