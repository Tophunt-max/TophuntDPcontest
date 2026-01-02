import React, { useState, useEffect } from 'react';
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
import { Left_Arrow } from '@/assets/svgs'; 
import { BattleSetupSkeleton } from '@/src/components/contests/BattleSetupSkeleton';

const PINK_ACCENT = '#FFB1BD';

export default function BattleSetupScreen() {
  const router = useRouter();
  const { contestId, matchId, mode } = useLocalSearchParams(); 
  const { user } = useAuth();
  const { data: profile } = useProfile(user?.uid || ''); 
  
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

  // New form state
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [caption, setCaption] = useState('');

  useEffect(() => { 
    if (contestId) {
      fetchContestDetail(contestId as string);
    } else if (matchId) {
       fetchMatchDetail(matchId as string);
    }
  }, [contestId, matchId]);

  // Autofill user info
  useEffect(() => {
    if (profile) {
      setDisplayName(profile.displayName || '');
      setUsername(profile.username || '');
    }
  }, [profile]);

  const fetchContestDetail = async (id: string) => {
    setLoading(true);
    try {
      const contest = await contestService.getContestById(id);
      setSelectedContest(contest);
    } catch (error) { console.error(error); } finally { setLoading(false); }
  };

  const fetchMatchDetail = async (id: string) => {
    setLoading(true);
    try {
      const match = await contestService.getMatchById(id); 
      setSelectedContest({ ...match, isJoinMode: true });
    } catch (error) { console.error(error); } finally { setLoading(false); }
  };

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled) setMedia(result.assets[0].uri);
  };

  const handleAction = async () => {
    if (!user) {
      Alert.alert("Authentication Required", "Please log in to participate.");
      return;
    }

    if (!selectedContest) {
      Alert.alert("Error", "No contest selected.");
      return;
    }

    if (!media) {
      Alert.alert("Hold on!", "Please upload a photo first.");
      return;
    }

    if (!displayName.trim() || !username.trim()) {
      Alert.alert("Required Fields", "Please provide your name and username.");
      return;
    }

    // Backend uses totalEntryFee. Fallback to entryFishCoins for compatibility.
    const totalEntryFee = selectedContest.totalEntryFee || selectedContest.entryFishCoins || 0;
    const fee = totalEntryFee / 2;
    // Backend uses 'coins' field in user document.
    const userCoins = profile?.coins || profile?.fishCoins || 0;

    if (userCoins < fee) {
        Alert.alert("Insufficient Coins", `You need ${fee} Coins. Current: ${userCoins}`);
        return;
    }

    setUploading(true);
    try {
      const downloadUrl = await contestMediaService.uploadMedia(media, selectedContest.id || selectedContest.contestId, user.uid, 'photo');
      
      const matchData = {
        mediaUrl: downloadUrl,
        mediaType: 'photo',
        caption: caption,
        displayName: displayName, // Note: Backend currently fetches these from User Doc
        username: username,
        deviceId: 'device-id' 
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
      setShowSuccessModal(true);
    } catch (error: any) {
      console.error("[BattleSetup] Action Error:", error);
      // Detailed error if possible
      const msg = error.details || error.message || "Something went wrong on the server.";
      Alert.alert("Submission Failed", msg);
    } finally {
      setUploading(false);
    }
  };

  if (showSuccessModal) return (
    <SuccessModal 
        title="Battle Joined!"
        subtitle={mode === 'join' ? "You are now LIVE in this battle!" : "Match created! Waiting for an opponent."}
        onGoHome={() => { setShowSuccessModal(false); router.replace('/home'); }} 
    />
  );

  if (loading) {
    return <BattleSetupSkeleton />;
  }

  if (!selectedContest) return null;

  const totalEntryFee = selectedContest.totalEntryFee || selectedContest.entryFishCoins || 0;
  const fee = totalEntryFee / 2;
  const winningReward = selectedContest.rewardCoins || selectedContest.winningCoins || 0;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]} edges={['top', 'bottom']}>
      <View style={styles.header}>
         <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
            <Left_Arrow width={24} height={24} fill={textColor} />
         </TouchableOpacity>
         <View style={styles.avatarPlaceholder} />
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
                   <View style={styles.coinIconOuter}>
                      <View style={styles.coinIconInner} />
                   </View>
                </View>
              </View>
            </View>

            <View style={styles.vsCircle}>
              <Text style={styles.vsText}>VS</Text>
            </View>

            <View style={styles.playerItem}>
              <View style={[styles.playerAvatarCircle, { backgroundColor: '#FFF5F5' }]}>
                 <Text style={styles.questionMark}>?</Text>
              </View>
              <Text style={[styles.playerName, { color: textColor }]} numberOfLines={1}>Opponent</Text>
              <View style={styles.feeInfo}>
                <Text style={styles.feeMinus}>-{fee}</Text>
                <View style={styles.coinIconWrapper}>
                   <View style={styles.coinIconOuter}>
                      <View style={styles.coinIconInner} />
                   </View>
                </View>
              </View>
            </View>
          </View>

          <View style={styles.winnerBanner}>
             <Text style={styles.winnerBannerText}>🏆 Winner Gets {winningReward} Coins!</Text>
          </View>
        </View>

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
                style={[styles.input, { backgroundColor: inputBg, color: textColor, borderColor }]}
                value={username}
                onChangeText={setUsername}
                placeholder="username"
                autoCapitalize="none"
                placeholderTextColor="#9E9E9E"
              />
           </View>

           <Text style={[styles.sectionTitle, { color: textColor, marginTop: 10 }]}>Your Submission</Text>
           
           <TouchableOpacity 
              activeOpacity={0.8}
              onPress={pickImage}
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
        <TouchableOpacity 
          activeOpacity={0.8}
          onPress={handleAction}
          disabled={uploading}
          style={styles.joinButton}
        >
           {uploading ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.joinBtnText}>Pay {fee} Coins & Join</Text>
            )}
        </TouchableOpacity>

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
    width: 16,
    height: 16,
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
  footer: {
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 0 : 20,
  },
  joinButton: {
    width: '100%',
    height: 60,
    borderRadius: 20,
    backgroundColor: PINK_ACCENT,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
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
});
