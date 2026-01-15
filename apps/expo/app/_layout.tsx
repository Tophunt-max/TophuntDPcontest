import { ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
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
  
  useEffect(() => {
    if (user && !loading) {
      updateUserPresence();
    }
  }, [user, loading]);

  // 2. Notification Listeners (Including Call Actions)
  useEffect(() => {
    const subscription = Notifications.addNotificationResponseReceivedListener(response => {
      const { actionIdentifier, notification } = response;
      const data = notification.request.content.data;

      // --- NEW: INTERACTIVE CALL ACTIONS ---
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

      // --- REDIRECTION LOGIC ---
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

    const foregroundSubscription = Notifications.addNotificationReceivedListener(notification => {
        // Handle foreground notifications
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

    if (!user) {
      if (!inAuthGroup && !inOnboarding && !inSplash && segments.length > 0) {
        router.replace('/auth/login');
      }
    } else {
      if (inAuthGroup || inOnboarding || inSplash) {
        router.replace('/home');
      }
    }
  }, [user, loading, segments]);

  useEffect(() => {
    if (user && !loading) {
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
