import React, { useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, RefreshControl, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { BackButton } from '@/src/components/ui/BackButton';
import { Ionicons } from '@/src/lib/icons';
import { emitToast } from '@/src/lib/toastBridge';
import { useAuth } from '@/src/hooks/useAuth';
import { BRAND, PAD, useExplorePalette, type ExplorePalette } from '@/src/components/explore/theme';
import { SectionEmpty, SectionError } from '@/src/components/explore/ExploreBits';
import { RarityPill } from '@/src/components/gamification/RarityPill';
import { rarityColor } from '@/src/lib/progression';
import { useAchievements, usePinAchievements, useProgression, type AchievementView } from '@/src/services/gamification';

/** Achievement collection: categories, progress, unlocked state and profile pins. */
export default function AchievementsScreen() {
  const p = useExplorePalette();
  const { user } = useAuth();
  const q = useAchievements(!!user);
  const prog = useProgression(!!user);
  const pin = usePinAchievements();
  const [category, setCategory] = useState<string>('all');

  const list = useMemo(() => q.data?.achievements ?? [], [q.data]);
  const categories = useMemo(() => ['all', ...Array.from(new Set(list.map((a) => a.category)))], [list]);
  const shown = category === 'all' ? list : list.filter((a) => a.category === category);
  const pinned = q.data?.pinned ?? [];
  const limit = q.data?.pinnedLimit ?? 3;
  const showcaseAt = prog.data?.showcaseUnlocksAt ?? 2;
  const canPin = (prog.data?.levelInfo.level ?? 0) >= showcaseAt && limit > 0;

  const togglePin = (a: AchievementView) => {
    const next = pinned.includes(a.id) ? pinned.filter((x) => x !== a.id) : [...pinned, a.id];
    if (next.length > limit) {
      emitToast(`You can pin up to ${limit}.`, 'info');
      return;
    }
    pin.mutate(next, { onError: (e: any) => emitToast(e?.message || 'Could not update pins', 'error') });
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: p.bg }]} edges={['top']}>
      <View style={styles.header}>
        <BackButton size={24} color={p.text} style={{ marginRight: 12 }} />
        <Text style={[styles.headerTitle, { color: p.text }]} accessibilityRole="header">Achievements</Text>
      </View>
      {q.isLoading ? (
        <View style={styles.center}><ActivityIndicator color={BRAND} /></View>
      ) : q.isError ? (
        <View style={{ marginTop: 30 }}><SectionError palette={p} onRetry={() => q.refetch()} label="Achievements load nahi ho paye." /></View>
      ) : (
        <FlatList
          data={shown}
          keyExtractor={(a) => a.id}
          numColumns={1}
          contentContainerStyle={{ paddingBottom: 40 }}
          refreshControl={<RefreshControl refreshing={q.isRefetching} onRefresh={() => q.refetch()} tintColor={BRAND} />}
          ListHeaderComponent={
            <View>
              <Text style={[styles.sub, { color: p.sub }]}>
                {canPin ? `Pin up to ${limit} on your profile (${pinned.length}/${limit}).` : `Pinning unlocks at level ${showcaseAt}.`}
              </Text>
              <FlatList
                horizontal
                data={categories}
                keyExtractor={(c) => c}
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ paddingHorizontal: PAD, gap: 8, paddingVertical: 10 }}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    onPress={() => setCategory(item)}
                    style={[styles.chip, { backgroundColor: item === category ? BRAND : p.chip }]}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: item === category }}
                  >
                    <Text style={[styles.chipText, { color: item === category ? '#FFF' : p.text }]}>{item === 'all' ? 'All' : item.charAt(0).toUpperCase() + item.slice(1)}</Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          }
          ListEmptyComponent={<SectionEmpty palette={p} icon="ribbon-outline" text="No achievements here yet." />}
          renderItem={({ item }) => (
            <Card a={item} p={p} pinned={pinned.includes(item.id)} canPin={canPin && item.unlocked} onPin={() => togglePin(item)} busy={pin.isPending} />
          )}
        />
      )}
    </SafeAreaView>
  );
}

const Card = React.memo(function Card({
  a, p, pinned, canPin, onPin, busy,
}: { a: AchievementView; p: ExplorePalette; pinned: boolean; canPin: boolean; onPin: () => void; busy: boolean }) {
  const color = a.unlocked ? rarityColor(a.rarity) : p.sub;
  const pct = a.target ? Math.min(100, ((a.progress ?? 0) / a.target) * 100) : 0;
  return (
    <View
      style={[styles.card, { backgroundColor: p.card, borderColor: a.unlocked ? `${color}66` : p.border, opacity: a.unlocked ? 1 : 0.85 }]}
      accessible
      accessibilityLabel={`${a.name}. ${a.description}. ${a.unlocked ? 'Unlocked' : a.target ? `Progress ${a.progress} of ${a.target}` : 'Locked'}.`}
    >
      <View style={[styles.icon, { backgroundColor: `${color}22` }]}>
        <Ionicons name={a.unlocked ? a.icon : 'lock-closed'} size={22} color={color} />
      </View>
      <View style={{ flex: 1 }}>
        <View style={styles.titleRow}>
          <Text style={[styles.name, { color: p.text }]} numberOfLines={1}>{a.name}{a.maxTier > 1 && a.tier ? ` · Tier ${a.tier}` : ''}</Text>
          <RarityPill rarity={a.rarity} />
        </View>
        <Text style={[styles.desc, { color: p.sub }]}>{a.description}</Text>
        {!a.unlocked && a.target ? (
          <>
            <View style={[styles.bar, { backgroundColor: p.chip }]}><View style={[styles.fill, { width: `${pct}%` }]} /></View>
            <Text style={[styles.desc, { color: p.sub }]}>{a.progress}/{a.target}{a.xpReward ? ` · +${a.xpReward} XP` : ''}</Text>
          </>
        ) : a.unlocked ? (
          <Text style={[styles.desc, { color: '#22C55E' }]}>Unlocked{a.unlockedAt ? ` · ${new Date(a.unlockedAt).toLocaleDateString()}` : ''}</Text>
        ) : (
          <Text style={[styles.desc, { color: p.sub }]}>Awarded by the TopHunt team</Text>
        )}
      </View>
      {canPin ? (
        <TouchableOpacity onPress={onPin} disabled={busy} accessibilityRole="button" accessibilityLabel={pinned ? `Unpin ${a.name}` : `Pin ${a.name}`} hitSlop={8}>
          <Ionicons name={pinned ? 'bookmark' : 'bookmark-outline'} size={20} color={pinned ? BRAND : p.sub} />
        </TouchableOpacity>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', height: 56, paddingHorizontal: 16 },
  headerTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  sub: { paddingHorizontal: PAD, fontSize: 12, fontFamily: 'Urbanist-Medium' },
  chip: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 14 },
  chipText: { fontSize: 12, fontFamily: 'Urbanist-Bold' },
  card: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: PAD, marginBottom: 10, padding: 14, borderRadius: 16, borderWidth: 1 },
  icon: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 15, fontFamily: 'Urbanist-Bold', flexShrink: 1 },
  desc: { fontSize: 12, fontFamily: 'Urbanist-Medium', marginTop: 2 },
  bar: { height: 6, borderRadius: 3, marginTop: 6, overflow: 'hidden' },
  fill: { height: '100%', backgroundColor: BRAND, borderRadius: 3 },
});
