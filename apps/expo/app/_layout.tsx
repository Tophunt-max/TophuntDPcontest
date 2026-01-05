import { ThemeProvider } from '@react-navigation/native';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import 'react-native-reanimated';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as PaperProvider } from 'react-native-paper';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

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
import { useAppConfig } from '@/src/services/appSettings';

const queryClient = new QueryClient();

// Component to handle maintenance redirect logic
function MaintenanceGuard({ children }: { children: React.ReactNode }) {
  const { config, loading } = useAppConfig();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;

    const isMaintenancePage = segments[0] === 'maintenance';

    if (config?.maintenanceMode) {
      if (!isMaintenancePage) {
        // Redirect to maintenance screen if mode is ON
        router.replace('/maintenance');
      }
    } else {
      if (isMaintenancePage) {
        // Redirect back to root if mode is OFF
        router.replace('/');
      }
    }
  }, [config?.maintenanceMode, loading, segments]);

  return <>{children}</>;
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
                <MaintenanceGuard>
                  <Stack screenOptions={{ headerShown: false }}>
                    <Stack.Screen name="index" />
                    <Stack.Screen name="splash" />
                    <Stack.Screen name="home" />
                    <Stack.Screen name="maintenance" options={{ gestureEnabled: false }} />
                  </Stack>
                </MaintenanceGuard>
                <StatusBar style="auto" />
              </ThemeProvider>
            </ToastProvider>
          </PaperProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
