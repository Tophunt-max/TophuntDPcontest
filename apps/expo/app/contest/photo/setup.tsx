import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
  Dimensions,
  Platform,
  TextInput,
  Modal
} from 'react-native';
import { Image } from 'expo-image';
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
  Easing,
  runOnJS
} from 'react-native-reanimated';
import { ImageViewer } from '@/src/components/ui/ImageViewer';
import * as Haptics from 'expo-haptics';
import { getOptimizedMediaUrl } from '@/src/utils/media';

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

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [caption, setCaption] = useState('');
  const [isReady, setIsReady] = useState(false);

  const glowOpacity = useSharedValue(0);
  const [showCoinAnimation, setShowCoinAnimation] = useState(false);
  const coinTranslateY = useSharedValue(0);
  const coinOpacity = useSharedValue(1);

  useEffect(() => { 
    if (contestId) fetchContestDetail(contestId as string);
    else if (matchId) fetchMatchDetail(matchId as string);
  }, [contestId, matchId]);

  useEffect(() => {
    if (profile) {
      setDisplayName(profile.fullName || profile.displayName || '');
      setUsername(profile.username || '');
    }
  }, [profile]);

  useEffect(() => {
    const ready = !!(media && displayName.trim() && username.trim());
    setIsReady(ready);
    if (ready) {
      glowOpacity.value = withRepeat(withSequence(withTiming(0.6, { duration: 1000 }), withTiming(0, { duration: 1000 })), -1, true);
    } else {
        glowOpacity.value = withTiming(0);
    }
  }, [media, displayName, username]);

  const animatedGlowStyle = useAnimatedStyle(() => ({ opacity: glowOpacity.value, shadowOpacity: glowOpacity.value }));
  const animatedCoinStyle = useAnimatedStyle(() => ({ transform: [{ translateY: coinTranslateY.value }], opacity: coinOpacity.value }));

  const fetchContestDetail = async (id: string) => {
    setLoading(true);
    try {
      const contest = await contestService.getContestById(id);
      setSelectedContest(contest);
    } catch (error) { 
      addToast("Failed to load contest details", 'error');
    } finally { setLoading(false); }
  };

  const fetchMatchDetail = async (id: string) => {
    setLoading(true);
    try {
      const match = await contestService.getMatchById(id); 
      setSelectedContest({ ...match, isJoinMode: true });
    } catch (error) { 
      addToast("Failed to load match details", 'error'); 
    } finally { setLoading(false); }
  };

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, quality: 0.8 });
    if (!result.canceled) {
        setMedia(result.assets[0].uri);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  const startCoinAnimation = (callback: () => void) => {
      setShowCoinAnimation(true);
      coinTranslateY.value = 0; coinOpacity.value = 1;
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      coinTranslateY.value = withTiming(-600, { duration: 1000, easing: Easing.out(Easing.exp) });
      coinOpacity.value = withTiming(0, { duration: 1000 }, (f) => { if (f) runOnJS(callback)(); });
  };

  const handleAction = async () => {
    if (!user || !selectedContest || !media || !displayName.trim()) return;
    
    const fee = (selectedContest.entryFee || selectedContest.entryFishCoins || 0) / 2;
    if ((profile?.Dpcoin || 0) < fee) { router.push('/wallet/store'); return; }

    startCoinAnimation(async () => {
        setShowCoinAnimation(false); setUploading(true);
        try {
            const downloadUrl = await contestMediaService.uploadMedia(media, selectedContest.id || selectedContest.contestId, user.uid, 'photo');
            const matchData = { mediaUrl: downloadUrl, mediaType: 'photo', caption, displayName, username, deviceId: 'device-id' };
            if (selectedContest.isJoinMode || mode === 'join') {
              await contestService.joinMatch({ matchId: (matchId as string) || selectedContest.id, ...matchData });
            } else {
              await contestService.startMatch({ contestId: selectedContest.id, ...matchData });
            }
            setShowSuccessModal(true);
          } catch (error: any) {
            addToast(error.message || "Failed to join", 'error');
          } finally { setUploading(false); }
    });
  };

  if (showSuccessModal) return <SuccessModal title="Battle Joined!" subtitle={mode === 'join' || selectedContest?.isJoinMode ? "You are now LIVE!" : "Match created!"} onGoHome={() => { setShowSuccessModal(false); router.replace('/home'); }} />;
  if (loading) return <BattleSetupSkeleton />;
  if (!selectedContest) return null;

  const fee = (selectedContest.entryFee || selectedContest.entryFishCoins || 0) / 2;
  const userCoins = profile?.Dpcoin || 0;
  
  const coinReward = selectedContest.winnerReward || selectedContest.rewardCoins || selectedContest.winningCoins || 0;
  const prizeName = selectedContest.prizeDescription || null;
  const rewardType = selectedContest.rewardType || 'coin';

  const isJoinMode = selectedContest.isJoinMode || mode === 'join';
  const opponent = isJoinMode ? selectedContest.userA : null;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
         <TouchableOpacity onPress={() => router.back()}><Left_Arrow width={24} height={24} color={textColor} /></TouchableOpacity>
         <TouchableOpacity onPress={() => router.push('/wallet/store')} style={[styles.walletContainer, { backgroundColor: inputBg }]}><Text style={[styles.walletText, { color: textColor }]}>{userCoins}</Text><Wallet_Color width={24} height={24} /></TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={[styles.title, { color: textColor }]}>Battle Setup</Text>

        <View style={[styles.breakdownCard, { backgroundColor: cardBg, borderColor }]}>
          <Text style={styles.breakdownLabel}>Entry Fee Breakdown</Text>
          <View style={styles.playersContainer}>
            <View style={styles.playerItem}>
              <View style={styles.playerAvatarCircle}>{profile?.profileImageUrl ? <Image source={{ uri: getOptimizedMediaUrl(profile.profileImageUrl) }} style={styles.avatarImg} /> : <Ionicons name="person" size={36} color="#03A9F4" />}</View>
              <Text style={[styles.playerName, { color: textColor }]}>You</Text>
              <View style={styles.feeInfo}><Text style={styles.feeMinus}>-{fee}</Text><Wallet_Color width={18} height={18} /></View>
            </View>
            <View style={styles.vsCircle}><Text style={styles.vsText}>VS</Text></View>
            <View style={styles.playerItem}>
              <View style={styles.playerAvatarCircle}>{opponent?.profilePic ? <Image source={{ uri: getOptimizedMediaUrl(opponent.profilePic) }} style={styles.avatarImg} /> : <Text style={styles.questionMark}>?</Text>}</View>
              <Text style={[styles.playerName, { color: textColor }]}>{opponent?.username || "Waiting..."}</Text>
              <View style={styles.feeInfo}><Text style={styles.feeMinus}>-{fee}</Text><Wallet_Color width={18} height={18} /></View>
            </View>
          </View>

          <View style={styles.winnerBanner}>
             <Text style={styles.winnerBannerText}>
                🏆 Winner Gets: {rewardType === 'product' ? prizeName : (rewardType === 'both' ? `${prizeName} + ${coinReward} Coins` : `${coinReward} Coins`)}
             </Text>
          </View>
        </View>

        <View style={styles.formSection}>
           <Text style={[styles.sectionTitle, { color: textColor }]}>Your Information</Text>
           <View style={styles.inputGroup}><Text style={[styles.inputLabel, { color: textColor }]}>Display Name</Text><TextInput style={[styles.input, { backgroundColor: inputBg, color: textColor, borderColor }]} value={displayName} onChangeText={setDisplayName} placeholder="Your Full Name" /></View>
           <View style={styles.inputGroup}><Text style={[styles.inputLabel, { color: textColor }]}>Username</Text><TextInput style={[styles.input, { backgroundColor: inputBg, color: '#888', borderColor }]} value={username} editable={false} /></View>
           
           <Text style={[styles.sectionTitle, { color: textColor, marginTop: 10 }]}>Your Submission</Text>
           <TouchableOpacity onPress={media ? () => setIsImageViewVisible(true) : pickImage} style={styles.uploadBox}>{media ? <Image source={{ uri: media }} style={styles.previewImage} /> : <View style={styles.uploadPlaceholder}><Ionicons name="camera" size={24} color="#9E9E9E" /><Text style={[styles.uploadText, { color: textColor }]}>Tap to Upload Photo</Text></View>}</TouchableOpacity>
           {media && <TouchableOpacity onPress={pickImage} style={styles.changePhotoBtn}><Text style={{ color: PRIMARY_COLOR, fontFamily: 'Urbanist-Bold' }}>Change Photo</Text></TouchableOpacity>}

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

      <View style={[styles.footer, { backgroundColor }]}>
        <View style={styles.buttonWrapper}>
          <Animated.View style={[styles.glowBackground, animatedGlowStyle]} />
          <TouchableOpacity onPress={handleAction} disabled={uploading} style={[styles.joinButton, { backgroundColor: (userCoins < fee) ? '#FF9800' : (isReady ? PRIMARY_COLOR : PINK_ACCENT) }]}>
             {uploading ? <ActivityIndicator color="#FFF" /> : <Text style={styles.joinBtnText}>{(userCoins < fee) ? "Get Coins" : `Pay ${fee} Coins & Join`}</Text>}
          </TouchableOpacity>
        </View>
        <TouchableOpacity onPress={() => setShowRulesModal(true)} style={styles.rulesContainer}><Text style={styles.rulesLink}>By joining, you agree to the contest rules.</Text></TouchableOpacity>
      </View>
      <RulesModal isVisible={showRulesModal} onClose={() => setShowRulesModal(false)} rules={selectedContest?.rules || "No rules specified."} title="Contest Rules" />
      {media && <ImageViewer images={[{ uri: media }]} imageIndex={0} visible={isImageViewVisible} onRequestClose={() => setIsImageViewVisible(false)} />}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10 },
  walletContainer: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20, gap: 8 },
  walletText: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  scrollContent: { paddingHorizontal: 20, alignItems: 'center', paddingBottom: 20 },
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginVertical: 15 },
  breakdownCard: { width: '100%', borderRadius: 25, borderWidth: 1, padding: 20, alignItems: 'center', marginBottom: 25 },
  breakdownLabel: { fontSize: 16, fontFamily: 'Urbanist-Medium', color: '#9E9E9E', marginBottom: 20 },
  playersContainer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 20 },
  playerItem: { alignItems: 'center', flex: 1 },
  playerAvatarCircle: { width: 70, height: 70, borderRadius: 35, backgroundColor: '#E1F5FE', justifyContent: 'center', alignItems: 'center', marginBottom: 8, overflow: 'hidden' },
  avatarImg: { width: '100%', height: '100%' },
  playerName: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginBottom: 4 },
  feeInfo: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  feeMinus: { fontSize: 14, color: '#FF4D67', fontFamily: 'Urbanist-Bold' },
  vsCircle: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#FF758C', justifyContent: 'center', alignItems: 'center' },
  vsText: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  questionMark: { fontSize: 32, color: '#FF4D67', fontFamily: 'Urbanist-Bold' },
  winnerBanner: { backgroundColor: '#FEF9C3', width: '100%', paddingVertical: 12, borderRadius: 12, alignItems: 'center' },
  winnerBannerText: { color: '#EAB308', fontFamily: 'Urbanist-Bold', fontSize: 14, textAlign: 'center', paddingHorizontal: 10 },
  formSection: { width: '100%', marginBottom: 20 },
  sectionTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginBottom: 15 },
  inputGroup: { width: '100%', marginBottom: 15 },
  inputLabel: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginBottom: 8, marginLeft: 4 },
  input: { width: '100%', height: 56, borderRadius: 16, paddingHorizontal: 16, fontSize: 16, fontFamily: 'Urbanist-Medium', borderWidth: 1 },
  textArea: { height: 100, paddingTop: 16, textAlignVertical: 'top' },
  uploadBox: { width: '100%', aspectRatio: 1.5, borderRadius: 20, borderWidth: 2, borderStyle: 'dashed', borderColor: '#E0E0E0', justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  uploadPlaceholder: { alignItems: 'center' },
  uploadText: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginTop: 10 },
  previewImage: { width: '100%', height: '100%' },
  changePhotoBtn: { marginTop: 10, alignItems: 'center' },
  footer: { paddingHorizontal: 20, paddingVertical: 15 },
  buttonWrapper: { position: 'relative', width: '100%' },
  glowBackground: { position: 'absolute', top: -4, left: -4, right: -4, bottom: -4, backgroundColor: PRIMARY_COLOR, borderRadius: 24 },
  joinButton: { width: '100%', height: 60, borderRadius: 20, justifyContent: 'center', alignItems: 'center', zIndex: 10 },
  joinBtnText: { color: '#FFF', fontSize: 18, fontFamily: 'Urbanist-Bold' },
  rulesContainer: { alignItems: 'center', marginTop: 10 },
  rulesLink: { color: '#9E9E9E', fontSize: 12, textDecorationLine: 'underline' }
});
