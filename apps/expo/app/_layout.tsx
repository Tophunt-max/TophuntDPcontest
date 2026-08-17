import { ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import 'react-native-reanimated';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache, onlineManager, focusManager } from '@tanstack/react-query';
import { Provider as PaperProvider } from 'react-native-paper';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';
import NetInfo from '@react-native-community/netinfo';

import dayjs from 'dayjs';
import localeData from 'dayjs/plugin/localeData';
import weekday from 'dayjs/plugin/weekday';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import calendar from 'dayjs/plugin/calendar';
import utc from 'dayjs/plugin/utc';

// Initialize all dayjs plugins globally at the root
dayjs.extend(localeData);
dayjs.extend(weekday);
dayjs.extend(localizedFormat);
dayjs.extend(customParseFormat);
dayjs.extend(calendar);
dayjs.extend(utc);

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ToastProvider } from '@/src/components/toast/ToastProvider';
import { lightTheme, darkTheme } from '@/constants/theme';
import '@/src/services/firebase/initFirebase'; // Import to initialize Firebase
import { getNotificationDestination } from '@/src/services/notifications/notificationMeta';
import { View, AppState } from 'react-native';
// Icons are now SVG-based (src/lib/icons.tsx via lucide-react-native), so there
// are NO icon fonts to preload — icons render identically on web/Android/iOS.

// Pause react-query background refetches (refetchInterval) whenever the app is
// not in the foreground. On mobile the "window" is never focused the way a
// browser is, so without this react-query keeps polling even when the app is
// backgrounded — burning Worker requests + D1 reads for idle users. Wiring
// focusManager to AppState makes every useQuery poll ONLY while the app is open.
focusManager.setEventListener((handleFocus) => {
  const sub = AppState.addEventListener('change', (state) => handleFocus(state === 'active'));
  return () => sub.remove();
});
import { useAppConfig, isUpdateRequired } from '@/src/services/appSettings';
import { useAuth } from '@/src/hooks/useAuth'; // Import useAuth hook
import { notificationService } from '@/src/services/notifications/notificationService';
import { AnnouncementBanner } from '@/src/components/ui/AnnouncementBanner';
import { ErrorBoundary } from '@/src/components/ErrorBoundary';
import { OfflineBanner } from '@/src/components/ui/OfflineBanner';
import { emitToast } from '@/src/lib/toastBridge';
import { reportError } from '@/src/lib/reportError';

// Drive React Query's online state from the device's real connectivity so
// queries pause offline and auto-refetch when the network returns.
onlineManager.setEventListener((setOnline) =>
  NetInfo.addEventListener((state) => setOnline(!!state.isConnected)),
);

// Resilient defaults: retry transient failures, keep data briefly fresh, and
// refetch when connectivity returns — important on flaky mobile networks.
const queryClient = new QueryClient({
  // Report every query error; toast only on user-triggered mutation failures to
  // avoid spamming toasts for background refetches.
  queryCache: new QueryCache({
    onError: (error) => reportError(error),
  }),
  mutationCache: new MutationCache({
    onError: (error: any) => {
      reportError(error);
      emitToast(error?.message || 'Something went wrong. Please try again.', 'error');
    },
  }),
  defaultOptions: {
    queries: {
      retry: 2,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      staleTime: 30_000,
      refetchOnReconnect: true,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 0,
    },
  },
});

// Component to handle maintenance redirect logic
function MaintenanceGuard({ children }: { children: React.ReactNode }) {
  const { config, loading } = useAppConfig();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const isMaintenancePage = segments[0] === 'maintenance';
    const isForceUpdatePage = segments[0] === 'force-update';

    // 1) Maintenance takes top priority.
    if (config?.maintenanceMode) {
      if (!isMaintenancePage) router.replace('/maintenance');
      return;
    }
    // 2) Force update (app version below the admin-set minimum).
    if (isUpdateRequired(config)) {
      if (!isForceUpdatePage) router.replace('/force-update');
      return;
    }
    // 3) Neither active — leave the gate screens if we're stuck on one.
    if (isMaintenancePage || isForceUpdatePage) {
      router.replace('/');
    }
  }, [config?.maintenanceMode, config?.forceUpdate, config?.minAppVersion, loading, segments]);

  return <>{children}</>;
}

// Main Root Layout Component
function RootLayoutNav() {
  const { user, loading } = useAuth(); // Get user auth state
  const segments = useSegments();
  const router = useRouter();
  
  // Hook to handle notification listeners
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const data = response.notification.request.content.data;
      console.log("Notification Clicked Data:", data);

      // Resolve the destination with the SAME shared helper the in-app list
      // uses, so a tap behaves identically from the OS tray or inside the app.
      // `data.url` (admin deep-link) wins; otherwise the real backend `type`
      // string (follow, match_like, contest-win, purchase, ...) maps to a route.
      try {
          const dest = getNotificationDestination(
              data?.type as string | undefined,
              data?.targetId as string | undefined,
              data?.url as string | undefined,
          );
          router.push((dest || '/notifications') as any);
      } catch (e) {
          console.error('Notification navigation failed', e);
          router.push('/notifications');
      }
    });

    // Also handle foreground notifications if needed
    const foregroundSubscription = Notifications.addNotificationReceivedListener(notification => {
        // You can show a toast here if you want custom UI instead of system alert
    });

    return () => {
        subscription.remove();
        foregroundSubscription.remove();
    };
  }, []);

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === 'auth';
    const inOnboarding = segments[0] === 'onboarding';
    const inSplash = segments[0] === 'splash';
    // Public content — viewable without login (needed for SEO + old shared
    // links): the blog listing/detail (/blog, /blog/[slug]), root-level post
    // permalinks (app/[slug].tsx -> segment "[slug]"), and legal pages.
    const isPublic =
      segments[0] === 'blog' || segments[0] === '[slug]' || segments[0] === 'legal';

    if (!user) {
      // Agar user login nahi hai aur kisi protected page par jane ki koshish kar raha hai
      if (!inAuthGroup && !inOnboarding && !inSplash && !isPublic && segments.length > 0) {
        router.replace('/auth/login');
      }
    } else {
      // Agar user login hai lekin auth pages par hai, toh home par bhej do
      if (inAuthGroup || inOnboarding || inSplash) {
        router.replace('/home');
      }
    }
  }, [user, loading, segments]);

  useEffect(() => {
    // Register for push notifications only when user is logged in
    if (user && !loading) {
      notificationService.registerForPushNotificationsAsync(user.uid);
    }
  }, [user, loading]);

  return (
    <MaintenanceGuard>
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="splash" />
          <Stack.Screen name="home" />
          <Stack.Screen name="maintenance" options={{ gestureEnabled: false }} />
          <Stack.Screen name="force-update" options={{ gestureEnabled: false }} />
          <Stack.Screen name="notifications/index" options={{ presentation: 'modal', title: 'Notifications' }} />
        </Stack>
        {/* Admin-controlled announcement banner (overlays all screens). */}
        <AnnouncementBanner />
        {/* Connectivity banner shown whenever the device goes offline. */}
        <OfflineBanner />
      </View>
    </MaintenanceGuard>
  );
}


export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <PaperProvider>
              <ToastProvider>
                <ThemeProvider value={colorScheme === 'dark' ? darkTheme : lightTheme}>
                  <RootLayoutNav />
                  <StatusBar style="auto" />
                </ThemeProvider>
              </ToastProvider>
            </PaperProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
