import { SafeAreaView } from 'react-native-safe-area-context';
import { StyleSheet } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { NotFoundView } from '@/src/components/ui/NotFoundView';
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
 *
 * ## What does NOT reach here
 *
 * Only multi-segment unknowns. A single-segment path such as `/settings` is
 * claimed by `app/[slug].tsx`, the root-level catch-all that serves the original
 * tophunt.in blog permalinks. That route reports and renders the same 404 itself —
 * see the `permalink` branch in `src/screens/BlogDetailScreen.tsx`. The body is
 * shared through `NotFoundView` so both look identical.
 */
export default function NotFoundScreen() {
  const router = useRouter();
  const pathname = usePathname();
  const isDark = useColorScheme() === 'dark';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;

  useEffect(() => {
    reportError(new Error(`Unmatched route: ${pathname}`), { screen: 'not-found', pathname });
  }, [pathname]);

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor }]}>
      <NotFoundView
        title="This page doesn't exist"
        message="The link you followed may be broken or the page may have moved."
        primary={{ label: 'Go to Home', onPress: () => router.replace('/home') }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1 },
});
