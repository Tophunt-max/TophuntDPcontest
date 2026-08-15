import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@/src/lib/icons';
import { useAppConfig } from '@/src/services/appSettings';

/**
 * Admin-controlled announcement banner. Shows when appConfig.announcement is
 * enabled with a message. Dismissible for the session; re-appears if the admin
 * changes the message (dismissal is keyed by message text).
 */
export function AnnouncementBanner() {
  const { config } = useAppConfig();
  const insets = useSafeAreaInsets();
  const [dismissedMsg, setDismissedMsg] = useState<string | null>(null);

  const ann = config?.announcement;
  const message = ann?.message?.trim();
  if (!ann?.enabled || !message || dismissedMsg === message) return null;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
      <TouchableOpacity
        activeOpacity={ann.link ? 0.85 : 1}
        onPress={() => ann.link && Linking.openURL(ann.link).catch(() => {})}
        style={styles.banner}
      >
        <Ionicons name="megaphone" size={18} color="#FFF" />
        <Text style={styles.text} numberOfLines={2}>{message}</Text>
        <TouchableOpacity onPress={() => setDismissedMsg(message)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
          <Ionicons name="close" size={18} color="#FFF" />
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
