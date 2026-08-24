import React from 'react';
import { View, Text, StyleSheet, Dimensions, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { useQuery } from '@tanstack/react-query';
import { LinearGradient } from 'expo-linear-gradient';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@/src/lib/icons';
import { Avatar } from '@/src/components/ui/Avatar';
import { CoinIcon } from '@/src/components/ui/CoinIcon';
import { contestService } from '@/src/services/contests/contestService';

const { width, height } = Dimensions.get('window');

/**
 * The head-to-head frame for a `contest_vs` story: both entries side by side with
 * a VS badge between them.
 *
 * Composed here at render time rather than baked into an image on the server,
 * because there is no server-side image composition available — see
 * `apps/worker/src/lib/matchStories.ts` for the full reasoning. The upside is that
 * this frame stays live: it reads the match, so the title, prize and both entries
 * are always current, and it needs no extra storage or cleanup.
 *
 * Visual language is deliberately the same as the feed's battle card
 * (`components/home/PostCard.tsx`): two rounded halves, a gradient VS orb
 * overlapping the gap, avatars and handles underneath.
 */

type Props = {
  matchId: string;
  /** Falls back to this while the match loads, so the frame is never empty. */
  fallbackMediaUrl?: string;
  contestTitle?: string | null;
};

/** One side of the battle. Videos show their first frame, muted and still. */
const VsSide: React.FC<{ uri?: string | null; isVideo: boolean; label: string }> = ({ uri, isVideo, label }) => {
  // A story is a glance, not a watch — a paused first frame reads better than two
  // videos competing for attention, and avoids two decoders for one frame.
  const player = useVideoPlayer(isVideo && uri ? uri : null, (p) => {
    p.muted = true;
    p.pause();
  });

  return (
    <View style={styles.side}>
      <View style={styles.mediaWrap}>
        {isVideo && uri ? (
          <VideoView player={player} style={styles.media} contentFit="cover" nativeControls={false} />
        ) : (
          <Image source={uri ? { uri } : undefined} style={styles.media} contentFit="cover" transition={150} />
        )}
        {isVideo && (
          <View style={styles.videoPip}>
            <Ionicons name="videocam" size={12} color="#FFF" />
          </View>
        )}
      </View>
      <Text style={styles.sideLabel} numberOfLines={1}>@{label}</Text>
    </View>
  );
};

export const StoryVsFrame: React.FC<Props> = ({ matchId, fallbackMediaUrl, contestTitle }) => {
  const { data: match, isLoading } = useQuery({
    queryKey: ['match', matchId],
    queryFn: () => contestService.getMatchById(matchId),
    // A battle's participants never change once it is live, so this is stable
    // for the life of the story.
    staleTime: 60_000,
    enabled: !!matchId,
  });

  const userA = (match as any)?.userA;
  const userB = (match as any)?.userB;

  // The match may be missing for a legitimate reason — it can be filtered out
  // when a participant is blocked — so fall back to the single entry this story
  // row already carries rather than showing an error.
  if (!isLoading && (!match || !userA || !userB)) {
    return (
      <View style={styles.container}>
        {fallbackMediaUrl ? (
          <Image source={{ uri: fallbackMediaUrl }} style={styles.fallback} contentFit="contain" />
        ) : null}
      </View>
    );
  }

  const isVideo = (match as any)?.type === 'video';
  const prize = Number((match as any)?.rewardAmount ?? (match as any)?.prizeCoins ?? 0);

  return (
    <LinearGradient colors={['#1B1226', '#2A1330', '#40121F']} style={styles.container}>
      {isLoading ? (
        <ActivityIndicator size="large" color="#FFF" />
      ) : (
        <View style={styles.card}>
          <View style={styles.livePill}>
            <View style={styles.liveDot} />
            <Text style={styles.livePillText}>BATTLE LIVE</Text>
          </View>

          <Text style={styles.title} numberOfLines={2}>
            {(match as any)?.title || contestTitle || 'Battle'}
          </Text>

          <View style={styles.row}>
            <VsSide uri={userA?.mediaUrlOptimized || userA?.mediaUrl} isVideo={isVideo} label={userA?.username || 'user'} />
            <VsSide uri={userB?.mediaUrlOptimized || userB?.mediaUrl} isVideo={isVideo} label={userB?.username || 'user'} />

            {/* Overlaps the gap between the two halves, like the feed card. */}
            <View pointerEvents="none" style={styles.vsBadge}>
              <LinearGradient
                colors={['#FF4D7E', '#FF8A4D']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.vsBadgeGradient}
              >
                <Text style={styles.vsBadgeText}>VS</Text>
              </LinearGradient>
            </View>
          </View>

          <View style={styles.footerRow}>
            <Avatar uri={userA?.profilePicThumb || userA?.profilePic} name={userA?.username} size={26} />
            <Avatar uri={userB?.profilePicThumb || userB?.profilePic} name={userB?.username} size={26} style={styles.overlapAvatar} />
            {prize > 0 && (
              <View style={styles.prizePill}>
                <CoinIcon size={12} color="#FFD54F" />
                <Text style={styles.prizeText}>{prize}</Text>
              </View>
            )}
          </View>

          <Text style={styles.cta}>Tap through to vote — fans decide the winner</Text>
        </View>
      )}
    </LinearGradient>
  );
};

const CARD_W = width - 32;
const SIDE_H = Math.min(height * 0.34, 320);

const styles = StyleSheet.create({
  container: { width, height, justifyContent: 'center', alignItems: 'center' },
  fallback: { width, height },
  card: { width: CARD_W, alignItems: 'center' },

  livePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: '#FF4D67', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFF' },
  livePillText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Bold', letterSpacing: 0.6 },

  title: {
    color: '#FFF', fontSize: 20, fontFamily: 'Urbanist-Bold',
    textAlign: 'center', marginTop: 12, marginBottom: 16, paddingHorizontal: 8,
  },

  row: { flexDirection: 'row', gap: 12, width: '100%', position: 'relative' },
  side: { flex: 1 },
  mediaWrap: {
    width: '100%', height: SIDE_H, borderRadius: 20, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)',
  },
  media: { width: '100%', height: '100%' },
  videoPip: {
    position: 'absolute', top: 8, right: 8,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 100, padding: 5,
  },
  sideLabel: {
    color: '#FFF', fontSize: 13, fontFamily: 'Urbanist-Bold',
    textAlign: 'center', marginTop: 8, opacity: 0.95,
  },

  vsBadge: { position: 'absolute', top: '50%', left: 0, right: 0, alignItems: 'center', marginTop: -22, zIndex: 15 },
  vsBadgeGradient: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    borderWidth: 3, borderColor: '#FFF',
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4, elevation: 5,
  },
  vsBadgeText: { fontFamily: 'Urbanist-Bold', fontSize: 15, color: '#FFF', letterSpacing: 0.5 },

  footerRow: { flexDirection: 'row', alignItems: 'center', marginTop: 18 },
  overlapAvatar: { marginLeft: -10 },
  prizePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5, marginLeft: 12,
    backgroundColor: 'rgba(255,213,79,0.16)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 100,
  },
  prizeText: { color: '#FFD54F', fontSize: 13, fontFamily: 'Urbanist-Bold' },

  cta: {
    color: 'rgba(255,255,255,0.7)', fontSize: 12, fontFamily: 'Urbanist-Medium',
    marginTop: 14, textAlign: 'center',
  },
});

export default StoryVsFrame;
