import React, { useState, useEffect } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Audio } from 'expo-av';

// Use basic shapes or SVGs for Play/Pause in Web compatibility
const PlayIcon = ({ color }: { color: string }) => (
    <View style={{ width: 0, height: 0, backgroundColor: 'transparent', borderStyle: 'solid', borderLeftWidth: 15, borderRightWidth: 0, borderBottomWidth: 10, borderTopWidth: 10, borderLeftColor: color, borderRightColor: 'transparent', borderBottomColor: 'transparent', borderTopColor: 'transparent', marginLeft: 4 }} />
);

const PauseIcon = ({ color }: { color: string }) => (
    <View style={{ flexDirection: 'row', justifyContent: 'center' }}>
        <View style={{ width: 4, height: 18, backgroundColor: color, borderRadius: 2, marginRight: 4 }} />
        <View style={{ width: 4, height: 18, backgroundColor: color, borderRadius: 2 }} />
    </View>
);

export default function AudioPlayer({ url }: { url: string }) {
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  async function loadSound() {
    setIsLoading(true);
    try {
        const { sound } = await Audio.Sound.createAsync({ uri: url }, { shouldPlay: false }, onPlaybackStatusUpdate);
        setSound(sound);
    } catch (e) { console.log(e); }
    setIsLoading(false);
  }

  function onPlaybackStatusUpdate(status: any) {
    if (status.isLoaded) {
      setPosition(status.positionMillis);
      setDuration(status.durationMillis);
      if (status.didJustFinish) { setIsPlaying(false); sound?.setPositionAsync(0); }
    }
  }

  useEffect(() => {
    loadSound();
    return () => { sound?.unloadAsync(); };
  }, [url]);

  const handlePlayPause = async () => {
    if (!sound) return;
    if (isPlaying) { await sound.pauseAsync(); setIsPlaying(false); }
    else { await sound.playAsync(); setIsPlaying(true); }
  };

  const formatTime = (millis: number) => {
    const totalSeconds = Math.floor(millis / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
  };

  return (
    <View style={styles.container}>
      {isLoading ? <ActivityIndicator color="#FF4D67" /> : (
        <TouchableOpacity onPress={handlePlayPause} style={styles.playButton}>
          {isPlaying ? <PauseIcon color="white" /> : <PlayIcon color="white" />}
        </TouchableOpacity>
      )}
      <View style={styles.progressContainer}>
        <View style={styles.progressBar}><View style={[styles.progressFill, { width: `${(position / (duration || 1)) * 100}%` }]} /></View>
        <Text style={styles.timeText}>{formatTime(position)} / {formatTime(duration)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', padding: 10, width: 200, borderRadius: 20 },
  playButton: { backgroundColor: '#FF4D67', width: 40, height: 40, borderRadius: 20, justifyContent: 'center', alignItems: 'center', marginRight: 10 },
  progressContainer: { flex: 1 },
  progressBar: { height: 4, backgroundColor: 'rgba(0,0,0,0.05)', borderRadius: 2, marginBottom: 5 },
  progressFill: { height: '100%', backgroundColor: '#FF4D67', borderRadius: 2 },
  timeText: { fontSize: 10, color: '#666', fontFamily: 'Urbanist-Medium' },
});
