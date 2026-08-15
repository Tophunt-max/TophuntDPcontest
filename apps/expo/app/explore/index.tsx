import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, SafeAreaView, useColorScheme, Image, TouchableOpacity,
  ScrollView, Dimensions, TextInput, Animated as RNAnimated, FlatList,
} from 'react-native';
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

const { width } = Dimensions.get('window');
const PAD = 20;
const CONTENT_W = width - PAD * 2;
const GRID_GAP = 14;
const PEOPLE_CARD_W = (CONTENT_W - GRID_GAP) / 2;
const TEMPLATE_W = 168;

type TabKey = 'photo' | 'video' | 'users';

const TABS: {
  key: TabKey;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  color: string;
  grad: [string, string];
}[] = [
  { key: 'photo', label: 'Photos', icon: 'image', color: '#FF4D67', grad: ['#FF4D67', '#FF7A45'] },
  { key: 'video', label: 'Videos', icon: 'videocam', color: '#6A5AE0', grad: ['#6A5AE0', '#8B5CF6'] },
  { key: 'users', label: 'People', icon: 'people', color: '#22C55E', grad: ['#22C55E', '#16A34A'] },
];

const QUICK_ACTIONS: {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  grad: [string, string];
  route: string;
}[] = [
  { key: 'leaderboard', label: 'Ranks', icon: 'trophy', grad: ['#FFB300', '#FF7A00'], route: '/explore/leaderboard' },
  { key: 'contests', label: 'Contests', icon: 'flame', grad: ['#FF4D67', '#FF7A45'], route: '/contests' },
  { key: 'rewards', label: 'Rewards', icon: 'gift', grad: ['#22C55E', '#16A34A'], route: '/wallet/store' },
  { key: 'wallet', label: 'Wallet', icon: 'wallet', grad: ['#6A5AE0', '#8B5CF6'], route: '/wallet' },
];

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
  const [followedUsers, setFollowedUsers] = useState<Set<string>>(new Set());

  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<TabKey>('photo');

  const activeMeta = TABS.find(t => t.key === activeTab)!;
  const activeColor = activeMeta.color;

  useEffect(() => {
    if (currentUserProfile && currentUserProfile.following) {
      setFollowedUsers(new Set(currentUserProfile.following));
    }
  }, [currentUserProfile]);

  useEffect(() => {
    if (!authLoading) fetchExploreData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authLoading, user]);

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

  const handleAction = (action: () => void) => {
    if (!user) {
      router.push(`/auth/login?redirect=${encodeURIComponent('/explore')}`);
    } else {
      action();
    }
  };

  const handleFollow = async (targetId: string) => {
    handleAction(async () => {
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
  const filteredContests = availableContests.filter(c =>
    (c.type === activeTab || (!c.type && activeTab === 'photo')) &&
    (!q || c.title?.toLowerCase().includes(q))
  );
  const filteredMatches = waitingMatches.filter(m =>
    (m.type === activeTab || (!m.type && activeTab === 'photo')) &&
    (!q || m.title?.toLowerCase().includes(q) || m.userA?.username?.toLowerCase().includes(q))
  );
  const filteredUsers = suggestedUsers.filter(u =>
    !q || u.name?.toLowerCase().includes(q) || u.username?.toLowerCase().includes(q)
  );

  // ================================================================
  // HEADER (non-sticky)
  // ================================================================
  const renderHeader = () => (
    <View style={{ backgroundColor: bg }}>
      {/* Top bar */}
      <View style={styles.topBar}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.kicker, { color: activeColor }]}>DISCOVER</Text>
          <Text style={[styles.title, { color: textColor }]}>Explore</Text>
        </View>
        <TouchableOpacity
          activeOpacity={0.85}
          style={[styles.iconBtn, { backgroundColor: chipBg }]}
          onPress={() => handleAction(() => router.push('/explore/leaderboard'))}
        >
          <Ionicons name="trophy" size={20} color="#FFB300" />
        </TouchableOpacity>
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
            placeholder={`Search ${activeTab === 'users' ? 'people' : activeTab}...`}
            placeholderTextColor={subText}
            value={searchQuery}
            onChangeText={setSearchQuery}
            returnKeyType="search"
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <Ionicons name="close-circle" size={18} color={subText} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Quick action shortcuts */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.quickRow}
      >
        {QUICK_ACTIONS.map(a => (
          <TouchableOpacity
            key={a.key}
            activeOpacity={0.85}
            style={styles.quickItem}
            onPress={() => handleAction(() => router.push(a.route as any))}
          >
            <LinearGradient colors={a.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.quickCircle}>
              <Ionicons name={a.icon} size={22} color="#FFF" />
            </LinearGradient>
            <Text style={[styles.quickLabel, { color: subText }]}>{a.label}</Text>
          </TouchableOpacity>
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
              <TouchableOpacity key={tab.key} activeOpacity={0.9} onPress={() => setActiveTab(tab.key)}>
                <LinearGradient colors={tab.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.chipActive}>
                  <Ionicons name={tab.icon} size={16} color="#FFF" />
                  <Text style={styles.chipActiveText}>{tab.label}</Text>
                  {count > 0 && (
                    <View style={styles.chipCount}>
                      <Text style={styles.chipCountText}>{count}</Text>
                    </View>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            );
          }
          return (
            <TouchableOpacity
              key={tab.key}
              activeOpacity={0.85}
              style={[styles.chip, { backgroundColor: chipBg }]}
              onPress={() => setActiveTab(tab.key)}
            >
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
    const prize = item.rewardCoins ?? item.totalEntryFee ?? item.entryFee ?? 0;
    return (
      <TouchableOpacity
        key={item.id}
        activeOpacity={0.9}
        style={styles.templateCard}
        onPress={() => handleAction(() => router.push({
          pathname: isVideo ? '/contest/video' : '/contest/photo',
          params: { contestId: item.id },
        }))}
      >
        <LinearGradient colors={activeMeta.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.templateInner}>
          <MaterialCommunityIcons
            name={isVideo ? 'movie-open-star' : 'image-filter-hdr'}
            size={72}
            color="rgba(255,255,255,0.14)"
            style={styles.templateWm}
          />
          <View style={styles.templateIcon}>
            <MaterialCommunityIcons name={isVideo ? 'movie-open-play' : 'image-multiple'} size={20} color="#FFF" />
          </View>
          {prize > 0 && (
            <View style={styles.templatePrize}>
              <FontAwesome5 name="coins" size={9} color="#FFF" />
              <Text style={styles.templatePrizeText}>{prize}</Text>
            </View>
          )}
          <View style={{ flex: 1, justifyContent: 'flex-end' }}>
            <Text style={styles.templateTitle} numberOfLines={2}>{item.title}</Text>
            <View style={styles.templateCta}>
              <Text style={styles.templateCtaText}>Start Battle</Text>
              <Ionicons name="arrow-forward" size={12} color={activeColor} />
            </View>
          </View>
        </LinearGradient>
      </TouchableOpacity>
    );
  };

  // ================================================================
  // VERSUS / LIVE BATTLE CARD (redesigned)
  // ================================================================
  const renderVersus = (item: any) => {
    const isMyMatch = user && item.userA && item.userA.uid === user.uid;
    const entryFee = item.entryFee ? item.entryFee / 2 : 0;
    const prize = item.entryFee || 0;
    const isVideo = item.type === 'video';

    const goJoin = () => handleAction(() => {
      if (isMyMatch) { addToast('This is your own contest! Wait for someone to join.', 'info'); return; }
      router.push({
        pathname: isVideo ? '/contest/video/setup' : '/contest/photo/setup',
        params: { matchId: item.id, mode: 'join' },
      });
    });

    return (
      <View key={item.id} style={[styles.battleCard, { backgroundColor: cardBg, borderColor }]}>
        {/* Media strip */}
        <View style={styles.battleMedia}>
          <Image source={{ uri: item.userA?.mediaUrl }} style={styles.battleImg} />
          <LinearGradient colors={['transparent', 'rgba(0,0,0,0.75)']} style={StyleSheet.absoluteFill as any} />

          {/* top row: status + prize */}
          <View style={styles.battleTopRow}>
            <View style={styles.statusPill}>
              <View style={styles.liveDot} />
              <Text style={styles.statusText}>WAITING</Text>
            </View>
            <View style={styles.prizePill}>
              <FontAwesome5 name="coins" size={10} color="#FFB300" />
              <Text style={styles.prizeText}>{prize}</Text>
            </View>
          </View>

          {/* creator chip */}
          <View style={styles.creatorChip}>
            <Image source={{ uri: item.userA?.avatar || 'https://via.placeholder.com/50' }} style={styles.creatorAvatar} />
            <Text style={styles.creatorName} numberOfLines={1}>@{item.userA?.username || 'user'}</Text>
          </View>

          {/* VS badge */}
          <View style={styles.vsWrap}>
            <LinearGradient colors={activeMeta.grad} style={styles.vsCircle}>
              <Text style={styles.vsText}>VS</Text>
            </LinearGradient>
          </View>
        </View>

        {/* footer */}
        <View style={styles.battleFooter}>
          <View style={{ flex: 1, marginRight: 12 }}>
            <Text style={[styles.battleTitle, { color: textColor }]} numberOfLines={1}>{item.title || 'Untitled Battle'}</Text>
            {!isMyMatch ? (
              <View style={styles.entryRow}>
                <Text style={[styles.entryLabel, { color: subText }]}>Entry</Text>
                <FontAwesome5 name="coins" size={10} color={activeColor} />
                <Text style={[styles.entryVal, { color: activeColor }]}>{entryFee}</Text>
              </View>
            ) : (
              <Text style={[styles.entryLabel, { color: subText, marginTop: 4 }]}>Your battle · waiting for a rival</Text>
            )}
          </View>
          <TouchableOpacity activeOpacity={0.85} onPress={goJoin} disabled={!!isMyMatch}>
            <LinearGradient
              colors={isMyMatch ? ['#9AA0AA', '#7E848E'] : activeMeta.grad}
              start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
              style={styles.joinBtn}
            >
              <Ionicons name={isMyMatch ? 'hourglass' : 'flash'} size={14} color="#FFF" />
              <Text style={styles.joinBtnText}>{isMyMatch ? 'Waiting' : 'Join Battle'}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </View>
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
          <SectionHeader icon="people" color={activeColor} title="Suggested People" textColor={textColor} />
          {filteredUsers.length === 0 ? (
            <EmptyState icon="people-outline" text="No people found." border={borderColor} sub={subText} />
          ) : (
            <View style={styles.peopleGrid}>
              {filteredUsers.map(renderPerson)}
            </View>
          )}
        </View>
      );
    }

    return (
      <View style={{ marginTop: 18 }}>
        {/* Start a battle */}
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

        {/* Live arena */}
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
            <EmptyState
              iconLib="mci" mci="sword-cross" text="No active battles right now."
              border={borderColor} sub={subText}
              actionText="Check Leaderboard"
              actionColor={activeColor}
              onAction={() => handleAction(() => router.push('/explore/leaderboard'))}
            />
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
// Small presentational helpers
// ================================================================
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
function SkeletonBody({ isDark, activeTab, cardBg, borderColor }: any) {
  const pulse = useRef(new RNAnimated.Value(0.4)).current;
  useEffect(() => {
    const loop = RNAnimated.loop(
      RNAnimated.sequence([
        RNAnimated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        RNAnimated.timing(pulse, { toValue: 0.4, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const block = isDark ? '#20222B' : '#EAEBF0';

  if (activeTab === 'users') {
    return (
      <View style={{ paddingHorizontal: PAD, marginTop: 18 }}>
        <RNAnimated.View style={{ opacity: pulse }}>
          <View style={[styles.skLine, { backgroundColor: block, width: 160, marginBottom: 16 }]} />
          <View style={styles.peopleGrid}>
            {[0, 1, 2, 3].map(i => (
              <View key={i} style={[styles.personCard, { backgroundColor: cardBg, borderColor, width: PEOPLE_CARD_W, alignItems: 'center' }]}>
                <View style={[styles.skCircle, { backgroundColor: block }]} />
                <View style={[styles.skLine, { backgroundColor: block, width: '70%', marginTop: 12 }]} />
                <View style={[styles.skLine, { backgroundColor: block, width: '45%', marginTop: 6, height: 8 }]} />
                <View style={[styles.skBtn, { backgroundColor: block }]} />
              </View>
            ))}
          </View>
        </RNAnimated.View>
      </View>
    );
  }

  return (
    <View style={{ marginTop: 18 }}>
      <RNAnimated.View style={{ opacity: pulse }}>
        <View style={{ paddingHorizontal: PAD }}>
          <View style={[styles.skLine, { backgroundColor: block, width: 180, marginBottom: 16 }]} />
        </View>
        <View style={{ flexDirection: 'row', paddingHorizontal: PAD, gap: 14 }}>
          {[0, 1].map(i => (
            <View key={i} style={[styles.templateCard, { backgroundColor: block }]} />
          ))}
        </View>
        <View style={{ paddingHorizontal: PAD, marginTop: 28, gap: 16 }}>
          {[0, 1].map(i => (
            <View key={i} style={[styles.battleCard, { backgroundColor: cardBg, borderColor }]}>
              <View style={[styles.battleMedia, { backgroundColor: block }]} />
              <View style={styles.battleFooter}>
                <View style={{ flex: 1 }}>
                  <View style={[styles.skLine, { backgroundColor: block, width: '60%' }]} />
                  <View style={[styles.skLine, { backgroundColor: block, width: '30%', marginTop: 8, height: 8 }]} />
                </View>
                <View style={[styles.skBtn, { backgroundColor: block, width: 110, marginTop: 0 }]} />
              </View>
            </View>
          ))}
        </View>
      </RNAnimated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Top bar
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, paddingTop: 10, paddingBottom: 4 },
  kicker: { fontSize: 12, fontFamily: 'Urbanist-Bold', letterSpacing: 1.5, marginBottom: 2 },
  title: { fontSize: 30, fontFamily: 'Urbanist-Bold', letterSpacing: -0.5 },
  iconBtn: { width: 44, height: 44, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },

  // Search
  searchWrap: { paddingHorizontal: PAD, marginTop: 14 },
  searchBox: {
    flexDirection: 'row', alignItems: 'center', height: 52, borderRadius: 16, paddingHorizontal: 16, gap: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.05, shadowRadius: 10, elevation: 2,
  },
  searchInput: { flex: 1, fontSize: 16, fontFamily: 'Urbanist-Medium' },

  // Quick actions
  quickRow: { paddingHorizontal: PAD, gap: 20, paddingTop: 18, paddingBottom: 6 },
  quickItem: { alignItems: 'center', width: 62 },
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
    width: TEMPLATE_W, height: 200, borderRadius: 24, overflow: 'hidden',
    shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 10, elevation: 5,
  },
  templateInner: { flex: 1, padding: 16 },
  templateWm: { position: 'absolute', right: -10, top: -8 },
  templateIcon: { width: 40, height: 40, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.22)', justifyContent: 'center', alignItems: 'center' },
  templatePrize: { position: 'absolute', top: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.28)', paddingHorizontal: 9, paddingVertical: 5, borderRadius: 100 },
  templatePrizeText: { color: '#FFF', fontSize: 11, fontFamily: 'Urbanist-Black' },
  templateTitle: { color: '#FFF', fontSize: 17, fontFamily: 'Urbanist-Bold', marginBottom: 10, lineHeight: 20 },
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
