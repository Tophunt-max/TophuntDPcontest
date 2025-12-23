import React, { useEffect, useState } from 'react';
import { View, StyleSheet, Image, Dimensions, Text } from 'react-native';
import { useRouter } from 'expo-router';
import { onAuthStateChanged } from 'firebase/auth';
import { auth } from '../src/services/firebase/initFirebase';
import { SplashAnimation } from '../components/SplashAnimation';
import * as Font from 'expo-font';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { getAppConfig, AppConfig } from '../src/services/appSettings';

const { width, height } = Dimensions.get('window');

export default function SplashScreen() {
  const router = useRouter();
  const [appIsReady, setAppIsReady] = useState(false);
  const [config, setConfig] = useState<AppConfig | null>(null);

  useEffect(() => {
    async function prepare() {
      try {
        console.log("Preparing app...");
        // 1. Load Fonts
        await Font.loadAsync({
            'Urbanist-Regular': require('../assets/fonts/Urbanist-Regular.ttf'),
            'Urbanist-Bold': require('../assets/fonts/Urbanist-Bold.ttf'),
            'Urbanist-Medium': require('../assets/fonts/Urbanist-Medium.ttf'),
            'Urbanist-SemiBold': require('../assets/fonts/Urbanist-SemiBold.ttf'),
        });
        console.log("Fonts loaded");

        // 2. Fetch Live Config with a shorter timeout
        try {
            const appConfig = await getAppConfig();
            if (appConfig) {
                setConfig(appConfig);
                console.log("Config loaded");
            }
        } catch (e) {
            console.warn('Config fetch skipped:', e);
        }

      } catch (e) {
        console.warn('General preparation error:', e);
      } finally {
        setAppIsReady(true);
      }
    }

    prepare();
  }, []);


  useEffect(() => {
    if (!appIsReady) return;

    let isMounted = true;
    let authUnsubscribe: (() => void) | null = null;

    const checkAuthAndOnboarding = async () => {
        try {
            console.log("Checking auth...");
            // Minimum wait for splash to be visible
            await new Promise(resolve => setTimeout(resolve, 3000));
            
            if (!isMounted) return;

            const hasSeenOnboarding = await AsyncStorage.getItem('hasSeenOnboarding');

            authUnsubscribe = onAuthStateChanged(auth, (user) => {
                console.log("Auth state changed, user:", user?.uid);
                if (user) {
                    router.replace('/home');
                } else {
                    if (hasSeenOnboarding === 'true') {
                        router.replace('/auth/login');
                    } else {
                        router.replace('/onboarding');
                    }
                }
            });

        } catch (e) {
            console.error("Auth check error:", e);
            router.replace('/onboarding');
        }
    };

    checkAuthAndOnboarding();

    return () => {
        isMounted = false;
        if (authUnsubscribe) authUnsubscribe();
    };

  }, [appIsReady]);

  // Always render the splash UI while waiting for appIsReady or during the minimum timeout
  return (
    <View style={styles.container}>
      {config?.splashImageUrl ? (
          <Image 
            source={{ uri: config.splashImageUrl }} 
            style={styles.fullImage} 
            resizeMode="cover"
          />
      ) : (
          <SplashAnimation />
      )}
      {!appIsReady && (
          <View style={styles.loadingOverlay}>
              <Text style={styles.loadingText}>Loading Assets...</Text>
          </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff', 
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullImage: {
      width: width,
      height: height,
  },
  loadingOverlay: {
      position: 'absolute',
      bottom: 50,
      backgroundColor: 'rgba(255, 255, 255, 0.8)',
      padding: 10,
      borderRadius: 20,
  },
  loadingText: {
      color: '#FF4D67',
      fontFamily: 'Urbanist-Medium',
      fontSize: 12,
  }
});
