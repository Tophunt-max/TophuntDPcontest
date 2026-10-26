import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView, ActivityIndicator, Keyboard } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { Image } from 'expo-image';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { Avatar } from '@/src/components/ui/Avatar';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { useAuth } from '@/src/hooks/useAuth';
import { useAuthGate } from '@/src/hooks/useAuthGate';
import { useProfile } from '@/src/hooks/useProfileData';
import { useFollowToggle } from '@/src/hooks/useFollowToggle';
import { followButtonLabel } from '@/src/lib/followState';
import { compactCount, searchView } from '@/src/lib/exploreMedia';
import { contestPrize, describePrize } from '@/src/lib/contestPrize';
import { isFreeContest } from '@/src/lib/contestPricing';
import { clearRecentSearches, loadRecentSearches, saveRecentSearch, useLiveContests, useUniversalSearch } from '@/src/services/explore';
import { BattleTile } from '@/src/components/explore/BattleTile';
import { BRAND, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { useDesignWindow } from '@/src/lib/layout';

/**
 * Universal search: people (handle or name), live contests, open/live battles and
 * blog posts, from one debounced request (GET /read/search). Recent searches are
 * kept on this device; live contests are offered as suggestions before typing.
 */
export default function ExploreSearchScreen() {
  const router = useRouter();
  const p = useExplorePalette();
  const { width } = useDesignWindow();
  const { user } = useAuth();
  const { requireAuth } = useAuthGate();
  const { data: profile } = useProfile(user?.uid || '');
  const follow = useFollowToggle((profile as any)?.following);
  const input = useRef<TextInput>(null);

  const [text, setText] = useState('');
  const [term, setTerm] = useState('');
  const [recent, setRecent] = useState<string[]>([]);

  useEffect(() => {
    loadRecentSearches().then(setRecent);
    const t = setTimeout(() => input.current?.focus(), 250);
    return () => clearTimeout(t);
  }, []);

  // 300ms debounce; the query itself is cached per term by react-query.
  useEffect(() => {
    const t = setTimeout(() => setTerm(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);

  const search = useUniversalSearch(term);
  const suggestions = useLiveContests(undefined, term.length < 2);
  const active = term.replace(/^@+/, '').length >= 2;
  const r = search.data;
  const total = r ? r.people.length + r.contests.length + r.battles.length + r.blog.length : 0;
  const view = searchView({ isError: search.isError, isLoading: search.isLoading, placeholder: search.isPlaceholderData, total: r ? total : null });

  const remember = () => {
    if (active) saveRecentSearch(text).then(setRecent);
  };
  const go = (to: any) => {
    remember();
    Keyboard.dismiss();
    router.push(to);
  };

  const tileW = (width - PAD * 2 - 12) / 2;
  const battleRows = useMemo(() => {
    const rows: any[][] = [];
    const list = r?.battles || [];
    for (let i = 0; i < list.length; i += 2) rows.push(list.slice(i, i + 2));
    return rows;
  }, [r?.battles]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} />
        <View style={[styles.box, { backgroundColor: p.card, borderColor: p.border }]}>
          <Ionicons name="search" size={18} color={BRAND} />
          <TextInput
            ref={input}
            value={text}
            onChangeText={setText}
            onSubmitEditing={remember}
            placeholder="People, battles, contests…"
            placeholderTextColor={p.sub}
            style={[styles.input, { color: p.text }]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            accessibilityLabel="Search"
          />
          {search.isFetching && active ? <ActivityIndicator size="small" color={BRAND} /> : null}
          {text.length > 0 && !(search.isFetching && active) ? (
            <TouchableOpacity onPress={() => setText('')} accessibilityLabel="Clear search" hitSlop={8}>
              <CloseIcon variant="circle" size={18} color={p.sub} />
            </TouchableOpacity>
          ) : null}
        </View>
      </View>

      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ paddingBottom: 40 }}>
        {!active ? (
          <>
            {recent.length > 0 && (
              <View>
                <View style={styles.rowHead}>
                  <Text style={[styles.label, { color: p.sub }]}>RECENT</Text>
                  <TouchableOpacity onPress={() => clearRecentSearches().then(() => setRecent([]))} accessibilityRole="button">
                    <Text style={styles.clear}>Clear</Text>
                  </TouchableOpacity>
                </View>
                {recent.map((q) => (
                  <TouchableOpacity key={q} style={styles.recent} onPress={() => setText(q)} accessibilityRole="button" accessibilityLabel={`Search ${q}`}>
                    <Ionicons name="time-outline" size={18} color={p.sub} />
                    <Text style={[styles.recentText, { color: p.text }]} numberOfLines={1}>{q}</Text>
                    <ArrowIcon size={14} color={p.sub} variant="chevron" direction="right" />
                  </TouchableOpacity>
                ))}
              </View>
            )}
            {(suggestions.data || []).length > 0 && (
              <View>
                <Text style={[styles.label, styles.labelPad, { color: p.sub }]}>LIVE CONTESTS</Text>
                <View style={styles.chips}>
                  {(suggestions.data || []).slice(0, 10).map((c: any) => (
                    <TouchableOpacity key={c.id} style={[styles.chip, { backgroundColor: p.chip }]} onPress={() => setText(c.title)}>
                      <Ionicons name={typeIcon(c.type)} size={13} color={BRAND} />
                      <Text style={[styles.chipText, { color: p.text }]} numberOfLines={1}>{c.title}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )}
            <Text style={[styles.hint, { color: p.sub }]}>Kisi ka @username ya naam, battle ya contest ka title likho.</Text>
          </>
        ) : view === 'error' ? (
          <View style={styles.center}>
            <Ionicons name="cloud-offline-outline" size={30} color={p.sub} />
            <Text style={[styles.hint, { color: p.sub }]}>Search nahi ho paya.</Text>
            <TouchableOpacity onPress={() => search.refetch()} style={styles.retry}>
              <Text style={styles.retryText}>Retry</Text>
            </TouchableOpacity>
          </View>
        ) : view === 'loading' ? (
          <ActivityIndicator color={BRAND} style={{ marginTop: 40 }} />
        ) : r && view === 'empty' ? (
          <View style={styles.center}>
            <Ionicons name="search-outline" size={34} color={p.sub} />
            <Text style={[styles.hint, { color: p.sub }]}>“{term}” ke liye kuch nahi mila.</Text>
          </View>
        ) : r ? (
          // 'stale': the previous term's results, dimmed until the new ones arrive.
          <View style={view === 'stale' ? styles.stale : null} accessibilityState={{ busy: view === 'stale' }}>
            {r.people.length > 0 && (
              <Group title="People" palette={p}>
                {r.people.map((u) => {
                  const st = follow.stateOf(u.id);
                  return (
                    <View key={u.id} style={styles.person}>
                      <TouchableOpacity style={styles.personMain} onPress={() => go(`/profile?userId=${encodeURIComponent(u.id)}`)} accessibilityRole="link">
                        <Avatar uri={u.avatar} name={u.name} size={46} />
                        <View style={{ flex: 1, marginLeft: 12 }}>
                          <View style={styles.inline}>
                            <Text style={[styles.name, { color: p.text }]} numberOfLines={1}>{u.name}</Text>
                            <VerifiedBadge verified={u.verified} size={13} />
                          </View>
                          <Text style={[styles.sub, { color: p.sub }]} numberOfLines={1}>
                            @{u.username}
                            {u.followersCount ? ` · ${compactCount(u.followersCount)} followers` : ''}
                          </Text>
                        </View>
                      </TouchableOpacity>
                      {u.id !== user?.uid && (
                        <TouchableOpacity
                          onPress={() => follow.toggle(u.id)}
                          style={[styles.follow, st === 'none' ? { backgroundColor: BRAND } : { backgroundColor: p.chip }]}
                          accessibilityRole="button"
                        >
                          <Text style={[styles.followText, { color: st === 'none' ? '#FFF' : p.text }]}>{followButtonLabel(st)}</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  );
                })}
              </Group>
            )}

            {r.contests.length > 0 && (
              <Group title="Contests" palette={p}>
                {r.contests.map((c: any) => (
                  <TouchableOpacity
                    key={c.id}
                    style={styles.contest}
                    onPress={() => {
                      if (!requireAuth('create')) return;
                      go({ pathname: c.type === 'video' ? '/contest/video' : '/contest/photo', params: { contestId: c.id } });
                    }}
                    accessibilityRole="button"
                  >
                    <View style={[styles.contestIcon, { backgroundColor: p.chip }]}>
                      {c.bannerUrl ? (
                        <Image source={{ uri: c.bannerUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
                      ) : (
                        <Ionicons name={typeIcon(c.type)} size={20} color={BRAND} />
                      )}
                    </View>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={[styles.name, { color: p.text }]} numberOfLines={1}>{c.title}</Text>
                      <Text style={[styles.sub, { color: p.sub }]} numberOfLines={1}>
                        {isFreeContest(c) ? 'Free entry' : 'Paid entry'}
                        {describePrize(contestPrize(c)) ? ` · ${describePrize(contestPrize(c))}` : ''}
                      </Text>
                    </View>
                    <Text style={styles.cta}>Start</Text>
                  </TouchableOpacity>
                ))}
              </Group>
            )}

            {r.battles.length > 0 && (
              <Group title="Battles" palette={p}>
                {battleRows.map((row, i) => (
                  <View key={i} style={styles.battleRow}>
                    {row.map((m) => (
                      <View key={m.id} onTouchEnd={remember}>
                        <BattleTile item={m} width={tileW} palette={p} />
                      </View>
                    ))}
                  </View>
                ))}
              </Group>
            )}

            {r.blog.length > 0 && (
              <Group title="Blog" palette={p}>
                {r.blog.map((b: any) => (
                  <TouchableOpacity key={b.id} style={styles.contest} onPress={() => go(`/blog/${b.slug}`)} accessibilityRole="link">
                    <View style={[styles.contestIcon, { backgroundColor: p.chip }]}>
                      {b.coverImageUrlThumb || b.coverImageUrl ? (
                        <Image source={{ uri: b.coverImageUrlThumb || b.coverImageUrl }} style={StyleSheet.absoluteFill} contentFit="cover" />
                      ) : (
                        <Ionicons name="newspaper-outline" size={20} color={BRAND} />
                      )}
                    </View>
                    <View style={{ flex: 1, marginLeft: 12 }}>
                      <Text style={[styles.name, { color: p.text }]} numberOfLines={2}>{b.title}</Text>
                      {b.category ? <Text style={[styles.sub, { color: p.sub }]}>{b.category}</Text> : null}
                    </View>
                  </TouchableOpacity>
                ))}
              </Group>
            )}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const typeIcon = (t?: string) => (t === 'video' ? 'videocam' : 'image');

function Group({ title, palette: p, children }: { title: string; palette: ExplorePalette; children: React.ReactNode }) {
  return (
    <View style={{ marginTop: 18 }}>
      <Text style={[styles.label, styles.labelPad, { color: p.sub }]} accessibilityRole="header">
        {title.toUpperCase()}
      </Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  box: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, height: 46, borderRadius: 14, borderWidth: 1, paddingHorizontal: 12 },
  input: { flex: 1, fontSize: 15, fontFamily: 'Urbanist-Medium' },
  rowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: PAD, marginTop: 16, marginBottom: 4 },
  label: { fontSize: 12, fontFamily: 'Urbanist-Bold', letterSpacing: 1 },
  labelPad: { paddingHorizontal: PAD, marginTop: 16, marginBottom: 8 },
  clear: { color: BRAND, fontFamily: 'Urbanist-Bold', fontSize: 13 },
  recent: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: PAD, paddingVertical: 11 },
  recentText: { flex: 1, fontSize: 15, fontFamily: 'Urbanist-Medium' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingHorizontal: PAD },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 100, maxWidth: '100%' },
  chipText: { fontSize: 13, fontFamily: 'Urbanist-SemiBold', flexShrink: 1 },
  hint: { textAlign: 'center', fontSize: 13, fontFamily: 'Urbanist-Medium', marginTop: 24, paddingHorizontal: 30 },
  center: { alignItems: 'center', marginTop: 50 },
  retry: { backgroundColor: BRAND, paddingHorizontal: 18, paddingVertical: 8, borderRadius: 100, marginTop: 12 },
  retryText: { color: '#FFF', fontFamily: 'Urbanist-Bold' },
  person: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, paddingVertical: 8 },
  personMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  name: { fontSize: 15, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  sub: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  follow: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 100, marginLeft: 8 },
  followText: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  contest: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: PAD, paddingVertical: 8 },
  contestIcon: { width: 48, height: 48, borderRadius: 12, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' },
  cta: { color: BRAND, fontFamily: 'Urbanist-Bold', fontSize: 13 },
  battleRow: { flexDirection: 'row', gap: 12, paddingHorizontal: PAD, marginBottom: 12 },
  stale: { opacity: 0.5 },
});
