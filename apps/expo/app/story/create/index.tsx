import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Dimensions,
  StatusBar,
  TextInput,
  Modal,
  FlatList,
  PanResponder,
  Platform,
} from "react-native";
import { Alert } from '@/src/lib/appAlert';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { AppImage as Image } from '@/src/components/ui/AppImage';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useAudioPlayer } from 'expo-audio';
import { Ionicons } from '@/src/lib/icons';
import { uploadToR2 } from '@/src/lib/uploadToR2';
import { optimizeImageForUpload } from '@/src/lib/imageOptimize';
import { createStoryRecord, fetchStories, searchUsers } from '@/src/services/stories/storyService';
import {
  searchMusic,
  fetchMusicCatalog,
  type MusicTrack,
  type MusicCategory,
} from '@/src/services/stories/musicService';
import { nextPreview, audibleTrack, shouldPlay } from '@/src/services/stories/musicPreview';
import { uploadVideoToBunny } from '@/src/services/video/bunnyUpload';
import { useQueryClient } from '@tanstack/react-query';
import Svg, { Circle } from 'react-native-svg';
import { LinearGradient } from 'expo-linear-gradient';
// Only the icons that are still hand-rolled SVGs. The toolbar and the music
// transport now come from src/lib/icons.tsx — see the comment on the toolbar.
import { Gallery_Icon, Close_Circle_Icon } from '@/assets/svgs';
import { PanGestureHandler } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, runOnJS } from 'react-native-reanimated';
import { useReadjustablePhoto } from '@/src/components/media/useImageAdjuster';
import { validateVideo, STORY_MAX_VIDEO_SEC } from '@/src/lib/videoValidation';
import { CloseIcon } from '@/src/components/ui/CloseIcon';

/** Story frame aspect (width / height) — matches the 9:16 story viewer. */
const STORY_ASPECT = 9 / 16;

const { width, height } = Dimensions.get('window');
const STICKERS = ['🔥', '❤️', '😂', '😍', '✨', '💯', '📍', '🎂', '🎉', '🍕', '🌈', '👑'];
/** One size for every toolbar icon, so the row reads as a single set. */
const ICON_SIZE = 26;
const ACCENT = '#ff4466';

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
  const { adjustPicked, readjust, canReadjust, forget, host: adjusterHost } = useReadjustablePhoto(STORY_ASPECT);
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
  const [musicList, setMusicList] = useState<MusicTrack[]>([]);
  const [isLoadingMusic, setIsLoadingMusic] = useState(false);
  const [musicError, setMusicError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<MusicCategory[]>([]);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [selectedMusic, setSelectedMusic] = useState<MusicTrack | null>(null);
  const [isMusicPlaying, setIsMusicPlaying] = useState(true);
  /**
   * The row being auditioned in the picker, which is NOT the same thing as the
   * track attached to the story. Keeping them apart is the point: the list's play
   * button used to be a bare icon inside the row's own `onPress`, so the only
   * thing it could do was select the track and close the sheet — there was no way
   * to hear a track before committing to it.
   */
  const [previewTrack, setPreviewTrack] = useState<MusicTrack | null>(null);

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

  /**
   * Preview of the chosen track.
   *
   * `expo-audio`, not a 0x0 `VideoView` fed to `useVideoPlayer`. The old approach
   * mounted a hidden video surface to play an audio file, which meant the
   * soundtrack was tied to a view in the tree, and it also created a player for
   * `''` whenever nothing was selected.
   *
   * Autoplay: choosing a track is itself a user gesture, so the browser's
   * autoplay policy is satisfied by the time this is asked to play. It is only
   * ever started from the picker's own `onPress`, never on mount.
   */
  /**
   * One player, and a single rule for what it should be playing: a row being
   * auditioned in the picker wins over the track already attached to the story.
   * Two players would let a preview and the attached track overlap.
   */
  // Rules live in musicPreview.ts so they can be tested without rendering this
  // screen — see test/musicPreview.test.ts.
  const nowAudible = audibleTrack(previewTrack, selectedMusic);
  const musicPlayer = useAudioPlayer(nowAudible ? { uri: nowAudible.previewUrl } : null);
  const shouldPlayMusic = shouldPlay(previewTrack, selectedMusic, isMusicPlaying);

  useEffect(() => {
      // A story cannot have two soundtracks. Muting the clip is what makes the
      // chosen track audible rather than layered under the original — and it has
      // to apply while auditioning too, or a video's own audio plays over the
      // track being previewed.
      try { player.muted = !!nowAudible; } catch { /* no source loaded */ }
      if (!nowAudible) {
          try { musicPlayer.pause(); } catch { /* nothing loaded yet */ }
          return;
      }
      musicPlayer.loop = true;
      if (shouldPlayMusic) musicPlayer.play();
      else musicPlayer.pause();
  }, [nowAudible, shouldPlayMusic, player, musicPlayer]);

  // Stop the preview when leaving the screen. Without this the track keeps
  // playing over whatever the user navigated to — the single most obvious way an
  // audio feature feels broken.
  useEffect(() => {
      return () => {
          try { musicPlayer.pause(); } catch { /* already gone */ }
      };
  }, [musicPlayer]);

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

  /**
   * Run a catalogue search.
   *
   * The previous version called `itunes.apple.com` directly — which the site's
   * CSP blocks on the web — and swallowed the failure into `console.error`, so
   * the picker sat empty forever with nothing to react to. It now goes through
   * our Worker and, crucially, SHOWS what happened: a failed request is a
   * message with a Retry, not an empty list that looks like "no results".
   */
  const runMusicSearch = useCallback(async (query: string) => {
      const q = query.trim();
      if (!q) { setMusicList([]); setMusicError(null); return; }
      setIsLoadingMusic(true);
      setMusicError(null);
      try {
          const { tracks, providerFailed } = await searchMusic(q);
          setMusicList(tracks);
          // "Nothing matched and we could not ask further" is a different fact
          // from "no such song", and the user can act on it (retry) — so it is
          // reported instead of rendering as an empty list.
          if (tracks.length === 0 && providerFailed) {
              setMusicError('Could not search right now. Browse the categories below, or try again.');
          }
      } catch (e: any) {
          setMusicList([]);
          setMusicError(e?.message || 'Could not load music. Check your connection.');
      } finally {
          setIsLoadingMusic(false);
      }
  }, []);

  /**
   * Load the curated catalogue the sheet opens on.
   *
   * This is what makes music appear at all. The picker used to run a live
   * "Top Hits" search against the provider on every open; that API throttles per
   * source IP and the Worker's egress is shared, so it returned zero results and
   * the sheet was permanently blank with nothing to explain why.
   */
  const loadCatalog = useCallback(async () => {
      setIsLoadingCatalog(true);
      setCatalogError(null);
      try {
          const cats = await fetchMusicCatalog();
          setCatalog(cats);
          setActiveCategory((prev) => prev ?? cats[0]?.key ?? null);
      } catch (e: any) {
          setCatalogError(e?.message || 'Could not load music. Check your connection.');
      } finally {
          setIsLoadingCatalog(false);
      }
  }, []);

  useEffect(() => {
      const delaySearch = setTimeout(() => {
          if (musicSearch.trim()) void runMusicSearch(musicSearch);
      }, 400);
      return () => clearTimeout(delaySearch);
  }, [musicSearch, runMusicSearch]);

  /**
   * Which list the sheet is showing: search results, or the curated catalogue.
   *
   * Derived from the text box rather than kept in state, so the two can never
   * disagree — clearing the search always returns to browsing.
   */
  const isSearching = musicSearch.trim().length > 0;
  const visibleTracks = isSearching
    ? musicList
    : (catalog.find((c) => c.key === activeCategory)?.tracks ?? catalog[0]?.tracks ?? []);

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
          if (catalog.length === 0) void loadCatalog();
      } else { 
          // An audition belongs to the open sheet. Leaving it running would keep
          // playing a track the user did not attach, over the story they are still
          // editing.
          setPreviewTrack(null);
          musicSheetY.value = withSpring(height, {}, () => { runOnJS(setShowMusicPicker)(false); }); 
      }
  };

  /**
   * Audition a row without attaching it. Tapping the same row again stops, so the
   * one button is both play and pause.
   */
  const togglePreview = (track: MusicTrack) => {
      setPreviewTrack((current) => nextPreview(current, track));
  };

  /** Attach a track to the story and stop auditioning. */
  const chooseTrack = (track: MusicTrack) => {
      setPreviewTrack(null);
      setSelectedMusic(track);
      setIsMusicPlaying(true);
      toggleMusicSheet(false);
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
    if (result.canceled) return;
    const asset = result.assets[0];
    if (asset.type === 'video') {
      // Reject an over-long / oversized clip now, before a long mobile upload
      // that the server would only reject at the end.
      const check = validateVideo(
        { durationMs: asset.duration, fileSize: asset.fileSize },
        { maxDurationSec: STORY_MAX_VIDEO_SEC },
      );
      if (!check.ok) {
        Alert.alert('Video too long', check.message);
        return;
      }
      setMedia({ uri: asset.uri, type: 'video' });
      return;
    }
    // Let the user frame the photo to 9:16 before it becomes the story. On cancel
    // we keep the original so choosing a photo is never a dead end.
    setMedia({ uri: await adjustPicked(asset.uri), type: 'image' });
  };

  const takePicture = async () => {
    if (!cameraRef.current || !isCameraReady) return;
    try {
        const photo = await cameraRef.current.takePictureAsync({ quality: 0.8 });
        if (!photo) return;
        setMedia({ uri: await adjustPicked(photo.uri), type: 'image' });
    } catch (e: any) {
        console.error("Capture Error:", e);
    }
  };

  /**
   * Reopen the adjuster on the ORIGINAL photo.
   *
   * Closing the adjuster used to be final: `adjust` was only reachable in the
   * instant after picking, so the only way back was to discard the story and pick
   * the photo again. Re-cropping starts from the original, never from the previous
   * crop, so it is lossless however many times it is used.
   */
  const handleReadjust = async () => {
    if (!media || media.type !== 'image') return;
    const next = await readjust();
    if (next) setMedia({ uri: next, type: 'image' });
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

      const { musicAttached } = await createStoryRecord(
          mediaUrl,
          media.type,
          visibility,
          storyText || null,
          storyText ? textPos : null,
          mentions,
          // Only the id. The server resolves and stores the rest.
          selectedMusic?.id ?? null,
      );

      // Stop the preview before navigating, or it plays on over the home feed.
      try { musicPlayer.pause(); } catch { /* nothing loaded */ }
      // A plain invalidate is not enough: `fetchStories` is cache-first, so
      // re-running it just returns the existing local rows — without the story
      // just published, and without the music metadata the server resolved from
      // the track id (the client never sees title/artist/preview). Force the
      // network read so both land in the cache and the viewer can play the track.
      //
      // The story is already published by this point, so a refresh failure must
      // NOT fall through to the "Upload Failed" alert below — degrade to an
      // invalidate and let the next read pick it up.
      try {
        queryClient.setQueryData(['stories'], await fetchStories({ forceRefresh: true }));
      } catch {
        await queryClient.invalidateQueries({ queryKey: ['stories'] });
      }
      router.replace('/home');
      // Told AFTER the story is safely published, and only when a track was
      // actually chosen and lost. Silently publishing a silent story is what made
      // this feature feel broken rather than degraded.
      if (selectedMusic && !musicAttached) {
        Alert.alert(
          'Posted without music',
          'Your story is up, but the track could not be attached. You can delete it and try again.',
        );
      }
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
      {/* Full-screen crop overlay; renders nothing until a photo is being adjusted. */}
      {adjusterHost}

      {/*
        Scrim behind the toolbar. The bar is absolutely positioned over the photo
        and its controls are white, so on any light image the whole row — close,
        the tools and "Next" — became invisible. A top-down gradient keeps them
        legible without painting a hard band across the frame.
        `pointerEvents="none"` so it never eats a tap meant for the toolbar.
      */}
      {!isUploading && (
        <LinearGradient
          colors={['rgba(0,0,0,0.55)', 'rgba(0,0,0,0)']}
          style={styles.headerScrim}
          pointerEvents="none"
        />
      )}

      {!isUploading && (
        <SafeAreaView style={styles.header}>
          <TouchableOpacity
            onPress={() => { if (media) { setMedia(null); forget(); } else { router.back(); } }}
            accessibilityRole="button"
            accessibilityLabel={media ? 'Discard selected media' : 'Close'}
          >
            <CloseIcon size={30} color="white" />
          </TouchableOpacity>
          
          {/*
            Toolbar icons come from the app's own icon registry (src/lib/icons.tsx),
            not from assets/svgs. Three reasons the hand-rolled SVGs were wrong here:

              - every one of them hardcodes `stroke="white"` and accepts no colour,
                so they cannot respond to a state (active/inactive) or a background;
              - they were a mismatched set — a music note, a plain smiley and a
                person outline at different optical weights, which is why the row
                read as a random assortment of shapes;
              - the crop button used `<Ionicons name="crop-outline">`, a name that
                was NOT in the registry, so it silently rendered the blank-Circle
                fallback. scripts/audit-icon-names.mjs now fails CI on that class
                of bug; it found the same break on two other screens.

            Each button also carries a visible-on-press active tint and an
            accessibility label — they had neither, and an unlabelled icon-only
            control is unusable with a screen reader.
          */}
          {media && (
              <View style={styles.topTools}>
                  {media.type === 'image' && canReadjust && (
                    <TouchableOpacity onPress={handleReadjust} style={styles.toolBtn} accessibilityRole="button" accessibilityLabel="Adjust photo">
                        <Ionicons name="crop-outline" size={ICON_SIZE} color="white" />
                    </TouchableOpacity>
                  )}
                  <TouchableOpacity
                    onPress={() => toggleMusicSheet(true)}
                    style={styles.toolBtn}
                    accessibilityRole="button"
                    accessibilityLabel={selectedMusic ? `Change music, currently ${selectedMusic.title}` : 'Add music'}
                  >
                      <Ionicons name="musical-notes" size={ICON_SIZE} color={selectedMusic ? ACCENT : 'white'} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => toggleStickerSheet(true)}
                    style={styles.toolBtn}
                    accessibilityRole="button"
                    accessibilityLabel={selectedSticker ? 'Change sticker' : 'Add a sticker'}
                  >
                      <Ionicons name="happy" size={ICON_SIZE} color={selectedSticker ? ACCENT : 'white'} />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={startMentionMode}
                    style={styles.toolBtn}
                    accessibilityRole="button"
                    accessibilityLabel="Mention someone"
                  >
                      <Ionicons name="at" size={ICON_SIZE} color="white" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setIsEditingText(true)}
                    style={styles.toolBtn}
                    accessibilityRole="button"
                    accessibilityLabel={storyText ? 'Edit text' : 'Add text'}
                  >
                      <Ionicons name="text" size={ICON_SIZE} color={storyText ? ACCENT : 'white'} />
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
                            {/*
                              Registry icons rather than the music_play/music_pause
                              SVGs, which baked in `#FF3B30` — a different red from
                              the app's `#ff4466` accent, so the transport button
                              never quite matched anything around it.
                            */}
                            <TouchableOpacity
                              onPress={() => setIsMusicPlaying(!isMusicPlaying)}
                              style={styles.musicTransport}
                              accessibilityRole="button"
                              accessibilityLabel={isMusicPlaying ? 'Pause preview' : 'Play preview'}
                            >
                                <Ionicons name={isMusicPlaying ? 'pause' : 'play'} size={20} color="#fff" />
                            </TouchableOpacity>
                            {selectedMusic.artworkUrl
                              ? <Image source={{ uri: selectedMusic.artworkUrl }} style={styles.musicCover} />
                              : <View style={[styles.musicCover, styles.musicThumbFallback]}><Ionicons name="musical-notes" size={18} color="#999" /></View>}
                            <View style={{ flex: 1 }}>
                                <Text style={styles.musicTitle} numberOfLines={1}>{selectedMusic.title}</Text>
                                <Text style={styles.musicArtist} numberOfLines={1}>{selectedMusic.artist}</Text>
                            </View>
                            {/*
                              Change the track, rather than only remove it. Swapping
                              songs previously meant removing the sticker and finding
                              the toolbar's music button again — the attached track
                              looked final once it was on the story.
                            */}
                            <TouchableOpacity
                              onPress={() => toggleMusicSheet(true)}
                              style={{ padding: 5 }}
                              accessibilityRole="button"
                              accessibilityLabel={`Change music, currently ${selectedMusic.title}`}
                            >
                                <Ionicons name="swap-horizontal" size={22} color="#fff" />
                            </TouchableOpacity>
                            <TouchableOpacity
                              onPress={() => { setSelectedMusic(null); setIsMusicPlaying(false); }}
                              style={{ padding: 5 }}
                              accessibilityRole="button"
                              accessibilityLabel={`Remove music ${selectedMusic.title}`}
                            >
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
                            {musicSearch.length > 0 && (
                              <TouchableOpacity onPress={() => setMusicSearch('')} accessibilityRole="button" accessibilityLabel="Clear search" hitSlop={8}>
                                <CloseIcon variant="circle" size={18} color="#999" />
                              </TouchableOpacity>
                            )}
                        </View>

                        {/*
                          Category chips. With no search term the sheet browses the
                          curated catalogue, which is the whole point: it used to run
                          a live provider search on open, get throttled to zero
                          results, and show nothing at all.
                        */}
                        {!isSearching && catalog.length > 0 && (
                          <View style={styles.categoryRow}>
                            <FlatList
                              horizontal
                              data={catalog}
                              keyExtractor={(c) => c.key}
                              showsHorizontalScrollIndicator={false}
                              keyboardShouldPersistTaps="handled"
                              renderItem={({ item }) => {
                                const active = item.key === activeCategory;
                                return (
                                  <TouchableOpacity
                                    onPress={() => setActiveCategory(item.key)}
                                    accessibilityRole="button"
                                    accessibilityLabel={`${item.label} music`}
                                    accessibilityState={{ selected: active }}
                                    style={[styles.categoryChip, active && styles.categoryChipActive]}
                                  >
                                    <Text style={[styles.categoryChipText, active && styles.categoryChipTextActive]}>
                                      {item.label}
                                    </Text>
                                  </TouchableOpacity>
                                );
                              }}
                            />
                          </View>
                        )}
                        <FlatList
                          data={visibleTracks}
                          keyExtractor={item => item.id}
                          keyboardShouldPersistTaps="handled"
                          renderItem={({ item }) => (
                            <TouchableOpacity
                              style={styles.musicItem}
                              accessibilityRole="button"
                              accessibilityLabel={`Use ${item.title} by ${item.artist}`}
                              onPress={() => {
                                // Tapping the ROW attaches the track. Hearing it first
                                // is the transport button's job — see below.
                                chooseTrack(item);
                              }}
                            >
                                {item.artworkUrl
                                  ? <Image source={{ uri: item.artworkUrl }} style={styles.musicThumb} />
                                  : <View style={[styles.musicThumb, styles.musicThumbFallback]}><Ionicons name="musical-notes" size={20} color="#999" /></View>}
                                <View style={{ flex: 1 }}><Text style={styles.musicItemTitle} numberOfLines={1}>{item.title}</Text><Text style={styles.musicItemArtist} numberOfLines={1}>{item.artist}</Text></View>
                                {/* The track already attached, so reopening the picker
                                    to change it shows what is currently on the story. */}
                                {selectedMusic?.id === item.id && (
                                  <Ionicons name="checkmark-circle" size={22} color={ACCENT} style={{ marginRight: 4 }} />
                                )}
                                {/*
                                  A real button, not decoration. This was a bare
                                  `play-circle` icon sitting inside the row's own
                                  `onPress`, so the only thing tapping it could do was
                                  attach the track and dismiss the sheet — pressing
                                  play was indistinguishable from choosing. Now it
                                  auditions the track in place and leaves the sheet
                                  open, and tapping it again stops.
                                */}
                                <TouchableOpacity
                                  onPress={() => togglePreview(item)}
                                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                                  style={styles.musicPreviewBtn}
                                  accessibilityRole="button"
                                  accessibilityLabel={
                                    previewTrack?.id === item.id
                                      ? `Stop preview of ${item.title}`
                                      : `Preview ${item.title} by ${item.artist}`
                                  }
                                >
                                    <Ionicons
                                      name={previewTrack?.id === item.id ? 'pause-circle' : 'play-circle'}
                                      size={30}
                                      color={ACCENT}
                                    />
                                </TouchableOpacity>
                            </TouchableOpacity>
                          )}
                          /*
                            Three distinct states, where there used to be one. The old
                            empty component said "No music found" for a blocked
                            request, a provider outage and a genuinely obscure search
                            term alike — so the CSP failure looked like a search
                            result, which is why nobody could tell music was broken.
                          */
                          /*
                            Five distinct states where there used to be one. The old
                            empty component said "No music found" for a CSP-blocked
                            request, a throttled provider and an obscure search term
                            alike — so a permanently broken picker was
                            indistinguishable from an unlucky search.
                          */
                          ListEmptyComponent={
                            (isSearching ? isLoadingMusic : isLoadingCatalog) ? (
                              <ActivityIndicator color={ACCENT} style={{ marginTop: 40 }} />
                            ) : (isSearching ? musicError : catalogError) ? (
                              <View style={styles.musicStateBox}>
                                <Text style={styles.emptyText}>{isSearching ? musicError : catalogError}</Text>
                                <TouchableOpacity
                                  onPress={() => (isSearching ? runMusicSearch(musicSearch) : loadCatalog())}
                                  style={styles.musicRetryBtn}
                                  accessibilityRole="button"
                                >
                                  <Text style={styles.musicRetryText}>Retry</Text>
                                </TouchableOpacity>
                              </View>
                            ) : (
                              <Text style={styles.emptyText}>
                                {isSearching ? `No results for "${musicSearch.trim()}"` : 'No music available right now.'}
                              </Text>
                            )
                          }
                        />
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
  headerScrim: { position: 'absolute', top: 0, left: 0, right: 0, height: 140, zIndex: 9 },
  topTools: { flexDirection: 'row', alignItems: 'center', gap: 18 },
  // 44px minimum touch target. These were `padding: 5` around a 26px glyph, i.e.
  // 36px — under the platform guidance on both iOS and Android, and noticeably
  // fiddly next to each other in a row.
  toolBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  musicTransport: { width: 34, height: 34, borderRadius: 17, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' },
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
  // Padding, not just the icon's own bounds: this is a button nested inside the
  // row's press target, so it needs a reliably tappable area of its own.
  musicPreviewBtn: { paddingVertical: 6, paddingLeft: 10, paddingRight: 2 },
  musicThumb: { width: 50, height: 50, borderRadius: 8, marginRight: 15 },
  musicItemTitle: { fontSize: 16, fontFamily: 'Urbanist-Bold', color: '#000' },
  musicItemArtist: { fontSize: 14, color: '#666', fontFamily: 'Urbanist-Medium' },
  musicSticker: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'white', padding: 10, borderRadius: 12, shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.2, shadowRadius: 5, elevation: 5, position: 'relative', maxWidth: width * 0.75 },
  musicCover: { width: 40, height: 40, borderRadius: 6, marginRight: 10 },
  musicTitle: { fontSize: 14, fontFamily: 'Urbanist-Bold', color: '#000' },
  musicArtist: { fontSize: 12, color: '#666', fontFamily: 'Urbanist-Medium' },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 50, fontFamily: 'Urbanist-Medium', paddingHorizontal: 20 },
  musicStateBox: { alignItems: 'center', gap: 16 },
  musicThumbFallback: { backgroundColor: '#F0F0F0', alignItems: 'center', justifyContent: 'center' },
  musicRetryBtn: { minHeight: 44, paddingHorizontal: 24, justifyContent: 'center', borderRadius: 22, backgroundColor: ACCENT },
  musicRetryText: { color: '#fff', fontFamily: 'Urbanist-Bold', fontSize: 15 },
  categoryRow: { marginBottom: 14 },
  categoryChip: { paddingHorizontal: 16, minHeight: 36, justifyContent: 'center', borderRadius: 18, backgroundColor: '#F2F2F5', marginRight: 8 },
  categoryChipActive: { backgroundColor: ACCENT },
  categoryChipText: { fontSize: 14, fontFamily: 'Urbanist-SemiBold', color: '#555' },
  categoryChipTextActive: { color: '#fff' }
});
