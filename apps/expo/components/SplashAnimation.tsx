import React, { useEffect } from 'react';
import { View, StyleSheet, Dimensions } from 'react-native';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withRepeat, 
  withTiming, 
  Easing,
  withDelay
} from 'react-native-reanimated';
import Svg, { Circle, Defs, RadialGradient, Stop } from 'react-native-svg';
import AppLogo from '@/assets/svgs/appLogo.svg';

const { width, height } = Dimensions.get('window');

// Blob component for the floating pink blobs
const Blob = ({ x, y, size, delay, duration }: { x: number, y: number, size: number, delay: number, duration: number }) => {
  const scale = useSharedValue(0);
  const opacity = useSharedValue(0);

  useEffect(() => {
    scale.value = withDelay(delay, withRepeat(withTiming(1, { duration, easing: Easing.inOut(Easing.ease) }), -1, true));
    opacity.value = withDelay(delay, withRepeat(withTiming(0.6, { duration, easing: Easing.inOut(Easing.ease) }), -1, true));
  }, []);

  const animatedStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: scale.value }],
      opacity: opacity.value,
      position: 'absolute',
      left: x,
      top: y,
    };
  });

  return (
    <Animated.View style={animatedStyle}>
        <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: '#FF4D67' }} />
    </Animated.View>
  );
};

// Loading Spinner Component
const LoadingSpinner = () => {
    const rotation = useSharedValue(0);

    useEffect(() => {
        rotation.value = withRepeat(withTiming(360, { duration: 2000, easing: Easing.linear }), -1);
    }, []);

    const animatedStyle = useAnimatedStyle(() => {
        return {
            transform: [{ rotate: `${rotation.value}deg` }],
        };
    });

    return (
        <Animated.View style={[styles.spinnerContainer, animatedStyle]}>
            {[...Array(8)].map((_, i) => (
                <View 
                    key={i} 
                    style={[
                        styles.dot, 
                        { 
                            transform: [
                                { rotate: `${i * 45}deg` },
                                { translateY: -12 }
                            ],
                            opacity: 1 - (i * 0.1)
                        }
                    ]} 
                />
            ))}
        </Animated.View>
    );
};

export const SplashAnimation = () => {
  const logoScale = useSharedValue(0.8);

  useEffect(() => {
    logoScale.value = withRepeat(withTiming(1, { duration: 1500, easing: Easing.inOut(Easing.ease) }), -1, true);
  }, []);

  const logoStyle = useAnimatedStyle(() => {
    return {
      transform: [{ scale: logoScale.value }],
    };
  });

  return (
    <View style={styles.container}>
        {/* Floating Blobs */}
        <Blob x={width * 0.2} y={height * 0.3} size={20} delay={0} duration={2000} />
        <Blob x={width * 0.7} y={height * 0.25} size={30} delay={500} duration={2500} />
        <Blob x={width * 0.15} y={height * 0.6} size={40} delay={200} duration={2200} />
        <Blob x={width * 0.8} y={height * 0.55} size={25} delay={800} duration={2800} />
        <Blob x={width * 0.5} y={height * 0.7} size={15} delay={1000} duration={1800} />
        <Blob x={width * 0.3} y={height * 0.4} size={10} delay={1200} duration={1500} />


      {/* Center Logo */}
      <Animated.View style={[styles.logoContainer, logoStyle]}>
        <AppLogo width={120} height={120} />
      </Animated.View>

      {/* Loading Spinner */}
      <View style={styles.spinnerWrapper}>
         <LoadingSpinner />
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'white',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  spinnerWrapper: {
      position: 'absolute',
      bottom: 80,
  },
  spinnerContainer: {
      width: 40,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
  },
  dot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: '#FF4D67',
      position: 'absolute',
  }
});
