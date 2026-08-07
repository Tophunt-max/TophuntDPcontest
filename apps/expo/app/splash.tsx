import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Image, Dimensions, Text, useColorScheme } from 'react-native';
import { useRouter } from 'expo-router';
import { onAuthStateChanged, User } from 'firebase/auth';
import { auth } from '../src/services/firebase/initFirebase';
import * as Font from 'expo-font';
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

const { width } = Dimensions.get('window');

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
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashImage, setSplashImage] = useState<string | null>(null);
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

        // 2. Load Fonts
        await Font.loadAsync({
            'Urbanist-Regular': require('../assets/fonts/Urbanist-Regular.ttf'),
            'Urbanist-Bold': require('../assets/fonts/Urbanist-Bold.ttf'),
            'Urbanist-Medium': require('../assets/fonts/Urbanist-Medium.ttf'),
            'Urbanist-SemiBold': require('../assets/fonts/Urbanist-SemiBold.ttf'),
        });
        
        console.log("Assets loaded successfully.");
      } catch (e) {
        console.warn('Splash Error:', e);
      } finally {
        // Wait a small bit so splash is not too abrupt
        setTimeout(() => {
            setAppIsReady(true);
        }, 500);
      }
    }

    prepare();
  }, []);

  useEffect(() => {
    if (!appIsReady) return;

    let unsubscribe: (() => void) | undefined;

    const performNavigationCheck = async () => {
        const hasSeenOnboarding = await AsyncStorage.getItem('hasSeenOnboarding');

        unsubscribe = onAuthStateChanged(auth, async (user: User | null) => {
            console.log("Auth state:", user ? "Logged in" : "Guest");

            if (user) {
                try {
                    // Check if the user has a completed profile in D1 (via the Worker)
                    const userData: any = await readApi(`/read/users/${user.uid}`).catch(() => null);

                    if (userData) {
                        if (userData.signupCompleted === true || userData.username) {
                            console.log("Profile complete -> Home");
                            router.replace('/home');
                        } else {
                            console.log("Profile incomplete -> Fill Profile");
                            router.replace('/auth/signup/fill-profile');
                        }
                    } else {
                        // Authenticated but no profile row (signup interrupted)
                        console.log("No profile record -> Fill Profile");
                        router.replace('/auth/signup/fill-profile');
                    }
                } catch (error) {
                    console.error("Navigation check failed:", error);
                    // On error, try to go Home if logged in, better than getting stuck
                    router.replace('/home');
                }
            } else {
                // Not logged in
                if (hasSeenOnboarding === 'true') {
                    console.log("Returning guest -> Login");
                    router.replace('/auth/login');
                } else {
                    console.log("First time user -> Onboarding");
                    router.replace('/onboarding');
                }
            }
        });
    };

    performNavigationCheck();

    return () => {
        if (unsubscribe) unsubscribe();
    };
  }, [appIsReady]);

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
