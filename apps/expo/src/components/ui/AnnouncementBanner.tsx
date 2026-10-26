import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { safeExternalUrl } from '@/src/lib/safeLink';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSegments } from 'expo-router';
import { Ionicons } from '@/src/lib/icons';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { useAppControl } from '@/src/hooks/useAppControl';
import { dismissAnnouncement, useControlChoices } from '@/src/lib/controlStore';
import { bannerVisibleOn } from '@/src/lib/announcementBanner';

const TONES = {
  info: { bg: '#7C3AED', icon: 'megaphone' },
  warning: { bg: '#D97706', icon: 'warning' },
  success: { bg: '#059669', icon: 'checkmark-circle' },
  danger: { bg: '#DC2626', icon: 'alert-circle' },
} as const;

/**
 * Admin-controlled announcement banner (App Control → "In-App Announcement
 * Banner"). Live: an admin save reaches it within seconds (LiveAppConfig).
 *
 * Shown on the app's main screens (not login, splash, onboarding or the gate
 * screens); honours the admin's tone, audience and start/end window. Dismissal
 * is persisted per announcement ID, so a new announcement (or an explicit
 * "show again") reaches people who closed the previous one, and a typo fix to the
 * same one does not.
 */
export function AnnouncementBanner() {
  const { control } = useAppControl();
  const choices = useControlChoices();
  const insets = useSafeAreaInsets();
  const segments = useSegments() as string[];
  const a = control.announcement;

  if (!choices.hydrated || !a.visible || !bannerVisibleOn(segments)) return null;
  // Another strip (upcoming maintenance / staff bar) takes the top slot first.
  if (control.maintenance.bypassed || (control.maintenance.upcoming && choices.dismissedUpcomingAt !== control.maintenance.upcoming.startAt)) {
    return null;
  }
  const tone = TONES[a.tone] || TONES.info;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
      <TouchableOpacity
        activeOpacity={a.link ? 0.85 : 1}
        onPress={() => {
          const url = safeExternalUrl(a.link);
          if (url) Linking.openURL(url).catch(() => {});
        }}
        style={[styles.banner, { backgroundColor: tone.bg }]}
        accessibilityRole={a.link ? 'link' : undefined}
      >
        <Ionicons name={tone.icon as any} size={18} color="#FFF" />
        <Text style={styles.text} numberOfLines={3}>{a.message}</Text>
        <TouchableOpacity
          onPress={() => dismissAnnouncement(a.id)}
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
