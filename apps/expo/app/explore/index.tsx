import React, { useCallback, useMemo, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, RefreshControl, Platform, ActivityIndicator, ScrollView, Pressable } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import { useQueryClient } from '@tanstack/react-query';
import { BottomNav } from '@/src/components/home/BottomNav';
import { Ionicons } from '@/src/lib/icons';
import { DiamondIcon } from '@/src/components/ui/DiamondIcon';
import { balancesOf } from '@/src/lib/balances';
import { Avatar } from '@/src/components/ui/Avatar';
import { Skeleton } from '@/src/components/ui/Skeleton';
import { useAuth } from '@/src/hooks/useAuth';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { useProfile } from '@/src/hooks/useProfileData';
import { useCachedIdentity } from '@/src/hooks/useCachedIdentity';
import { useFollowToggle } from '@/src/hooks/useFollowToggle';
import { useAppConfig, useFeature } from '@/src/services/appSettings';
import { emitToast } from '@/src/lib/toastBridge';
import { isFreeContest } from '@/src/lib/contestPricing';
import { useDesignWindow } from '@/src/lib/layout';
import { chunk, enabledSections, joinableOpenBattles, type ExploreSectionKey, type ExploreTab } from '@/src/lib/exploreMedia';
import {
  EXPLORE_KEY,
  useBattlePages,
  useExploreBattles,
  useLiveContests,
  useSuggestedPeople,
  useTopCreators,
  type BattleKind,
  type BattleType,
} from '@/src/services/explore';
import { offerLine } from '@/src/services/referrals';
import { accountShellFlags } from '@/src/lib/authState';
import { BRAND, BRAND_GRAD, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { BattleTile } from '@/src/components/explore/BattleTile';
import { OpenBattleCard } from '@/src/components/explore/OpenBattleCard';
import { BattleTileSkeleton, CreatorChipSkeleton, OpenBattleCardSkeleton, PersonCardSkeleton, SkeletonRail, repeat } from '@/src/components/explore/ExploreSkeletons';
import { TemplateCard, TEMPLATE_H, TEMPLATE_W } from '@/src/components/explore/TemplateCard';
import { BannerCarousel } from '@/src/components/explore/BannerCarousel';
import { CreatorChip, PersonCard } from '@/src/components/explore/PeopleCards';
import { RailSkeleton, SectionEmpty, SectionError, SectionHeader } from '@/src/components/explore/ExploreBits';
import { ScaleTouchable } from '@/src/components/explore/ScaleTouchable';

/**
 * Explore — the discovery hub.
 *
 * One virtualised FlatList: a header, sticky type tabs, then the sections the
 * admin enabled (appConfig.explore.sections, in their order), then an
 * infinite-scrolling grid of fresh battles. On "People" the body is a grid of
 * suggested accounts instead.
 *
 * Every section is its own react-query query, so each one loads, caches, fails
 * and retries independently. Public: guests browse everything and are asked to
 * sign in only for an action that needs an account (follow, join, start, wallet).
 */

const TABS: { key: ExploreTab; label: string; icon: string }[] = [
  { key: 'all', label: 'For you', icon: 'apps' },
  { key: 'photo', label: 'Photo', icon: 'image' },
  { key: 'video', label: 'Video', icon: 'videocam' },
  { key: 'people', label: 'People', icon: 'people' },
];

type PriceKey = 'all' | 'free' | 'paid';
const GRID_GAP = 12;

type Row =
  | { kind: 'top' }
  | { kind: 'tabs' }
  | { kind: 'section'; key: ExploreSectionKey }
  | { kind: 'gridHeader' }
  | { kind: 'gridRow'; id: string; items: any[] }
  | { kind: 'gridFooter' }
  | { kind: 'peopleRow'; id: string; items: any[] }
  | { kind: 'peopleState' };

export default function ExploreScreen() {
  const router = useRouter();
  const qc = useQueryClient();
  const p = useExplorePalette();
  const { width } = useDesignWindow();
  const { user, status: authStatus, ready: authReady } = useAuth();
  const { requireAuth } = useAuthGate();
  const { data: profile } = useProfile(user?.uid || '');
  const identity = useCachedIdentity(user?.uid, profile);
  const { config } = useAppConfig();
  const contestsOn = useFeature('contests');

  const [tab, setTab] = useState<ExploreTab>('all');
  const [price, setPrice] = useState<PriceKey>('all');
  const [refreshing, setRefreshing] = useState(false);

  const type: BattleType = tab === 'photo' || tab === 'video' ? tab : undefined;
  const isPeople = tab === 'people';
  const sections = useMemo(() => {
    const all = enabledSections(config?.explore);
    return all.filter((k) => contestsOn || (k !== 'contests' && k !== 'openBattles'));
  }, [config?.explore, contestsOn]);
  const has = (k: ExploreSectionKey) => !isPeople && sections.includes(k);

  // ---- data (each section independent) ----
  const trending = useExploreBattles('trending', type, 10, authReady && has('trending'));
  const ending = useExploreBattles('ending', type, 10, authReady && has('endingSoon'));
  const open = useExploreBattles('open', type, 20, authReady && has('openBattles'));
  const contests = useLiveContests(type, authReady && has('contests'));
  const creators = useTopCreators(10, authReady && has('topCreators'));
  const people = useSuggestedPeople(isPeople ? 50 : 12, user?.uid ?? null, authReady && (isPeople || has('people')));
  const grid = useBattlePages('fresh', type, 18, authReady && has('grid'));

  const following = (profile as any)?.following as string[] | undefined;
  const follow = useFollowToggle(following);

  // The header chip shows Diamonds: what entry fees are paid with.
  const coins = balancesOf(profile as any).diamonds;
  const shell = accountShellFlags(authStatus, identity.hasIdentity, !!profile);
  const tileW = (width - PAD * 2 - GRID_GAP) / 2;
  const railTileW = Math.min(200, Math.round(width * 0.46));

  const openBattles = useMemo(() => joinableOpenBattles(open.data, user?.uid), [open.data, user?.uid]);
  const liveContests = useMemo(
    () => (contests.data || []).filter((c: any) => price === 'all' || (price === 'free' ? isFreeContest(c) : !isFreeContest(c))),
    [contests.data, price],
  );
  const gridItems = useMemo(() => {
    const seen = new Set<string>();
    const out: any[] = [];
    for (const page of grid.data?.pages || []) for (const m of page.items) if (!seen.has(m.id)) {
        seen.add(m.id);
        out.push(m);
      }
    return out;
  }, [grid.data]);

  const switchTab = (k: ExploreTab) => {
    if (Platform.OS !== 'web') Haptics.selectionAsync().catch(() => {});
    setTab(k);
  };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await qc.invalidateQueries({ queryKey: EXPLORE_KEY });
    } finally {
      setRefreshing(false);
    }
  }, [qc]);

  const seeAll = (kind: BattleKind) => router.push({ pathname: '/explore/battles', params: { kind, ...(type ? { type } : {}) } } as any);

  const joinBattle = useCallback(
    (item: any) => {
      if (!requireAuth('join')) return;
      if (user && item.userA?.uid === user.uid) {
        emitToast('Ye aapki battle hai — rival ka intezaar karo.', 'info');
        return;
      }
      router.push({
        pathname: item.type === 'video' ? '/contest/video' : '/contest/photo/setup',
        params: { matchId: item.id, mode: 'join' },
      } as any);
    },
    [requireAuth, router, user],
  );

  const startContest = useCallback(
    (item: any) => {
      if (!requireAuth('create')) return;
      router.push({ pathname: item.type === 'video' ? '/contest/video' : '/contest/photo', params: { contestId: item.id } } as any);
    },
    [requireAuth, router],
  );

  // ---- rows ----
  const rows: Row[] = useMemo(() => {
    const r: Row[] = [{ kind: 'top' }, { kind: 'tabs' }];
    if (isPeople) {
      const list = people.data || [];
      if (!list.length) r.push({ kind: 'peopleState' });
      chunk(list, 2).forEach((items, i) => r.push({ kind: 'peopleRow', id: `p${i}`, items }));
      return r;
    }
    for (const key of sections) if (key !== 'grid') r.push({ kind: 'section', key });
    if (sections.includes('grid')) {
      r.push({ kind: 'gridHeader' });
      chunk(gridItems, 2).forEach((items, i) => r.push({ kind: 'gridRow', id: `g${i}`, items }));
      r.push({ kind: 'gridFooter' });
    }
    return r;
  }, [isPeople, people.data, sections, gridItems]);

  // ---- section renderers ----
  const renderSection = (key: ExploreSectionKey) => {
    switch (key) {
      case 'banners': {
        const banners = config?.explore?.banners || [];
        return banners.length ? <BannerCarousel banners={banners} width={width} /> : null;
      }
      case 'quickActions':
        return <QuickActions palette={p} contestsOn={contestsOn} onGated={(route, action) => requireAuth(action) && router.push(route as any)} />;
      case 'trending':
        return (
          <BattleRail
            title="Trending battles"
            icon="flame"
            palette={p}
            query={trending}
            tileW={railTileW}
            emphasis="trending"
            onSeeAll={() => seeAll('trending')}
            emptyText="Abhi koi live battle nahi. Pehli battle start karo!"
          />
        );
      case 'endingSoon':
        return (
          <BattleRail
            title="Ending soon — vote now"
            icon="time"
            iconColor="#DC2626"
            palette={p}
            query={ending}
            tileW={railTileW}
            emphasis="ending"
            onSeeAll={() => seeAll('ending')}
            hideWhenEmpty
          />
        );
      case 'contests':
        return (
          <View>
            <SectionHeader title="Start a battle" icon="trophy" iconColor="#F59E0B" palette={p} right={<PriceToggle value={price} onChange={setPrice} palette={p} />} />
            {contests.isLoading ? (
              <RailSkeleton width={TEMPLATE_W} height={TEMPLATE_H} radius={24} />
            ) : contests.isError ? (
              <SectionError palette={p} onRetry={() => contests.refetch()} />
            ) : liveContests.length ? (
              <FlatList
                horizontal
                data={liveContests}
                keyExtractor={(c) => c.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.rail}
                renderItem={({ item }) => <TemplateCard item={item} onStart={() => startContest(item)} />}
                initialNumToRender={3}
                windowSize={3}
              />
            ) : (
              <SectionEmpty
                palette={p}
                text={price === 'all' ? 'Abhi koi contest live nahi hai.' : `Koi ${price === 'free' ? 'free' : 'paid'} contest nahi.`}
                actionText={price === 'all' ? undefined : 'Sab dikhao'}
                onAction={() => setPrice('all')}
              />
            )}
          </View>
        );
      case 'openBattles':
        return (
          <View>
            <SectionHeader title="Open battles — join now" icon="flash" palette={p} onSeeAll={openBattles.length > 3 ? () => seeAll('open') : undefined} />
            {open.isLoading ? (
              <SkeletonRail>{repeat(2, () => <OpenBattleCardSkeleton />)}</SkeletonRail>
            ) : open.isError ? (
              <SectionError palette={p} onRetry={() => open.refetch()} />
            ) : openBattles.length ? (
              <FlatList
                horizontal
                data={openBattles}
                keyExtractor={(m) => m.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.rail}
                renderItem={({ item }) => <OpenBattleCard item={item} isMine={!!user && item.userA?.uid === user.uid} palette={p} onJoin={joinBattle} />}
                initialNumToRender={2}
                windowSize={3}
              />
            ) : (
              <SectionEmpty
                palette={p}
                icon="flash-outline"
                text="Koi battle rival ka intezaar nahi kar rahi."
                actionText={contestsOn ? 'Apni battle start karo' : undefined}
                onAction={() => requireAuth('create') && router.push('/contest/photo' as any)}
              />
            )}
          </View>
        );
      case 'topCreators':
        return (
          <View>
            <SectionHeader title="Top creators" icon="trophy" iconColor="#F59E0B" palette={p} onSeeAll={() => router.push('/explore/leaderboard' as any)} />
            {creators.isLoading ? (
              <SkeletonRail gap={8}>{repeat(5, () => <CreatorChipSkeleton />)}</SkeletonRail>
            ) : creators.isError ? (
              <SectionError palette={p} onRetry={() => creators.refetch()} />
            ) : (creators.data || []).length ? (
              <FlatList
                horizontal
                data={creators.data}
                keyExtractor={(u: any) => u.uid}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={[styles.rail, { gap: 8 }]}
                renderItem={({ item, index }) => <CreatorChip user={item} rank={index + 1} palette={p} />}
              />
            ) : (
              <SectionEmpty palette={p} text="Abhi rankings ban rahi hain." />
            )}
          </View>
        );
      case 'people':
        return (
          <View>
            <SectionHeader title="People you may know" icon="people" iconColor="#22C55E" palette={p} onSeeAll={() => switchTab('people')} />
            {people.isLoading ? (
              <SkeletonRail>{repeat(3, () => <PersonCardSkeleton width={150} />)}</SkeletonRail>
            ) : people.isError ? (
              <SectionError palette={p} onRetry={() => people.refetch()} />
            ) : (people.data || []).length ? (
              <FlatList
                horizontal
                data={people.data}
                keyExtractor={(u) => u.id}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.rail}
                renderItem={({ item }) => (
                  <PersonCard person={item} width={150} palette={p} followState={follow.stateOf(item.id)} onFollow={follow.toggle} />
                )}
              />
            ) : (
              <SectionEmpty palette={p} text="Aap sabko follow kar chuke ho! 🎉" />
            )}
          </View>
        );
      default:
        return null;
    }
  };

  const renderRow = ({ item: row }: { item: Row }) => {
    switch (row.kind) {
      case 'top':
        return (
          <TopBar
            palette={p}
            signedIn={authStatus === 'authenticated'}
            avatarLoading={shell.avatarLoading}
            balanceLoading={shell.balanceLoading}
            coins={coins}
            avatar={identity.avatarUrl}
            name={identity.name}
            guestOffer={shell.showGuestUi && config?.referral?.enabled ? offerLine(config.referral) : null}
            onSearch={() => router.push('/explore/search' as any)}
            onProfile={() => requireAuth('profile') && router.push('/profile' as any)}
            onNotifications={() => requireAuth('notifications') && router.push('/notifications' as any)}
            onWallet={() => router.push('/wallet/store' as any)}
            onSignUp={() => router.push('/auth/signup' as any)}
          />
        );
      case 'tabs':
        return <Tabs tab={tab} onChange={switchTab} palette={p} />;
      case 'section':
        return renderSection(row.key);
      case 'gridHeader':
        return <SectionHeader title="Fresh battles" icon="grid" palette={p} />;
      case 'gridRow':
        return (
          <View style={styles.gridRow}>
            {row.items.map((m) => (
              <BattleTile key={m.id} item={m} width={tileW} palette={p} />
            ))}
          </View>
        );
      case 'gridFooter':
        if (grid.isLoading) {
          return (
            <View style={styles.gridRow}>
              {[0, 1].map((i) => (
                <BattleTileSkeleton key={i} width={tileW} />
              ))}
            </View>
          );
        }
        if (grid.isError && !gridItems.length) return <SectionError palette={p} onRetry={() => grid.refetch()} />;
        if (grid.isFetchingNextPage) return <ActivityIndicator color={BRAND} style={{ marginVertical: 20 }} />;
        if (!gridItems.length) return <SectionEmpty palette={p} text="Abhi koi live battle nahi." />;
        if (!grid.hasNextPage) return <Text style={[styles.end, { color: p.sub }]}>Sab dekh liya! 🎉</Text>;
        return null;
      case 'peopleRow':
        return (
          <View style={styles.gridRow}>
            {row.items.map((u) => (
              <PersonCard key={u.id} person={u} width={tileW} palette={p} followState={follow.stateOf(u.id)} onFollow={follow.toggle} />
            ))}
          </View>
        );
      case 'peopleState':
        if (people.isLoading) {
          return (
            <View style={[styles.gridRow, { marginTop: 18 }]}>
              {[0, 1].map((i) => (
                <PersonCardSkeleton key={i} width={tileW} />
              ))}
            </View>
          );
        }
        if (people.isError) return <View style={{ marginTop: 18 }}><SectionError palette={p} onRetry={() => people.refetch()} /></View>;
        return (
          <View style={{ marginTop: 18 }}>
            <SectionEmpty palette={p} icon="people-outline" text="Abhi suggest karne ko koi nahi. Search karke dhundo!" actionText="Search" onAction={() => router.push('/explore/search' as any)} />
          </View>
        );
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <FlatList
        data={rows}
        keyExtractor={(r, i) => ('id' in r ? r.id : r.kind === 'section' ? `s-${r.key}` : `${r.kind}-${i}`)}
        renderItem={renderRow}
        stickyHeaderIndices={[1]}
        contentContainerStyle={{ paddingBottom: 120 }}
        keyboardShouldPersistTaps="handled"
        onEndReachedThreshold={0.6}
        onEndReached={() => {
          if (!isPeople && grid.hasNextPage && !grid.isFetchingNextPage) grid.fetchNextPage();
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={BRAND} colors={[BRAND]} />}
        initialNumToRender={8}
        windowSize={7}
        removeClippedSubviews={Platform.OS === 'android'}
      />
      <BottomNav backgroundColor={p.bg} isDark={p.isDark} />
    </SafeAreaView>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function TopBar({
  palette: p,
  signedIn,
  avatarLoading,
  balanceLoading,
  coins,
  avatar,
  name,
  guestOffer,
  onSearch,
  onProfile,
  onNotifications,
  onWallet,
  onSignUp,
}: {
  palette: ExplorePalette;
  signedIn: boolean;
  avatarLoading: boolean;
  balanceLoading: boolean;
  coins: number;
  avatar: string | null;
  name: string | null;
  guestOffer: string | null;
  onSearch: () => void;
  onProfile: () => void;
  onNotifications: () => void;
  onWallet: () => void;
  onSignUp: () => void;
}) {
  return (
    <View style={{ backgroundColor: p.bg }}>
      <View style={styles.topBar}>
        <TouchableOpacity onPress={onProfile} accessibilityRole="button" accessibilityLabel="My profile">
          {avatarLoading ? (
            <Skeleton width={42} height={42} borderRadius={21} />
          ) : (
            <Avatar uri={avatar} name={name} size={42} style={[styles.headerAvatar, { borderColor: BRAND }]} />
          )}
        </TouchableOpacity>
        <View style={{ flex: 1, marginLeft: 12 }}>
          <Text style={[styles.kicker, { color: BRAND }]}>DISCOVER</Text>
          <Text style={[styles.title, { color: p.text }]} accessibilityRole="header">Explore</Text>
        </View>
        {signedIn && (balanceLoading ? (
          <Skeleton width={76} height={38} borderRadius={19} />
        ) : (
          <TouchableOpacity style={[styles.coinChip, { backgroundColor: p.chip }]} onPress={onWallet} accessibilityRole="button" accessibilityLabel={`${coins} Diamonds. Buy Diamonds`}>
            <DiamondIcon size={14} />
            <Text style={[styles.coinText, { color: p.text }]}>{coins.toLocaleString()}</Text>
            <View style={styles.coinPlus}>
              <Ionicons name="add" size={13} color="#FFF" />
            </View>
          </TouchableOpacity>
        ))}
        <TouchableOpacity style={[styles.iconBtn, { backgroundColor: p.chip }]} onPress={onNotifications} accessibilityRole="button" accessibilityLabel="Notifications">
          <Ionicons name="notifications" size={20} color={BRAND} />
        </TouchableOpacity>
      </View>

      <Pressable onPress={onSearch} style={[styles.search, { backgroundColor: p.card, borderColor: p.border }]} accessibilityRole="search" accessibilityLabel="Search people, battles, contests">
        <Ionicons name="search" size={19} color={BRAND} />
        <Text style={[styles.searchText, { color: p.sub }]} numberOfLines={1}>Search people, battles, contests…</Text>
      </Pressable>

      {guestOffer ? (
        <ScaleTouchable style={styles.guest} onPress={onSignUp} accessibilityRole="button" accessibilityLabel={`Sign up. ${guestOffer}`}>
          <LinearGradient colors={BRAND_GRAD} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.guestInner}>
            <Ionicons name="gift" size={22} color="#FFF" />
            <View style={{ flex: 1 }}>
              <Text style={styles.guestTitle}>TopHunt join karo — vote karo, battle jeeto</Text>
              <Text style={styles.guestSub} numberOfLines={2}>{guestOffer}</Text>
            </View>
            <Text style={styles.guestCta}>Sign up</Text>
          </LinearGradient>
        </ScaleTouchable>
      ) : null}
    </View>
  );
}

function Tabs({ tab, onChange, palette: p }: { tab: ExploreTab; onChange: (k: ExploreTab) => void; palette: ExplorePalette }) {
  return (
    <View style={[styles.tabsBar, { backgroundColor: p.bg }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: PAD, gap: 8 }} accessibilityRole="tablist">
        {TABS.map((t) => {
          const active = t.key === tab;
          return (
            <TouchableOpacity
              key={t.key}
              onPress={() => onChange(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              activeOpacity={0.85}
            >
              {active ? (
                <LinearGradient colors={BRAND_GRAD} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.tab}>
                  <Ionicons name={t.icon} size={15} color="#FFF" />
                  <Text style={[styles.tabText, { color: '#FFF' }]}>{t.label}</Text>
                </LinearGradient>
              ) : (
                <View style={[styles.tab, { backgroundColor: p.chip }]}>
                  <Ionicons name={t.icon} size={15} color={p.sub} />
                  <Text style={[styles.tabText, { color: p.sub }]}>{t.label}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

function PriceToggle({ value, onChange, palette: p }: { value: PriceKey; onChange: (v: PriceKey) => void; palette: ExplorePalette }) {
  return (
    <View style={[styles.price, { backgroundColor: p.chip }]}>
      {(['all', 'free', 'paid'] as const).map((k) => (
        <TouchableOpacity
          key={k}
          onPress={() => onChange(k)}
          style={[styles.priceItem, value === k && { backgroundColor: p.card }]}
          accessibilityRole="button"
          accessibilityState={{ selected: value === k }}
        >
          <Text style={[styles.priceText, { color: value === k ? p.text : p.sub }]}>{k === 'all' ? 'All' : k === 'free' ? 'Free' : 'Paid'}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const QUICK: { key: string; label: string; icon: string; grad: [string, string]; route: string; gate?: 'wallet' | 'create' }[] = [
  { key: 'ranks', label: 'Ranks', icon: 'trophy', grad: ['#FFB300', '#FF7A00'], route: '/explore/leaderboard' },
  { key: 'photo', label: 'Photo battle', icon: 'image', grad: ['#FF4D67', '#FF7A45'], route: '/contest/photo' },
  { key: 'video', label: 'Video battle', icon: 'videocam', grad: ['#6A5AE0', '#8B5CF6'], route: '/contest/video' },
  { key: 'refer', label: 'Refer & Earn', icon: 'gift', grad: ['#22C55E', '#16A34A'], route: '/referral', gate: 'wallet' },
  { key: 'wallet', label: 'Wallet', icon: 'wallet', grad: ['#0EA5E9', '#2563EB'], route: '/wallet', gate: 'wallet' },
];

function QuickActions({
  palette: p,
  contestsOn,
  onGated,
}: {
  palette: ExplorePalette;
  contestsOn: boolean;
  onGated: (route: string, action: 'wallet' | 'create') => void;
}) {
  const router = useRouter();
  const items = QUICK.filter((q) => contestsOn || (q.key !== 'photo' && q.key !== 'video'));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.quickRow}>
      {items.map((a) => (
        <ScaleTouchable
          key={a.key}
          style={styles.quickItem}
          onPress={() => (a.gate ? onGated(a.route, a.gate) : router.push(a.route as any))}
          accessibilityRole="button"
          accessibilityLabel={a.label}
        >
          <LinearGradient colors={a.grad} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.quickCircle}>
            <Ionicons name={a.icon} size={21} color="#FFF" />
          </LinearGradient>
          <Text style={[styles.quickLabel, { color: p.sub }]} numberOfLines={1}>{a.label}</Text>
        </ScaleTouchable>
      ))}
    </ScrollView>
  );
}

function BattleRail({
  title,
  icon,
  iconColor,
  palette: p,
  query,
  tileW,
  emphasis,
  onSeeAll,
  emptyText,
  hideWhenEmpty,
}: {
  title: string;
  icon: string;
  iconColor?: string;
  palette: ExplorePalette;
  query: { data?: any[]; isLoading: boolean; isError: boolean; refetch: () => any };
  tileW: number;
  emphasis: 'trending' | 'ending';
  onSeeAll: () => void;
  emptyText?: string;
  hideWhenEmpty?: boolean;
}) {
  const list = query.data || [];
  if (hideWhenEmpty && !query.isLoading && !query.isError && !list.length) return null;
  return (
    <View>
      <SectionHeader title={title} icon={icon} iconColor={iconColor} palette={p} onSeeAll={list.length >= 4 ? onSeeAll : undefined} />
      {query.isLoading ? (
        <SkeletonRail>{repeat(3, () => <BattleTileSkeleton width={tileW} />)}</SkeletonRail>
      ) : query.isError ? (
        <SectionError palette={p} onRetry={() => query.refetch()} />
      ) : list.length ? (
        <FlatList
          horizontal
          data={list}
          keyExtractor={(m) => m.id}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.rail}
          renderItem={({ item }) => <BattleTile item={item} width={tileW} palette={p} emphasis={emphasis} />}
          initialNumToRender={3}
          windowSize={3}
        />
      ) : (
        <SectionEmpty palette={p} text={emptyText || 'Kuch nahi mila.'} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  topBar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, paddingTop: 8, gap: 8 },
  headerAvatar: { borderWidth: 2 },
  kicker: { fontSize: 11, fontFamily: 'Urbanist-Bold', letterSpacing: 1.5 },
  title: { fontSize: 26, fontFamily: 'Urbanist-Bold', letterSpacing: -0.5 },
  coinChip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 12, paddingRight: 4, height: 38, borderRadius: 19 },
  coinText: { fontSize: 14, fontFamily: 'Urbanist-Black' },
  coinPlus: { width: 26, height: 26, borderRadius: 13, backgroundColor: '#FFB300', justifyContent: 'center', alignItems: 'center' },
  iconBtn: { width: 42, height: 42, borderRadius: 14, justifyContent: 'center', alignItems: 'center' },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 50,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    marginHorizontal: PAD,
    marginTop: 14,
  },
  searchText: { flex: 1, fontSize: 15, fontFamily: 'Urbanist-Medium' },
  guest: { marginHorizontal: PAD, marginTop: 14, borderRadius: 18, overflow: 'hidden' },
  guestInner: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14 },
  guestTitle: { color: '#FFF', fontSize: 14, fontFamily: 'Urbanist-Bold' },
  guestSub: { color: 'rgba(255,255,255,0.9)', fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  guestCta: { color: BRAND, backgroundColor: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 12, paddingHorizontal: 12, paddingVertical: 7, borderRadius: 100, overflow: 'hidden' },
  tabsBar: { paddingVertical: 12, zIndex: 10 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 9, borderRadius: 14 },
  tabText: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  rail: { paddingHorizontal: PAD, gap: 12 },
  gridRow: { flexDirection: 'row', gap: GRID_GAP, paddingHorizontal: PAD, marginBottom: GRID_GAP },
  end: { textAlign: 'center', fontFamily: 'Urbanist-Medium', fontSize: 13, marginVertical: 18 },
  price: { flexDirection: 'row', borderRadius: 10, padding: 3 },
  priceItem: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 8 },
  priceText: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  quickRow: { paddingHorizontal: PAD, gap: 14, paddingTop: 20 },
  quickItem: { alignItems: 'center', width: 70 },
  quickCircle: { width: 56, height: 56, borderRadius: 19, justifyContent: 'center', alignItems: 'center' },
  quickLabel: { fontSize: 11, fontFamily: 'Urbanist-SemiBold', marginTop: 7, textAlign: 'center' },
});
