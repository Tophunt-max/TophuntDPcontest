import React, { useState, useEffect, useRef } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  ActivityIndicator, 
  Alert, 
  Dimensions, 
  StatusBar,
  TextInput,
  Modal,
  FlatList,
  PanResponder,
  Platform,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { AppImage as Image } from '@/src/components/ui/AppImage';
import { useVideoPlayer, VideoView } from 'expo-video';
import { Ionicons } from '@/src/lib/icons';
import { uploadToR2 } from '@/src/lib/uploadToR2';
import { optimizeImageForUpload } from '@/src/lib/imageOptimize';
import { createStoryRecord, searchUsers } from '@/src/services/stories/storyService';
import { uploadVideoToBunny } from '@/src/services/video/bunnyUpload';
import { useQueryClient } from '@tanstack/react-query';
import Svg, { Circle } from 'react-native-svg';
import { auth } from '@/src/services/firebase/initFirebase';
import { 
    Gallery_Icon, 
    Sticker_Icon, 
    Music_Icon_Story, 
    Close_Circle_Icon, 
    Music_Play_Icon, 
    Music_Pause_Icon,
    Mention_Icon
} from '@/assets/svgs';
import { PanGestureHandler } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated';
import { CloseIcon } from '@/src/components/ui/CloseIcon';

const { width, height } = Dimensions.get('window');
const STICKERS = ['🔥', '❤️', '😂', '😍', '✨', '💯', '📍', '🎂', '🎉', '🍕', '🌈', '👑'];

const CircularProgress = ({ progress }: { progress: number }) => {
  const size = 120;
  const strokeWidth = 8;
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - progress * circumference;

  return (
    <View style={styles.progressContainer}>
      <Svg width={size} height={size}>
        <Circle stroke="rgba(255, 255, 255, 0.2)" fill="none" cx={size / 2} cy={size / 2} r={radius} strokeWidth={strokeWidth} />
        <Circle stroke="#CA1D7E" fill="none" cx={size / 2} cy={size / 2} r={radius} strokeWidth={strokeWidth} strokeDasharray={circumference} strokeDashoffset={offset} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} />
      </Svg>
      <View style={styles.progressTextContainer}><Text style={styles.progressText}>{Math.round(progress * 100)}%</Text></View>
    </View>
  );
};

export default function AddStoryScreen() {
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [media, setMedia] = useState<{ uri: string, type: 'image' | 'video' } | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [facing, setFacing] = useState<'back' | 'front'>('back');
  const [visibility, setVisibility] = useState<'public' | 'followers'>('followers');
  const [isCameraReady, setIsCameraReady] = useState(false);
  
  // Overlay States
  const [storyText, setStoryText] = useState('');
  const [isEditingText, setIsEditingText] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [selectedSticker, setSelectedSticker] = useState<string | null>(null);
  
  // Music States
  const [showMusicPicker, setShowMusicPicker] = useState(false);
  const [musicSearch, setMusicSearch] = useState('');
  const [musicList, setMusicList] = useState<any[]>([]);
  const [isLoadingMusic, setIsLoadingMusic] = useState(false);
  const [selectedMusic, setSelectedMusic] = useState<any | null>(null);
  const [isMusicPlaying, setIsMusicPlaying] = useState(true);

  // Mention State
  const [showMentions, setShowMentions] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionResults, setMentionResults] = useState<any[]>([]);
  const [mentions, setMentions] = useState<string[]>([]);

  const textX = useSharedValue(width / 2 - 50);
  const textY = useSharedValue(height / 2);
  const stickerX = useSharedValue(width / 2 - 40);
  const stickerY = useSharedValue(height / 2 + 60);
  const musicX = useSharedValue(width / 2 - 120);
  const musicY = useSharedValue(height / 2);

  const stickerSheetY = useSharedValue(height);
  const musicSheetY = useSharedValue(height);

  const cameraRef = useRef<CameraView>(null);
  const router = useRouter();
  const queryClient = useQueryClient();

  // expo-camera's live CameraView is unreliable on web (renders a black frame
  // and blocks behind the permission gate). On web we skip the live camera and
  // let the user pick a photo/video from their device instead — the preview,
  // overlays and upload flow all work fine in the browser.
  const isWeb = Platform.OS === 'web';

  const player = useVideoPlayer(media?.type === 'video' ? media.uri : '', (player) => {
    player.loop = true;
    player.muted = selectedMusic ? true : false; 
    player.play();
  });

  const musicPlayer = useVideoPlayer(selectedMusic?.previewUrl || '', (p) => {
      p.loop = true;
      if (isMusicPlaying) p.play();
      else p.pause();
  });

  useEffect(() => {
      if (selectedMusic) {
          player.muted = true;
          if (isMusicPlaying) musicPlayer.play();
          else musicPlayer.pause();
      } else {
          player.muted = false;
          musicPlayer.pause();
      }
  }, [selectedMusic, isMusicPlaying, player, musicPlayer]);

  // Mention Search Logic
  useEffect(() => {
      if (isEditingText) {
          const words = storyText.split(' ');
          const lastWord = words[words.length - 1];
          if (lastWord.startsWith('@') && lastWord.length > 1) {
              setMentionQuery(lastWord.substring(1));
              setShowMentions(true);
          } else {
              setShowMentions(false);
          }
      }
  }, [storyText, isEditingText]);

  useEffect(() => {
      if (showMentions && mentionQuery) {
          const timeout = setTimeout(async () => {
              const users = await searchUsers(mentionQuery);
              setMentionResults(users);
          }, 300);
          return () => clearTimeout(timeout);
      }
  }, [mentionQuery, showMentions]);

  const handleMentionSelect = (username: string) => {
      const words = storyText.split(' ');
      words[words.length - 1] = `@${username} `;
      setStoryText(words.join(' '));
      setMentions(prev => [...prev, username]);
      setShowMentions(false);
  };

  // Direct Mention Icon Action
  const startMentionMode = () => {
      setStoryText('@');
      setIsEditingText(true);
  };

  const searchMusic = async (query: string) => {
      if (!query) return;
      setIsLoadingMusic(true);
      try {
          const response = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&media=music&limit=20`);
          const data = await response.json();
          const results = data.results.map((item: any) => ({
              id: item.trackId.toString(),
              title: item.trackName,
              artist: item.artistName,
              cover: item.artworkUrl100,
              previewUrl: item.previewUrl
          }));
          setMusicList(results);
      } catch (error) {
          console.error("Music search error:", error);
      } finally {
          setIsLoadingMusic(false);
      }
  };

  useEffect(() => {
      const delaySearch = setTimeout(() => {
          if (musicSearch) searchMusic(musicSearch);
      }, 500);
      return () => clearTimeout(delaySearch);
  }, [musicSearch]);

  const animatedTextStyle = useAnimatedStyle(() => ({ transform: [{ translateX: textX.value }, { translateY: textY.value }], position: 'absolute', zIndex: 100 }));
  const animatedStickerStyle = useAnimatedStyle(() => ({ transform: [{ translateX: stickerX.value }, { translateY: stickerY.value }], position: 'absolute', zIndex: 101 }));
  const animatedMusicStyle = useAnimatedStyle(() => ({ transform: [{ translateX: musicX.value }, { translateY: musicY.value }], position: 'absolute', zIndex: 102 }));
  const animatedStickerSheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: stickerSheetY.value }] }));
  const animatedMusicSheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: musicSheetY.value }] }));

  const toggleStickerSheet = (show: boolean) => {
      if (show) { setShowStickerPicker(true); stickerSheetY.value = withSpring(0); }
      else { stickerSheetY.value = withSpring(height, {}, () => { runOnJS(setShowStickerPicker)(false); }); }
  };

  const toggleMusicSheet = (show: boolean) => {
      if (show) { 
          setShowMusicPicker(true); 
          musicSheetY.value = withSpring(0);
          if (musicList.length === 0) searchMusic('Top Hits');
      } else { 
          musicSheetY.value = withSpring(height, {}, () => { runOnJS(setShowMusicPicker)(false); }); 
      }
  };

  const stickerPanResponder = useRef(PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (evt, gestureState) => { if (gestureState.dy > 0) stickerSheetY.value = gestureState.dy; },
      onPanResponderRelease: (evt, gestureState) => { if (gestureState.dy > 100) toggleStickerSheet(false); else toggleStickerSheet(true); }
  })).current;

  const musicPanResponder = useRef(PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: (evt, gestureState) => { if (gestureState.dy > 0) musicSheetY.value = gestureState.dy; },
      onPanResponderRelease: (evt, gestureState) => { if (gestureState.dy > 100) toggleMusicSheet(false); else toggleMusicSheet(true); }
  })).current;

  const pickFromGallery = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], quality: 0.8 });
    if (!result.canceled) {
      setMedia({ uri: result.assets[0].uri, type: result.assets[0].type === 'video' ? 'video' : 'image' });
    }
  };

  const takePicture = async () => {
    if (!cameraRef.current || !isCameraReady) return;
    try {
        const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
        if (photo) setMedia({ uri: photo.uri, type: 'image' });
    } catch (e: any) {
        console.error("Capture Error:", e);
    }
  };

  const handleUpload = async () => {
    if (!media) return;
    setIsUploading(true);
    setUploadProgress(0);
    try {
      // Videos prefer Bunny Stream (resumable upload + adaptive bitrate).
      // uploadVideoToBunny returns null when Bunny is not configured on the
      // server, in which case we fall through to the existing R2 path.
      let mediaUrl: string | null = null;
      if (media.type === 'video') {
        try {
          const bunny = await uploadVideoToBunny(media.uri, {
            title: `story-${Date.now()}`,
            targetType: 'story',
            onProgress: setUploadProgress,
          });
          if (bunny) mediaUrl = bunny.playbackUrl;
        } catch (e) {
          console.warn('Bunny story upload failed, falling back to R2:', e);
        }
      }

      if (!mediaUrl) {
        const isVideo = media.type === 'video';
        const fileType = isVideo ? 'video/mp4' : 'image/jpeg';
        // Photos are downscaled to the 1080x1920 story spec first; video bytes
        // are never touched here.
        const source = isVideo
          ? media.uri
          : await optimizeImageForUpload(media.uri, 'story');
        mediaUrl = (await uploadToR2(source, fileType, 'stories', (p: number) => {
          setUploadProgress(p);
        })) as string;
      }

      const textPos = { x: textX.value / width, y: textY.value / height };
      
      const storyId = await createStoryRecord(
          mediaUrl, 
          media.type, 
          visibility, 
          storyText || null,
          storyText ? textPos : null,
          mentions
      ); 
      
      console.log("Story Record Created:", storyId);
      await queryClient.invalidateQueries({ queryKey: ['stories'] });
      router.replace('/home');
    } catch (error: any) {
      console.error("Story Creation Error:", error);
      Alert.alert("Upload Failed", error.message);
    } finally {
      setIsUploading(false);
    }
  };

  // On web we don't use the native camera, so skip the permission gate entirely.
  if (!isWeb) {
    if (!cameraPermission) {
      return <View />;
    }

    if (!cameraPermission.granted) {
      return (
        <View style={[styles.container, styles.permissionContainer]}>
          <Ionicons name="camera-outline" size={64} color="white" style={{ marginBottom: 16 }} />
          <Text style={styles.permissionText}>We need your permission to show the camera</Text>
          <TouchableOpacity onPress={requestCameraPermission} style={styles.permissionButton}>
            <Text style={styles.permissionButtonText}>Grant Permission</Text>
          </TouchableOpacity>
        </View>
      );
    }
  }

  return (
    <View style={styles.container}>
      <StatusBar hidden />
      
      {!isUploading && (
        <SafeAreaView style={styles.header}>
          <TouchableOpacity
            onPress={() => media ? setMedia(null) : router.back()}
            accessibilityRole="button"
            accessibilityLabel={media ? 'Discard selected media' : 'Close'}
          >
            <CloseIcon size={30} color="white" />
          </TouchableOpacity>
          
          {media && (
              <View style={styles.topTools}>
                  <TouchableOpacity onPress={() => toggleMusicSheet(true)} style={styles.toolBtn}>
                      <Music_Icon_Story width={28} height={28} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => toggleStickerSheet(true)} style={styles.toolBtn}>
                      <Sticker_Icon width={28} height={28} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={startMentionMode} style={styles.toolBtn}>
                      <Mention_Icon width={28} height={28} />
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setIsEditingText(true)} style={styles.toolBtn}>
                      <Text style={styles.aaText}>Aa</Text>
                  </TouchableOpacity>
              </View>
          )}

          <TouchableOpacity onPress={handleUpload} disabled={!media} style={[styles.nextButton, !media && styles.disabledButton]}>
            <Text style={[styles.nextButtonText, !media && styles.disabledText]}>Next</Text>
          </TouchableOpacity>
        </SafeAreaView>
      )}

      <View style={styles.content}>
        {!media ? (
            isWeb ? (
                <View style={styles.webCaptureContainer}>
                    <View style={styles.webUploadIcon}>
                        <Ionicons name="cloud-upload-outline" size={64} color="#ff4466" />
                    </View>
                    <Text style={styles.webCaptureTitle}>Create a Story</Text>
                    <Text style={styles.webCaptureSubtitle}>Select a photo or video from your device to share.</Text>
                    <TouchableOpacity onPress={pickFromGallery} style={styles.webUploadButton}>
                        <Gallery_Icon width={22} height={22} />
                        <Text style={styles.webUploadButtonText}>Choose Photo or Video</Text>
                    </TouchableOpacity>
                </View>
            ) : (
            <CameraView 
                ref={cameraRef} 
                style={styles.camera} 
                facing={facing} 
                onCameraReady={() => {
                    console.log("Camera Ready");
                    setIsCameraReady(true);
                }}
            >
                <View style={styles.cameraOverlay}>
                    <View style={styles.bottomControls}>
                        <TouchableOpacity onPress={pickFromGallery} style={styles.iconCircle}><Gallery_Icon width={28} height={28} /></TouchableOpacity>
                        <TouchableOpacity onPress={takePicture} style={[styles.captureButton, !isCameraReady && { opacity: 0.3 }]} disabled={!isCameraReady}><View style={styles.captureButtonInner} /></TouchableOpacity>
                        <TouchableOpacity onPress={() => setFacing(f => f === 'back' ? 'front' : 'back')} style={styles.iconCircle}><Ionicons name="camera-reverse-outline" size={28} color="white" /></TouchableOpacity>
                    </View>
                </View>
            </CameraView>
            )
        ) : (
          <View style={styles.previewContainer}>
            {media.type === 'image' ? <Image source={{ uri: media.uri }} style={styles.previewMedia} contentFit="cover" /> : <VideoView player={player} style={styles.previewMedia} contentFit="cover" />}
            
            <VideoView player={musicPlayer} style={{ width: 0, height: 0, position: 'absolute' }} />

            {/* Text Overlay */}
            {storyText !== '' && !isEditingText && !isUploading && (
                <PanGestureHandler onGestureEvent={(e) => { textX.value = e.nativeEvent.absoluteX - 50; textY.value = e.nativeEvent.absoluteY - 20; }}>
                    <Animated.View style={animatedTextStyle}>
                        <View style={styles.textBubble}>
                            <Text style={styles.overlayTextDisplay}>{storyText}</Text>
                            <TouchableOpacity style={styles.removeBtn} onPress={() => setStoryText('')}>
                                <Close_Circle_Icon width={28} height={28} />
                            </TouchableOpacity>
                        </View>
                    </Animated.View>
                </PanGestureHandler>
            )}

            {selectedSticker && !isUploading && (
                <PanGestureHandler onGestureEvent={(e) => { stickerX.value = e.nativeEvent.absoluteX - 40; stickerY.value = e.nativeEvent.absoluteY - 40; }}>
                    <Animated.View style={animatedStickerStyle}>
                        <View style={{ position: 'relative' }}>
                            <Text style={{ fontSize: 80 }}>{selectedSticker}</Text>
                            <TouchableOpacity style={[styles.removeBtn, { top: -10, right: -10 }]} onPress={() => setSelectedSticker(null)}>
                                <Close_Circle_Icon width={32} height={32} />
                            </TouchableOpacity>
                        </View>
                    </Animated.View>
                </PanGestureHandler>
            )}

            {selectedMusic && !isUploading && (
                <PanGestureHandler onGestureEvent={(e) => { musicX.value = e.nativeEvent.absoluteX - 100; musicY.value = e.nativeEvent.absoluteY - 30; }}>
                    <Animated.View style={animatedMusicStyle}>
                        <View style={styles.musicSticker}>
                            <TouchableOpacity onPress={() => setIsMusicPlaying(!isMusicPlaying)}>
                                {isMusicPlaying ? <Music_Pause_Icon width={40} height={40} /> : <Music_Play_Icon width={40} height={40} />}
                            </TouchableOpacity>
                            <Image source={{ uri: selectedMusic.cover }} style={styles.musicCover} />
                            <View style={{ flex: 1 }}>
                                <Text style={styles.musicTitle} numberOfLines={1}>{selectedMusic.title}</Text>
                                <Text style={styles.musicArtist} numberOfLines={1}>{selectedMusic.artist}</Text>
                            </View>
                            <TouchableOpacity onPress={() => { setSelectedMusic(null); setIsMusicPlaying(false); }} style={{ padding: 5 }}>
                                <Close_Circle_Icon width={32} height={32} />
                            </TouchableOpacity>
                        </View>
                    </Animated.View>
                </PanGestureHandler>
            )}

            {isEditingText && (
                <View style={styles.textEditOverlay}>
                    <TextInput autoFocus style={styles.textInput} value={storyText} onChangeText={setStoryText} multiline placeholder="Type something..." placeholderTextColor="rgba(255,255,255,0.5)" onBlur={() => setIsEditingText(false)} />
                    {/* Mentions List */}
                    {showMentions && (
                        <View style={styles.mentionsList}>
                            <FlatList 
                                data={mentionResults}
                                keyExtractor={item => item.id}
                                keyboardShouldPersistTaps="always"
                                renderItem={({ item }) => (
                                    <TouchableOpacity style={styles.mentionItem} onPress={() => handleMentionSelect(item.username)}>
                                        <Image source={{ uri: item.avatarUrl }} style={styles.mentionAvatar} />
                                        <Text style={styles.mentionText}>{item.username}</Text>
                                    </TouchableOpacity>
                                )}
                            />
                        </View>
                    )}
                    <TouchableOpacity style={styles.doneBtn} onPress={() => setIsEditingText(false)}><Text style={styles.doneBtnText}>Done</Text></TouchableOpacity>
                </View>
            )}

            {!isUploading && !isEditingText && !showStickerPicker && !showMusicPicker && (
                <View style={styles.visibilityContainer}>
                    <View style={styles.visibilityOptions}>
                        <TouchableOpacity style={[styles.visibilityBtn, visibility === 'followers' && styles.visibilityBtnActive]} onPress={() => setVisibility('followers')}>
                            <Ionicons name="people" size={18} color={visibility === 'followers' ? 'white' : '#ccc'} /><Text style={[styles.visibilityBtnText, visibility === 'followers' && styles.visibilityBtnTextActive]}>Followers</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={[styles.visibilityBtn, visibility === 'public' && styles.visibilityBtnActive]} onPress={() => setVisibility('public')}>
                            <Ionicons name="globe" size={18} color={visibility === 'public' ? 'white' : '#ccc'} /><Text style={[styles.visibilityBtnText, visibility === 'public' && styles.visibilityBtnTextActive]}>Public</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            )}
            {isUploading && <View style={styles.uploadOverlay}><CircularProgress progress={uploadProgress} /><Text style={styles.loadingText}>Uploading...</Text></View>}

            {/* Sticker Picker Modal */}
            <Modal visible={showStickerPicker} transparent animationType="none">
                <View style={styles.modalOverlay}>
                    <Animated.View style={[styles.sheet, animatedStickerSheetStyle]} {...stickerPanResponder.panHandlers}>
                        <View style={styles.sheetHandle} />
                        <View style={styles.sheetHeader}><Text style={styles.sheetTitle}>Choose Sticker</Text><TouchableOpacity onPress={() => toggleStickerSheet(false)}><CloseIcon variant="circle" size={24} color="#666" /></TouchableOpacity></View>
                        <FlatList data={STICKERS} numColumns={4} keyExtractor={item => item} renderItem={({ item }) => (
                            <TouchableOpacity style={styles.stickerItem} onPress={() => { setSelectedSticker(item); toggleStickerSheet(false); }}><Text style={{ fontSize: 40 }}>{item}</Text></TouchableOpacity>
                        )} />
                    </Animated.View>
                </View>
            </Modal>

            {/* Music Picker Modal */}
            <Modal visible={showMusicPicker} transparent animationType="none">
                <View style={styles.modalOverlay}>
                    <Animated.View style={[styles.sheet, animatedMusicSheetStyle]} {...musicPanResponder.panHandlers}>
                        <View style={styles.sheetHandle} />
                        <View style={styles.sheetHeader}><Text style={styles.sheetTitle}>Choose Music</Text><TouchableOpacity onPress={() => toggleMusicSheet(false)}><CloseIcon variant="circle" size={24} color="#666" /></TouchableOpacity></View>
                        <View style={styles.musicSearchContainer}>
                            <Ionicons name="search" size={20} color="#999" />
                            <TextInput style={styles.musicSearchInput} placeholder="Search music..." value={musicSearch} onChangeText={setMusicSearch} />
                        </View>
                        <FlatList data={musicList} keyExtractor={item => item.id} renderItem={({ item }) => (
                            <TouchableOpacity style={styles.musicItem} onPress={() => { setSelectedMusic(item); setIsMusicPlaying(true); toggleMusicSheet(false); }}>
                                <Image source={{ uri: item.cover }} style={styles.musicThumb} />
                                <View style={{ flex: 1 }}><Text style={styles.musicItemTitle} numberOfLines={1}>{item.title}</Text><Text style={styles.musicItemArtist} numberOfLines={1}>{item.artist}</Text></View>
                                <Ionicons name="play-circle" size={30} color="#ff4466" />
                            </TouchableOpacity>
                        )} ListEmptyComponent={isLoadingMusic ? <ActivityIndicator color="#ff4466" /> : <Text style={styles.emptyText}>No music found</Text>} />
                    </Animated.View>
                </View>
            </Modal>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'black' },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 15, paddingVertical: 10, zIndex: 10, position: 'absolute', top: 0, width: '100%' },
  topTools: { flexDirection: 'row', alignItems: 'center', gap: 20 },
  toolBtn: { padding: 5 },
  aaText: { color: 'white', fontSize: 24, fontFamily: 'Urbanist-Bold' },
  nextButton: { paddingHorizontal: 15 },
  nextButtonText: { color: '#0095f6', fontSize: 18, fontWeight: 'bold' },
  disabledButton: { opacity: 0.5 },
  disabledText: { color: '#8e8e8e' },
  content: { flex: 1 },
  permissionContainer: { justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
  permissionText: { textAlign: 'center', color: 'white', fontSize: 16, fontFamily: 'Urbanist-SemiBold', marginBottom: 20 },
  permissionButton: { backgroundColor: '#ff4466', paddingHorizontal: 28, paddingVertical: 14, borderRadius: 30 },
  permissionButtonText: { color: 'white', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  webCaptureContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 40 },
  webUploadIcon: { width: 130, height: 130, borderRadius: 65, backgroundColor: 'rgba(255,68,102,0.12)', justifyContent: 'center', alignItems: 'center', marginBottom: 28 },
  webCaptureTitle: { color: 'white', fontSize: 26, fontFamily: 'Urbanist-Bold', marginBottom: 10 },
  webCaptureSubtitle: { color: 'rgba(255,255,255,0.6)', fontSize: 15, fontFamily: 'Urbanist-Medium', textAlign: 'center', lineHeight: 22, marginBottom: 36 },
  webUploadButton: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#ff4466', paddingHorizontal: 28, paddingVertical: 16, borderRadius: 30 },
  webUploadButtonText: { color: 'white', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  camera: { flex: 1 },
  cameraOverlay: { flex: 1, backgroundColor: 'transparent', justifyContent: 'flex-end', paddingBottom: 40 },
  bottomControls: { flexDirection: 'row', justifyContent: 'space-around', alignItems: 'center', width: '100%' },
  captureButton: { width: 70, height: 70, borderRadius: 35, borderWidth: 5, borderColor: 'white', justifyContent: 'center', alignItems: 'center' },
  captureButtonInner: { width: 54, height: 54, borderRadius: 27, backgroundColor: 'white' },
  iconCircle: { width: 50, height: 50, borderRadius: 25, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  previewContainer: { flex: 1 },
  previewMedia: { width: width, height: '100%' },
  uploadOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.8)', justifyContent: 'center', alignItems: 'center', zIndex: 300 },
  loadingText: { color: 'white', marginTop: 20, fontSize: 18, fontFamily: 'Urbanist-Bold' },
  visibilityContainer: { position: 'absolute', bottom: 50, left: 0, right: 0, alignItems: 'center' },
  visibilityOptions: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 30, padding: 5 },
  visibilityBtn: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 25, gap: 8 },
  visibilityBtnActive: { backgroundColor: '#ff4466' },
  visibilityBtnText: { color: '#ccc', fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
  visibilityBtnTextActive: { color: 'white' },
  textEditOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'center', alignItems: 'center', zIndex: 200 },
  textInput: { color: 'white', fontSize: 32, fontFamily: 'Urbanist-Bold', textAlign: 'center', width: '80%', marginBottom: 20 },
  mentionsList: { maxHeight: 150, width: '80%', backgroundColor: 'white', borderRadius: 10, overflow: 'hidden' },
  mentionItem: { flexDirection: 'row', alignItems: 'center', padding: 10, borderBottomWidth: 1, borderBottomColor: '#EEE' },
  mentionAvatar: { width: 30, height: 30, borderRadius: 15, marginRight: 10 },
  mentionText: { fontSize: 16, fontFamily: 'Urbanist-Medium' },
  doneBtn: { position: 'absolute', top: 50, right: 20 },
  doneBtnText: { color: 'white', fontSize: 18, fontFamily: 'Urbanist-Bold' },
  textBubble: { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 10, position: 'relative' },
  overlayTextDisplay: { color: 'white', fontSize: 24, fontFamily: 'Urbanist-Bold', textAlign: 'center' },
  removeBtn: { position: 'absolute', zIndex: 200 },
  removeMusicBtn: { marginLeft: 10 },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  progressContainer: { justifyContent: 'center', alignItems: 'center' },
  progressTextContainer: { position: 'absolute' },
  progressText: { color: 'white', fontSize: 20, fontFamily: 'Urbanist-Bold' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: 'white', borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, height: height * 0.7, position: 'absolute', bottom: 0, width: '100%' },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#DDD', alignSelf: 'center', marginBottom: 10 },
  sheetHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 15 },
  sheetTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  stickerItem: { flex: 1, alignItems: 'center', padding: 15 },
  musicSearchContainer: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#F5F5F5', borderRadius: 10, paddingHorizontal: 12, height: 45, marginBottom: 20 },
  musicSearchInput: { flex: 1, marginLeft: 10, fontFamily: 'Urbanist-Medium', fontSize: 16 },
  musicItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0' },
  musicThumb: { width: 50, height: 50, borderRadius: 8, marginRight: 15 },
  musicItemTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', color: '#000' },
  musicItemArtist: { fontSize: 14, color: '#666', fontFamily: 'Urbanist-Medium' },
  musicSticker: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'white', padding: 10, borderRadius: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 5, elevation: 5, position: 'relative', maxWidth: width * 0.75 },
  musicCover: { width: 40, height: 40, borderRadius: 6, marginRight: 10 },
  musicTitle: { fontSize: 14, fontFamily: 'Urbanist-Bold', color: '#000' },
  musicArtist: { fontSize: 12, color: '#666', fontFamily: 'Urbanist-Medium' },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 50, fontFamily: 'Urbanist-Medium' }
});
