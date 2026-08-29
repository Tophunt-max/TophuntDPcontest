import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Image,
  ActivityIndicator,
  Alert,
  ScrollView,
  Dimensions,
  Platform,
  TextInput,
  Modal
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@/src/lib/icons';
import { LinearGradient } from 'expo-linear-gradient';
import * as ImagePicker from 'expo-image-picker';
import { contestService } from '@/src/services/contests/contestService';
import { contestMediaService } from '@/src/services/contests/uploadMedia';
import { useAuth } from '@/src/hooks/useAuth';
import { goToCongratulations } from '@/src/lib/contestSuccess';
import { RulesModal } from '@/src/components/modals/RulesModal';
import { useProfile } from '@/src/hooks/useProfileData'; 
import { useThemeColor } from '@/hooks/use-theme-color';
import { BackButton } from '@/src/components/ui/BackButton';
import { CoinIcon } from '@/src/components/ui/CoinIcon'; 
import { BattleSetupSkeleton } from '@/src/components/contests/BattleSetupSkeleton';
import { useToast } from '@/src/components/toast/ToastProvider';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withRepeat, 
  withTiming, 
  withSequence,
  withDelay,
  Easing,
  useDerivedValue,
  interpolate
} from 'react-native-reanimated';
import { ImageViewer } from '@/src/components/ui/ImageViewer';
import * as Haptics from 'expo-haptics';
import { getDeviceId } from '@/src/lib/deviceId';
import { useReadjustablePhoto } from '@/src/components/media/useImageAdjuster';
import { entryFeePerPlayer, rewardCoins } from '@/src/lib/contestPricing';
import { hasEnded } from '@/src/lib/countdown';

const PINK_ACCENT = '#FFB1BD';
const PRIMARY_COLOR = '#FF4D67';
const SECONDARY_COLOR = '#FF758C';
/** Contest entries render at 4:5 (`previewImg` aspectRatio 0.8), so crop to that. */
const ENTRY_ASPECT = 0.8;

export default function BattleSetupScreen() {
  const router = useRouter();
  const { contestId, matchId, mode } = useLocalSearchParams(); 
  const { user } = useAuth();
  const { data: profile } = useProfile(user?.uid || ''); 
  const { addToast } = useToast();
  
  const backgroundColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const borderColor = useThemeColor({ light: '#EEEEEE', dark: '#35383F' }, 'border');
  const inputBg = useThemeColor({ light: '#F5F5F5', dark: '#1F222A' }, 'background');
  const subTextColor = useThemeColor({ light: '#9E9E9E', dark: '#8E939A' }, 'text');

  const [loading, setLoading] = useState(true);
  const [selectedContest, setSelectedContest] = useState<any>(null);
  const [media, setMedia] = useState<string | null>(null);
  // Contest entries are displayed at 4:5 (see `previewImg`), so that is what the
  // entry is cropped to — cropping to any other ratio just moves the cropping
  // decision to the renderer, where the user has no say in it.
  const { adjustPicked, readjust, canReadjust, host: adjusterHost } = useReadjustablePhoto(ENTRY_ASPECT);
  const [uploading, setUploading] = useState(false);

  const [showRulesModal, setShowRulesModal] = useState(false);
  const [isImageViewVisible, setIsImageViewVisible] = useState(false);

  // New form state
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [caption, setCaption] = useState('');
  const [isReady, setIsReady] = useState(false);

  // Glow Animation
  const glowOpacity = useSharedValue(0);

  // Coin Animation
  const [showCoinAnimation, setShowCoinAnimation] = useState(false);
  const coinTranslateY = useSharedValue(0);
  const coinOpacity = useSharedValue(1);

  // Refs for positions
  const walletRef = useRef<View>(null);
  const [walletPosition, setWalletPosition] = useState({ x: 0, y: 0, width: 0, height: 0 });

  useEffect(() => { 
    if (contestId) {
      fetchContestDetail(contestId as string);
    } else if (matchId) {
       fetchMatchDetail(matchId as string);
    }
  }, [contestId, matchId]);

  // Autofill user info. The profile row uses `fullName` (there is no
  // `displayName` field), so fall back to it — otherwise the Display Name stays
  // empty and the user is blocked from joining until they retype their own name.
  useEffect(() => {
    if (profile) {
      setDisplayName((profile as any).displayName || profile.fullName || '');
      setUsername(profile.username || '');
    }
  }, [profile]);

  // Check if form is ready
  useEffect(() => {
    const ready = !!(media && displayName.trim() && username.trim());
    setIsReady(ready);
    
    if (ready) {
      glowOpacity.value = withRepeat(
        withSequence(
          withTiming(0.6, { duration: 1000, easing: Easing.ease }),
          withTiming(0, { duration: 1000, easing: Easing.ease })
        ),
        -1, 
        true 
      );
    } else {
        glowOpacity.value = withTiming(0);
    }
  }, [media, displayName, username]);

  const animatedGlowStyle = useAnimatedStyle(() => {
    return {
      opacity: glowOpacity.value,
      shadowOpacity: glowOpacity.value,
    };
  });

  const animatedCoinStyle = useAnimatedStyle(() => {
    return {
        transform: [{ translateY: coinTranslateY.value }],
        opacity: coinOpacity.value
    }
  });

  const fetchContestDetail = async (id: string) => {
    setLoading(true);
    try {
      const contest = await contestService.getContestById(id);
      setSelectedContest(contest);
    } catch (error) { 
      console.error(error); 
      addToast("Failed to load contest details", 'error');
    } finally { setLoading(false); }
  };

  const fetchMatchDetail = async (id: string) => {
    setLoading(true);
    try {
      const match = await contestService.getMatchById(id); 
      setSelectedContest({ ...match, isJoinMode: true });
    } catch (error) { 
      console.error(error);
      addToast("Failed to load match details", 'error'); 
    } finally { setLoading(false); }
  };

  const pickImage = async () => {
    // No `allowsEditing`: that crop UI is native-only, so on web a contest entry
    // could not be framed at all and a tall photo was cropped arbitrarily by the
    // layout. `ImageAdjuster` crops on every platform. Every other picker in the
    // app was moved across for this reason; this screen — the one that decides
    // what a battle actually looks like — had been missed.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.8,
    });
    if (!result.canceled) {
        setMedia(await adjustPicked(result.assets[0].uri));
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  /** Reopen the adjuster on the ORIGINAL pick, so repeated crops never compound. */
  const handleReadjust = async () => {
    const next = await readjust();
    if (next) {
      setMedia(next);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  /**
   * Fire-and-forget coin animation.
   *
   * This deliberately takes NO callback. It used to accept one and invoke it from
   * Reanimated's completion handler behind `if (finished)` — and the entire
   * submit lived in that callback: the media upload, the entry-fee charge and the
   * success screen. Any interruption (a re-render reassigning the shared value,
   * the view unmounting, the screen losing focus, a worklet callback not firing
   * on web) left `finished` false, so nothing ran at all. Because the try/catch
   * was inside the callback too, there was not even an error toast: the user
   * tapped Submit, watched the coin fly away, and silently landed back on the
   * form. Decoration must never gate a payment.
   */
  const playCoinAnimation = () => {
      setShowCoinAnimation(true);
      coinTranslateY.value = 0;
      coinOpacity.value = 1;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Animate up and fade out
      coinTranslateY.value = withTiming(-600, { duration: 1000, easing: Easing.out(Easing.exp) });
      coinOpacity.value = withTiming(0, { duration: 1000, easing: Easing.in(Easing.exp) });
  };

  const handleAction = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);

    if (!user) {
      addToast("Please log in to participate.", 'error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    if (!selectedContest) {
      addToast("No contest selected.", 'error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // Shared with every contest card — and, more importantly, floored the same
    // way the Worker charges. Plain `total / 2` on an odd total quotes half a
    // coin more than is actually taken, which showed as "Insufficient Coins" to
    // a user holding exactly enough.
    const fee = entryFeePerPlayer(selectedContest);
    const userCoins = profile?.coins || profile?.Dpcoin || 0;

    // This screen can be open for far longer than the 60s the contest list is
    // cached for — pick a photo, crop it, adjust it — so the closing time is
    // re-checked here rather than trusted from whenever the list was fetched.
    // The Worker refuses the entry too; this makes it a clear message instead of
    // a failed upload.
    if (hasEnded(selectedContest.endsAt)) {
      addToast('This contest has closed and is no longer accepting entries.', 'error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // Logic for "Get Coins" flow
    if (userCoins < fee) {
      addToast(`Insufficient Coins. Redirecting to Wallet...`, 'info');
      router.push('/wallet/store'); // Assuming this route exists
      return;
    }

    if (!media) {
      addToast("Please upload a photo first.", 'error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    if (!displayName.trim() || !username.trim()) {
      addToast("Please provide your name and username.", 'error');
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }

    // The animation plays alongside the submit, not in front of it.
    playCoinAnimation();
    setUploading(true);
    const isJoining = !!(selectedContest.isJoinMode || mode === 'join');
    try {
        const downloadUrl = await contestMediaService.uploadMedia(media, selectedContest.id || selectedContest.contestId, user.uid, 'photo');
        const deviceId = await getDeviceId();

        const matchData = {
          mediaUrl: downloadUrl,
          mediaType: 'photo',
          caption: caption,
          displayName: displayName,
          username: username,
          deviceId,
        };

        if (isJoining) {
          await contestService.joinMatch({
            matchId: matchId as string || selectedContest.id,
            ...matchData
          });
        } else {
          await contestService.startMatch({
            contestId: selectedContest.id,
            ...matchData
          });
        }
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        goToCongratulations(router, {
          contestName: selectedContest.title || selectedContest.name,
          isJoining,
        });
      } catch (error: any) {
        console.error("[BattleSetup] Action Error:", error);
        const msg = error.details || error.message || "Something went wrong on the server.";
        addToast(msg, 'error');
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      } finally {
        setUploading(false);
        setShowCoinAnimation(false);
      }
  };

  const navigateToWallet = () => {
    router.push('/wallet/store');
  }
  
  const measureWallet = () => {
     walletRef.current?.measure((x, y, width, height, pageX, pageY) => {
        setWalletPosition({ x: pageX, y: pageY, width, height });
     });
  }

  if (loading) {
    return <BattleSetupSkeleton />;
  }

  if (!selectedContest) return null;

  const fee = entryFeePerPlayer(selectedContest);
  const winningReward = rewardCoins(selectedContest);
  const userCoins = profile?.coins || profile?.Dpcoin || 0;
  const hasInsufficientCoins = userCoins < fee;

  // Identify if we are User B joining an existing match
  const isJoinMode = selectedContest.isJoinMode || mode === 'join';
  const opponent = isJoinMode ? selectedContest.userA : null;
  const opponentPic = opponent?.profilePic || opponent?.profileImageUrl;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
         <BackButton size={22} color={textColor} style={[styles.backBtn, { backgroundColor: cardBg }]} />
         <Text style={[styles.headerTitle, { color: textColor }]}>Battle Setup</Text>
         <TouchableOpacity 
            ref={walletRef}
            onLayout={measureWallet}
            onPress={navigateToWallet} 
            style={[styles.walletContainer, { backgroundColor: cardBg }]}
         >
            <CoinIcon size={20} />
            <Text style={[styles.walletText, { color: textColor }]}>{userCoins}</Text>
         </TouchableOpacity>
      </View>

      <ScrollView 
        contentContainerStyle={styles.scrollContent} 
        showsVerticalScrollIndicator={false}
      >
        {/* Entry Fee Breakdown Card */}
        <View style={[styles.breakdownCard, { backgroundColor: cardBg, borderColor }]}>
          <View style={styles.breakdownHeaderRow}>
            <Ionicons name="flash" size={15} color={PRIMARY_COLOR} />
            <Text style={styles.breakdownLabel}>Entry Fee Breakdown</Text>
          </View>
          
          <View style={styles.playersContainer}>
            {/* User Profile (Left) */}
            <View style={styles.playerItem}>
              <LinearGradient
                colors={[PRIMARY_COLOR, SECONDARY_COLOR]}
                style={styles.avatarRing}
              >
                <View style={[styles.playerAvatarCircle, { backgroundColor: cardBg }]}>
                  {profile?.profileImageUrl ? (
                    <Image source={{ uri: profile.profileImageUrl }} style={styles.avatarImg} />
                  ) : (
                    <Ionicons name="person" size={32} color="#03A9F4" />
                  )}
                </View>
              </LinearGradient>
              <Text style={[styles.playerName, { color: textColor }]} numberOfLines={1}>You</Text>
              <View style={styles.feeInfo}>
                <Text style={styles.feeMinus}>-{fee}</Text>
                <CoinIcon size={18} />
              </View>
            </View>

            <View style={styles.vsWrap}>
              <LinearGradient
                colors={[PRIMARY_COLOR, SECONDARY_COLOR]}
                style={styles.vsCircle}
              >
                <Text style={styles.vsText}>VS</Text>
              </LinearGradient>
            </View>

            {/* Opponent Profile (Right) */}
            <View style={styles.playerItem}>
              <View style={[styles.avatarRing, styles.avatarRingIdle, { backgroundColor: borderColor }]}>
                <View style={[styles.playerAvatarCircle, { backgroundColor: cardBg }]}>
                  {opponentPic ? (
                    <Image source={{ uri: opponentPic }} style={styles.avatarImg} />
                  ) : (
                    opponent ? (
                      <Ionicons name="person" size={32} color="#03A9F4" />
                    ) : (
                      <Text style={[styles.questionMark, { color: subTextColor }]}>?</Text>
                    )
                  )}
                </View>
              </View>
              <Text style={[styles.playerName, { color: textColor }]} numberOfLines={1}>
                {opponent ? (opponent.displayName || opponent.username || "Opponent") : "Waiting..."}
              </Text>
              <View style={styles.feeInfo}>
                <Text style={styles.feeMinus}>-{fee}</Text>
                <CoinIcon size={18} />
              </View>
            </View>
          </View>

          <View style={styles.winnerBanner}>
             <Ionicons name="trophy" size={16} color="#EAB308" />
             <Text style={styles.winnerBannerText}>Winner Gets {winningReward} Coins!</Text>
          </View>
        </View>

        {/* Comparison Preview (New for User B) */}
        {isJoinMode && opponent && (
          <View style={styles.matchupPreviewContainer}>
            <Text style={[styles.sectionTitle, { color: textColor, textAlign: 'center' }]}>The Matchup</Text>
            <View style={styles.previewRow}>
              <View style={styles.previewBox}>
                 <View style={styles.previewHeader}>
                    <Image 
                      source={opponentPic ? { uri: opponentPic } : require('@/assets/images/icon.png')} 
                      style={styles.miniAvatar} 
                    />
                    <Text style={[styles.previewLabel, { color: textColor }]} numberOfLines={1}>
                       {opponent.displayName || opponent.username || "Opponent"}
                    </Text>
                 </View>
                 <Image source={{ uri: opponent.mediaUrl }} style={styles.previewImg} />
              </View>

              <View style={styles.vsSmallCircle}>
                 <Text style={styles.vsSmallText}>VS</Text>
              </View>

              <View style={styles.previewBox}>
                 <View style={styles.previewHeader}>
                    <Image 
                      source={profile?.profileImageUrl ? { uri: profile.profileImageUrl } : require('@/assets/images/icon.png')} 
                      style={styles.miniAvatar} 
                    />
                    <Text style={[styles.previewLabel, { color: textColor }]} numberOfLines={1}>You</Text>
                 </View>
                 {media ? (
                   <TouchableOpacity onPress={() => setIsImageViewVisible(true)}>
                    <Image source={{ uri: media }} style={styles.previewImg} />
                   </TouchableOpacity>
                 ) : (
                   <TouchableOpacity onPress={pickImage} style={[styles.previewImg, styles.emptyPreview]}>
                      <Ionicons name="add" size={32} color="#9E9E9E" />
                   </TouchableOpacity>
                 )}
              </View>
            </View>
          </View>
        )}

        {/* Your Submission Section */}
        <View style={styles.formSection}>
           <View style={styles.sectionHeaderRow}>
             <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>1</Text></View>
             <Text style={[styles.sectionTitle, { color: textColor }]}>Your Submission</Text>
           </View>
           
           <TouchableOpacity 
              activeOpacity={0.85}
              onPress={media ? () => setIsImageViewVisible(true) : pickImage}
              style={[styles.uploadBox, { borderColor: media ? 'transparent' : borderColor, backgroundColor: inputBg }]}
            >
              {media ? (
                <>
                  <Image source={{ uri: media }} style={styles.previewImage} />
                  <View style={styles.previewOverlay}>
                    <Ionicons name="expand-outline" size={18} color="#FFF" />
                  </View>
                </>
              ) : (
                <View style={styles.uploadPlaceholder}>
                  <LinearGradient
                    colors={[PRIMARY_COLOR, SECONDARY_COLOR]}
                    style={styles.uploadCircleInner}
                  >
                     <Ionicons name="camera" size={26} color="#FFF" />
                  </LinearGradient>
                  <Text style={[styles.uploadText, { color: textColor }]}>Tap to Upload Photo</Text>
                  <Text style={styles.uploadSubtext}>Supports JPG, PNG · Max 10MB</Text>
                </View>
              )}
           </TouchableOpacity>
           
           {media && (
               <View style={styles.photoActionsRow}>
                   {canReadjust && (
                       <TouchableOpacity onPress={handleReadjust} style={styles.changePhotoBtn} accessibilityRole="button" accessibilityLabel="Adjust photo">
                           <Ionicons name="crop-outline" size={15} color={PRIMARY_COLOR} />
                           <Text style={[styles.changePhotoText, { color: PRIMARY_COLOR }]}>Adjust</Text>
                       </TouchableOpacity>
                   )}
                   <TouchableOpacity onPress={pickImage} style={styles.changePhotoBtn} accessibilityRole="button" accessibilityLabel="Change photo">
                       <Ionicons name="sync-outline" size={15} color={PRIMARY_COLOR} />
                       <Text style={[styles.changePhotoText, { color: PRIMARY_COLOR }]}>Change Photo</Text>
                   </TouchableOpacity>
               </View>
           )}
        </View>

        {/* User Info Section */}
        <View style={styles.formSection}>
           <View style={styles.sectionHeaderRow}>
             <View style={styles.stepBadge}><Text style={styles.stepBadgeText}>2</Text></View>
             <Text style={[styles.sectionTitle, { color: textColor }]}>Your Information</Text>
           </View>
           
           <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: subTextColor }]}>Display Name</Text>
              <TextInput 
                style={[styles.input, { backgroundColor: inputBg, color: textColor, borderColor }]}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Your name"
                placeholderTextColor="#9E9E9E"
              />
           </View>

           <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: subTextColor }]}>Username</Text>
              <View style={[styles.input, styles.inputDisabled, { backgroundColor: inputBg, borderColor }]}>
                <Text style={styles.usernamePrefix}>@</Text>
                <TextInput 
                  style={[styles.usernameField, { color: subTextColor }]}
                  value={username}
                  editable={false}
                  placeholder="username"
                  autoCapitalize="none"
                  placeholderTextColor="#9E9E9E"
                />
                <Ionicons name="lock-closed" size={15} color={subTextColor} />
              </View>
           </View>

           <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: subTextColor }]}>Caption (Optional)</Text>
              <TextInput 
                style={[styles.input, styles.textArea, { backgroundColor: inputBg, color: textColor, borderColor }]}
                value={caption}
                onChangeText={setCaption}
                placeholder="Write a catchy caption..."
                placeholderTextColor="#9E9E9E"
                multiline
                numberOfLines={3}
              />
           </View>
        </View>
      </ScrollView>

      {/* Sticky Bottom Actions */}
      <View style={[styles.footer, { backgroundColor, borderTopColor: borderColor }]}>
        <View style={styles.buttonWrapper}>
          <Animated.View style={[styles.glowBackground, animatedGlowStyle]} />
          <TouchableOpacity 
            activeOpacity={0.85}
            onPress={handleAction}
            disabled={uploading}
            style={styles.joinButtonTouchable}
          >
             <LinearGradient
               colors={hasInsufficientCoins ? ['#FF9800', '#FFB74D'] : (isReady ? [PRIMARY_COLOR, SECONDARY_COLOR] : [PINK_ACCENT, PINK_ACCENT])}
               start={{ x: 0, y: 0 }}
               end={{ x: 1, y: 0 }}
               style={styles.joinButton}
             >
               {uploading ? (
                  <ActivityIndicator color="#FFF" />
                ) : (
                  <View style={styles.joinBtnContent}>
                    {!hasInsufficientCoins && <CoinIcon size={20} color="#FFF" />}
                    <Text style={styles.joinBtnText}>
                      {hasInsufficientCoins ? "Get Coins" : `Pay ${fee} Coins & Join`}
                    </Text>
                  </View>
                )}
             </LinearGradient>
          </TouchableOpacity>
          {/* Coin Animation */}
          {showCoinAnimation && (
            <Animated.View style={[styles.flyingCoin, animatedCoinStyle]}>
                <CoinIcon size={32} />
                <Text style={styles.flyingCoinText}>-{fee}</Text>
            </Animated.View>
          )}
        </View>

        <TouchableOpacity onPress={() => setShowRulesModal(true)} style={styles.rulesContainer}>
          <Text style={[styles.rulesLink, { color: subTextColor }]}>By joining, you agree to the contest rules.</Text>
        </TouchableOpacity>
      </View>

      <RulesModal 
        isVisible={showRulesModal}
        onClose={() => setShowRulesModal(false)}
        rules={selectedContest?.rules || "No rules specified for this contest."}
        title={selectedContest?.name || selectedContest?.title ? `${selectedContest.name || selectedContest.title} Rules` : "Contest Rules"}
      />
      
      {/* Full-screen crop overlay; renders nothing until a photo is being adjusted. */}
      {adjusterHost}

      {/* Full Screen Image Viewer */}
      {media && (
        <ImageViewer
          images={[{ uri: media }]}
          imageIndex={0}
          visible={isImageViewVisible}
          onRequestClose={() => setIsImageViewVisible(false)}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingCenter: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { 
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20, 
    paddingVertical: 10
  },
  backBtn: { 
    width: 40,
    height: 40,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  headerTitle: {
    fontSize: 18,
    fontFamily: 'Urbanist-Bold',
  },
  avatarPlaceholder: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F5F5F5',
  },
  walletContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    height: 40,
    borderRadius: 20,
    gap: 6,
    elevation: 2,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.08,
    shadowRadius: 4,
  },
  walletText: {
    fontSize: 15,
    fontFamily: 'Urbanist-Bold',
  },
  scrollContent: { paddingHorizontal: 20, alignItems: 'center', paddingBottom: 20, paddingTop: 8 },
  breakdownCard: {
    width: '100%',
    borderRadius: 24,
    borderWidth: 1,
    padding: 20,
    alignItems: 'center',
    marginBottom: 24,
    elevation: 3,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.08,
    shadowRadius: 10,
  },
  breakdownHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 22,
  },
  breakdownLabel: {
    fontSize: 14,
    fontFamily: 'Urbanist-Bold',
    color: '#9E9E9E',
    letterSpacing: 0.3,
  },
  playersContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 10,
    marginBottom: 22,
  },
  playerItem: {
    alignItems: 'center',
    flex: 1,
  },
  avatarRing: {
    width: 78,
    height: 78,
    borderRadius: 39,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 10,
  },
  avatarRingIdle: {
    borderStyle: 'dashed',
  },
  playerAvatarCircle: {
    width: 68,
    height: 68,
    borderRadius: 34,
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  playerName: {
    fontSize: 15,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 6,
    width: 90,
    textAlign: 'center',
  },
  feeInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  feeMinus: {
    fontSize: 15,
    color: '#FF4D67',
    fontFamily: 'Urbanist-Bold',
  },
  vsWrap: {
    zIndex: 1,
  },
  vsCircle: {
    width: 46,
    height: 46,
    borderRadius: 23,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: PRIMARY_COLOR,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
  },
  vsText: {
    color: '#FFF',
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
  },
  questionMark: {
    fontSize: 32,
    color: '#FF4D67',
    fontFamily: 'Urbanist-Bold',
  },
  winnerBanner: {
    backgroundColor: '#FEF9C3',
    width: '100%',
    paddingVertical: 13,
    borderRadius: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  winnerBannerText: {
    color: '#CA8A04',
    fontFamily: 'Urbanist-Bold',
    fontSize: 15,
  },
  matchupPreviewContainer: {
    width: '100%',
    marginBottom: 24,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: 15,
  },
  previewBox: {
    flex: 1,
    alignItems: 'center',
  },
  previewHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 10,
    gap: 8,
    width: '100%',
    paddingHorizontal: 5,
  },
  miniAvatar: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#EEE',
  },
  previewLabel: {
    fontSize: 14,
    fontFamily: 'Urbanist-Bold',
    flex: 1,
  },
  previewImg: {
    width: '100%',
    aspectRatio: 0.8,
    borderRadius: 15,
    backgroundColor: '#F5F5F5',
  },
  emptyPreview: {
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E0E0E0',
    borderStyle: 'dashed',
  },
  vsSmallCircle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#FF4D67',
    justifyContent: 'center',
    alignItems: 'center',
    marginHorizontal: 10,
    zIndex: 2,
    marginTop: 30, 
  },
  vsSmallText: {
    color: '#FFF',
    fontSize: 10,
    fontFamily: 'Urbanist-Bold',
  },
  formSection: {
    width: '100%',
    marginBottom: 22,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 16,
  },
  stepBadge: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: PRIMARY_COLOR,
    justifyContent: 'center',
    alignItems: 'center',
  },
  stepBadgeText: {
    color: '#FFF',
    fontSize: 14,
    fontFamily: 'Urbanist-Bold',
  },
  sectionTitle: {
    fontSize: 19,
    fontFamily: 'Urbanist-Bold',
  },
  inputGroup: {
    width: '100%',
    marginBottom: 16,
  },
  inputLabel: {
    fontSize: 13,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 8,
    marginLeft: 4,
    letterSpacing: 0.2,
  },
  input: {
    width: '100%',
    height: 56,
    borderRadius: 16,
    paddingHorizontal: 16,
    fontSize: 16,
    fontFamily: 'Urbanist-Medium',
    borderWidth: 1,
  },
  inputDisabled: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  usernamePrefix: {
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
    color: '#9E9E9E',
  },
  usernameField: {
    flex: 1,
    fontSize: 16,
    fontFamily: 'Urbanist-Medium',
    height: '100%',
  },
  textArea: {
    height: 100,
    paddingTop: 16,
    textAlignVertical: 'top',
  },
  uploadBox: {
    width: '100%',
    aspectRatio: 1.5,
    borderRadius: 20,
    borderWidth: 2,
    borderStyle: 'dashed',
    justifyContent: 'center',
    alignItems: 'center',
    overflow: 'hidden',
  },
  uploadPlaceholder: {
    alignItems: 'center',
  },
  uploadCircleInner: {
    width: 58,
    height: 58,
    borderRadius: 29,
    marginBottom: 15,
    justifyContent: 'center',
    alignItems: 'center',
  },
  uploadText: {
    fontSize: 18,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 5,
  },
  uploadSubtext: {
    fontSize: 12,
    color: '#9E9E9E',
    fontFamily: 'Urbanist-Medium',
  },
  previewImage: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  previewOverlay: {
    position: 'absolute',
    top: 12,
    right: 12,
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  photoActionsRow: { flexDirection: 'row', justifyContent: 'center', gap: 10 },
  changePhotoBtn: {
    marginTop: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,77,103,0.08)',
  },
  changePhotoText: {
    fontSize: 14,
    fontFamily: 'Urbanist-Bold',
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 14,
    paddingBottom: Platform.OS === 'ios' ? 0 : 20,
    borderTopWidth: 1,
  },
  buttonWrapper: {
    position: 'relative',
    width: '100%',
    marginBottom: 12,
  },
  glowBackground: {
    position: 'absolute',
    top: -4,
    left: -4,
    right: -4,
    bottom: -4,
    backgroundColor: PRIMARY_COLOR,
    borderRadius: 24,
    shadowColor: PRIMARY_COLOR,
    shadowOffset: { width: 0, height: 0 },
    shadowRadius: 15,
    elevation: 8,
  },
  joinButtonTouchable: {
    width: '100%',
    borderRadius: 20,
    overflow: 'hidden',
    zIndex: 10,
  },
  joinButton: {
    width: '100%',
    height: 60,
    justifyContent: 'center',
    alignItems: 'center',
  },
  joinBtnContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  joinBtnText: {
    color: '#FFF',
    fontSize: 18,
    fontFamily: 'Urbanist-Bold',
  },
  rulesContainer: {
    alignItems: 'center',
    marginBottom: 5,
  },
  rulesLink: {
    color: '#9E9E9E',
    fontSize: 12,
    fontFamily: 'Urbanist-Medium',
    textDecorationLine: 'underline',
  },
  flyingCoin: {
      position: 'absolute',
      top: 0,
      left: '50%',
      marginLeft: -16,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      zIndex: 20,
  },
  flyingCoinText: {
      color: '#FF4D67',
      fontSize: 18,
      fontFamily: 'Urbanist-Bold',
  }
});
