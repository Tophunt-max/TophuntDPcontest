import React, { useState, useEffect } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  FlatList, 
  Image, 
  ActivityIndicator, 
  Alert, 
  ScrollView, 
  Dimensions, 
  TextInput, 
  KeyboardAvoidingView, 
  Platform, 
  StatusBar,
  Share
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { contestService } from '@/src/services/contests/contestService';
import { contestMediaService } from '@/src/services/contests/uploadMedia';
import { httpsCallable } from 'firebase/functions';
import { functions } from '@/src/services/firebase/initFirebase';
import { useAuth } from '@/src/hooks/useAuth';
import { Contest } from '@/src/types/contest';
import { SuccessModal } from '@/src/components/forms/SuccessModal';
import { useProfile } from '@/src/hooks/useProfileData'; 
import dayjs from 'dayjs';
import duration from 'dayjs/plugin/duration';
import { LinearGradient } from 'expo-linear-gradient';
import { useThemeColor } from '@/hooks/use-theme-color';

dayjs.extend(duration);

const { width } = Dimensions.get('window');

// --- APP THEME COLORS ---
const BRAND_PRIMARY = '#FF4D67'; 
const BRAND_SECONDARY = '#FFA3B3'; 
const ACCENT = '#FFD700'; 

// --- Helper Component: Countdown Timer ---
const CountdownTimer = ({ endDate, style }: { endDate: any, style?: any }) => {
    const [timeLeft, setTimeLeft] = useState("");
  
    useEffect(() => {
      const calculateTimeLeft = () => {
        const end = dayjs(endDate.toDate());
        const now = dayjs();
        const diff = end.diff(now);
  
        if (diff <= 0) return "Ended";
  
        const d = dayjs.duration(diff);
        if (d.asDays() >= 1) {
            return `${Math.floor(d.asDays())}d ${d.hours()}h left`;
        }
        return `${d.hours()}h ${d.minutes()}m left`;
      };
  
      setTimeLeft(calculateTimeLeft());
      const timer = setInterval(() => {
        setTimeLeft(calculateTimeLeft());
      }, 60000); // Update every minute
  
      return () => clearInterval(timer);
    }, [endDate]);
  
    return (
        <Text style={[styles.infoText, style]}>{timeLeft}</Text>
    );
};

export default function PhotoContestScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const { data: profile } = useProfile(user?.uid || ''); 
  
  // Theme Hooks
  const backgroundColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  
  // Custom Card Backgrounds based on theme
  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const inputBg = useThemeColor({ light: '#F9F9F9', dark: '#2A2D35' }, 'background');
  const borderColor = useThemeColor({ light: '#EEEEEE', dark: '#35383F' }, 'border');
  const subTextColor = useThemeColor({ light: '#9E9E9E', dark: '#E0E0E0' }, 'text');

  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedContest, setSelectedContest] = useState<Contest | null>(null);
  const [media, setMedia] = useState<string | null>(null);
  
  const [caption, setCaption] = useState(""); 
  const [displayName, setDisplayName] = useState("");
  const [username, setUsername] = useState("");
  const [uploading, setUploading] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  useEffect(() => { loadContests(); }, []);

  useEffect(() => {
    if (user) setDisplayName(prev => prev || user.displayName || "");
    if (profile?.username) {
        setUsername(profile.username);
        if (profile.fullName && !displayName) setDisplayName(profile.fullName);
    }
  }, [user, profile]);

  const loadContests = async () => {
    try {
      const data = await contestService.getLiveContests('photo');
      setContests(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoading(false);
    }
  };

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      allowsEditing: true,
      quality: 0.8,
    });
    if (!result.canceled) setMedia(result.assets[0].uri);
  };

  const handleJoin = async () => {
    if (!selectedContest || !media || !user || !displayName.trim() || caption.trim().length === 0) {
      Alert.alert("Hold on!", "Please upload a photo and write a caption first.");
      return;
    }
    setUploading(true);
    try {
      const downloadUrl = await contestMediaService.uploadMedia(media, selectedContest.id, user.uid, 'photo');
      const joinContestFn = httpsCallable(functions, 'joinContest');
      await joinContestFn({
        contestId: selectedContest.id,
        mediaUrl: downloadUrl,
        caption,
        username: username || 'user', 
        displayName, 
      });
      setShowSuccessModal(true);
    } catch (error: any) {
      Alert.alert("Oops!", error.message || "Something went wrong.");
    } finally {
      setUploading(false);
    }
  };

  const handleShare = async () => {
    try {
      const result = await Share.share({
        message: `I just joined the ${selectedContest?.name || 'Photo Contest'} on Fishagram! Come check out my entry!`,
      });
    } catch (error: any) {
      Alert.alert(error.message);
    }
  };

  const renderContestCard = ({ item, index }: { item: Contest, index: number }) => {
    const gradients = [
        ['#FF9A9E', '#FECFEF'],
        ['#a18cd1', '#fbc2eb'],
        ['#84fab0', '#8fd3f4'],
        ['#fccb90', '#d57eeb'],
    ];
    const gradient = gradients[index % gradients.length];
    const entryFee = Math.floor(item.entryFishCoins / 2);

    return (
      <TouchableOpacity 
        activeOpacity={0.9}
        style={[styles.contestCard, { backgroundColor: cardBg, borderColor }]} 
        onPress={() => setSelectedContest(item)}
      >
        {item.bannerUrl ? (
          <View style={styles.bannerHeader}>
             <Image source={{ uri: item.bannerUrl }} style={styles.bannerImage} resizeMode="cover" />
             <LinearGradient
               colors={['transparent', 'rgba(0,0,0,0.6)']}
               style={styles.bannerOverlay}
             />
             <Text style={styles.bannerTitle}>{item.name}</Text>
          </View>
        ) : (
          <LinearGradient
              colors={gradient as any}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.cardHeader}
          >
              <View style={styles.iconContainer}>
                  <Ionicons name="camera-outline" size={24} color="#FFF" />
              </View>
              <Text style={styles.cardTitle}>{item.name}</Text>
          </LinearGradient>
        )}
        
        <View style={styles.cardBody}>
            <View style={styles.prizeSection}>
                <Text style={[styles.label, { color: textColor }]}>Prize Pool</Text>
                <View style={styles.prizeBadge}>
                    <Text style={styles.prizeText}>🏆 {item.winningCoins} Coins</Text>
                </View>
            </View>
            
            <View style={styles.divider} />

            <View style={styles.infoRow}>
                <View style={styles.infoItem}>
                    <Ionicons name="ticket-outline" size={18} color="#FF4D67" />
                    <Text style={[styles.infoText, { color: textColor }]}>{entryFee} Fish Entry</Text>
                </View>
                <View style={styles.infoItem}>
                    <Ionicons name="time-outline" size={18} color="#FF4D67" />
                    <CountdownTimer endDate={item.endDate} style={{ color: textColor }} />
                </View>
            </View>

            <TouchableOpacity style={styles.enterButton} onPress={() => setSelectedContest(item)}>
                <Text style={styles.enterButtonText}>Enter Now</Text>
                <Ionicons name="arrow-forward" size={18} color="#FFF" />
            </TouchableOpacity>
        </View>
      </TouchableOpacity>
    );
  };

  if (showSuccessModal) return (
    <SuccessModal 
        title="Submission Successful!"
        subtitle="You have successfully joined the contest."
        onGoHome={() => { setShowSuccessModal(false); router.replace('/home'); }} 
        onShare={handleShare}
    />
  );

  // --- GAME LOBBY VIEW (Restored & Improved) ---
  if (selectedContest) {
    const entryFee = Math.floor(selectedContest.entryFishCoins / 2);

    return (
        <View style={[styles.lobbyContainer, { backgroundColor }]}>
            <StatusBar barStyle={Platform.OS === 'ios' ? 'dark-content' : 'default'} />
            <SafeAreaView style={{ flex: 1 }}>
                
                {/* Header */}
                <View style={styles.lobbyHeader}>
                    <TouchableOpacity 
                        onPress={() => { setSelectedContest(null); setMedia(null); }} 
                        style={[styles.backCircle, { backgroundColor: inputBg }]}
                    >
                        <Ionicons name="chevron-back" size={24} color={textColor} />
                    </TouchableOpacity>
                    <Text style={[styles.lobbyTitle, { color: textColor }]}>Battle Setup</Text>
                    <View style={{ width: 40 }} />
                </View>

                <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
                    
                    {/* 1. VS CARD */}
                    <View style={[styles.vsCard, { backgroundColor: cardBg, borderColor }]}>
                        <Text style={[styles.vsTitle, { color: subTextColor }]}>Entry Fee Breakdown</Text>
                        <View style={styles.vsRow}>
                            <View style={styles.playerCol}>
                                <View style={[styles.avatarCircle, { backgroundColor: inputBg }]}>
                                    <Text style={{ fontSize: 24 }}>👤</Text>
                                </View>
                                <Text style={[styles.playerLabel, { color: textColor }]}>You</Text>
                                <Text style={[styles.playerFee, { color: BRAND_PRIMARY }]}>-{entryFee} 🪙</Text>
                            </View>
                            <View style={styles.vsBadgeContainer}>
                                <LinearGradient colors={[BRAND_PRIMARY, '#FF8A9B']} style={styles.vsBadge}>
                                    <Text style={styles.vsText}>VS</Text>
                                </LinearGradient>
                            </View>
                            <View style={styles.playerCol}>
                                <View style={[styles.avatarCircle, { backgroundColor: inputBg }]}>
                                    <Text style={{ fontSize: 24 }}>❓</Text>
                                </View>
                                <Text style={[styles.playerLabel, { color: textColor }]}>Opponent</Text>
                                <Text style={[styles.playerFee, { color: BRAND_PRIMARY }]}>-{entryFee} 🪙</Text>
                            </View>
                        </View>
                        <View style={[styles.poolBanner, { backgroundColor: '#FFF9C4' }]}>
                            <Text style={[styles.poolText, { color: '#FBC02D' }]}>🏆 Winner Gets {selectedContest.winningCoins} Coins!</Text>
                        </View>
                    </View>

                    {/* 2. UPLOAD CARD */}
                    <Text style={[styles.sectionHeader, { color: textColor }]}>Your Submission</Text>
                    <TouchableOpacity 
                        onPress={pickImage} 
                        activeOpacity={0.9} 
                        style={[
                            styles.uploadContainer, 
                            { backgroundColor: cardBg, borderColor: media ? BRAND_PRIMARY : borderColor }, 
                            !media && styles.uploadDashed
                        ]}
                    >
                        {media ? (
                            <>
                                <Image source={{ uri: media }} style={styles.fullImage} resizeMode="cover" />
                                <LinearGradient colors={['transparent', 'rgba(0,0,0,0.7)']} style={styles.imageOverlay} />
                                <View style={styles.imageOverlayContent}>
                                    <View style={styles.tagBadge}>
                                        <Ionicons name="checkmark-circle" size={14} color="#FFF" />
                                        <Text style={styles.tagText}>Ready to Submit</Text>
                                    </View>
                                    <TouchableOpacity style={styles.fabButton} onPress={pickImage}>
                                        <MaterialIcons name="edit" size={20} color={BRAND_PRIMARY} />
                                    </TouchableOpacity>
                                </View>
                            </>
                        ) : (
                            <View style={styles.emptyUploadContent}>
                                <View style={[styles.uploadIconCircle, { backgroundColor: inputBg }]}>
                                    <Ionicons name="cloud-upload" size={32} color={BRAND_PRIMARY} />
                                </View>
                                <Text style={[styles.uploadTitle, { color: textColor }]}>Tap to Upload Photo</Text>
                                <Text style={[styles.uploadSubtitle, { color: subTextColor }]}>Supports JPG, PNG • Max 10MB</Text>
                            </View>
                        )}
                    </TouchableOpacity>

                    {/* 3. FORM FIELDS */}
                    <View style={styles.formContainer}>
                        <View style={styles.fieldGroup}>
                            <Text style={[styles.label, { color: textColor }]}>Display Name</Text>
                            <View style={[styles.inputWrapper, { backgroundColor: inputBg, borderColor }]}>
                                <Ionicons name="person-outline" size={20} color={subTextColor} style={styles.inputIcon} />
                                <TextInput 
                                    style={[styles.textInput, { color: textColor }]} 
                                    value={displayName} 
                                    onChangeText={setDisplayName}
                                    placeholder="Enter your name"
                                    placeholderTextColor={subTextColor}
                                />
                            </View>
                        </View>

                        <View style={styles.fieldGroup}>
                            <View style={{flexDirection: 'row', justifyContent: 'space-between'}}>
                                <Text style={[styles.label, { color: textColor }]}>Caption</Text>
                                <Text style={[styles.charCount, { color: subTextColor }]}>{caption.length}/100</Text>
                            </View>
                            <View style={[styles.inputWrapper, { backgroundColor: inputBg, borderColor, alignItems: 'flex-start', paddingVertical: 12 }]}>
                                <MaterialIcons name="short-text" size={22} color={subTextColor} style={styles.inputIcon} />
                                <TextInput 
                                    style={[styles.textInput, { color: textColor, height: 60, textAlignVertical: 'top' }]} 
                                    value={caption} 
                                    onChangeText={setCaption}
                                    placeholder="Write something interesting..."
                                    placeholderTextColor={subTextColor}
                                    multiline
                                    maxLength={100}
                                />
                            </View>
                        </View>
                    </View>

                </ScrollView>

                {/* JOIN BUTTON */}
                <View style={[styles.joinBar, { backgroundColor: cardBg, shadowColor: borderColor }]}>
                    <TouchableOpacity 
                        style={[styles.bigJoinBtn, { opacity: (uploading || !media) ? 0.6 : 1 }]}
                        onPress={handleJoin}
                        disabled={uploading || !media}
                    >
                         <LinearGradient 
                            colors={[BRAND_PRIMARY, '#FF8A9B']} 
                            start={{x: 0, y: 0}} end={{x: 1, y: 0}}
                            style={styles.btnGradient}
                         >
                            {uploading ? (
                                <ActivityIndicator color="#FFF" />
                            ) : (
                                <>
                                    <Text style={styles.btnMainText}>Pay {entryFee} Coins & Join</Text>
                                    <Ionicons name="arrow-forward" size={20} color="#FFF" />
                                </>
                            )}
                         </LinearGradient>
                    </TouchableOpacity>
                    <Text style={[styles.disclaimer, { color: subTextColor }]}>By joining, you agree to the contest rules.</Text>
                </View>
            </SafeAreaView>
        </View>
    );
  }

  // --- LIST VIEW ---
  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()} style={[styles.backButton, { borderColor: borderColor }]}>
          <Ionicons name="arrow-back" size={24} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, { color: textColor }]}>Photo Contests</Text>
        <View style={{ width: 40 }} />
      </View>

      {loading ? (
        <View style={styles.center}><ActivityIndicator size="large" color={BRAND_PRIMARY} /></View>
      ) : (
        <FlatList
            data={contests}
            keyExtractor={item => item.id}
            renderItem={renderContestCard}
            contentContainerStyle={{ padding: 20, paddingBottom: 40 }}
            showsVerticalScrollIndicator={false}
            ListEmptyComponent={<Text style={[styles.emptyText, { color: subTextColor }]}>No live contests right now.</Text>}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  lobbyContainer: { flex: 1 }, 
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  
  // Headers (Restored)
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10 },
  backButton: { width: 40, height: 40, borderRadius: 12, borderWidth: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  
  // --- RESTORED CARD STYLES ---
  contestCard: { 
    borderRadius: 24, 
    marginBottom: 20,
    borderWidth: 1,
    overflow: 'hidden',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
  },
  cardHeader: { padding: 20, flexDirection: 'row', alignItems: 'center' },
  
  // Banner Styles in List
  bannerHeader: { height: 120, width: '100%', position: 'relative' },
  bannerImage: { width: '100%', height: '100%' },
  bannerOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, height: '100%' },
  bannerTitle: { position: 'absolute', bottom: 15, left: 20, color: '#FFF', fontSize: 22, fontFamily: 'Urbanist-Bold', zIndex: 10 },

  iconContainer: { width: 40, height: 40, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.3)', justifyContent: 'center', alignItems: 'center', marginRight: 15 },
  cardTitle: { fontSize: 22, fontFamily: 'Urbanist-Bold', color: '#FFF', flex: 1 },
  
  cardBody: { padding: 20 },
  prizeSection: { marginBottom: 15 },
  label: { fontSize: 14, fontFamily: 'Urbanist-Medium', marginBottom: 5, opacity: 0.7 },
  prizeBadge: { alignSelf: 'flex-start', backgroundColor: '#E8F5E9', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  prizeText: { color: '#2E7D32', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  divider: { height: 1, backgroundColor: '#EEE', marginVertical: 15 },
  infoRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 20 },
  infoItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  infoText: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
  enterButton: { backgroundColor: '#FF4D67', flexDirection: 'row', justifyContent: 'center', alignItems: 'center', paddingVertical: 14, borderRadius: 16, gap: 8 },
  enterButtonText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },

  // --- DETAIL / LOBBY STYLES ---
  lobbyHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingVertical: 10 },
  backCircle: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', elevation: 0 },
  lobbyTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },

  scrollContent: { padding: 20, paddingBottom: 100 },
  vsCard: { borderRadius: 20, padding: 20, alignItems: 'center', borderWidth: 1, elevation: 1, marginBottom: 24 },
  vsTitle: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginBottom: 16 },
  vsRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', width: '100%', marginBottom: 16 },
  playerCol: { alignItems: 'center', flex: 1 },
  avatarCircle: { width: 56, height: 56, borderRadius: 28, justifyContent: 'center', alignItems: 'center', marginBottom: 8 },
  playerLabel: { fontSize: 14, fontFamily: 'Urbanist-Bold' },
  playerFee: { fontSize: 12, marginTop: 2, fontFamily: 'Urbanist-Bold' },
  vsBadgeContainer: { zIndex: 10 },
  vsBadge: { width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', elevation: 5 },
  vsText: { color: '#FFF', fontFamily: 'Urbanist-Black', fontSize: 14, fontStyle: 'italic' },
  poolBanner: { width: '100%', paddingVertical: 8, borderRadius: 8, alignItems: 'center' },
  poolText: { fontFamily: 'Urbanist-Bold', fontSize: 13 },

  sectionHeader: { fontSize: 16, fontFamily: 'Urbanist-Bold', marginBottom: 12, marginLeft: 4 },
  uploadContainer: { height: 240, borderRadius: 24, marginBottom: 24, borderWidth: 1, elevation: 2, overflow: 'hidden' },
  uploadDashed: { borderWidth: 2, borderStyle: 'dashed' },
  emptyUploadContent: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  uploadIconCircle: { width: 64, height: 64, borderRadius: 32, justifyContent: 'center', alignItems: 'center', marginBottom: 12 },
  uploadTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold' },
  uploadSubtitle: { fontSize: 13, marginTop: 4 },
  fullImage: { width: '100%', height: '100%', borderRadius: 24 },
  imageOverlay: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, borderBottomLeftRadius: 24, borderBottomRightRadius: 24 },
  imageOverlayContent: { position: 'absolute', bottom: 16, left: 16, right: 16, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  tagBadge: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 12, gap: 6 },
  tagText: { color: '#FFF', fontSize: 12, fontFamily: 'Urbanist-Bold' },
  fabButton: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#FFF', justifyContent: 'center', alignItems: 'center', elevation: 4 },

  formContainer: { marginBottom: 20 },
  fieldGroup: { marginBottom: 16 },
  label: { fontSize: 14, fontFamily: 'Urbanist-Bold', marginBottom: 8, marginLeft: 4 },
  inputWrapper: { flexDirection: 'row', alignItems: 'center', borderRadius: 16, paddingHorizontal: 16, borderWidth: 1 },
  inputIcon: { marginRight: 10 },
  textInput: { flex: 1, fontSize: 16, fontFamily: 'Urbanist-Regular', paddingVertical: 14 },
  charCount: { fontSize: 12 },

  joinBar: { position: 'absolute', bottom: 0, left: 0, right: 0, padding: 20, borderTopLeftRadius: 24, borderTopRightRadius: 24, shadowOffset: { width: 0, height: -4 }, shadowOpacity: 0.05, elevation: 20 },
  bigJoinBtn: { borderRadius: 16, overflow: 'hidden', height: 56, marginBottom: 10 },
  btnGradient: { flex: 1, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8 },
  btnMainText: { color: '#FFF', fontSize: 18, fontFamily: 'Urbanist-Bold' },
  disclaimer: { textAlign: 'center', fontSize: 11 },

  emptyText: { textAlign: 'center', marginTop: 50 },
});
