import React, { useEffect } from 'react';
import { View, StyleSheet } from 'react-native';
import Svg, { Circle, Defs, LinearGradient, Stop } from 'react-native-svg';
import Animated, { useSharedValue, useAnimatedProps, withRepeat, withTiming, Easing } from 'react-native-reanimated';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export const PauseRing = () => {
  const rotation = useSharedValue(0);

  useEffect(() => {
    rotation.value = withRepeat(
      withTiming(360, {
        duration: 1000,
        easing: Easing.linear,
      }),
      -1,
      false
    );
  }, []);

  const animatedProps = useAnimatedProps(() => {
    return {
      strokeDashoffset: 0, 
      transform: [{ rotate: `${rotation.value}deg` }],
    };
  });

  return (
    <View style={styles.container}>
        <Svg width={80} height={80} viewBox="0 0 80 80">
            <Defs>
                <LinearGradient id="grad" x1="0" y1="0" x2="1" y2="0">
                    <Stop offset="0" stopColor="#CA1D7E" stopOpacity="1" />
                    <Stop offset="1" stopColor="#FF4D67" stopOpacity="1" />
                </LinearGradient>
            </Defs>
            <Circle
                cx="40"
                cy="40"
                r="35"
                stroke="rgba(255,255,255,0.2)"
                strokeWidth="4"
                fill="none"
            />
             {/* Rotating Segment */}
             <AnimatedCircle
                cx="40"
                cy="40"
                r="35"
                stroke="url(#grad)"
                strokeWidth="4"
                fill="none"
                strokeDasharray="60, 200"
                origin="40, 40"
                rotation={rotation}
             />
        </Svg>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    justifyContent: 'center',
    alignItems: 'center',
  },
});
