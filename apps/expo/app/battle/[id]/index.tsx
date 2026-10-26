import React, { useCallback, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, RefreshControl, StatusBar } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery } from '@tanstack/react-query';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { contestService } from '@/src/services/contests/contestService';
import { PostCard } from '@/src/components/home/PostCard';
import { PostSkeleton } from '@/src/components/home/PostSkeleton';
import { StoryVsFrame } from '@/src/components/stories/StoryVsFrame';
import { BottomNav } from '@/src/components/home/BottomNav';
import { BackButton } from '@/src/components/ui/BackButton';
import { useAuth } from '@/src/hooks/useAuth';
import { useWebSeo } from '@/src/lib/webSeo';
import { useScreenPlayback } from '@/src/hooks/useListPlayback';

/**
 * A shared battle: `https://tophunt.in/battle/<id>` — the post-detail page.
 *
 * The target of every share link (src/lib/share.ts). On a device with the app
 * installed the verified App Link opens the app straight here; in a browser the
 * web build serves it (the edge worker adds the og tags for link previews).
 *
 * It renders the SAME `PostCard` as the home feed, so a visitor gets the whole
 * battle — both entries, the live vote count, the countdown, likes, comments,
 * save and share — not a picture with a button. Guests can read everything;
 * voting, liking, commenting and saving ask them to sign in at the tap and
 * bring them back here (useAuthGate). A battle still waiting for an opponent has
 * nothing to vote on yet, so it shows its single entry with the VS frame.
 */
export default function BattleDetail() {
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === 'string' ? rawId : '';
  const router = useRouter();
  const { user } = useAuth();
  const isDark = useColorScheme() === 'dark';
  const bg = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const sub = isDark ? '#A0A0A0' : '#666';
  const [refreshing, setRefreshing] = useState(false);
  // Pauses under a pushed screen or in the background (was always playing).
  const playActive = useScreenPlayback();

  // Per-viewer: the answer carries the viewer's like/vote/save state, and a
  // battle with someone the viewer blocked reads as missing.
  const { data: match, isLoading, isError, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['battle', id, user?.uid ?? 'guest'],
    queryFn: () => contestService.getMatchById(id),
    enabled: !!id,
    staleTime: 10_000,
  });

  const a = match?.userA;
  const b = match?.userB;
  const versus = a?.username && b?.username ? `@${a.username} vs @${b.username}` : 'Battle';
  useWebSeo({
    title: match?.title ? `${match.title} — ${versus}` : versus,
    description: 'Vote for your favourite in this head-to-head battle on TopHunt.',
    canonical: id ? `https://tophunt.in/battle/${encodeURIComponent(id)}` : undefined,
    image: typeof match?.vsImageUrl === 'string' ? match.vsImageUrl : undefined,
    type: 'article',
  });

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refetch();
    } finally {
      setRefreshing(false);
    }
  }, [refetch]);

  const goHome = () => router.replace('/home');

  const header = (
    <View style={[styles.header, { borderBottomColor: isDark ? '#23262D' : '#EEF0F4' }]}>
      <BackButton size={24} color={textColor} />
      <Text style={[styles.headerTitle, { color: textColor }]} numberOfLines={1}>
        {match?.title || 'Battle'}
      </Text>
    </View>
  );

  // Two-sided battles render as the full feed card. A waiting battle has only one
  // entry and PostCard needs both, so it keeps the VS frame.
  const twoSided = !!(a?.uid && b?.uid);
  const unavailable = !id || (!isLoading && (!match || isError || match.status === 'cancelled'));

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: bg }]} edges={['top', 'left', 'right']}>
      <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
      {header}
      {isLoading ? (
        <PostSkeleton isDark={isDark} />
      ) : unavailable ? (
        <View style={styles.center}>
          <Text style={[styles.missingTitle, { color: textColor }]}>This battle isn&apos;t available</Text>
          <Text style={[styles.missingBody, { color: sub }]}>
            {id ? 'It may have been removed, or the link may be wrong.' : 'This battle link is invalid.'}
          </Text>
          <TouchableOpacity style={styles.cta} onPress={goHome} accessibilityRole="button" accessibilityLabel="See more battles">
            <Text style={styles.ctaText}>See more battles</Text>
          </TouchableOpacity>
        </View>
      ) : twoSided ? (
        <ScrollView
          contentContainerStyle={{ paddingBottom: 32 }}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#FF4D67" colors={['#FF4D67']} />}
        >
          {/*
            PostCard seeds its like/vote/save state from `item` on mount only, so
            it is re-keyed on every fresh answer: pull-to-refresh, and the
            return trip after a sign-in that the vote/like prompt started.
          */}
          <PostCard key={`${user?.uid ?? 'guest'}:${dataUpdatedAt}`} item={match} isDark={isDark} playActive={playActive} />
          <TouchableOpacity style={[styles.cta, styles.more]} onPress={goHome} accessibilityRole="button" accessibilityLabel="See more battles">
            <Text style={styles.ctaText}>See more battles</Text>
          </TouchableOpacity>
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>
          <View style={styles.frameWrap}>
            <StoryVsFrame matchId={id} />
          </View>
          <Text style={[styles.waiting, { color: sub }]}>Waiting for an opponent — check back soon.</Text>
          <TouchableOpacity style={[styles.cta, styles.more]} onPress={goHome} accessibilityRole="button" accessibilityLabel="See more battles">
            <Text style={styles.ctaText}>See more battles</Text>
          </TouchableOpacity>
        </View>
      )}
      <BottomNav backgroundColor={bg} isDark={isDark} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, gap: 4 },
  headerTitle: { flex: 1, fontSize: 18, fontFamily: 'Urbanist-Bold' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  missingTitle: { fontFamily: 'Urbanist-Bold', fontSize: 18, textAlign: 'center' },
  missingBody: { fontFamily: 'Urbanist-Regular', fontSize: 14, textAlign: 'center', marginTop: 8 },
  frameWrap: { flex: 1, margin: 16, borderRadius: 16, overflow: 'hidden', backgroundColor: '#000' },
  waiting: { fontFamily: 'Urbanist-Medium', fontSize: 14, textAlign: 'center' },
  cta: { backgroundColor: '#FF4D67', height: 50, borderRadius: 25, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, marginTop: 20 },
  more: { alignSelf: 'center', marginBottom: 12 },
  ctaText: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 16 },
});
