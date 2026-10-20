import React, { useEffect } from 'react';
import { View, Text, StyleSheet, Image, type ImageSourcePropType } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';

/**
 * The canonical TopHunt splash visual.
 *
 * Both the routed splash (`app/splash.tsx`) and the auth-restoration gate use
 * this exact component. The auth fix therefore cannot replace the old design or
 * typography again: hand-off is visually seamless — same 140px logo, pulse,
 * Urbanist title/tagline and rotating dotted loader.
 */
export function SplashVisual({
  imageSource,
  loading = true,
  footer,
}: {
  imageSource?: ImageSourcePropType;
  loading?: boolean;
  footer?: React.ReactNode;
}) {
  const dark = useColorScheme() === 'dark';
  const logoScale = useSharedValue(0.8);
  const logoOpacity = useSharedValue(0);

  useEffect(() => {
    logoOpacity.value = withTiming(1, { duration: 800 });
    logoScale.value = withRepeat(withSequence(withSpring(1.1), withSpring(1)), -1, true);
  }, [logoOpacity, logoScale]);

  const animatedLogoStyle = useAnimatedStyle(() => ({
    transform: [{ scale: logoScale.value }],
    opacity: logoOpacity.value,
  }));

  return (
    <View
      style={[styles.container, { backgroundColor: dark ? Colors.dark.background : Colors.light.background }]}
      accessibilityState={{ busy: loading }}
    >
      <Animated.View style={[styles.logoContainer, animatedLogoStyle]}>
        <Image
          source={imageSource || require('../../../assets/images/splesh.png')}
          style={styles.logo}
          resizeMode="contain"
        />
      </Animated.View>

      <Animated.View entering={FadeIn.delay(300)} style={styles.textContainer}>
        <Text style={[styles.appName, { color: dark ? '#FFF' : '#212121' }]}>TopHunt</Text>
        <Text style={styles.tagline}>Compete. Vote. Win.</Text>
      </Animated.View>

      {loading ? (
        <View style={styles.loadingWrapper}>
          <DottedSpinner />
        </View>
      ) : footer ? (
        <View style={styles.footer}>{footer}</View>
      ) : null}
    </View>
  );
}

function DottedSpinner() {
  const rotation = useSharedValue(0);
  useEffect(() => {
    rotation.value = withRepeat(withTiming(360, { duration: 1500, easing: Easing.linear }), -1);
  }, [rotation]);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  return (
    <Animated.View style={[styles.spinnerContainer, animatedStyle]} accessibilityLabel="Loading">
      {Array.from({ length: 8 }, (_, i) => (
        <View
          key={i}
          style={[
            styles.spinnerDot,
            {
              transform: [{ rotate: `${i * 45}deg` }, { translateY: -14 }],
              opacity: 1 - i * 0.1,
            },
          ]}
        />
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  logoContainer: {
    marginBottom: 30,
    shadowColor: '#FF4D67',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
    elevation: 10,
  },
  logo: { width: 140, height: 140, borderRadius: 30 },
  textContainer: { alignItems: 'center' },
  appName: { fontSize: 36, fontFamily: 'Urbanist-Bold', marginBottom: 10 },
  tagline: { fontSize: 18, fontFamily: 'Urbanist-Medium', color: '#9E9E9E' },
  loadingWrapper: { position: 'absolute', bottom: 80 },
  spinnerContainer: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  spinnerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF4D67', position: 'absolute' },
  footer: { position: 'absolute', left: 28, right: 28, bottom: 58, alignItems: 'center' },
});
