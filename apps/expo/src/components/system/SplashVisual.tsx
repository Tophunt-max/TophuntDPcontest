import React from 'react';
import { View, Text, StyleSheet, Image, Platform, useWindowDimensions, type ImageSourcePropType } from 'react-native';
import Animated, { useAnimatedStyle, useFrameCallback, useSharedValue } from 'react-native-reanimated';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useReduceMotion } from '@/src/hooks/usePlaybackEnvironment';
import { Colors } from '@/constants/theme';

/**
 * The canonical TopHunt splash visual.
 *
 * Both the routed splash (`app/splash.tsx`) and the auth-restoration gate use
 * this exact component, so the hand-off between them is visually seamless.
 *
 * Every animation is a pure function of the time since the FIRST splash mount
 * of this JS session (`SESSION_START`), not of the current mount. The gate and
 * the routed splash are separate mounts; time-based styles let the second one
 * continue the logo intro / breathing / loader exactly where the first left off
 * instead of restarting with a visible jump.
 */
const LOGO = require('../../../assets/images/splash.webp');
const LOGO_ASPECT = 2172 / 724; // splash.webp is a 3:1 wordmark

const INTRO_MS = 900; // fade + rise + scale-in of the logo
const BREATH_MS = 2600; // one full slow "breathing" cycle after the intro
const TAGLINE_DELAY_MS = 450;
const TAGLINE_FADE_MS = 500;
const SPINNER_MS = 1500; // one loader revolution
const FADE_IN = Platform.OS === 'web';

let sessionStart: number | null = null;

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
  const reduceMotion = useReduceMotion();
  const { width } = useWindowDimensions();
  const logoWidth = Math.min(width * 0.78, 340);

  if (sessionStart === null) sessionStart = Date.now();
  const start = sessionStart;
  const elapsed = useSharedValue(Date.now() - start);
  useFrameCallback(() => {
    elapsed.value = Date.now() - start;
  });

  const logoStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: 1, transform: [{ translateY: 0 }, { scale: 1 }] };
    const t = elapsed.value;
    const p = Math.min(Math.max(t / INTRO_MS, 0), 1);
    const intro = 1 - Math.pow(1 - p, 3); // ease-out cubic: fast start, soft landing, no overshoot
    // 0 -> 1 -> 0 cosine wave; starts at 0 so the loop picks up from the intro's end pose with no jump.
    const wave = t > INTRO_MS ? (1 - Math.cos(((t - INTRO_MS) / BREATH_MS) * 2 * Math.PI)) / 2 : 0;
    return {
      // Native builds hand over from the OS splash, which already shows this logo:
      // fading it in from 0 there would blink. Web has no OS splash, so it fades in.
      opacity: FADE_IN ? Math.min(p * 1.6, 1) : 1,
      transform: [{ translateY: 16 * (1 - intro) - 5 * wave }, { scale: (0.86 + 0.14 * intro) * (1 + 0.035 * wave) }],
    };
  }, [reduceMotion]);

  const taglineStyle = useAnimatedStyle(() => {
    if (reduceMotion) return { opacity: 1, transform: [{ translateY: 0 }] };
    const p = Math.min(Math.max((elapsed.value - TAGLINE_DELAY_MS) / TAGLINE_FADE_MS, 0), 1);
    return { opacity: p, transform: [{ translateY: 8 * (1 - p) }] };
  }, [reduceMotion]);

  const spinnerStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${((elapsed.value % SPINNER_MS) / SPINNER_MS) * 360}deg` }],
  }));

  return (
    <View
      style={[styles.container, { backgroundColor: dark ? Colors.dark.background : Colors.light.background }]}
      accessibilityState={{ busy: loading }}
    >
      <Animated.View style={[styles.logoContainer, logoStyle]}>
        {imageSource ? (
          // Admin-configured splash image (`splashImageUrl`): keep the square card look.
          <Image source={imageSource} style={styles.customLogo} resizeMode="contain" accessibilityLabel="TopHunt" />
        ) : (
          <Image
            source={LOGO}
            style={{ width: logoWidth, height: logoWidth / LOGO_ASPECT }}
            resizeMode="contain"
            accessibilityRole="image"
            accessibilityLabel="TopHunt"
          />
        )}
      </Animated.View>

      <Animated.View style={[styles.textContainer, taglineStyle]}>
        <Text style={styles.tagline}>Compete. Vote. Win.</Text>
      </Animated.View>

      {loading ? (
        <View style={styles.loadingWrapper}>
          <Animated.View style={[styles.spinnerContainer, spinnerStyle]} accessibilityLabel="Loading">
            {Array.from({ length: 8 }, (_, i) => (
              <View
                key={i}
                style={[
                  styles.spinnerDot,
                  { transform: [{ rotate: `${i * 45}deg` }, { translateY: -14 }], opacity: 1 - i * 0.1 },
                ]}
              />
            ))}
          </Animated.View>
        </View>
      ) : footer ? (
        <View style={styles.footer}>{footer}</View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  // No shadow on the wordmark: web and Android draw it as a rectangle around the
  // transparent image. Only the admin's square card keeps the old pink glow.
  logoContainer: { marginBottom: 22 },
  customLogo: {
    width: 140,
    height: 140,
    borderRadius: 30,
    shadowColor: '#FF4D67',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.2,
    shadowRadius: 20,
  },
  textContainer: { alignItems: 'center' },
  tagline: { fontSize: 18, fontFamily: 'Urbanist-Medium', color: '#9E9E9E' },
  loadingWrapper: { position: 'absolute', bottom: 80 },
  spinnerContainer: { width: 40, height: 40, justifyContent: 'center', alignItems: 'center' },
  spinnerDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#FF4D67', position: 'absolute' },
  footer: { position: 'absolute', left: 28, right: 28, bottom: 58, alignItems: 'center' },
});
