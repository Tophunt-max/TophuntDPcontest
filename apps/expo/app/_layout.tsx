import { ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as PaperProvider } from 'react-native-paper';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

import { useColorScheme } from '@/hooks/use-color-scheme';
import { ToastProvider } from '@/src/components/toast/ToastProvider';
import { lightTheme, darkTheme } from '@/constants/theme';
import '@/src/services/firebase/initFirebase'; // Import to initialize Firebase

const queryClient = new QueryClient();

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <PaperProvider>
          <ToastProvider>
            <ThemeProvider value={colorScheme === 'dark' ? darkTheme : lightTheme}>
              <Stack screenOptions={{ headerShown: false }}>
                <Stack.Screen name="index" />
                <Stack.Screen name="splash" />
                <Stack.Screen name="home" />
              </Stack>
              <StatusBar style="auto" />
            </ThemeProvider>
          </ToastProvider>
        </PaperProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
