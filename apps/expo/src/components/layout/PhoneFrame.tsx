import React from 'react';
import { View, StyleSheet, useWindowDimensions, ViewStyle } from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { PHONE_MAX_WIDTH, isPhoneFramed } from '@/src/lib/layout';

/**
 * Draws the app in a centred, phone-width column on a desktop browser.
 *
 * Every screen in this app is a phone layout. Without a frame, a desktop window
 * stretches them to 1280–1920px: the bottom nav spans the whole monitor, rows
 * push their text to the far edges, and anything sized from the window width
 * (grids, cards, skeletons) grows until it overflows. The column keeps each
 * screen at the size it was designed for. The width matches `designWidth()`, so
 * sizes from `useDesignWindow()` fit the column exactly.
 *
 * On native, and on web windows no wider than a phone, it is a plain `flex: 1`
 * View. The two Views are always rendered and only their styles change, so
 * resizing a window across the threshold does not remount the whole app.
 *
 * `disabled` turns the frame off for screens with their own desktop layout (the
 * blog reader has an 800px reading column).
 *
 * The column clips horizontally only (`overflow-x: clip`). `hidden` would make it
 * a scroll container, and then it could no longer grow taller than the viewport.
 * Screens without a ScrollView depend on that growth to scroll with the page
 * (see the notes in `public/index.html`).
 */
export function PhoneFrame({
  children,
  disabled = false,
}: {
  children: React.ReactNode;
  disabled?: boolean;
}) {
  const { width } = useWindowDimensions();
  const isDark = useColorScheme() === 'dark';
  const framed = !disabled && isPhoneFramed(width);

  return (
    <View
      style={[
        styles.fill,
        framed && [styles.backdrop, { backgroundColor: isDark ? '#050507' : '#E9E9EF' }],
      ]}
    >
      <View
        style={[
          styles.fill,
          framed && [
            styles.column,
            {
              backgroundColor: isDark ? Colors.dark.background : Colors.light.background,
              // A shadow ring, not a border: a border takes 2px out of the
              // content box, so the column would be narrower than
              // designWidth() and full-width pagers would drift off-page.
              boxShadow: `0 0 0 1px ${isDark ? '#23232B' : '#DADAE2'}`,
            },
          ],
        ]}
      >
        {children}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { alignItems: 'center' },
  column: {
    width: '100%',
    maxWidth: PHONE_MAX_WIDTH,
    // react-native-web writes this through to CSS. RN's types only allow
    // visible/hidden/scroll, so it is cast.
    overflowX: 'clip',
  } as ViewStyle,
});
