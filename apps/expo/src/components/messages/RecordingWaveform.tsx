import React, { useEffect, useMemo } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withTiming 
} from 'react-native-reanimated';

const { width: SCREEN_WIDTH } = Dimensions.get('window');
const BAR_WIDTH = 3;
const BAR_GAP = 2;
const MAX_BARS = Math.floor((SCREEN_WIDTH - 100) / (BAR_WIDTH + BAR_GAP));

interface RecordingWaveformProps {
  meteringData: number[];
}

const WaveformBar = ({ level }: { level: number }) => {
  const height = useSharedValue(5);
  const normalizedLevel = Math.max(0, (level + 60) / 60);
  const targetHeight = 5 + normalizedLevel * 40;

  useEffect(() => {
    height.value = withTiming(targetHeight, { duration: 100 });
  }, [level, targetHeight]);

  const animatedStyle = useAnimatedStyle(() => ({
    height: height.value,
  }));

  return <Animated.View style={[styles.bar, animatedStyle]} />;
};

export default function RecordingWaveform({ meteringData }: RecordingWaveformProps) {
  const displayData = useMemo(() => meteringData.slice(-MAX_BARS), [meteringData]);
  return (
    <View style={styles.container}>
      {displayData.map((level, index) => <WaveformBar key={index} level={level} />)}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', height: 60, backgroundColor: '#F8F8F8', borderRadius: 30, paddingHorizontal: 20, marginHorizontal: 10, flex: 1 },
  bar: { width: BAR_WIDTH, marginHorizontal: BAR_GAP / 2, borderRadius: BAR_WIDTH / 2, backgroundColor: '#FF4D67' },
});
