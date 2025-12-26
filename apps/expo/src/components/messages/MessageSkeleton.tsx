import React from 'react';
import { View, StyleSheet, Animated } from 'react-native';

interface MessageSkeletonProps {
  isDark: boolean;
}

export const MessageSkeleton = ({ isDark }: MessageSkeletonProps) => {
  const animatedValue = new Animated.Value(0);

  React.useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(animatedValue, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(animatedValue, {
          toValue: 0,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  }, []);

  const opacity = animatedValue.interpolate({
    inputRange: [0, 1],
    outputRange: [0.3, 0.7],
  });

  const skeletonColor = isDark ? '#1F222A' : '#F5F5F5';

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.avatar, { backgroundColor: skeletonColor, opacity }]} />
      <View style={styles.content}>
        <View style={styles.row}>
          <Animated.View style={[styles.name, { backgroundColor: skeletonColor, opacity }]} />
          <Animated.View style={[styles.time, { backgroundColor: skeletonColor, opacity }]} />
        </View>
        <Animated.View style={[styles.message, { backgroundColor: skeletonColor, opacity }]} />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 20,
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
  },
  content: {
    flex: 1,
    marginLeft: 16,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  name: {
    width: 120,
    height: 16,
    borderRadius: 4,
  },
  time: {
    width: 40,
    height: 12,
    borderRadius: 4,
  },
  message: {
    width: '80%',
    height: 14,
    borderRadius: 4,
  },
});
