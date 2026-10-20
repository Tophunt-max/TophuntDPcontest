import React, { useEffect, useState } from 'react';
import { Linking } from 'react-native';
import { useRouter } from 'expo-router';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAuth } from '@/src/hooks/useAuth';
import { SplashVisual } from '@/src/components/system/SplashVisual';
import { getAppConfig } from '@/src/services/appSettings';
import { readApi } from '@/src/services/api';
import { guestStartRoute, ONBOARDING_SEEN_KEY, sessionEntryKind } from '@/src/lib/onboarding';
import { isProfileComplete } from '@/src/lib/profileCompletion';

/**
 * Routed startup controller. The visual itself is shared with the root auth gate
 * (`SplashVisual`), so session restoration can never swap the old design/font for
 * a second temporary splash.
 */
export default function SplashScreen() {
  const router = useRouter();
  const { user, loading: authLoading, status: authStatus } = useAuth();
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashImage, setSplashImage] = useState<string | null>(null);
  // Admin switch for the first-launch intro; unknown (config failed) = on.
  const onboardingEnabledRef = React.useRef(true);

  useEffect(() => {
    let active = true;
    async function prepare() {
      try {
        const config = await getAppConfig();
        if (!active) return;
        if (config?.splashImageUrl) setSplashImage(config.splashImageUrl);
        if (config && config.onboardingEnabled === false) onboardingEnabledRef.current = false;
      } catch (e) {
        console.warn('Splash config error:', e);
      } finally {
        // No cosmetic delay. The root already held this same visual until auth
        // restoration, so route as soon as config is resolved.
        if (active) setAppIsReady(true);
      }
    }
    void prepare();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    // The app-wide observer has already resolved before this route can mount
    // (app/_layout.tsx). Never attach a second observer here.
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

      if (hasSeenOnboarding !== 'true') void AsyncStorage.setItem(ONBOARDING_SEEN_KEY, 'true').catch(() => {});

      try {
        const meStatus: any = await readApi('/read/me/status').catch(() => null);
        if (cancelled) return;
        if (meStatus?.status === 'pending_deletion' && meStatus?.deletion) {
          router.replace('/account-scheduled-deletion');
          return;
        }

        // A network error is not "profile missing": it falls into the catch and
        // keeps the authenticated shell. Only a successful null/incomplete row
        // resumes interrupted signup.
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

  return <SplashVisual imageSource={splashImage ? { uri: splashImage } : undefined} />;
}
