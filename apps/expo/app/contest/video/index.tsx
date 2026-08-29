import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, ScrollView, TextInput, ImageBackground } from 'react-native';
import { Alert } from '@/src/lib/appAlert';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@/src/lib/icons';
import { BackButton } from '@/src/components/ui/BackButton';
import { ArrowIcon } from '@/src/components/ui/ArrowIcon';
import { ContestListSkeleton } from '@/src/components/skeletons/ContestListSkeleton';
import * as ImagePicker from 'expo-image-picker';
import { useVideoPlayer, VideoView } from 'expo-video';
import { contestService } from '@/src/services/contests/contestService';
import { contestMediaService } from '@/src/services/contests/uploadMedia';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData';
import { useThemeColor } from '@/hooks/use-theme-color';
import { LinearGradient } from 'expo-linear-gradient';
import { goToCongratulations } from '@/src/lib/contestSuccess';
import { getDeviceId } from '@/src/lib/deviceId';
import { validateVideo, CONTEST_MAX_VIDEO_SEC } from '@/src/lib/videoValidation';

const BRAND_PRIMARY = '#FF4D67';

export default function VideoContestScreen() {
  const router = useRouter();
  const { contestId, matchId, mode } = useLocalSearchParams();
  const { user } = useAuth();
  const { data: profile } = useProfile(user?.uid || '');
  
  const [contests, setContests] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedContest, setSelectedContest] = useState<any>(null);
  const [media, setMedia] = useState<string | null>(null);
  const [caption, setCaption] = useState("");
  const [uploading, setUploading] = useState(false);


  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const inputBg = useThemeColor({ light: '#F9F9F9', dark: '#2A2D35' }, 'background');
  const borderColor = useThemeColor({ light: '#EEEEEE', dark: '#35383F' }, 'border');
  const subTextColor = useThemeColor({ light: '#9E9E9E', dark: '#E0E0E0' }, 'text');

  const player = useVideoPlayer(media, (player) => {
    player.loop = true;
    player.play();
    player.muted = true;
  });

  useEffect(() => {
    if (contestId) {
      fetchContestDetail(contestId as string);
    } else if (matchId) {
      // Joining an existing battle. Without this branch a join deep-link fell
      // through to the contest LIST, so the user picked an unrelated template and
      // `handleAction` then sent that template's id as the matchId.
      fetchMatchDetail(matchId as string);
    } else {
      loadContests();
    }
  }, [contestId, matchId]);

  const loadContests = async () => {
    try {
      const data = await contestService.getAvailableContests('video');
      setContests(data);
    } catch (error) { console.error(error); } finally { setLoading(false); }
  };

  const fetchContestDetail = async (id: string) => {
    setLoading(true);
    try {
      const contest = await contestService.getContestById(id);
      setSelectedContest(contest);
    } catch (error) { console.error(error); } finally { setLoading(false); }
  };

  /**
   * Load the battle being joined and present it as the selected contest, so the
   * entry fee, prize and title shown are the ones this battle was created with.
   * Mirrors `fetchMatchDetail` in the photo setup screen.
   */
  const fetchMatchDetail = async (id: string) => {
    setLoading(true);
    try {
      const match = await contestService.getMatchById(id);
      if (!match) {
        Alert.alert('Battle unavailable', 'This battle is no longer open to join.');
        router.replace('/explore');
        return;
      }
      setSelectedContest({
        ...match,
        // The match carries the entry fee it was created with; the contest
        // template it came from may since have been edited.
        id: match.contestId || match.id,
        title: match.title,
        totalEntryFee: match.entryFee,
        entryFishCoins: match.entryFee,
        rewardCoins: match.rewardAmount ?? match.prizeCoins,
        isJoinMode: true,
      });
    } catch (error) {
      console.error(error);
      Alert.alert('Error', 'Could not load this battle.');
      router.replace('/explore');
    } finally { setLoading(false); }
  };

  const pickVideo = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsEditing: true,
      quality: 1,
      videoMaxDuration: CONTEST_MAX_VIDEO_SEC,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    // `videoMaxDuration` only caps in-app recording; a library-picked clip can
    // still be longer, so validate the chosen asset explicitly.
    const check = validateVideo(
      { durationMs: asset.duration, fileSize: asset.fileSize },
      { maxDurationSec: CONTEST_MAX_VIDEO_SEC },
    );
    if (!check.ok) {
      Alert.alert('Video too long', check.message);
      return;
    }
    setMedia(asset.uri);
  };

  const handleAction = async () => {
    if (!selectedContest || !media || !user || caption.trim().length === 0) {
      Alert.alert("Error", "Please upload a video and write a caption.");
      return;
    }

    const fee = selectedContest.entryFishCoins || selectedContest.entryFee || 0;
    // Profile balance is stored as `Dpcoin` (there is no `coins` field), so the
    // old `profile?.coins` read was always undefined and blocked every entry.
    const userCoins = (profile as any)?.Dpcoin ?? (profile as any)?.coins ?? 0;
    if (userCoins < fee) {
        Alert.alert("Insufficient Coins", `Need ${fee} Coins. Current: ${userCoins}`);
        return;
    }

    setUploading(true);
    const isJoining = !!(selectedContest.isJoinMode || mode === 'join' || matchId);
    try {
      const downloadUrl = await contestMediaService.uploadMedia(media, selectedContest.id || selectedContest.contestId, user.uid, 'video');
      const deviceId = await getDeviceId();

      if (isJoining) {
        await contestService.joinMatch({
          matchId: matchId as string || selectedContest.id,
          mediaUrl: downloadUrl,
          mediaType: 'video',
          caption,
          deviceId,
        });
      } else {
        await contestService.startMatch({
          contestId: selectedContest.id,
          mediaUrl: downloadUrl,
          mediaType: 'video',
          caption,
          deviceId,
        });
      }
      goToCongratulations(router, {
        contestName: selectedContest.title || selectedContest.name,
        isJoining,
      });
    } catch (error: any) {
      Alert.alert("Oops!", error.message || "Failed to submit.");
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <View style={{ flex: 1, backgroundColor: bgColor, paddingTop: 56 }}><ContestListSkeleton /></View>;

  return (
    <SafeAreaView style={[styles.container, {backgroundColor: bgColor}]}>
      <View style={styles.header}>
        <BackButton size={26} color={textColor} />
        <Text style={[styles.title, {color: textColor}]}>Video Contests</Text>
        <View style={{ width: 28 }} />
      </View>

      {!selectedContest ? (
        <FlatList
          data={contests}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => {
            const reward = item.winningCoins || item.rewardCoins || 0;
            const fee = item.entryFishCoins || item.totalEntryFee || 0;
            return (
              <TouchableOpacity
                activeOpacity={0.92}
                style={[styles.contestCard, { backgroundColor: cardBg }]}
                onPress={() => setSelectedContest(item)}
              >
                <ImageBackground
                  // No banner -> no source; cardBanner's own background colour
                  // is the placeholder (was a via.placeholder.com request).
                  source={item.bannerUrl ? { uri: item.bannerUrl } : undefined}
                  style={styles.cardBanner}
                  imageStyle={styles.cardBannerImg}
                >
                  <LinearGradient colors={['rgba(0,0,0,0.05)', 'rgba(0,0,0,0.85)']} style={styles.bannerGradient}>
                    <View style={styles.topRow}>
                      <View style={styles.livePill}>
                        <View style={styles.livePillDot} />
                        <Text style={styles.livePillText}>LIVE</Text>
                      </View>
                      <View style={styles.feeBadge}>
                        <Ionicons name="videocam" size={13} color="#FFF" />
                        <Text style={styles.feeText}>{fee} Coins</Text>
                      </View>
                    </View>
                    <Text style={styles.cardTitle} numberOfLines={2}>{item.title || item.name}</Text>
                  </LinearGradient>
                </ImageBackground>

                <View style={styles.cardFooter}>
                  <View style={styles.rewardInfo}>
                    <Text style={[styles.rewardLabel, { color: subTextColor }]}>WINNER GETS</Text>
                    <View style={styles.rewardValueRow}>
                      <Ionicons name="trophy" size={16} color="#FFB800" />
                      <Text style={styles.rewardValue}>{reward} Coins</Text>
                    </View>
                  </View>
                  <LinearGradient colors={[BRAND_PRIMARY, '#FF8A9B']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.startBtn}>
                    <Text style={styles.startBtnText}>Enter</Text>
                    <ArrowIcon size={16} color="#FFF" variant="arrow" />
                  </LinearGradient>
                </View>
              </TouchableOpacity>
            );
          }}
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={[styles.subtitle, {color: textColor}]}>{selectedContest.title || selectedContest.name}</Text>
          
          <TouchableOpacity style={[styles.mediaUpload, {backgroundColor: inputBg, borderColor}]} onPress={pickVideo}>
            {media ? (
              <VideoView player={player} style={styles.previewVideo} contentFit="cover" />
            ) : (
              <View style={styles.placeholder}>
                <Ionicons name="videocam" size={40} color={BRAND_PRIMARY} />
                <Text style={{color: subTextColor, marginTop: 10, fontFamily: 'Urbanist-Medium'}}>Tap to Select Video</Text>
              </View>
            )}
          </TouchableOpacity>

          <TextInput 
            style={[styles.captionInput, { color: textColor, backgroundColor: inputBg, borderColor }]} 
            placeholder="Write a catchy caption..."
            placeholderTextColor={subTextColor}
            value={caption}
            onChangeText={setCaption}
            multiline
          />

          <TouchableOpacity 
            style={[styles.joinButton, { opacity: uploading ? 0.6 : 1 }]} 
            onPress={handleAction}
            disabled={uploading}
          >
            <LinearGradient colors={[BRAND_PRIMARY, '#FF8A9B']} style={styles.gradient}>
                {uploading ? <ActivityIndicator color="white" /> : <Text style={styles.joinButtonText}>Submit Entry</Text>}
            </LinearGradient>
          </TouchableOpacity>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  title: { fontSize: 22, fontFamily: 'Urbanist-Bold' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  contestCard: {
    borderRadius: 22,
    marginBottom: 20,
    elevation: 5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    overflow: 'hidden',
  },
  cardBanner: { width: '100%', height: 190, backgroundColor: '#2A2D36' },
  cardBannerImg: { borderTopLeftRadius: 22, borderTopRightRadius: 22 },
  bannerGradient: { flex: 1, justifyContent: 'flex-end', padding: 16 },
  topRow: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(255,77,103,0.95)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 20,
  },
  livePillDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFF' },
  livePillText: { color: '#FFF', fontSize: 10, fontFamily: 'Urbanist-Bold', letterSpacing: 0.5 },
  feeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.25)',
  },
  feeText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  cardTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold', color: '#FFF' },
  cardFooter: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16 },
  rewardInfo: { flex: 1 },
  rewardLabel: { fontSize: 11, fontFamily: 'Urbanist-Bold', letterSpacing: 0.6 },
  rewardValueRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 },
  rewardValue: { fontSize: 17, fontFamily: 'Urbanist-Bold', color: '#FFB800' },
  startBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 11,
    borderRadius: 14,
  },
  startBtnText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 15 },
  subtitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginBottom: 20 },
  mediaUpload: { width: '100%', height: 350, borderRadius: 24, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderStyle: 'dashed' },
  previewVideo: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center' },
  captionInput: { marginTop: 20, height: 100, borderRadius: 16, padding: 15, borderWidth: 1, textAlignVertical: 'top', fontFamily: 'Urbanist-Medium' },
  joinButton: { marginTop: 30, height: 56, borderRadius: 16, overflow: 'hidden' },
  gradient: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  joinButtonText: { color: 'white', fontSize: 18, fontFamily: 'Urbanist-Bold' }
});
