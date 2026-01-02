import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ActivityIndicator, Alert, ScrollView, TextInput } from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { Video, ResizeMode } from 'expo-av';
import { contestService } from '@/src/services/contests/contestService';
import { contestMediaService } from '@/src/services/contests/uploadMedia';
import { useAuth } from '@/src/hooks/useAuth';
import { useProfile } from '@/src/hooks/useProfileData';
import { useThemeColor } from '@/hooks/use-theme-color';
import { LinearGradient } from 'expo-linear-gradient';
import { SuccessModal } from '@/src/components/forms/SuccessModal';

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
  const [showSuccessModal, setShowSuccessModal] = useState(false);

  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');
  const cardBg = useThemeColor({ light: '#FFFFFF', dark: '#1F222A' }, 'background');
  const inputBg = useThemeColor({ light: '#F9F9F9', dark: '#2A2D35' }, 'background');
  const borderColor = useThemeColor({ light: '#EEEEEE', dark: '#35383F' }, 'border');
  const subTextColor = useThemeColor({ light: '#9E9E9E', dark: '#E0E0E0' }, 'text');

  useEffect(() => {
    if (contestId) {
      fetchContestDetail(contestId as string);
    } else {
      loadContests();
    }
  }, [contestId]);

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

  const pickVideo = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      allowsEditing: true,
      quality: 1,
      videoMaxDuration: 30,
    });
    if (!result.canceled) setMedia(result.assets[0].uri);
  };

  const handleAction = async () => {
    if (!selectedContest || !media || !user || caption.trim().length === 0) {
      Alert.alert("Error", "Please upload a video and write a caption.");
      return;
    }

    const fee = selectedContest.entryFishCoins || 0;
    if ((profile?.coins || 0) < fee) {
        Alert.alert("Insufficient Coins", `Need ${fee} Coins. Current: ${profile?.coins || 0}`);
        return;
    }

    setUploading(true);
    try {
      const downloadUrl = await contestMediaService.uploadMedia(media, selectedContest.id || selectedContest.contestId, user.uid, 'video');
      
      if (mode === 'join' || matchId) {
        await contestService.joinMatch({
          matchId: matchId as string || selectedContest.id,
          mediaUrl: downloadUrl,
          mediaType: 'video',
          caption,
          deviceId: 'device-id'
        });
      } else {
        await contestService.startMatch({
          contestId: selectedContest.id,
          mediaUrl: downloadUrl,
          mediaType: 'video',
          caption,
          deviceId: 'device-id'
        });
      }
      setShowSuccessModal(true);
    } catch (error: any) {
      Alert.alert("Oops!", error.message || "Failed to submit.");
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

  if (loading) return <View style={[styles.centered, {backgroundColor: bgColor}]}><ActivityIndicator size="large" color={BRAND_PRIMARY} /></View>;

  return (
    <SafeAreaView style={[styles.container, {backgroundColor: bgColor}]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, {color: textColor}]}>Video Contests</Text>
        <View style={{ width: 28 }} />
      </View>

      {!selectedContest ? (
        <FlatList
          data={contests}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => (
            <TouchableOpacity 
              style={[styles.contestCard, { backgroundColor: cardBg, borderColor }]} 
              onPress={() => setSelectedContest(item)}
            >
              <View>
                <Text style={[styles.contestName, {color: textColor}]}>{item.title || item.name}</Text>
                <Text style={styles.contestPrize}>Prize: {item.winningCoins} Coins</Text>
              </View>
              <Ionicons name="chevron-forward" size={24} color={BRAND_PRIMARY} />
            </TouchableOpacity>
          )}
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={[styles.subtitle, {color: textColor}]}>{selectedContest.title || selectedContest.name}</Text>
          
          <TouchableOpacity style={[styles.mediaUpload, {backgroundColor: inputBg, borderColor}]} onPress={pickVideo}>
            {media ? (
              <Video source={{ uri: media }} style={styles.previewVideo} resizeMode={ResizeMode.COVER} shouldPlay isLooping isMuted />
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
  contestCard: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 20, borderRadius: 20, marginBottom: 12, borderWidth: 1 },
  contestName: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  contestPrize: { color: '#4CAF50', fontFamily: 'Urbanist-SemiBold', marginTop: 4 },
  subtitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginBottom: 20 },
  mediaUpload: { width: '100%', height: 350, borderRadius: 24, overflow: 'hidden', justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderStyle: 'dashed' },
  previewVideo: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center' },
  captionInput: { marginTop: 20, height: 100, borderRadius: 16, padding: 15, borderWidth: 1, textAlignVertical: 'top', fontFamily: 'Urbanist-Medium' },
  joinButton: { marginTop: 30, height: 56, borderRadius: 16, overflow: 'hidden' },
  gradient: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  joinButtonText: { color: 'white', fontSize: 18, fontFamily: 'Urbanist-Bold' }
});
