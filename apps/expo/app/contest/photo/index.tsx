import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList, Image, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { contestService } from '@/src/services/contests/contestService';
import { contestMediaService } from '@/src/services/contests/uploadMedia';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { useAuth } from '@/src/hooks/useAuth';
import { Contest } from '@/src/types/contest';
import { useThemeColor } from '@/hooks/use-theme-color';

export default function PhotoContestScreen() {
  const router = useRouter();
  const { user } = useAuth();
  const [contests, setContests] = useState<Contest[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedContest, setSelectedContest] = useState<Contest | null>(null);
  const [media, setMedia] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const bgColor = useThemeColor({}, 'background');
  const textColor = useThemeColor({}, 'text');

  useEffect(() => {
    loadContests();
  }, []);

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
      aspect: [4, 5],
      quality: 0.8,
    });

    if (!result.canceled) {
      setMedia(result.assets[0].uri);
    }
  };

  const handleJoin = async () => {
    if (!selectedContest || !media || !user) {
      Alert.alert("Error", "Please select a contest and upload a photo.");
      return;
    }

    setUploading(true);
    try {
      // 1. Upload Media
      const downloadUrl = await contestMediaService.uploadMedia(
        media, 
        selectedContest.id, 
        user.uid, 
        'photo'
      );

      // 2. Call Cloud Function to Join
      const functions = getFunctions();
      const joinContestFn = httpsCallable(functions, 'joinContest');
      
      const result: any = await joinContestFn({
        contestId: selectedContest.id,
        mediaUrl: downloadUrl,
        username: user.displayName || 'user',
        displayName: user.displayName || 'User',
      });

      Alert.alert("Success", result.data.message);
      router.replace('/home');
    } catch (error: any) {
      console.error(error);
      Alert.alert("Error", error.message || "Failed to join contest.");
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <View style={[styles.centered, {backgroundColor: bgColor}]}><ActivityIndicator size="large" color="#FF4D67" /></View>;

  return (
    <SafeAreaView style={[styles.container, {backgroundColor: bgColor}]}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Ionicons name="chevron-back" size={28} color={textColor} />
        </TouchableOpacity>
        <Text style={[styles.title, {color: textColor}]}>Photo Contests</Text>
        <View style={{ width: 28 }} />
      </View>

      {!selectedContest ? (
        <FlatList
          data={contests}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: 16 }}
          renderItem={({ item }) => (
            <TouchableOpacity 
              style={[styles.contestCard, { backgroundColor: '#F8F8F8' }]} 
              onPress={() => setSelectedContest(item)}
            >
              <View>
                <Text style={styles.contestName}>{item.name}</Text>
                <Text style={styles.contestPrize}>Prize: {item.winningCoins} Coins</Text>
                <Text style={styles.contestFee}>Entry: {item.entryFishCoins / 2} Fish</Text>
              </View>
              <Ionicons name="chevron-forward" size={24} color="#FF4D67" />
            </TouchableOpacity>
          )}
          ListEmptyComponent={<Text style={{textAlign: 'center', marginTop: 20, color: '#999'}}>No live photo contests found.</Text>}
        />
      ) : (
        <ScrollView contentContainerStyle={{ padding: 20 }}>
          <Text style={[styles.subtitle, {color: textColor}]}>Join: {selectedContest.name}</Text>
          <Text style={styles.rulesText}>{selectedContest.rules}</Text>
          
          <TouchableOpacity style={styles.mediaUpload} onPress={pickImage}>
            {media ? (
              <Image source={{ uri: media }} style={styles.previewImage} />
            ) : (
              <View style={styles.placeholder}>
                <Ionicons name="camera" size={40} color="#FF4D67" />
                <Text style={{color: '#666', marginTop: 10}}>Select Photo from Gallery</Text>
              </View>
            )}
          </TouchableOpacity>

          <TouchableOpacity 
            style={[styles.joinButton, { opacity: uploading ? 0.6 : 1 }]} 
            onPress={handleJoin}
            disabled={uploading}
          >
            {uploading ? (
              <ActivityIndicator color="white" />
            ) : (
              <Text style={styles.joinButtonText}>Submit Entry</Text>
            )}
          </TouchableOpacity>

          <TouchableOpacity onPress={() => {setSelectedContest(null); setMedia(null);}}>
            <Text style={{textAlign: 'center', marginTop: 15, color: '#FF4D67'}}>Choose Another Contest</Text>
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
    flexDirection: 'row', 
    justifyContent: 'space-between', 
    alignItems: 'center', 
    padding: 18, 
    borderRadius: 16, 
    marginBottom: 12,
    borderWidth: 1,
    borderColor: '#EEE'
  },
  contestName: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  contestPrize: { color: '#4CAF50', fontFamily: 'Urbanist-SemiBold', marginTop: 4 },
  contestFee: { color: '#666', fontSize: 13, marginTop: 2 },
  subtitle: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginBottom: 10 },
  rulesText: { fontSize: 14, color: '#777', marginBottom: 20, lineHeight: 20 },
  mediaUpload: { 
    width: '100%', 
    height: 350, 
    backgroundColor: '#F0F0F0', 
    borderRadius: 20, 
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#EEE',
    borderStyle: 'dashed'
  },
  previewImage: { width: '100%', height: '100%' },
  placeholder: { alignItems: 'center' },
  joinButton: { 
    backgroundColor: '#FF4D67', 
    padding: 18, 
    borderRadius: 16, 
    marginTop: 30, 
    alignItems: 'center' 
  },
  joinButtonText: { color: 'white', fontSize: 18, fontFamily: 'Urbanist-Bold' }
});
