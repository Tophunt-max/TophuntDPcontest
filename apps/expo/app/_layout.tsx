import { ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef } from 'react';
import 'react-native-reanimated';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as PaperProvider } from 'react-native-paper';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import * as Notifications from 'expo-notifications';

import dayjs from 'dayjs';
import localeData from 'dayjs/plugin/localeData';
import weekday from 'dayjs/plugin/weekday';
import localizedFormat from 'dayjs/plugin/localizedFormat';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import calendar from 'dayjs/plugin/calendar';
import utc from 'dayjs/plugin/utc';

dayjs.extend(localeData);
dayjs.extend(weekday);
dayjs.extend(localizedFormat);
dayjs.extend(customParseFormat);
dayjs.extend(calendar);
dayjs.extend(utc);

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ToastProvider } from '@/src/components/toast/ToastProvider';
import { lightTheme, darkTheme } from '@/constants/theme';
import '@/src/services/firebase/initFirebase'; 
import { useAppConfig } from '@/src/services/appSettings';
import { useAuth } from '@/src/hooks/useAuth'; 
import { notificationService } from '@/src/services/notifications/notificationService';
import { updateUserPresence } from '@/src/services/messages/messageService';
import { respondToCall, declineCall } from '@/src/services/calls/callService';

const queryClient = new QueryClient();

function MaintenanceGuard({ children }: { children: React.ReactNode }) {
  const { config, loading } = useAppConfig();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    const isMaintenancePage = segments[0] === 'maintenance';
    if (config?.maintenanceMode) {
      if (!isMaintenancePage) router.replace('/maintenance');
    } else {
      if (isMaintenancePage) router.replace('/');
    }
  }, [config?.maintenanceMode, loading, segments]);

  return <>{children}</>;
}

function RootLayoutNav() {
  const { user, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const isMounted = useRef(false);

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);
  
  useEffect(() => {
    if (user && !loading) {
      updateUserPresence();
    }
  }, [user, loading]);

  // Notification Listeners (DO NOT REMOVE)
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const { actionIdentifier, notification } = response;
      const data = notification.request.content.data;

      if (data.type === 'call' && data.chatId) {
          if (actionIdentifier === 'ACCEPT_CALL') {
              respondToCall(data.chatId, { sdp: 'init' });
              router.push(`/messages/chat/${data.chatId}`);
              return;
          } else if (actionIdentifier === 'DECLINE_CALL') {
              declineCall(data.chatId);
              return;
          }
      }

      if (data?.url) {
          try { router.push(data.url); } catch (e) { router.push('/notifications'); }
          return;
      }
      if (data?.chatId) {
          router.push(`/messages/chat/${data.chatId}`);
          return;
      }
      if (data?.targetId) {
          switch (data.type) {
              case 'follow': router.push(`/profile/view/${data.targetId}`); break;
              case 'like':
              case 'comment': router.push(`/home`); break;
              case 'contest': router.push(`/contest/${data.targetId}`); break;
              default: router.push('/notifications');
          }
      } else {
          router.push('/notifications');
      }
    });

    return () => {
        subscription.remove();
    };
  }, []);

  // AUTH & PROFILE GUARD LOGIC (BUG FIX)
  useEffect(() => {
    if (loading || !isMounted.current) return;

    const inAuthGroup = segments[0] === 'auth';
    const inOnboarding = segments[0] === 'onboarding';
    const inSplash = segments[0] === 'splash';
    const inMaintenance = segments[0] === 'maintenance';
    const isRoot = segments.length === 0 || (segments.length === 1 && segments[0] === 'index');

    if (!user) {
      if (!inAuthGroup && !inOnboarding && !inSplash && !inMaintenance && !isRoot) {
        console.log("[Guard] Logged out, redirecting to login");
        router.replace('/auth/login');
      }
    } else {
      const isProfileComplete = user.signupCompleted === true;
      const inSignupFlow = segments[0] === 'auth' && segments[1] === 'signup';
      const isCongratulationsPage = segments[2] === 'congratulations';

      if (!isProfileComplete) {
        // FIXED: Agar user signup process ke andar hai (congratulations tak), toh force redirect mat karo
        if (!inSignupFlow && !inOnboarding && !inSplash && !inMaintenance && !isCongratulationsPage) {
           console.log("[Guard] Profile incomplete, forcing signup flow");
           router.replace('/auth/signup/fill-profile');
        }
      } else {
        // Profile complete hai, toh auth pages se bahar nikalo (except congratulations)
        if (inAuthGroup && !isCongratulationsPage) {
           console.log("[Guard] Profile complete, redirecting to home");
           router.replace('/home');
        }
      }
    }
  }, [user, loading, segments]);

  useEffect(() => {
    if (user && !loading && user.signupCompleted) {
      notificationService.registerForPushNotificationsAsync(user.uid);
    }
  }, [user, loading]);

  return (
    <MaintenanceGuard>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" />
        <Stack.Screen name="splash" />
        <Stack.Screen name="home" />
        <Stack.Screen name="maintenance" options={{ gestureEnabled: false }} />
        <Stack.Screen name="notifications/index" options={{ presentation: 'modal', title: 'Notifications' }} />
      </Stack>
    </MaintenanceGuard>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
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
  );
}
