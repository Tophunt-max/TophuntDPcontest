import React from 'react';
import { Text, StyleSheet, ScrollView, TouchableOpacity } from 'react-native';
import { Ionicons } from '@/src/lib/icons';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';

/**
 * The "this page does not exist" body, shared by every dead-end in the app.
 *
 * There were two of these with different visuals and different promises.
 * `app/+not-found.tsx` handled unmatched multi-segment routes. But a single-segment
 * path like `/settings` never reaches it — `app/[slug].tsx` is a root-level
 * catch-all for the original tophunt.in blog permalinks, so it claims the path and
 * `BlogDetailScreen` renders **"Post not found — Browse the blog"**. For a
 * mistyped settings URL that is a wrong answer twice over: it asserts the site
 * once had an article there, and the only way out is the blog.
 *
 * One component so a 404 looks the same wherever it is reached, with the caller
 * supplying the copy and the exits, because those genuinely differ: a deleted blog
 * post should offer the blog, and a mistyped route should offer home.
 *
 * Deliberately NOT a full screen — no SafeAreaView and no header. `+not-found` is
 * a bare screen, while the blog permalink renders the global `<Header />` above
 * this. Owning the chrome here would force one of them to be wrong.
 */
interface Action {
  label: string;
  onPress: () => void;
}

interface Props {
  title: string;
  message: string;
  /** The main way out. */
  primary: Action;
  /** Offered when a second destination is genuinely plausible. */
  secondary?: Action;
}

export function NotFoundView({ title, message, primary, secondary }: Props) {
  const isDark = useColorScheme() === 'dark';
  const textColor = isDark ? Colors.dark.text : Colors.light.text;
  const secondaryColor = isDark ? '#A0A0A0' : '#666';

  return (
    // Scrollable so the exit buttons — the only way out of a dead link — cannot
    // be clipped off a short window, which is what a centred fixed-height
    // container did with no scrollbar to recover them.
    <ScrollView contentContainerStyle={styles.container} showsVerticalScrollIndicator={false}>
      <Ionicons name="compass-outline" size={64} color={secondaryColor} />
      <Text style={[styles.title, { color: textColor }]}>{title}</Text>
      <Text style={[styles.message, { color: secondaryColor }]}>{message}</Text>

      <TouchableOpacity
        style={styles.primaryButton}
        onPress={primary.onPress}
        accessibilityRole="button"
        accessibilityLabel={primary.label}
      >
        <Text style={styles.primaryText}>{primary.label}</Text>
      </TouchableOpacity>

      {!!secondary && (
        <TouchableOpacity
          style={styles.secondaryButton}
          onPress={secondary.onPress}
          accessibilityRole="button"
          accessibilityLabel={secondary.label}
        >
          <Text style={[styles.secondaryText, { color: secondaryColor }]}>{secondary.label}</Text>
        </TouchableOpacity>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  // flexGrow, not flex — inside a ScrollView `flex: 1` sets `flex-basis: 0`,
  // collapsing the content box back to the viewport and re-clipping the content.
  container: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 12 },
  title: { fontSize: 20, fontFamily: 'Urbanist-Bold', marginTop: 8, textAlign: 'center' },
  message: { fontSize: 14, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 20 },
  primaryButton: {
    marginTop: 20,
    backgroundColor: '#FF4D67',
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 26,
  },
  primaryText: { color: '#fff', fontSize: 15, fontFamily: 'Urbanist-Bold' },
  secondaryButton: { marginTop: 4, paddingVertical: 10, paddingHorizontal: 20 },
  secondaryText: { fontSize: 14, fontFamily: 'Urbanist-SemiBold' },
});
