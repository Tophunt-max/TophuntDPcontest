import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Image, Dimensions, Text } from 'react-native';
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

const { width } = Dimensions.get('window');

// Loading Spinner Component (Round Round Spinner)
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
                                { translateY: -14 } // Distance from center
                            ],
                            opacity: 1 - (i * 0.1) // Fade trail effect
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
        console.log("Preparing app...");
        // 2. Load Fonts
        await Font.loadAsync({
            'Urbanist-Regular': require('../assets/fonts/Urbanist-Regular.ttf'),
            'Urbanist-Bold': require('../assets/fonts/Urbanist-Bold.ttf'),
            'Urbanist-Medium': require('../assets/fonts/Urbanist-Medium.ttf'),
            'Urbanist-SemiBold': require('../assets/fonts/Urbanist-SemiBold.ttf'),
        });
        console.log("Fonts loaded");
      } catch (e) {
        console.warn('Error loading fonts:', e);
      } finally {
        // 3. Mark app as ready to proceed to auth check
        setAppIsReady(true);
      }
    }

    prepare();
  }, []);

  useEffect(() => {
    if (!appIsReady) return;

    // 4. Auth & Navigation Logic
    const checkAuth = async () => {
        const hasSeenOnboarding = await AsyncStorage.getItem('hasSeenOnboarding');

        const unsubscribe = onAuthStateChanged(auth, (user: User | null) => {
            if (user) {
                // User is logged in -> Go to Home
                console.log("User authenticated, navigating to Home");
                router.replace('/home');
            } else {
                // User is NOT logged in
                if (hasSeenOnboarding === 'true') {
                    // If they have seen onboarding before, go to Login
                    console.log("User not auth, seen onboarding -> Login");
                    router.replace('/auth/login');
                } else {
                    // First time user -> Onboarding
                    console.log("User not auth, new user -> Onboarding");
                    router.replace('/onboarding');
                }
            }
        });

        return unsubscribe;
    };

    checkAuth();
  }, [appIsReady]);

  const animatedLogoStyle = useAnimatedStyle(() => ({
    transform: [{ scale: logoScale.value }],
    opacity: logoOpacity.value,
  }));

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.logoContainer, animatedLogoStyle]}>
          <Image 
            source={require('../assets/images/icon.png')} 
            style={styles.logo} 
            resizeMode="contain"
          />
      </Animated.View>

      <Animated.View entering={FadeIn.delay(300)} style={styles.textContainer}>
        <Text style={styles.appName}>TopHunt</Text>
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
    backgroundColor: '#FFFFFF', 
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
      color: '#212121',
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
