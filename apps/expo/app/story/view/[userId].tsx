import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  StyleSheet,
  View,
  Dimensions,
  Pressable,
  SafeAreaView,
  StatusBar,
  Text,
  Animated,
  PanResponder,
  ActivityIndicator,
  FlatList,
  Modal,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  Share,
} from "react-native";
import { Alert } from '@/src/lib/appAlert';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AppImage as Image } from '@/src/components/ui/AppImage';
import { useVideoPlayer, VideoView, createVideoPlayer } from 'expo-video';
import { useAudioPlayer } from 'expo-audio';
import {
  DEFAULT_STORY_WINDOW_MS,
  clampStartMs,
  shouldLoopBack,
} from '@/src/services/stories/musicTrim';
import {
  STARTS_MUTED,
  AUTOPLAY_PROBE_MS,
  AUTOPLAY_CONFIRM_MS,
  shouldProbeAutoplay,
  autoplayRefused,
  isMutedNow,
  toggleMute,
  musicPillLabel,
} from '@/src/services/stories/musicAutoplay';
import { Ionicons } from '@/src/lib/icons';
import { 
    fetchStories, 
    markStoryAsSeen, 
    fetchStoryViewers,
    fetchUserHighlights,
    createHighlight,
    addStoryToHighlight,
    reactToStory,
    createStoryRecord,
    deleteStory 
} from '@/src/services/stories/storyService';
import { auth } from '@/src/services/firebase/initFirebase';
import { 
    Highlight_Story_Icon,
    Viewers_Icon,
    Delete_Icon
} from '@/assets/svgs';
import { Colors } from '@/constants/theme';
import { formatClockTime } from '@/src/lib/formatTime';
import { videoSourceFor, videoSourceWithMp4 } from '@/src/lib/videoSource';
import { useVideoStatus } from '@/src/hooks/useVideoStatus';
import { prefetchImages } from '@/src/lib/mediaPrefetch';
import { Avatar } from '@/src/components/ui/Avatar';
import { isVideoStory, isVsStory, storyMediaKind, type StoryViewer } from '@/src/types/stories';
import { StoryVsFrame } from '@/src/components/stories/StoryVsFrame';
import { VsCaptureBoundary } from '@/src/components/stories/VsCaptureBoundary';
import { useVsStoryCard } from '@/src/hooks/useVsStoryCard';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { VerifiedBadge } from '@/src/components/ui/VerifiedBadge';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';

const { width, height } = Dimensions.get('window');
// Shared with the editor's music trimmer: the window it cuts has to be the window
// this screen plays, or a trimmed soundtrack ends early or runs past what the
// author auditioned.
const DEFAULT_STORY_DURATION = DEFAULT_STORY_WINDOW_MS;
// Vertical space the top (progress + author row) and bottom (reply bar) chrome
// occupy, so the photo can be inset clear of them. Approximate on purpose — the
// goal is only that no image content sits hidden behind the chrome.
const CHROME_TOP = 72;
const CHROME_BOTTOM = 96;
const REACTION_EMOJIS = ['❤️', '🙌', '🔥', '😂', '😮', '😢', '👏', '🎉'];

export default function StoryView() {
  const { userId } = useLocalSearchParams<{ userId: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDarkTheme = colorScheme === 'dark';
  const backgroundColorTheme = isDarkTheme ? Colors.dark.background : Colors.light.background;
  const textColorTheme = isDarkTheme ? Colors.dark.text : Colors.light.text;

  const [currentStoryIndex, setCurrentStoryIndex] = useState(0);
  const [progress] = useState(new Animated.Value(0));
  const [isPaused, setIsPaused] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  /**
   * The player reported it cannot play this source.
   *
   * Needed because `isLoading` was only ever cleared by `readyToPlay`, and the
   * progress animation was started from that same branch — so a video that failed
   * to load left a spinner up forever AND never advanced the story. A Bunny video
   * hits exactly that during its 10-60s encode, as does one whose MP4 fallback is
   * missing on the web.
   */
  const [videoError, setVideoError] = useState(false);
  const [duration, setDuration] = useState(DEFAULT_STORY_DURATION);
  const [showViewers, setShowViewers] = useState(false);
  const [viewers, setViewers] = useState<StoryViewer[]>([]);
  const [loadingViewers, setLoadingViewers] = useState(false);

  // Highlights State
  const [showHighlightModal, setShowHighlightModal] = useState(false);
  const [highlights, setHighlights] = useState<any[]>([]);
  const [newHighlightName, setNewHighlightName] = useState('');
  const [isCreatingHighlight, setIsCreatingHighlight] = useState(false);
  
  // Reply State
  const [replyText, setReplyText] = useState('');
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  
  // Repost State
  const [isReposting, setIsReposting] = useState(false);

  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const progressValue = useRef(0);
  const viewersTranslateY = useRef(new Animated.Value(height)).current;
  const highlightTranslateY = useRef(new Animated.Value(height)).current;

  const [activeReaction, setActiveReaction] = useState<string | null>(null);
  const reactionAnim = useRef(new Animated.Value(0)).current;

  const { data: allUserStories } = useQuery({
    queryKey: ['stories'],
    // Wrapped, not passed by reference: react-query would otherwise pass its
    // QueryFunctionContext in as fetchStories' options argument.
    queryFn: () => fetchStories(),
  });

  const users = allUserStories || [];
  const currentUserIndex = users.findIndex(u => u.userId === userId);
  const currentUserStories = users[currentUserIndex];
  const currentStory = currentUserStories?.stories[currentStoryIndex];
  // The stories adjacent to the current one. Named *Item to stay distinct from the
  // nextStory/prevStory *navigation callbacks* declared further down.
  const nextStoryItem = currentUserStories?.stories[currentStoryIndex + 1];
  const prevStoryItem = currentUserStories?.stories[currentStoryIndex - 1];

  // Warm the adjacent story IMAGES. Combined with the video preload below this
  // is what makes tapping through a story reel feel instant: by the time the
  // progress bar advances, the next frame is already decoded on disk.
  useEffect(() => {
    const adjacentImages = [nextStoryItem, prevStoryItem]
      .filter((s) => s && !isVideoStory(s) && !!s.mediaUrl)
      .map((s) => s!.mediaUrl);
    if (adjacentImages.length) void prefetchImages(adjacentImages);
  }, [nextStoryItem?.mediaUrl, prevStoryItem?.mediaUrl]);

  // Warm the adjacent videos so transitions don't stall on a cold buffer.
  // createVideoPlayer() returns a player that does NOT auto-release, so every
  // instance created here must be released in the cleanup phase or it leaks a
  // native decoder for the lifetime of the screen.
  useEffect(() => {
    const preloadSources = [nextStoryItem, prevStoryItem]
      .filter((s) => s?.mediaType === 'video' && !!s?.mediaUrl)
      .map((s) => videoSourceFor(s!.mediaUrl));

    const players = preloadSources.map((source) => {
      try {
        const p = createVideoPlayer(source);
        p.muted = true;
        return p;
      } catch (e) {
        console.warn('[StoryView] video preload failed:', e);
        return null;
      }
    });

    return () => {
      players.forEach((p) => {
        try {
          p?.release();
        } catch {
          // Already released by the runtime; nothing to do.
        }
      });
    };
  }, [nextStoryItem?.mediaUrl, prevStoryItem?.mediaUrl]);

  const isMyStory = currentUserStories?.userId === auth.currentUser?.uid;
  const isMentioned = currentStory?.mentions?.includes(auth.currentUser?.uid || '');

  // The composite VS card for a battle story: captured from the frame below once
  // it has painted, and used to share the battle as an image rather than a link.
  // `canGenerate` is `isMyStory` because a `contest_vs` story only ever exists on
  // the two participants' own reels — so "my own battle story" is exactly the
  // permission the server checks, established without needing the match loaded.
  const isVsCurrent = !!currentStory && isVsStory(currentStory);
  const { shotRef: vsShotRef, onCaptureReady: onVsCaptureReady, shareCard } = useVsStoryCard({
    matchId: isVsCurrent ? currentStory!.matchId : null,
    canGenerate: isVsCurrent && isMyStory,
    setPaused: setIsPaused,
  });

  /**
   * Share the current story.
   *
   * This button existed with no `onPress` at all, so the paper-plane did nothing.
   * A battle shares as the head-to-head image where the device can produce one;
   * everything else, and every device that cannot, shares the text and link that
   * the rest of the app already sends.
   */
  const handleShareStory = useCallback(() => {
    const who = currentUserStories?.username ? `@${currentUserStories.username}` : 'someone';
    const message = isVsCurrent
      ? `${currentStory?.contestTitle || 'A battle'} is live on TopHunt — tap through to vote.\n\nhttps://tophunt.in`
      : `Check out ${who}'s story on TopHunt.\n\nhttps://tophunt.in`;
    void shareCard(async () => {
      try {
        await Share.share({ message });
      } catch (e) {
        // A dismissed share sheet rejects on some platforms; that is not an error.
        console.warn('[StoryView] share failed', e);
      }
    });
  }, [shareCard, isVsCurrent, currentStory?.contestTitle, currentUserStories?.username]);

  /**
   * Consulted for TWO things: to explain a playback failure, and — on web — to
   * get the MP4 url Bunny actually encoded.
   *
   * It never GATES the player. Gating on it (as the feed's PostCard does) would
   * put an API round trip in front of every video story, including the
   * overwhelming majority that are long since encoded — a real cost paid on every
   * view to cover the first minute of one. So the player is still mounted
   * optimistically; this is consulted once `statusChange` reports an error, to say
   * "still processing" instead of a bare "unavailable".
   *
   * Must sit ABOVE `useVideoPlayer` because the source depends on `mp4Url`.
   */
  const { isProcessing: videoStillEncoding, mp4Url: serverMp4Url } = useVideoStatus(
    currentStory?.mediaType === 'video' ? currentStory.mediaUrl : null,
  );

  // Resolves the platform-correct URL and enables the disk cache, so re-watching
  // a story does not refetch it. On web it prefers the server-resolved MP4 over a
  // guessed `play_720p.mp4`, which 404s when that rendition was never encoded.
  const player = useVideoPlayer(
    currentStory?.mediaType === 'video'
      ? videoSourceWithMp4(currentStory.mediaUrl, serverMp4Url)
      : null,
    (player) => {
      player.loop = false;
    },
  );

  /**
   * The story's soundtrack, and it starts AUDIBLE.
   *
   * It used to start muted on every platform. That could never fail — a muted play
   * is never blocked — but nobody heard a soundtrack without first finding and
   * tapping the pill, which reads as the music being broken.
   *
   * Asking for sound is safe here because a refusal is detected rather than
   * assumed: see the probe below and src/services/stories/musicAutoplay.ts. In
   * practice web rarely refuses, because reaching this screen means the user
   * tapped a story and that gesture gives the document sticky activation; a cold
   * deep link with no interaction is the case that genuinely fails, and it falls
   * back to muted playback with a visible control.
   */
  const musicUrl = currentStory?.musicPreviewUrl || null;
  const musicPlayer = useAudioPlayer(musicUrl ? { uri: musicUrl } : null);
  /** The viewer asked for quiet. Sticky across stories — see musicAutoplay.ts. */
  const [userMuted, setUserMuted] = useState(STARTS_MUTED);
  /** The browser refused sound for THIS story. Reset when the story changes. */
  const [soundBlocked, setSoundBlocked] = useState(false);
  const isMuted = isMutedNow({ userMuted, soundBlocked });
  /**
   * Where in the track this story starts (migration 0037). Null and 0 mean the
   * same thing — from the beginning — which is also what an offset past the end of
   * the preview degrades to, so a bad value plays the song rather than silence.
   */
  const musicStartMs = Math.max(0, currentStory?.musicStartMs ?? 0);
  /** Measured preview length; 0 until the audio loads. */
  const [musicDurationMs, setMusicDurationMs] = useState(0);

  // Follow the SAME pause lifecycle as the video and the progress bar: a
  // long-press that freezes the story must freeze its music too, and the track
  // has to stop the moment the story advances or the screen closes. Anything else
  // leaves audio running under the next story.
  useEffect(() => {
    // A story has one soundtrack. When the author attached music, the clip's own
    // audio is muted so the two do not play over each other — the same rule the
    // editor applies while previewing. WITHOUT music the clip owns the sound, so
    // it follows the same mute state the sound button shows; otherwise that button
    // would be a control that visibly changes nothing.
    try { player.muted = musicUrl ? true : isMuted; } catch { /* no source loaded */ }
    if (!musicUrl) return;
    musicPlayer.loop = true;
    musicPlayer.muted = isMuted;
    if (isPaused || showHighlightModal || isKeyboardVisible || showViewers) musicPlayer.pause();
    else musicPlayer.play();
  }, [musicUrl, musicPlayer, player, isMuted, isPaused, showHighlightModal, isKeyboardVisible, showViewers]);

  /**
   * Did the sound actually start?
   *
   * expo-audio's web backend calls `media.play()` without awaiting the promise and
   * sets its own `isPlaying = true` regardless, so a refusal is swallowed twice —
   * `player.playing` would claim success while nothing plays. `paused` reads the
   * media element itself, so it is the only honest signal.
   *
   * Without this the story would sit silent behind a live-speaker pill: strictly
   * worse than starting muted, because nothing suggests there is anything to tap.
   */
  const musicIntendedToPlay = !(isPaused || showHighlightModal || isKeyboardVisible || showViewers);
  useEffect(() => {
    if (!shouldProbeAutoplay({
      hasMusic: !!musicUrl,
      muted: isMuted,
      intendedToPlay: musicIntendedToPlay,
      alreadyBlocked: soundBlocked,
    })) return;

    // Baseline for the progress check. Sampled now so a seek to the trim offset
    // that has already happened does not read as playback.
    let startedAt = 0;
    try { startedAt = musicPlayer.currentTime; } catch { /* nothing loaded */ }

    const check = (confirmed: boolean) => {
      let paused = false;
      let now = startedAt;
      try {
        paused = musicPlayer.paused;
        now = musicPlayer.currentTime;
      } catch { return; /* nothing loaded */ }
      const refused = autoplayRefused({
        paused,
        progressed: now > startedAt + 0.05,
        confirmed,
        muted: isMuted,
        intendedToPlay: musicIntendedToPlay,
      });
      if (!refused) return;
      // Fall back to a play that cannot be refused, and let the pill offer sound.
      setSoundBlocked(true);
    };

    // Two windows: `paused` is conclusive early, a stalled clock only later.
    const fast = setTimeout(() => check(false), AUTOPLAY_PROBE_MS);
    const slow = setTimeout(() => check(true), AUTOPLAY_CONFIRM_MS);
    return () => { clearTimeout(fast); clearTimeout(slow); };
  }, [musicUrl, musicPlayer, isMuted, musicIntendedToPlay, soundBlocked]);

  // Each story gets its own attempt at sound: a refusal on the first one is not a
  // property of the next, and by then the viewer has almost certainly tapped.
  // `userMuted` is deliberately NOT reset — quietly restoring sound after someone
  // asked for quiet is worse than never autoplaying.
  useEffect(() => {
    setSoundBlocked(false);
  }, [currentStory?.id]);

  /**
   * Play the part of the track the author chose.
   *
   * `loop` restarts at 0:00, which is outside that window, so a story lasting
   * longer than the trimmed section would drift back to the top of the song. The
   * window is therefore enforced here — expo-audio reports position but has no
   * "reached time" event, hence the poll.
   *
   * The offset is re-derived from the measured duration rather than trusted: a
   * preview can be replaced by a shorter one, and seeking past the end would play
   * nothing at all. `shouldLoopBack` treats that as "return to start".
   */
  useEffect(() => {
    if (!musicUrl) return;
    let cancelled = false;
    const startSec = () => clampStartMs(musicStartMs, duration, musicDurationMs) / 1000;
    if (musicStartMs > 0) { try { void musicPlayer.seekTo(startSec()); } catch { /* not loaded */ } }
    const id = setInterval(() => {
      if (cancelled) return;
      const d = musicPlayer.duration;
      if (Number.isFinite(d) && d > 0) {
        const ms = Math.round(d * 1000);
        setMusicDurationMs((cur) => (cur === ms ? cur : ms));
      }
      if (musicStartMs <= 0) return;
      const cur = musicPlayer.currentTime * 1000;
      if (shouldLoopBack(cur, musicStartMs, duration, musicDurationMs)) {
        try { void musicPlayer.seekTo(startSec()); } catch { /* not loaded */ }
      }
    }, 250);
    return () => { cancelled = true; clearInterval(id); };
  }, [musicUrl, musicPlayer, musicStartMs, duration, musicDurationMs]);

  // Stop on unmount and whenever the current story changes, so the previous
  // story's track never bleeds into the next one.
  useEffect(() => {
    return () => {
      try { musicPlayer.pause(); } catch { /* nothing loaded */ }
    };
  }, [musicPlayer, currentStory?.id]);

  // Keyboard Listeners
  useEffect(() => {
      const showSubscription = Keyboard.addListener('keyboardDidShow', () => {
          setIsKeyboardVisible(true);
          setIsPaused(true);
      });
      const hideSubscription = Keyboard.addListener('keyboardDidHide', () => {
          setIsKeyboardVisible(false);
          setIsPaused(false);
      });
      return () => {
          showSubscription.remove();
          hideSubscription.remove();
      };
  }, []);

  const nextStory = useCallback(() => {
    if (!currentUserStories) return;
    if (currentStoryIndex < currentUserStories.stories.length - 1) {
      setCurrentStoryIndex(prev => prev + 1);
    } else if (currentUserIndex < users.length - 1) {
      const nextUser = users[currentUserIndex + 1];
      router.setParams({ userId: nextUser.userId });
      setCurrentStoryIndex(0);
    } else {
      router.back();
    }
  }, [currentStoryIndex, currentUserStories, currentUserIndex, users, router]);

  const prevStory = useCallback(() => {
    if (!currentUserStories) return;
    if (currentStoryIndex > 0) {
      setCurrentStoryIndex(prev => prev - 1);
    } else if (currentUserIndex > 0) {
      const prevUser = users[currentUserIndex - 1];
      router.setParams({ userId: prevUser.userId });
      setCurrentStoryIndex(prevUser.stories.length - 1);
    }
  }, [currentStoryIndex, currentUserStories, currentUserIndex, users, router]);

  const startAnimation = (storyDuration: number) => {
    progress.setValue(0);
    progressValue.current = 0;
    if (animationRef.current) animationRef.current.stop();
    animationRef.current = Animated.timing(progress, {
      toValue: 1,
      duration: storyDuration,
      useNativeDriver: false,
    });
    animationRef.current.start(({ finished }) => {
      if (finished) nextStory();
    });
  };

  useEffect(() => {
    if (currentStory) {
      markStoryAsSeen(currentStory.id);
      setIsLoading(true);
      setVideoError(false);
      // Everything that is not a video advances on a fixed timer. This used to
      // test `=== 'image'`, which excluded the `"photo"` the contest flows wrote —
      // so contest stories never started their progress bar and never advanced.
      if (!isVideoStory(currentStory)) {
        setDuration(DEFAULT_STORY_DURATION);
        setIsLoading(false);
        startAnimation(DEFAULT_STORY_DURATION);
      }
      if (isMyStory) {
          loadViewers(currentStory.id);
          loadHighlights();
      }
    }
  }, [currentStoryIndex, userId]);

  const loadViewers = async (id: string) => {
      setLoadingViewers(true);
      const data = await fetchStoryViewers(id);
      setViewers(data);
      setLoadingViewers(false);
  };

  const loadHighlights = async () => {
      if (auth.currentUser) {
          const data = await fetchUserHighlights(auth.currentUser.uid);
          setHighlights(data);
      }
  };

  const handleReaction = async (emoji: string) => {
      if (!currentStory) return;
      setActiveReaction(emoji);
      reactionAnim.setValue(0);
      Animated.sequence([
          Animated.spring(reactionAnim, { toValue: 1, useNativeDriver: true, tension: 50, friction: 5 }),
          Animated.delay(1000),
          Animated.timing(reactionAnim, { toValue: 0, duration: 300, useNativeDriver: true })
      ]).start(() => setActiveReaction(null));
      await reactToStory(currentStory.id, emoji);
  };

  const handleCreateHighlight = async () => {
      if (!newHighlightName.trim() || !currentStory || !auth.currentUser) return;
      setIsCreatingHighlight(true);
      try {
          await createHighlight(newHighlightName, currentStory.mediaUrl, [currentStory.id]);
          setNewHighlightName('');
          toggleHighlightSheet(false);
          loadHighlights();
          queryClient.invalidateQueries({ queryKey: ['highlights', auth.currentUser.uid] });
          Alert.alert("Success", `Highlight "${newHighlightName}" created successfully!`);
      } catch (e) {
          Alert.alert("Error", "Could not create highlight");
      } finally {
          setIsCreatingHighlight(false);
      }
  };

  const handleAddToHighlight = async (hId: string) => {
      if (!currentStory) return;
      try {
          await addStoryToHighlight(hId, currentStory.id);
          toggleHighlightSheet(false);
          Alert.alert("Success", "Added to highlight!");
      } catch (e) {
          Alert.alert("Error", "Could not add to highlight");
      }
  };

  const handleSendReply = async () => {
      if (!replyText.trim() || !currentStory || !auth.currentUser) return;
      
      const text = replyText.trim();
      setReplyText('');
      Keyboard.dismiss();

      try {
          Alert.alert("Sent", "Reply sent successfully!"); 
      } catch (error) {
          console.error("Error sending reply:", error);
      }
  };

  const handleRepostStory = async () => {
      if (!currentStory || isReposting) return;
      setIsReposting(true);
      setIsPaused(true);
      try {
          await createStoryRecord(
              currentStory.mediaUrl,
              storyMediaKind(currentStory),
              'public',
              `Reposted from @${currentUserStories.username}`,
              { x: 0.5, y: 0.8 }
          );
          Alert.alert("Success", "Added to your story!");
          queryClient.invalidateQueries({ queryKey: ['stories'] });
      } catch (error) {
          Alert.alert("Error", "Failed to repost story");
      } finally {
          setIsReposting(false);
          setIsPaused(false);
      }
  };

  const handleDeleteStory = () => {
    setIsPaused(true);
    Alert.alert(
        "Delete Story",
        "Are you sure you want to delete this story?",
        [
            {
                text: "Cancel",
                style: "cancel",
                onPress: () => setIsPaused(false)
            },
            {
                text: "Delete",
                style: "destructive",
                onPress: async () => {
                    try {
                        if (!currentStory) return;
                        await deleteStory(currentStory.id);
                        await queryClient.invalidateQueries({ queryKey: ['stories'] });
                        
                        if (currentUserStories.stories.length <= 1) {
                            router.back();
                        } else {
                            nextStory();
                        }
                    } catch (error) {
                        console.error("Delete failed", error);
                        Alert.alert("Error", "Failed to delete story.");
                        setIsPaused(false);
                    }
                }
            }
        ]
    );
  };

  const toggleViewers = (show: boolean) => {
      setShowViewers(show);
      setIsPaused(show);
      Animated.spring(viewersTranslateY, {
          toValue: show ? height * 0.4 : height,
          useNativeDriver: true,
          tension: 50,
          friction: 8
      }).start();
  };

  const toggleHighlightSheet = (show: boolean) => {
      if (show) {
          setShowHighlightModal(true);
          setIsPaused(true);
          Animated.spring(highlightTranslateY, {
              toValue: 0,
              useNativeDriver: true,
              tension: 50,
              friction: 8
          }).start();
      } else {
          Animated.timing(highlightTranslateY, {
              toValue: height,
              duration: 300,
              useNativeDriver: true
          }).start(() => {
              setShowHighlightModal(false);
              setIsPaused(false);
          });
      }
  };

  useEffect(() => {
    if (currentStory?.mediaType === 'video') {
        const subscription = player.addListener('statusChange', (status) => {
            if (status.status === 'readyToPlay') {
                const videoDuration = (player.duration || 5) * 1000;
                setDuration(videoDuration);
                setIsLoading(false);
                setVideoError(false);
                if (!isPaused && !showHighlightModal) {
                    player.play();
                    startAnimation(videoDuration);
                }
            } else if (status.status === 'error') {
                // Fall back to the behaviour of a non-video story: drop the
                // spinner, explain briefly, and RUN THE TIMER so the story still
                // advances. Without this branch the viewer was a dead end — the
                // one thing a full-screen story must never be, since the progress
                // bar is also how the user gets out to the next one.
                setIsLoading(false);
                setVideoError(true);
                setDuration(DEFAULT_STORY_DURATION);
                if (!isPaused && !showHighlightModal) startAnimation(DEFAULT_STORY_DURATION);
            }
        });
        return () => subscription.remove();
    }
  }, [currentStory, player, isPaused, showHighlightModal]);

  useEffect(() => {
    if (isPaused || showHighlightModal || isKeyboardVisible) {
      if (animationRef.current) animationRef.current.stop();
      if (currentStory?.mediaType === 'video') player.pause();
    } else if (!showViewers) {
      if (currentStory?.mediaType === 'video') player.play();
      const remainingDuration = (1 - progressValue.current) * duration;
      animationRef.current = Animated.timing(progress, {
        toValue: 1,
        duration: remainingDuration,
        useNativeDriver: false,
      });
      animationRef.current.start(({ finished }) => {
        if (finished) nextStory();
      });
    }
  }, [isPaused, showViewers, showHighlightModal, isKeyboardVisible]);

  const mainPanResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => setIsPaused(true),
      onPanResponderMove: (evt, gestureState) => {
          if (isMyStory && gestureState.dy < -20 && !isKeyboardVisible) {
              toggleViewers(true);
          }
      },
      onPanResponderRelease: (evt, gestureState) => {
        if (showViewers || showHighlightModal || isKeyboardVisible) return;
        setIsPaused(false);
        if (gestureState.dy > 100) {
          router.back();
        } else if (evt.nativeEvent.locationX < width / 3) {
          prevStory();
        } else if (evt.nativeEvent.locationX > (2 * width) / 3) {
          nextStory();
        }
      },
    })
  ).current;

  const sheetPanResponder = useRef(
    PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderMove: (evt, gestureState) => {
            if (gestureState.dy > 0) {
                viewersTranslateY.setValue(height * 0.4 + gestureState.dy);
            }
        },
        onPanResponderRelease: (evt, gestureState) => {
            if (gestureState.dy > 100) {
                toggleViewers(false);
            } else {
                toggleViewers(true);
            }
        }
    })
  ).current;

  const highlightPanResponder = useRef(
    PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderMove: (evt, gestureState) => {
            if (gestureState.dy > 0) {
                highlightTranslateY.setValue(gestureState.dy);
            }
        },
        onPanResponderRelease: (evt, gestureState) => {
            if (gestureState.dy > 100) {
                toggleHighlightSheet(false);
            } else {
                toggleHighlightSheet(true);
            }
        }
    })
  ).current;

  if (!currentUserStories?.stories?.length) {
    router.back();
    return null;
  }
  if (!currentStory) return null;

  return (
    <KeyboardAvoidingView 
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
    >
        <View style={styles.container}>
        <StatusBar hidden />
        <View style={styles.mediaContainer} {...mainPanResponder.panHandlers}>
            {/*
              A battle story renders as a head-to-head frame built from the match,
              so it must be checked BEFORE the media-type branch — its own
              `mediaUrl` is only the fallback for one side.
            */}
            {isVsStory(currentStory) ? (
                // Wrapped so the frame can be screenshotted into the single image
                // that gets shared and, once captured, becomes the story itself for
                // both participants. The wrapper is a plain View on every platform
                // — it exists to keep the frame from being flattened away on
                // Android — so nothing about the rendering changes.
                <VsCaptureBoundary innerRef={vsShotRef}>
                    <StoryVsFrame
                        matchId={currentStory.matchId!}
                        fallbackMediaUrl={currentStory.mediaUrl}
                        contestTitle={currentStory.contestTitle}
                        onCaptureReady={onVsCaptureReady}
                    />
                </VsCaptureBoundary>
            ) : !isVideoStory(currentStory) ? (
                // Sit the photo BETWEEN the header and the reply bar, not under
                // them: a tall screenshot used to fill the whole screen so its top
                // and bottom were hidden behind the chrome. `contain` inside a
                // safe-inset box shows the whole image, and filling the flex
                // parent (rather than a fixed Dimensions height) means the web
                // build respects the real viewport instead of overflowing it.
                <View style={[styles.mediaSafe, { paddingTop: insets.top + CHROME_TOP, paddingBottom: insets.bottom + CHROME_BOTTOM }]}>
                    <Image source={{ uri: currentStory.mediaUrl }} style={styles.mediaFill} contentFit="contain" />
                </View>
            ) : (
                // Video is FULL-BLEED, like Instagram: no chrome padding, so a
                // 9:16 clip fills the screen edge to edge and the header/reply bar
                // float over it on their gradients. (Photos keep the padded box —
                // see the note above; a tall screenshot has to stay fully visible.)
                //
                // `nativeControls={false}` is the other half of looking like a
                // story rather than a web page: expo-video defaults them ON, which
                // on web is the browser's own bar — a scrubber, volume slider,
                // fullscreen and an overflow menu pinned across the bottom of a
                // full-screen story, directly on top of the reply row.
                <View style={styles.mediaSafe}>
                    <VideoView
                        player={player}
                        style={styles.mediaFill}
                        contentFit="contain"
                        nativeControls={false}
                        allowsFullscreen={false}
                        allowsPictureInPicture={false}
                    />
                </View>
            )}
            {/*
              Scrims behind the top/bottom chrome. contentFit="contain" letterboxes
              a photo whose edges then reach the screen edges, so white progress
              bars and the reply field can land on a light part of the image and
              vanish. These keep them legible without cropping the photo.
            */}
            <LinearGradient pointerEvents="none" colors={['rgba(0,0,0,0.5)', 'transparent']} style={styles.scrimTop} />
            <LinearGradient pointerEvents="none" colors={['transparent', 'rgba(0,0,0,0.6)']} style={styles.scrimBottom} />
            {isLoading && <View style={styles.loader}><ActivityIndicator size="large" color="white" /></View>}
            {/*
              Shown instead of a spinner that would never resolve. Bunny needs
              10-60s to encode, so a story opened right after posting is the common
              case here and deserves an honest label rather than "unavailable".
            */}
            {videoError && (
                <View pointerEvents="none" style={styles.videoErrorBox}>
                    <Ionicons
                        name={videoStillEncoding ? 'hourglass-outline' : 'videocam-off'}
                        size={34}
                        color="rgba(255,255,255,0.9)"
                    />
                    <Text style={styles.videoErrorText}>
                        {videoStillEncoding
                            ? 'Still processing — check back in a moment'
                            : 'This video could not be played'}
                    </Text>
                </View>
            )}
            
            {/*
              Soundtrack pill. Sound starts on, so most of the time this is a
              now-playing label that doubles as a mute control. It only asks to be
              tapped when the browser refused unmuted playback — the one case that
              still needs a gesture. Tapping toggles sound; it does not pause the
              story.
            */}
            {musicUrl && (
                <Pressable
                    pointerEvents="auto"
                    onPress={() => {
                        // Turning sound on clears a refusal too: this tap IS the
                        // gesture the browser was waiting for.
                        const next = toggleMute({ userMuted, soundBlocked });
                        setUserMuted(next.userMuted);
                        setSoundBlocked(next.soundBlocked);
                    }}
                    style={[styles.musicPill, { top: insets.top + CHROME_TOP + 8 }]}
                    accessibilityRole="button"
                    accessibilityLabel={
                        isMuted
                            ? `Turn on sound: ${currentStory.musicTitle || 'music'}`
                            : `Mute ${currentStory.musicTitle || 'music'}`
                    }
                >
                    <Ionicons name={isMuted ? 'volume-mute' : 'volume-high'} size={16} color="white" />
                    <Text style={styles.musicPillText} numberOfLines={1}>
                        {musicPillLabel(isMuted, currentStory.musicTitle, currentStory.musicArtist)}
                    </Text>
                </Pressable>
            )}

            {/*
              Sound button for a video story with NO soundtrack — the Instagram
              control. Without it a clip's own audio had no toggle at all: the pill
              above only exists when the author attached music, so a plain video was
              either audible or (if the browser refused unmuted autoplay) silent
              with nothing on screen to say so or fix it.
            */}
            {isVideoStory(currentStory) && !musicUrl && (
                <Pressable
                    pointerEvents="auto"
                    onPress={() => {
                        // Turning sound on doubles as the gesture a browser wants
                        // before it will allow unmuted playback.
                        const next = toggleMute({ userMuted, soundBlocked });
                        setUserMuted(next.userMuted);
                        setSoundBlocked(next.soundBlocked);
                    }}
                    style={[styles.soundButton, { top: insets.top + CHROME_TOP + 8 }]}
                    hitSlop={8}
                    accessibilityRole="button"
                    accessibilityLabel={isMuted ? 'Turn on sound' : 'Mute video'}
                >
                    <Ionicons name={isMuted ? 'volume-mute' : 'volume-high'} size={18} color="white" />
                </Pressable>
            )}

            {/* Saved Overlays */}
            {currentStory.overlayText && (
                <View style={[styles.textBubble, { 
                    position: 'absolute', 
                    left: (currentStory.textPosition?.x || 0.5) * width - 50, 
                    top: (currentStory.textPosition?.y || 0.5) * height 
                }]}>
                    <Text style={styles.overlayTextDisplay}>{currentStory.overlayText}</Text>
                </View>
            )}

            {/* Reactions Animation */}
            {activeReaction && (
                <Animated.View style={[styles.floatingReaction, { 
                    opacity: reactionAnim,
                    transform: [
                        { scale: reactionAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 2] }) },
                        { translateY: reactionAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -100] }) }
                    ] 
                }]}>
                    <Text style={{ fontSize: 60 }}>{activeReaction}</Text>
                </Animated.View>
            )}
        </View>

        <SafeAreaView style={styles.overlay} pointerEvents="box-none">
            <View style={styles.header}>
            <View style={styles.progressContainer}>
                {currentUserStories.stories.map((_, index) => (
                <View key={index} style={styles.progressBackground}>
                    <Animated.View style={[styles.progressBar, { width: index < currentStoryIndex ? '100%' : index === currentStoryIndex ? progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }) : '0%' }]} />
                </View>
                ))}
            </View>
            <View style={styles.userInfo}>
                <Avatar
                  uri={currentUserStories.avatarUrlThumb || currentUserStories.avatarUrl}
                  name={currentUserStories.username}
                  size={40}
                  style={styles.avatar}
                />
                <View style={styles.userTextContainer}>
                    <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                        <Text style={styles.username} numberOfLines={1}>{currentUserStories.username}</Text>
                        <VerifiedBadge verified={(currentUserStories as any)?.verified} size={15} />
                    </View>
                    <Text style={styles.timeAgo}>{formatClockTime(currentStory.createdAt)}</Text>
                </View>
                <Pressable pointerEvents="auto" onPress={() => router.back()} style={styles.closeButton} accessibilityRole="button" accessibilityLabel="Close story"><CloseIcon size={28} color="white" /></Pressable>
            </View>
            </View>

            {/* Repost Button */}
            {isMentioned && !isMyStory && (
                <View style={styles.repostContainer} pointerEvents="auto">
                    <TouchableOpacity style={styles.repostBtn} onPress={handleRepostStory} disabled={isReposting}>
                        {isReposting ? <ActivityIndicator color="white" /> : (
                            <>
                                <Ionicons name="add-circle" size={24} color="white" />
                                <Text style={styles.repostText}>Add to your story</Text>
                            </>
                        )}
                    </TouchableOpacity>
                </View>
            )}

            {/* Bottom Actions or Reply Field */}
            {!isMyStory && !showViewers && (
                <View style={styles.footerContainer} pointerEvents="auto">
                    <View style={styles.replyInputContainer}>
                        <TextInput 
                            style={styles.replyInput}
                            placeholder="Send message"
                            placeholderTextColor="white"
                            value={replyText}
                            onChangeText={setReplyText}
                            onFocus={() => setIsPaused(true)}
                        />
                        {replyText.length > 0 ? (
                            <TouchableOpacity onPress={handleSendReply}>
                                <Text style={styles.sendText}>Send</Text>
                            </TouchableOpacity>
                        ) : (
                            <View style={styles.quickReactions}>
                                <TouchableOpacity onPress={() => handleReaction('❤️')} style={styles.miniReaction}><Text style={{fontSize: 20}}>❤️</Text></TouchableOpacity>
                                <TouchableOpacity onPress={() => handleReaction('😂')} style={styles.miniReaction}><Text style={{fontSize: 20}}>😂</Text></TouchableOpacity>
                            </View>
                        )}
                    </View>
                    <TouchableOpacity style={styles.likeBtn} onPress={() => handleReaction('❤️')}>
                        <Ionicons name="heart-outline" size={28} color="white" />
                    </TouchableOpacity>
                    <TouchableOpacity
                        style={styles.shareBtn}
                        onPress={handleShareStory}
                        accessibilityRole="button"
                        accessibilityLabel={isVsCurrent ? 'Share this battle' : 'Share this story'}
                    >
                        <Ionicons name="paper-plane-outline" size={28} color="white" />
                    </TouchableOpacity>
                </View>
            )}

            {isMyStory && !showViewers && (
                <View style={styles.bottomActions} pointerEvents="auto">
                    <Pressable style={styles.actionBtn} onPress={() => toggleHighlightSheet(true)}>
                        <Highlight_Story_Icon width={28} height={28} />
                        <Text style={styles.actionText}>Highlight</Text>
                    </Pressable>
                    <Pressable style={styles.actionBtn} onPress={() => toggleViewers(true)}>
                        <Viewers_Icon width={28} height={28} />
                        <Text style={styles.actionText}>{viewers.length}</Text>
                    </Pressable>
                    {/*
                      Own-story actions had no share at all, which meant the one
                      person most likely to want to post their battle elsewhere —
                      a participant looking at their own new battle — was the only
                      one who couldn't.
                    */}
                    <Pressable style={styles.actionBtn} onPress={handleShareStory} accessibilityRole="button" accessibilityLabel={isVsCurrent ? 'Share this battle' : 'Share this story'}>
                        <Ionicons name="paper-plane-outline" size={26} color="white" />
                        <Text style={styles.actionText}>Share</Text>
                    </Pressable>
                    <Pressable style={styles.actionBtn} onPress={handleDeleteStory}>
                        <Delete_Icon width={24} height={24} />
                        <Text style={styles.actionText}>Delete</Text>
                    </Pressable>
                </View>
            )}
        </SafeAreaView>

        {/* Highlights Modal */}
        <Modal visible={showHighlightModal} transparent animationType="none">
            <View style={styles.modalOverlay}>
                <Animated.View style={[styles.highlightModal, { backgroundColor: backgroundColorTheme, transform: [{ translateY: highlightTranslateY }] }]} {...highlightPanResponder.panHandlers}>
                    <View style={styles.modalHeader}>
                        <View style={[styles.sheetHandle, { backgroundColor: isDarkTheme ? '#35383F' : '#DDD' }]} />
                        <View style={styles.modalHeaderContent}>
                            <Text style={[styles.modalTitle, { color: textColorTheme }]}>Add to Highlights</Text>
                            <Pressable onPress={() => toggleHighlightSheet(false)}><CloseIcon variant="circle" size={24} color={isDarkTheme ? '#BDBDBD' : "#666"} /></Pressable>
                        </View>
                    </View>
                    <View style={[styles.newHighlightContainer, { borderBottomColor: isDarkTheme ? '#35383F' : '#EEE' }]}>
                        <View style={[styles.newHighlightCircle, { backgroundColor: isDarkTheme ? '#2D1F22' : '#FFF0F3' }]}><Ionicons name="add" size={30} color="#ff4466" /></View>
                        <TextInput style={[styles.highlightInput, { backgroundColor: isDarkTheme ? '#1F222A' : '#F5F5F5', color: textColorTheme }]} placeholder="New Highlight" placeholderTextColor={isDarkTheme ? '#BDBDBD' : '#999'} value={newHighlightName} onChangeText={setNewHighlightName} />
                        <TouchableOpacity style={[styles.addBtn, !newHighlightName.trim() && { opacity: 0.5 }]} onPress={handleCreateHighlight} disabled={isCreatingHighlight || !newHighlightName.trim()}>
                            {isCreatingHighlight ? <ActivityIndicator color="white" /> : <Text style={styles.addBtnText}>Add</Text>}
                        </TouchableOpacity>
                    </View>
                    <FlatList data={highlights} horizontal showsHorizontalScrollIndicator={false} keyExtractor={(item) => item.id} contentContainerStyle={{ paddingVertical: 20 }} renderItem={({ item }) => (
                        <TouchableOpacity style={styles.highlightItem} onPress={() => handleAddToHighlight(item.id)}>
                            <Image source={{ uri: item.coverImageUrl }} style={styles.highlightThumb} />
                            <Text style={[styles.highlightName, { color: textColorTheme }]} numberOfLines={1}>{item.name}</Text>
                        </TouchableOpacity>
                    )} />
                </Animated.View>
            </View>
        </Modal>

        {/* Viewers Sheet */}
        <Animated.View style={[styles.viewersSheet, { backgroundColor: backgroundColorTheme, transform: [{ translateY: viewersTranslateY }] }]} {...sheetPanResponder.panHandlers}>
            <View style={styles.sheetHeader}>
                <View style={[styles.sheetHandle, { backgroundColor: isDarkTheme ? '#35383F' : '#DDD' }]} />
                <Text style={[styles.sheetTitle, { color: textColorTheme }]}>Viewers ({viewers.length})</Text>
                <Pressable onPress={() => toggleViewers(false)} style={styles.sheetClose}><CloseIcon variant="circle" size={24} color={isDarkTheme ? '#BDBDBD' : "#666"} /></Pressable>
            </View>
            <FlatList data={viewers} keyExtractor={(item, index) => `${item.uid}_${index}`} renderItem={({ item }) => (
                <View style={[styles.viewerItem, { borderBottomColor: isDarkTheme ? '#35383F' : '#F0F0F0' }]}>
                    <Image source={{ uri: item.avatarUrl }} style={styles.viewerAvatar} />
                    <View style={{ flex: 1 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                            <Text style={[styles.viewerName, { color: textColorTheme }]} numberOfLines={1}>{item.username}</Text>
                            <VerifiedBadge verified={(item as any)?.verified} size={13} />
                        </View>
                        <Text style={[styles.viewTime, { color: isDarkTheme ? '#BDBDBD' : '#666' }]}>{formatClockTime(item.viewedAt)}</Text>
                    </View>
                    {item.reaction && <Text style={{ fontSize: 24 }}>{item.reaction}</Text>}
                </View>
            )} ListEmptyComponent={<Text style={styles.emptyText}>No views yet</Text>} contentContainerStyle={{ paddingBottom: 50 }} />
        </Animated.View>
        </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  mediaContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // Kept for any legacy full-bleed use; the photo/video branch now uses the
  // safe-inset styles below so the chrome never hides content.
  media: { width: width, height: height },
  mediaSafe: { ...StyleSheet.absoluteFillObject },
  mediaFill: { flex: 1, width: '100%' },
  scrimTop: { position: 'absolute', top: 0, left: 0, right: 0, height: 140 },
  scrimBottom: { position: 'absolute', bottom: 0, left: 0, right: 0, height: 170 },
  loader: { position: 'absolute' },
  videoErrorBox: { position: 'absolute', alignItems: 'center', gap: 10, paddingHorizontal: 32 },
  videoErrorText: { color: 'rgba(255,255,255,0.9)', fontSize: 14, textAlign: 'center' },
  overlay: { ...StyleSheet.absoluteFillObject },
  pauseOverlay: { ...StyleSheet.absoluteFillObject, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
  pauseLottie: { width: 120, height: 120 },
  header: { paddingHorizontal: 10, paddingTop: 10 },
  progressContainer: { flexDirection: 'row', height: 2, marginBottom: 10 },
  progressBackground: { flex: 1, height: 2, backgroundColor: 'rgba(255, 255, 255, 0.3)', marginHorizontal: 2, borderRadius: 1, overflow: 'hidden' },
  progressBar: { height: '100%', backgroundColor: '#FFF' },
  userInfo: { flexDirection: 'row', alignItems: 'center', marginTop: 8 },
  avatar: { width: 40, height: 40, borderRadius: 20, marginRight: 10, borderWidth: 1, borderColor: 'white' },
  userTextContainer: { flex: 1 },
  username: { color: '#FFF', fontSize: 16, fontFamily: 'Urbanist-Bold' },
  timeAgo: { color: 'rgba(255, 255, 255, 0.8)', fontSize: 12 },
  closeButton: { padding: 5 },
  bottomActions: { position: 'absolute', bottom: 40, width: '100%', flexDirection: 'row', justifyContent: 'center', gap: 40 },
  actionBtn: { alignItems: 'center' },
  actionText: { color: 'white', fontSize: 12, marginTop: 4, fontFamily: 'Urbanist-Medium' },
  floatingReaction: { position: 'absolute', width: '100%', alignItems: 'center', bottom: height * 0.4 },
  textBubble: { backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 15, paddingVertical: 8, borderRadius: 10 },
  overlayTextDisplay: { color: 'white', fontSize: 24, fontFamily: 'Urbanist-Bold', textAlign: 'center' },
  musicPill: {
    position: 'absolute',
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    maxWidth: width * 0.7,
    minHeight: 34,
    paddingHorizontal: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 30,
  },
  musicPillText: { color: 'white', fontSize: 13, fontFamily: 'Urbanist-SemiBold', flexShrink: 1 },
  /**
   * Round, translucent sound toggle in the top-right — the Instagram story
   * control. Right-aligned so it never collides with the soundtrack pill (which
   * sits on the left) and clears the close button, which lives in the header row
   * above this offset.
   */
  soundButton: {
    position: 'absolute',
    right: 16,
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  reactionContainer: { position: 'absolute', bottom: 100, width: '100%', flexDirection: 'row', justifyContent: 'center', flexWrap: 'wrap', gap: 15, paddingHorizontal: 20 },
  reactionBtn: { backgroundColor: 'rgba(255,255,255,0.2)', padding: 10, borderRadius: 25 },
  
  // Repost Styles
  repostContainer: { position: 'absolute', bottom: 180, width: '100%', alignItems: 'center' },
  repostBtn: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#0095f6', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 30, gap: 10 },
  repostText: { color: 'white', fontFamily: 'Urbanist-Bold', fontSize: 16 },

  // Footer / Reply Styles
  footerContainer: { position: 'absolute', bottom: 20, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15 },
  replyInputContainer: { flex: 1, height: 45, borderRadius: 25, borderWidth: 1, borderColor: 'rgba(255,255,255,0.5)', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 15, marginRight: 15 },
  replyInput: { flex: 1, color: 'white', fontSize: 16 },
  sendText: { color: '#ff4466', fontWeight: 'bold', marginLeft: 10 },
  likeBtn: { marginRight: 15 },
  shareBtn: {},
  quickReactions: { flexDirection: 'row', gap: 10 },
  miniReaction: { padding: 0 },

  // Sheet Styles
  viewersSheet: { position: 'absolute', left: 0, right: 0, height: height * 0.6, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, zIndex: 100 },
  sheetHeader: { alignItems: 'center', marginBottom: 20 },
  sheetHandle: { width: 40, height: 4, borderRadius: 2, marginBottom: 10 },
  sheetTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  sheetClose: { position: 'absolute', right: 0, top: 0 },
  viewerItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1 },
  viewerAvatar: { width: 45, height: 45, borderRadius: 22.5, marginRight: 12 },
  viewerName: { fontSize: 16, fontFamily: 'Urbanist-SemiBold' },
  viewTime: { fontSize: 12 },
  emptyText: { textAlign: 'center', color: '#999', marginTop: 50, fontFamily: 'Urbanist-Medium' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
  highlightModal: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, minHeight: 300 },
  modalHeader: { alignItems: 'center', marginBottom: 20 },
  modalHeaderContent: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' },
  modalTitle: { fontSize: 18, fontFamily: 'Urbanist-Bold' },
  newHighlightContainer: { flexDirection: 'row', alignItems: 'center', gap: 12, borderBottomWidth: 1, paddingBottom: 15 },
  newHighlightCircle: { width: 60, height: 60, borderRadius: 30, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: '#ff4466' },
  highlightInput: { flex: 1, height: 45, borderRadius: 10, paddingHorizontal: 15, fontFamily: 'Urbanist-Medium' },
  addBtn: { backgroundColor: '#ff4466', paddingHorizontal: 15, paddingVertical: 10, borderRadius: 10 },
  addBtnText: { color: 'white', fontFamily: 'Urbanist-Bold' },
  highlightItem: { alignItems: 'center', marginRight: 20, width: 70 },
  highlightThumb: { width: 60, height: 60, borderRadius: 30, marginBottom: 8, borderWidth: 2, borderColor: '#ff4466' },
  highlightName: { fontSize: 12, fontFamily: 'Urbanist-SemiBold', textAlign: 'center' },
});
