import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, useWindowDimensions, Platform, ActivityIndicator } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@/src/lib/icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeColor } from '@/hooks/use-theme-color';
import { designWidth } from '@/src/lib/layout';
import { shareBattle, battleUrl, shareOrigin } from '@/src/lib/share';
import { contestSuccessCopy, type VsStoryState } from '@/src/lib/contestSuccess';
import { contestService } from '@/src/services/contests/contestService';

/** Poll cadence and budget while the server prepares the VS Story. */
const POLL_MS = 3000;
const MAX_POLLS = 20;

/**
 * Contest congratulations screen.
 *
 * Reached from both the create and the join flow via
 * `goToCongratulations` (src/lib/contestSuccess.ts). `mode` distinguishes the
 * two, because the copy is genuinely different: a joiner is immediately live and
 * being voted on, whereas a creator is waiting for an opponent. Previously this
 * screen said "you have successfully joined" in both cases — and in fact was
 * never navigated to at all, so the wording had never been exercised.
 *
 * Everything it CLAIMS comes from the server (`getMatchStoryStatus`), never from
 * the fact that navigation happened: the VS composite and both participants'
 * stories are produced asynchronously by the Worker after the join, so "Your VS
 * Story is now live" is shown only once the server confirms both rows exist.
 * Polling is bounded and the refresh only re-reads — nothing here can re-submit
 * an entry or charge a fee twice, and the backend never waits on this screen.
 */
export default function ContestJoinedScreen() {
  const router = useRouter();
  // Reactive, unlike the module-scope `Dimensions.get('window')` this replaced,
  // which was captured at bundle load and never tracked a desktop resize.
  const { width: windowWidth } = useWindowDimensions();
  const params = useLocalSearchParams();
  const contestName = params.contestName as string || "Contest";
  const isJoining = params.mode !== 'create';
  const matchId = (params.matchId as string) || '';
  const imageUrl = (params.imageUrl as string) || '';
  const mode: 'create' | 'join' = isJoining ? 'join' : 'create';

  const [storyStatus, setStoryStatus] = useState<VsStoryState | null>(
    !isJoining ? 'waiting_for_opponent' : matchId ? null : 'unavailable',
  );
  const [vsImageUrl, setVsImageUrl] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const polls = useRef(0);
  const copy = contestSuccessCopy(mode, storyStatus);

  const checkStatus = useCallback(async () => {
    if (!matchId || !isJoining) return;
    setChecking(true);
    try {
      const res = await contestService.getMatchStoryStatus(matchId);
      if (res?.storyStatus) setStoryStatus(res.storyStatus);
      if (res?.vsImageUrl) setVsImageUrl(res.vsImageUrl);
    } catch (e) {
      // A failed read is not a failed battle; keep the last known state.
      console.warn('[ContestJoined] story status check failed', e);
      setStoryStatus((prev) => prev ?? 'preparing');
    } finally {
      setChecking(false);
    }
  }, [matchId, isJoining]);

  useEffect(() => {
    void checkStatus();
  }, [checkStatus]);

  // Bounded polling while the server reports "preparing".
  useEffect(() => {
    if (!copy.poll || !matchId || checking || polls.current >= MAX_POLLS) return;
    const t = setTimeout(() => {
      polls.current += 1;
      void checkStatus();
    }, POLL_MS);
    return () => clearTimeout(t);
  }, [copy.poll, matchId, storyStatus, checking, checkStatus]);

  const onCheckAgain = () => {
    polls.current = 0;
    void checkStatus();
  };

  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#FFF', dark: '#1F222A' }, 'background');

  /**
   * Share the battle with a LINK and the entry PHOTO — not just the caption.
   *
   * The previous version sent only `message`, so recipients got a line of text
   * with no way to reach the battle and no image. Now:
   *  - the caption carries an openable battle link (`/battle/<id>`), falling back
   *    to the app's own origin when we don't have a match id;
   *  - the link's page provides the photo as its rich preview on every target
   *    that renders one (WhatsApp, Telegram, iMessage, X, Facebook…);
   *  - on web — where a file and text can be shared together — the entry image
   *    is attached directly too.
   *
   * `shareBattle` is the app's single, tested share implementation and never
   * throws (a cancelled sheet just resolves quietly).
   */
  const handleShare = async () => {
    const link = matchId ? battleUrl(matchId) : shareOrigin();
    const intro = isJoining
      ? `I just joined the ${contestName} battle on TopHunt! Vote for me and let's win some coins.`
      : `I just started a ${contestName} battle on TopHunt! Come challenge me and win coins.`;
    const caption = link ? `${intro}\n${link}` : intro;
    await shareBattle({
      caption,
      url: link,
      // Attaching a file drops the caption/link on native (an expo-sharing
      // limit), so only attach the image where both can go together (web).
      // Prefer the server-rendered VS card once it is confirmed live.
      vsImageUrl: Platform.OS === 'web' ? vsImageUrl || imageUrl || undefined : undefined,
    });
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: bgColor }]}>
      {/*
        Scrollable, because this screen carries the two actions a user needs after
        joining (Share, Go to Home). Centred in a fixed-height View they were
        clipped off a short window with no scrollbar, stranding the user on a
        congratulations screen with no way out.
      */}
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      {/* Clamped: `width * 0.9` of a 1280px window is a 1152px-wide column. */}
      <View style={[styles.content, { width: designWidth(windowWidth) * 0.9 }]}>
        
        {/* Success Icon */}
        <View style={styles.iconContainer}>
            <LinearGradient
                colors={['#4CAF50', '#81C784']}
                style={styles.successCircle}
            >
                <Ionicons name="checkmark" size={60} color="#FFF" />
            </LinearGradient>
        </View>

        <Text style={[styles.title, { color: textColor }]}>{copy.title}</Text>
        <Text style={styles.subtitle}>
            {copy.subtitle}{"\n"}
            <Text style={{ fontWeight: 'bold', color: '#FF4D67' }}>{contestName}</Text>
        </Text>

        {/* Info Card — server-confirmed state only */}
        <View style={[styles.infoCard, { backgroundColor: cardBg }]}>
            {copy.poll && <ActivityIndicator color="#FF4D67" style={{ marginBottom: 10 }} />}
            <Text style={[styles.infoText, { color: textColor }]}>{copy.info}</Text>
            {copy.canRefresh && !copy.poll ? (
              <TouchableOpacity onPress={onCheckAgain} disabled={checking} style={styles.refreshBtn} accessibilityRole="button">
                <Text style={styles.refreshText}>{checking ? 'Checking…' : 'Check again'}</Text>
              </TouchableOpacity>
            ) : null}
            {copy.poll && polls.current >= MAX_POLLS ? (
              <TouchableOpacity onPress={onCheckAgain} disabled={checking} style={styles.refreshBtn} accessibilityRole="button">
                <Text style={styles.refreshText}>{checking ? 'Checking…' : 'Check again'}</Text>
              </TouchableOpacity>
            ) : null}
        </View>

        {/* Share Button */}
        <TouchableOpacity style={styles.shareButton} onPress={handleShare}>
            <LinearGradient
                colors={['#FF4D67', '#FF8A9B']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 0 }}
                style={styles.gradientBtn}
            >
                <Ionicons name="share-social" size={24} color="#FFF" />
                <Text style={styles.shareText}>Share with Friends</Text>
            </LinearGradient>
        </TouchableOpacity>

        {/* Go Home Button */}
        <TouchableOpacity style={styles.homeButton} onPress={() => router.replace('/home')}>
            <Text style={[styles.homeText, { color: textColor }]}>Go to Home</Text>
        </TouchableOpacity>

      </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  // flexGrow, not flex — inside a ScrollView `flex: 1` sets `flex-basis: 0`,
  // collapsing the content box back to the viewport and re-clipping the content.
  container: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: 24 },
  // Width is applied inline from `useWindowDimensions` so it tracks a resize.
  content: { alignItems: 'center' },
  
  iconContainer: { marginBottom: 30, shadowColor: '#4CAF50', shadowOpacity: 0.3, shadowRadius: 15, elevation: 10 },
  successCircle: { width: 120, height: 120, borderRadius: 60, justifyContent: 'center', alignItems: 'center' },
  
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginBottom: 10 },
  subtitle: { fontSize: 16, fontFamily: 'Urbanist-Medium', color: '#888', textAlign: 'center', lineHeight: 24, marginBottom: 30 },
  
  infoCard: { padding: 20, borderRadius: 20, width: '100%', marginBottom: 40, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, elevation: 2 },
  infoText: { fontSize: 15, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 22 },
  refreshBtn: { marginTop: 12, paddingVertical: 8, paddingHorizontal: 16 },
  refreshText: { color: '#FF4D67', fontSize: 15, fontFamily: 'Urbanist-Bold' },
  
  shareButton: { width: '100%', height: 56, borderRadius: 28, overflow: 'hidden', marginBottom: 16, shadowColor: '#FF4D67', shadowOpacity: 0.3, shadowRadius: 10, elevation: 5 },
  gradientBtn: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 10 },
  shareText: { color: '#FFF', fontSize: 18, fontFamily: 'Urbanist-Bold' },
  
  homeButton: { paddingVertical: 15, paddingHorizontal: 30 },
  homeText: { fontSize: 16, fontFamily: 'Urbanist-Bold', opacity: 0.7 },
});
