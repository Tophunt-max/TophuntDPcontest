import React, { useEffect, useState } from 'react';
import {
  View,
  StyleSheet,
  Image,
  Text,
  Linking,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useRouter } from 'expo-router';
import { useAuth } from '@/src/hooks/useAuth';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Animated, { 
  useSharedValue, 
  useAnimatedStyle, 
  withSpring, 
  withRepeat, 
  withSequence,
  withTiming,
  FadeIn,
  Easing
} from 'react-native-reanimated';
import { Colors } from '@/constants/theme';
import { getAppConfig } from '../src/services/appSettings';
import { readApi } from '../src/services/api';
import { guestStartRoute, ONBOARDING_SEEN_KEY, sessionEntryKind } from '../src/lib/onboarding';
import { isProfileComplete } from '../src/lib/profileCompletion';


// Loading Spinner Component
const LoadingSpinner = () => {
    const rotation = useSharedValue(0);

    useEffect(() => {
        rotation.value = withRepeat(withTiming(360, { duration: 1500, easing: Easing.linear }), -1);
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
                        styles.spinnerDot, 
                        { 
                            transform: [
                                { rotate: `${i * 45}deg` },
                                { translateY: -14 }
                            ],
                            opacity: 1 - (i * 0.1)
                        }
                    ]} 
                />
            ))}
        </Animated.View>
    );
};

export default function SplashScreen() {
  const router = useRouter();
  const { user, loading: authLoading, status: authStatus } = useAuth();
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashImage, setSplashImage] = useState<string | null>(null);
  // Admin switch for the first-launch intro; unknown (config failed) = on.
  const onboardingEnabledRef = React.useRef(true);
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  
  // Animation Values
  const logoScale = useSharedValue(0.8);
  const logoOpacity = useSharedValue(0);

  useEffect(() => {
    // 1. Start Animation immediately
    logoOpacity.value = withTiming(1, { duration: 800 });
    logoScale.value = withRepeat(
        withSequence(withSpring(1.1), withSpring(1.0)),
        -1, 
        true
    );

    async function prepare() {
      try {
        console.log("Preparing app components...");
        
        // Fetch Admin App Config (Splash Image, etc.)
        const config = await getAppConfig();
        if (config?.splashImageUrl) {
            setSplashImage(config.splashImageUrl);
        }
        if (config && config.onboardingEnabled === false) onboardingEnabledRef.current = false;

        // Fonts are NOT loaded here. They are loaded by the root layout
        // (app/_layout.tsx), which is the only component that mounts for every
        // route — loading them here meant they were missing on any route opened
        // directly, because this screen never mounts in that case. Icons are SVG
        // (lucide, via src/lib/icons.tsx), so there is no icon font to preload
        // either.
        console.log("Assets loaded successfully.");
      } catch (e) {
        console.warn('Splash Error:', e);
      } finally {
        // No cosmetic delay: the root already held a branded shell until auth
        // restoration, so route as soon as config/assets are ready.
        setAppIsReady(true);
      }
    }

    prepare();
  }, []);

  useEffect(() => {
    // The app-wide observer has already resolved before this route can mount
    // (app/_layout.tsx). Never attach a second observer or repeat persistence
    // restoration here; consume the one shared session snapshot.
    if (!appIsReady || authLoading || authStatus === 'error') return;
    let cancelled = false;

    const performNavigationCheck = async () => {
      const [hasSeenOnboarding, entry] = await Promise.all([
        AsyncStorage.getItem(ONBOARDING_SEEN_KEY).catch(() => null),
        sessionEntryKind(() => Linking.getInitialURL()),
      ]);
      if (cancelled) return;

      if (!user) {
        router.replace(guestStartRoute(hasSeenOnboarding, { entry, enabled: onboardingEnabledRef.current }));
        return;
      }

      // A signed-in user never gets the intro — not now, and not after signing
      // out later (src/lib/onboarding.ts).
      if (hasSeenOnboarding !== 'true') void AsyncStorage.setItem(ONBOARDING_SEEN_KEY, 'true').catch(() => {});

      try {
        // Status failure is non-authoritative and may be offline: continue to the
        // profile read rather than treating an authenticated user as guest.
        const meStatus: any = await readApi('/read/me/status').catch(() => null);
        if (cancelled) return;
        if (meStatus?.status === 'pending_deletion' && meStatus?.deletion) {
          router.replace('/account-scheduled-deletion');
          return;
        }

        // Unlike the old `.catch(() => null)`, a NETWORK error is not interpreted
        // as "profile missing". Only a successful null response means signup was
        // interrupted; offline/server failure keeps the authenticated user in the
        // app and lets the normal profile query retry.
        const userData: any = await readApi(`/read/users/${user.uid}`);
        if (cancelled) return;
        if (!userData || !isProfileComplete(userData)) router.replace('/auth/signup/fill-profile');
        else router.replace('/home');
      } catch (error) {
        console.error('Startup profile check failed; keeping authenticated shell', error);
        if (!cancelled) router.replace('/home');
      }
    };

    void performNavigationCheck();
    return () => {
      cancelled = true;
    };
  }, [appIsReady, authLoading, authStatus, user, router]);

  const animatedLogoStyle = useAnimatedStyle(() => ({
    transform: [{ scale: logoScale.value }],
    opacity: logoOpacity.value,
  }));

  return (
    <View style={[styles.container, { backgroundColor }]}>
      <Animated.View style={[styles.logoContainer, animatedLogoStyle]}>
          <Image 
            source={splashImage ? { uri: splashImage } : require('../assets/images/splesh.png')} 
            style={styles.logo} 
            resizeMode="contain"
          />
      </Animated.View>

      <Animated.View entering={FadeIn.delay(300)} style={styles.textContainer}>
        <Text style={[styles.appName, { color: isDark ? '#fff' : '#212121' }]}>TopHunt</Text>
        <Text style={styles.tagline}>Compete. Vote. Win.</Text>
      </Animated.View>

      <View style={styles.loadingWrapper}>
         <LoadingSpinner />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  logoContainer: {
      marginBottom: 30,
      shadowColor: '#FF4D67',
      shadowOffset: { width: 0, height: 10 },
      shadowOpacity: 0.2,
      shadowRadius: 20,
      elevation: 10,
  },
  logo: {
      width: 140,
      height: 140,
      borderRadius: 30,
  },
  textContainer: {
      alignItems: 'center',
  },
  appName: {
      fontSize: 36,
      fontFamily: 'Urbanist-Bold',
      marginBottom: 10,
  },
  tagline: {
      fontSize: 18,
      fontFamily: 'Urbanist-Medium',
      color: '#9E9E9E',
  },
  loadingWrapper: {
      position: 'absolute',
      bottom: 80,
  },
  spinnerContainer: {
      width: 40,
      height: 40,
      justifyContent: 'center',
      alignItems: 'center',
  },
  spinnerDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: '#FF4D67',
      position: 'absolute',
  }
});
