import React, { useRef, useState, useEffect, useMemo } from 'react';
import { View, Image, StyleSheet, Dimensions, ActivityIndicator } from 'react-native';
import { Video, ResizeMode, Audio, AVPlaybackStatus } from 'expo-av';
import { getOptimizedMediaUrl } from '../../utils/media';
import { getCachedMedia } from '../../services/media/MediaCacheService';

const { width, height } = Dimensions.get('window');

interface StoryVideoProps {
  uri: string;
  thumbnail: string;
  isActive: boolean;
  isNext: boolean;
  onPlaybackFinished?: () => void;
  onLoadStart?: () => void;
  onPlaybackUpdate?: (status: AVPlaybackStatus) => void;
}

export const StoryVideo = ({ 
  uri, 
  thumbnail, 
  isActive, 
  isNext, 
  onPlaybackFinished,
  onLoadStart,
  onPlaybackUpdate
}: StoryVideoProps) => {
  const videoRef = useRef<Video>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isBuffering, setIsBuffering] = useState(false);
  const [videoSource, setVideoSource] = useState<string | null>(null);

  // Get Optimized URL from Worker
  const videoUri = useMemo(() => getOptimizedMediaUrl(uri), [uri]);
  const posterUri = useMemo(() => getOptimizedMediaUrl(thumbnail), [thumbnail]);

  useEffect(() => {
    let isMounted = true;
    
    const loadSource = async () => {
      // For videos, we use local cache if available, 
      // otherwise getCachedMedia returns the optimized CDN URL
      const cached = await getCachedMedia(videoUri);
      if (isMounted) {
        setVideoSource(cached);
      }
    };

    loadSource();
    return () => { isMounted = false; };
  }, [videoUri]);

  useEffect(() => {
    let isMounted = true;

    const controlPlayback = async () => {
      if (!videoRef.current || !isMounted || !isLoaded) return;

      try {
        if (isActive) {
          // Optimization: Set audio mode only when active
          await Audio.setAudioModeAsync({
            playsInSilentModeIOS: true,
            staysActiveInBackground: false,
          });
          
          await videoRef.current.playAsync();
        } else {
          await videoRef.current.pauseAsync();
          if (!isNext) {
            await videoRef.current.setPositionAsync(0);
          }
        }
      } catch (e) {
        // Silently catch interruptions
      }
    };

    controlPlayback();
    return () => { isMounted = false; };
  }, [isActive, isNext, isLoaded]);

  const onPlaybackStatusUpdate = (status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;

    setIsBuffering(status.isBuffering);
    onPlaybackUpdate?.(status);

    if (status.didJustFinish) {
      onPlaybackFinished?.();
    }
  };

  // While waiting for the video source path (local or CDN)
  if (!videoSource) {
    return (
      <View style={styles.container}>
        <Image
          source={{ uri: posterUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
        <View style={styles.loader}>
          <ActivityIndicator color="#fff" size="large" />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Show Poster while video is loading or inactive */}
      {(!isLoaded || !isActive) && (
        <Image
          source={{ uri: posterUri }}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      )}

      <Video
        ref={videoRef}
        source={{ uri: videoSource }}
        style={styles.video}
        resizeMode={ResizeMode.STRETCH}
        isLooping={true}
        shouldPlay={false} // Managed via controlPlayback
        onLoadStart={onLoadStart}
        onLoad={() => setIsLoaded(true)}
        onPlaybackStatusUpdate={onPlaybackStatusUpdate}
        progressUpdateIntervalMillis={500}
        useNativeControls={false}
      />

      {/* Buffering/Loading overlay */}
      {isActive && (!isLoaded || isBuffering) && (
        <View style={styles.loader}>
          <ActivityIndicator color="#fff" size="large" />
        </View>
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    width: '100%',
    height: '100%',
    backgroundColor: '#000',
  },
  video: {
    ...StyleSheet.absoluteFillObject,
  },
  loader: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
