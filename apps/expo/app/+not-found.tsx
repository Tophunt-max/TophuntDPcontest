import { Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter, usePathname } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { reportError } from '@/src/lib/reportError';
import { useEffect } from 'react';

/**
 * Fallback for a route that does not exist.
 *
 * Without this file Expo Router shows its own built-in "Unmatched Route" screen,
 * which looks like a crash to a user and is invisible to us. That is exactly how
 * a dead `/contest/video/setup` link sat in the Explore screen unnoticed: every
 * video join hit it, and there was nothing in the logs to say so.
 *
 * So this does two jobs — it gives the user a way out, and it reports the bad path
 * so the next broken link surfaces as an error rather than a support ticket.
 */
export default function NotFoundScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const isDark = useColorScheme() === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const secondary = isDark ? '#A0A0A0' : '#666';

  useEffect(() => {
    reportError(new Error(`Unmatched route: ${pathname}`), { screen: 'not-found', pathname });
  }, [pathname]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor }]}>
      {/*
        Scrollable so "Go to Home" — the only way out of a dead link — cannot be
        clipped off a short window, which is what a centred fixed-height container
        did with no scrollbar to recover it.
      */}
      <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <Ionicons name="compass-outline" size={64} color={secondary} />
      <Text style={[styles.title, { color: textColor }]}>This page doesn&apos;t exist</Text>
      <Text style={[styles.subtitle, { color: secondary }]}>
        The link you followed may be broken or the page may have moved.
      </Text>
      <TouchableOpacity style={styles.button} onPress={() => router.replace('/home')}>
        <Text style={styles.buttonText}>Go to Home</Text>
      </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
  // flexGrow, not flex — inside a ScrollView `flex: 1` sets `flex-basis: 0`,
  // collapsing the content box back to the viewport and re-clipping the content.
  container: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginTop: 8, textAlign: 'center' },
  subtitle: { fontSize: 14, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 20 },
  button: { marginTop: 20, backgroundColor: '#FF4D67', paddingVertical: 14, paddingHorizontal: 40, borderRadius: 26 },
  buttonText: { color: '#fff', fontSize: 15, fontFamily: 'Urbanist-Bold' },
});
