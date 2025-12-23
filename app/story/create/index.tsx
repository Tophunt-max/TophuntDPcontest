import React, { useState, useEffect, useRef } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  ActivityIndicator, 
  Alert, 
  Dimensions, 
  StatusBar 
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@expo/vector-icons';
import { uploadToS3 } from '@/src/lib/uploadToS3';
import { createStoryRecord } from '@/src/services/stories/storyService';
import { useQueryClient } from '@tanstack/react-query';
import Svg, { Circle } from 'react-native-svg';
import { auth } from '@/src/services/firebase/initFirebase';

const { width, height } = Dimensions.get('window');

const CircularProgress = ({ progress }: { progress: number }) => {
  const size = 120;
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - progress * circumference;

  return (
    <View style={styles.progressContainer}>
      <Svg width={size} height={size}>
        <Circle
          stroke="rgba(255, 255, 255, 0.2)"
          fill="none"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
        />
        <Circle
          stroke="#CA1D7E"
          fill="none"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={strokeWidth}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </Svg>
      <View style={styles.progressTextContainer}>
        <Text style={styles.progressText}>{Math.round(progress * 100)}%</Text>
      </View>
    </View>
  );
};

export default function AddStoryScreen() {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [media, setMedia] = useState<{ uri: string, type: 'image' | 'video' } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  
  const cameraRef = useRef<CameraView>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  const player = useVideoPlayer(media?.type === 'video' ? media.uri : '', (player) => {
    player.loop = true;
    player.muted = true;
    player.play();
  });

  useEffect(() => {
    if (!cameraPermission || !cameraPermission.granted) {
      requestCameraPermission();
    }
    
    // Check if user is logged in
    const currentUser = auth.currentUser;
    if (!currentUser) {
      // Small timeout to allow any ongoing auth state restoration to finish
      const checkAuth = setTimeout(() => {
        if (!auth.currentUser) {
          Alert.alert("Authentication Required", "Please login to post stories.");
          router.replace('/auth/login');
        }
      }, 1000);
      return () => clearTimeout(checkAuth);
    }
  }, []);

  const pickFromGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsEditing: true,
      aspect: [9, 16],
      quality: 0.8,
    });

    if (!result.canceled && result.assets[0]) {
      setMedia({
        uri: result.assets[0].uri,
        type: result.assets[0].type === 'video' ? 'video' : 'image'
      });
    }
  };

  const takePicture = async () => {
    if (cameraRef.current) {
      try {
        const photo = await cameraRef.current.takePictureAsync({
          quality: 0.8,
        });
        if (photo) {
          setMedia({ uri: photo.uri, type: 'image' });
        }
      } catch (e) {
        Alert.alert("Error", "Could not take picture");
      }
    }
  };

  const handleUpload = async () => {
    if (!media) return;

    // Double check authentication before starting upload
    if (!auth.currentUser) {
       Alert.alert("Error", "You must be logged in to upload a story.");
       router.replace('/auth/login');
       return;
    }

    setIsUploading(true);
    setUploadProgress(0);
    try {
      console.log("Step 1: Uploading media to S3...");
      const fileType = media.type === 'video' ? 'video/mp4' : 'image/jpeg';
      
      let mediaUrl;
      try {
        mediaUrl = await uploadToS3(media.uri, fileType, "stories", (progress) => {
          setUploadProgress(progress);
        });
        
        if (!mediaUrl) {
          throw new Error("S3 Upload returned empty URL");
        }
        
        console.log("S3 Upload complete, URL:", mediaUrl);
      } catch (err: any) {
        console.error("S3 Upload Failed:", err);
        throw new Error(`S3 Upload Failed: ${err.message}`);
      }
      
      setUploadProgress(1); // Set to 100% after S3 upload
      
      console.log("Step 2: Creating Firestore record...");
      try {
        // Add a 25-second timeout for the database write to prevent getting stuck
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error("Database write timed out. The story may have been uploaded but confirmation failed.")), 25000)
        );

        const storyId = await Promise.race([
          createStoryRecord(mediaUrl as string, media.type),
          timeoutPromise
        ]);
        
        console.log("Firestore record created, ID:", storyId);
      } catch (err: any) {
        console.error("Firestore record creation failed:", err);
        
        // Handle unauthenticated error specifically
        if (err.message && err.message.includes('unauthenticated')) {
             Alert.alert("Session Expired", "Please login again.");
             router.replace('/auth/login');
             return;
        }

        // Special alert for database error to help debugging
        Alert.alert("Note", err.message);
        // If it was a timeout, we still go home because S3 upload succeeded
        if (err.message.includes("timed out")) {
             router.replace('/home');
             return;
        }
        throw err;
      }
      
      console.log("Step 3: Invalidating queries...");
      await queryClient.invalidateQueries({ queryKey: ['stories'] });
      
      setIsUploading(false);
      router.replace('/home');
    } catch (error: any) {
      console.error("Critical Upload Error:", error);
      setIsUploading(false);
      // Ensure error message is shown
      if (error.message) {
         Alert.alert("Upload Failed", error.message);
      }
    }
  };

  const toggleCameraFacing = () => {
    setFacing(current => (current === 'back' ? 'front' : 'back'));
  };

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      
      {!isUploading && (
        <SafeAreaView style={styles.header}>
          <TouchableOpacity onPress={() => media ? setMedia(null) : router.back()}>
            <Ionicons name="close" size={30} color="white" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Add Story</Text>
          <TouchableOpacity 
            onPress={handleUpload} 
            disabled={!media || isUploading}
            style={[styles.nextButton, !media && styles.disabledButton]}
          >
            <Text style={[styles.nextButtonText, !media && styles.disabledText]}>Next</Text>
          </TouchableOpacity>
        </SafeAreaView>
      )}

      <View style={styles.content}>
        {!media ? (
          cameraPermission?.granted ? (
            <CameraView 
              ref={cameraRef} 
              style={styles.camera} 
              facing={facing}
            >
              <View style={styles.cameraOverlay}>
                <View style={styles.bottomControls}>
                  <TouchableOpacity onPress={pickFromGallery} style={styles.iconCircle}>
                    <Ionicons name="images-outline" size={24} color="white" />
                  </TouchableOpacity>
                  
                  <TouchableOpacity onPress={takePicture} style={styles.captureButton}>
                    <View style={styles.captureButtonInner} />
                  </TouchableOpacity>
                  
                  <TouchableOpacity onPress={toggleCameraFacing} style={styles.iconCircle}>
                    <Ionicons name="camera-reverse-outline" size={24} color="white" />
                  </TouchableOpacity>
                </View>
              </View>
            </CameraView>
          ) : (
            <View style={styles.centered}>
              <Text style={{color: 'white'}}>No camera access</Text>
              <TouchableOpacity onPress={requestCameraPermission} style={styles.permissionBtn}>
                 <Text style={{color: 'black', fontWeight: 'bold'}}>Grant Permission</Text>
              </TouchableOpacity>
            </View>
          )
        ) : (
          <View style={styles.previewContainer}>
            {media.type === 'image' ? (
              <Image source={{ uri: media.uri }} style={styles.previewMedia} contentFit="cover" />
            ) : (
              <VideoView player={player} style={styles.previewMedia} contentFit="cover" />
            )}
            
            {isUploading && (
              <View style={styles.uploadOverlay}>
                <CircularProgress progress={uploadProgress} />
                <Text style={styles.loadingText}>Uploading your story...</Text>
                <Text style={styles.subLoadingText}>
                  {uploadProgress < 1 ? 'Please wait, uploading to cloud' : 'Please wait, saving to database'}
                </Text>
              </View>
            )}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'black' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 10, zIndex: 10, position: 'absolute', top: 0, width: '100%' },
  headerTitle: { color: 'white', fontSize: 18, fontFamily: 'Urbanist-Bold' },
  nextButton: { paddingHorizontal: 15, paddingVertical: 5 },
  nextButtonText: { color: '#0095f6', fontSize: 16, fontWeight: 'bold' },
  disabledButton: { opacity: 0.5 },
  disabledText: { color: '#8e8e8e' },
  content: { flex: 1 },
  camera: { flex: 1 },
  cameraOverlay: { flex: 1, backgroundColor: 'transparent', justifyContent: 'flex-end', paddingBottom: 40 },
  bottomControls: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', width: '100%' },
  captureButton: { width: 80, height: 80, borderRadius: 40, borderWidth: 5, borderColor: 'white', justifyContent: 'center', alignItems: 'center' },
  captureButtonInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: 'white' },
  iconCircle: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  previewContainer: { flex: 1 },
  previewMedia: { width: width, height: '100%' },
  uploadOverlay: { 
    ...StyleSheet.absoluteFillObject, 
    backgroundColor: 'rgba(0,0,0,0.6)', 
    justifyContent: 'center', 
    alignItems: 'center' 
  },
  loadingText: { color: 'white', marginTop: 20, fontSize: 18, fontFamily: 'Urbanist-Bold' },
  subLoadingText: { color: 'rgba(255,255,255,0.7)', marginTop: 8, fontSize: 14, fontFamily: 'Urbanist-Medium' },
  permissionBtn: { backgroundColor: 'white', padding: 10, borderRadius: 8, marginTop: 20 },
  progressContainer: { justifyContent: 'center', alignItems: 'center' },
  progressTextContainer: { position: 'absolute' },
  progressText: { color: 'white', fontSize: 20, fontFamily: 'Urbanist-Bold' }
});
