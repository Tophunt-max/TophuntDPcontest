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
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { contestService } from '@/src/services/contests/contestService';
import { contestMediaService } from '@/src/services/contests/uploadMedia';
import { useAuth } from '@/src/hooks/useAuth';
import { SuccessModal } from '@/src/components/forms/SuccessModal';
import { RulesModal } from '@/src/components/modals/RulesModal';
import { useProfile } from '@/src/hooks/useProfileData'; 
import { useThemeColor } from '@/hooks/use-theme-color';
import { Left_Arrow, Wallet_Color } from '@/assets/svgs'; 
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
  runOnJS,
  useDerivedValue,
  interpolate
} from 'react-native-reanimated';
import { ImageViewer } from '@/src/components/ui/ImageViewer';
import * as Haptics from 'expo-haptics';
import { getDeviceId } from '@/src/lib/deviceId';

const PINK_ACCENT = '#FFB1BD';
const PRIMARY_COLOR = '#FF4D67';

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

  const [loading, setLoading] = useState(true);
  const [selectedContest, setSelectedContest] = useState<any>(null);
  const [media, setMedia] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
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
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled) {
        setMedia(result.assets[0].uri);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const startCoinAnimation = (callback: () => void) => {
      setShowCoinAnimation(true);
      coinTranslateY.value = 0;
      coinOpacity.value = 1;

      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      // Animate up and fade out
      coinTranslateY.value = withTiming(-600, { duration: 1000, easing: Easing.out(Easing.exp) });
      coinOpacity.value = withTiming(0, { duration: 1000, easing: Easing.in(Easing.exp) }, (finished) => {
          if (finished) {
             runOnJS(callback)();
          }
      });
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

    const totalEntryFee = selectedContest.totalEntryFee || selectedContest.entryFishCoins || selectedContest.entryFee || 0;
    const fee = totalEntryFee / 2;
    const userCoins = profile?.coins || profile?.Dpcoin || 0;

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

    // Start Animation and then upload
    startCoinAnimation(async () => {
        setShowCoinAnimation(false);
        setUploading(true);
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
      
            if (selectedContest.isJoinMode || mode === 'join') {
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
            setShowSuccessModal(true);
          } catch (error: any) {
            console.error("[BattleSetup] Action Error:", error);
            const msg = error.details || error.message || "Something went wrong on the server.";
            addToast(msg, 'error');
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
          } finally {
            setUploading(false);
          }
    });
  };

  const navigateToWallet = () => {
    router.push('/wallet/store');
  }
  
  const measureWallet = () => {
     walletRef.current?.measure((x, y, width, height, pageX, pageY) => {
        setWalletPosition({ x: pageX, y: pageY, width, height });
     });
  }

  if (showSuccessModal) return (
    <SuccessModal 
        title="Battle Joined!"
        subtitle={mode === 'join' || selectedContest?.isJoinMode ? "You are now LIVE in this battle!" : "Match created! Waiting for an opponent."}
        onGoHome={() => { setShowSuccessModal(false); router.replace('/home'); }} 
    />
  );

  if (loading) {
    return <BattleSetupSkeleton />;
  }

  if (!selectedContest) return null;

  // Added check for entryFee as well
  const totalEntryFee = selectedContest.totalEntryFee || selectedContest.entryFishCoins || selectedContest.entryFee || 0;
  const fee = totalEntryFee / 2;
  const winningReward = selectedContest.rewardCoins || selectedContest.winningCoins || 0;
  const userCoins = profile?.coins || profile?.Dpcoin || 0;
  const hasInsufficientCoins = userCoins < fee;

  // Identify if we are User B joining an existing match
  const isJoinMode = selectedContest.isJoinMode || mode === 'join';
  const opponent = isJoinMode ? selectedContest.userA : null;
  const opponentPic = opponent?.profilePic || opponent?.profileImageUrl;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
         <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Left_Arrow width={24} height={24} color={textColor} />
         </TouchableOpacity>
         <TouchableOpacity 
            ref={walletRef}
            onLayout={measureWallet}
            onPress={navigateToWallet} 
            style={[styles.walletContainer, { backgroundColor: inputBg }]}
         >
            <Text style={[styles.walletText, { color: textColor }]}>{userCoins}</Text>
            <Wallet_Color width={24} height={24} />
         </TouchableOpacity>
      </View>

      <ScrollView 
        contentContainerStyle={styles.scrollContent} 
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.title, { color: textColor }]}>Battle Setup</Text>

        {/* Entry Fee Breakdown Card */}
        <View style={[styles.breakdownCard, { backgroundColor: cardBg, borderColor }]}>
          <Text style={styles.breakdownLabel}>Entry Fee Breakdown</Text>
          
          <View style={styles.playersContainer}>
            {/* User Profile (Left) */}
            <View style={styles.playerItem}>
              <View style={[styles.playerAvatarCircle, { backgroundColor: '#E1F5FE' }]}>
                {profile?.profileImageUrl ? (
                  <Image source={{ uri: profile.profileImageUrl }} style={styles.avatarImg} />
                ) : (
                  <Ionicons name="person" size={36} color="#03A9F4" />
                )}
              </View>
              <Text style={[styles.playerName, { color: textColor }]} numberOfLines={1}>You</Text>
              <View style={styles.feeInfo}>
                <Text style={styles.feeMinus}>-{fee}</Text>
                <View style={styles.coinIconWrapper}>
                   <Wallet_Color width={24} height={24} />
                </View>
              </View>
            </View>

            <View style={styles.vsCircle}>
              <Text style={styles.vsText}>VS</Text>
            </View>

            {/* Opponent Profile (Right) */}
            <View style={styles.playerItem}>
              <View style={[styles.playerAvatarCircle, { backgroundColor: opponent ? '#E1F5FE' : '#FFF5F5' }]}>
                {opponentPic ? (
                  <Image source={{ uri: opponentPic }} style={styles.avatarImg} />
                ) : (
                  opponent ? (
                    <Ionicons name="person" size={36} color="#03A9F4" />
                  ) : (
                    <Text style={styles.questionMark}>?</Text>
                  )
                )}
              </View>
              <Text style={[styles.playerName, { color: textColor }]} numberOfLines={1}>
                {opponent ? (opponent.displayName || opponent.username || "Opponent") : "Waiting..."}
              </Text>
              <View style={styles.feeInfo}>
                <Text style={styles.feeMinus}>-{fee}</Text>
                <View style={styles.coinIconWrapper}>
                   <Wallet_Color width={24} height={24} />
                </View>
              </View>
            </View>
          </View>

          <View style={styles.winnerBanner}>
             <Text style={styles.winnerBannerText}>🏆 Winner Gets {winningReward} Coins!</Text>
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

        {/* User Info & Submission Section */}
        <View style={styles.formSection}>
           <Text style={[styles.sectionTitle, { color: textColor }]}>Your Information</Text>
           
           <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: textColor }]}>Display Name</Text>
              <TextInput 
                style={[styles.input, { backgroundColor: inputBg, color: textColor, borderColor }]}
                value={displayName}
                onChangeText={setDisplayName}
                placeholder="Your name"
                placeholderTextColor="#9E9E9E"
              />
           </View>

           <View style={styles.inputGroup}>
              <Text style={[styles.inputLabel, { color: textColor }]}>Username</Text>
              <TextInput 
                style={[styles.input, { backgroundColor: inputBg, color: '#888', borderColor }]}
                value={username}
                editable={false}
                placeholder="username"
                autoCapitalize="none"
                placeholderTextColor="#9E9E9E"
              />
           </View>

           <Text style={[styles.sectionTitle, { color: textColor, marginTop: 10 }]}>Your Submission</Text>
           
           <TouchableOpacity 
              activeOpacity={0.8}
              onPress={media ? () => setIsImageViewVisible(true) : pickImage}
              style={[styles.uploadBox, { borderColor: '#E0E0E0' }]}
            >
              {media ? (
                <Image source={{ uri: media }} style={styles.previewImage} />
              ) : (
                <View style={styles.uploadPlaceholder}>
                  <View style={styles.uploadCircleInner}>
                     <Ionicons name="camera" size={24} color="#9E9E9E" />
                  </View>
                  <Text style={[styles.uploadText, { color: textColor }]}>Tap to Upload Photo</Text>
                  <Text style={styles.uploadSubtext}>Supports JPG, PNG · Max 10MB</Text>
                </View>
              )}
           </TouchableOpacity>
           
           {/* Re-add Upload Button if media is present, to allow changing */}
           {media && (
               <TouchableOpacity onPress={pickImage} style={styles.changePhotoBtn}>
                   <Text style={[styles.changePhotoText, { color: PRIMARY_COLOR }]}>Change Photo</Text>
               </TouchableOpacity>
           )}

           <View style={[styles.inputGroup, { marginTop: 20 }]}>
              <Text style={[styles.inputLabel, { color: textColor }]}>Caption (Optional)</Text>
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
      <View style={[styles.footer, { backgroundColor }]}>
        <View style={styles.buttonWrapper}>
          <Animated.View style={[styles.glowBackground, animatedGlowStyle]} />
          <TouchableOpacity 
            activeOpacity={0.8}
            onPress={handleAction}
            disabled={uploading}
            style={[
              styles.joinButton,
              hasInsufficientCoins ? { backgroundColor: '#FF9800' } : (isReady ? { backgroundColor: PRIMARY_COLOR } : { backgroundColor: PINK_ACCENT })
            ]}
          >
             {uploading ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <Text style={styles.joinBtnText}>
                  {hasInsufficientCoins ? "Get Coins" : `Pay ${fee} Coins & Join`}
                </Text>
              )}
          </TouchableOpacity>
          {/* Coin Animation */}
          {showCoinAnimation && (
            <Animated.View style={[styles.flyingCoin, animatedCoinStyle]}>
                <Wallet_Color width={32} height={32} />
                <Text style={styles.flyingCoinText}>-{fee}</Text>
            </Animated.View>
          )}
        </View>

        <TouchableOpacity onPress={() => setShowRulesModal(true)} style={styles.rulesContainer}>
          <Text style={styles.rulesLink}>By joining, you agree to the contest rules.</Text>
        </TouchableOpacity>
      </View>

      <RulesModal 
        isVisible={showRulesModal}
        onClose={() => setShowRulesModal(false)}
        rules={selectedContest?.rules || "No rules specified for this contest."}
        title={selectedContest?.name || selectedContest?.title ? `${selectedContest.name || selectedContest.title} Rules` : "Contest Rules"}
      />
      
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
  backBtn: { padding: 5 },
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
    paddingVertical: 6,
    borderRadius: 20,
    gap: 8,
  },
  walletText: {
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
  },
  scrollContent: { paddingHorizontal: 20, alignItems: 'center', paddingBottom: 20 },
  title: { 
    fontSize: 28, 
    fontFamily: 'Urbanist-Bold', 
    marginVertical: 15, 
    textAlign: 'center',
    letterSpacing: 1
  },
  breakdownCard: {
    width: '100%',
    borderRadius: 25,
    borderWidth: 1,
    padding: 20,
    alignItems: 'center',
    marginBottom: 25,
  },
  breakdownLabel: {
    fontSize: 16,
    fontFamily: 'Urbanist-Medium',
    color: '#9E9E9E',
    marginBottom: 20,
  },
  playersContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingHorizontal: 10,
    marginBottom: 20,
  },
  playerItem: {
    alignItems: 'center',
    flex: 1,
  },
  playerAvatarCircle: {
    width: 70,
    height: 70,
    borderRadius: 35,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 8,
    overflow: 'hidden',
  },
  avatarImg: {
    width: '100%',
    height: '100%',
    resizeMode: 'cover',
  },
  playerName: {
    fontSize: 16,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 4,
    width: 80,
    textAlign: 'center',
  },
  feeInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  feeMinus: {
    fontSize: 14,
    color: '#FF4D67',
    fontFamily: 'Urbanist-Bold',
  },
  coinIconWrapper: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  coinIconOuter: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#FFD700',
    borderWidth: 1,
    borderColor: '#DAA520',
    justifyContent: 'center',
    alignItems: 'center',
  },
  coinIconInner: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.5)',
  },
  vsCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#FF758C',
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 1,
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
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
  winnerBannerText: {
    color: '#EAB308',
    fontFamily: 'Urbanist-Bold',
    fontSize: 15,
  },
  matchupPreviewContainer: {
    width: '100%',
    marginBottom: 25,
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
    marginBottom: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 15,
  },
  inputGroup: {
    width: '100%',
    marginBottom: 15,
  },
  inputLabel: {
    fontSize: 14,
    fontFamily: 'Urbanist-Bold',
    marginBottom: 8,
    marginLeft: 4,
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
    width: 50,
    height: 50,
    borderRadius: 25,
    backgroundColor: '#F5F5F5',
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
  changePhotoBtn: {
    marginTop: 10,
    alignItems: 'center',
  },
  changePhotoText: {
    fontSize: 14,
    fontFamily: 'Urbanist-Bold',
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 0 : 20,
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
  joinButton: {
    width: '100%',
    height: 60,
    borderRadius: 20,
    justifyContent: 'center',
    alignItems: 'center',
    zIndex: 10,
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
