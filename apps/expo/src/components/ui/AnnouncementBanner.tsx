import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSegments } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import { useAppConfig } from '@/src/services/appSettings';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { loadDismissedBanner, dismissBanner } from '@/src/lib/bannerDismiss';
import { bannerLink, bannerMessage, shouldShowBanner } from '@/src/lib/announcementBanner';

/**
 * Admin-controlled announcement banner. Driven by appConfig.announcement
 * (App Control Center → "In-App Announcement Banner").
 *
 * Shows ONLY on the home screen. It is mounted globally in app/_layout.tsx, so
 * without this gate it overlaid every screen — login, splash, onboarding and the
 * rest — which is not what a "home" announcement should do.
 *
 * Dismissal is PERSISTED (AsyncStorage), keyed by the message text: once the
 * user closes it, it stays closed across reloads and app restarts, and only
 * re-appears when the admin changes the message.
 *
 * The show/hide and link decisions live in src/lib/announcementBanner.ts (pure,
 * unit-tested); this component is only the view + wiring.
 */
export function AnnouncementBanner() {
  const { config } = useAppConfig();
  const insets = useSafeAreaInsets();
  const segments = useSegments();
  const [dismissedMsg, setDismissedMsg] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  // Hydrate the persisted dismissal once, before the first paint decision.
  useEffect(() => {
    let alive = true;
    loadDismissedBanner().then((msg) => {
      if (alive) {
        setDismissedMsg(msg);
        setReady(true);
      }
    });
    return () => {
      alive = false;
    };
  }, []);

  const ann = config?.announcement;
  const message = bannerMessage(ann);
  const link = bannerLink(ann?.link);

  // Home screen only. `segments[0]` is the top-level route slug ('home', 'auth',
  // 'splash', …); everything else must not carry the banner.
  const onHome = segments[0] === 'home';

  if (!shouldShowBanner({ onHome, ready, enabled: ann?.enabled, message, dismissedMessage: dismissedMsg })) {
    return null;
  }

  const handleDismiss = () => {
    setDismissedMsg(message!);
    void dismissBanner(message!);
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
      <TouchableOpacity
        activeOpacity={link ? 0.85 : 1}
        onPress={() => link && Linking.openURL(link).catch(() => {})}
        style={styles.banner}
      >
        <Ionicons name="megaphone" size={18} color="#FFF" />
        <Text style={styles.text} numberOfLines={2}>{message}</Text>
        <TouchableOpacity
          onPress={handleDismiss}
          hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
          accessibilityRole="button"
          accessibilityLabel="Dismiss announcement"
        >
          <CloseIcon size={18} color="#FFF" />
        </TouchableOpacity>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000, paddingHorizontal: 12 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#7C3AED',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 14,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  text: { flex: 1, color: '#FFF', fontFamily: 'Urbanist-Medium', fontSize: 13, lineHeight: 18 },
});
