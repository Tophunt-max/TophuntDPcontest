import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSegments } from 'expo-router';
import dayjs from 'dayjs';
import { Ionicons } from '@/src/lib/icons';
import { CloseIcon } from '@/src/components/ui/CloseIcon';
import { useAppControl } from '@/src/hooks/useAppControl';
import { dismissUpcomingMaintenance, setStaffBypass, useControlChoices } from '@/src/lib/controlStore';
import { formatCountdown, serverNow } from '@/src/lib/appControl';

const HIDDEN_ON = new Set(['maintenance', 'force-update', 'splash', 'onboarding', 'auth']);

/**
 * Two thin strips at the top of the app:
 *  - an upcoming scheduled maintenance ("Aaj 2:00 AM se 30 min maintenance"),
 *    dismissible for this session;
 *  - for STAFF who entered during maintenance: a red "maintenance is ON" bar with
 *    a way back to the maintenance screen, so nobody forgets users are locked out.
 */
export function AppControlBars() {
  const { control, config } = useAppControl();
  const choices = useControlChoices();
  const insets = useSafeAreaInsets();
  const segments = useSegments() as string[];
  if (HIDDEN_ON.has(segments[0])) return null;

  if (control.maintenance.bypassed) {
    return (
      <View style={[styles.wrap, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
        <View style={[styles.bar, { backgroundColor: '#DC2626' }]}>
          <Ionicons name="construct-outline" size={16} color="#FFF" />
          <Text style={styles.text} numberOfLines={2}>MAINTENANCE ON — users ko app band dikh raha hai (staff view)</Text>
          <TouchableOpacity onPress={() => setStaffBypass(false)} accessibilityRole="button" style={styles.pill}>
            <Text style={styles.pillText}>Exit</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const up = control.maintenance.upcoming;
  if (up && choices.dismissedUpcomingAt !== up.startAt) {
    const start = dayjs(up.startAt);
    const sameDay = start.isSame(dayjs(serverNow(config)), 'day');
    const when = `${sameDay ? 'Aaj' : start.format('D MMM')} ${start.format('h:mm A')}`;
    const length = formatCountdown(up.endAt - up.startAt);
    return (
      <View style={[styles.wrap, { paddingTop: insets.top + 6 }]} pointerEvents="box-none">
        <View style={[styles.bar, { backgroundColor: '#B45309' }]} accessibilityRole="alert">
          <Ionicons name="time-outline" size={16} color="#FFF" />
          <Text style={styles.text} numberOfLines={3}>
            {when} se {length} ke liye maintenance{up.notice ? ` — ${up.notice}` : ''}
          </Text>
          <TouchableOpacity
            onPress={() => dismissUpcomingMaintenance(up.startAt)}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityRole="button"
            accessibilityLabel="Dismiss maintenance notice"
          >
            <CloseIcon size={16} color="#FFF" />
          </TouchableOpacity>
        </View>
      </View>
    );
  }
  return null;
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1001, paddingHorizontal: 12 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingVertical: 8, paddingHorizontal: 12, elevation: 6 },
  text: { flex: 1, color: '#FFF', fontFamily: 'Urbanist-SemiBold', fontSize: 12.5, lineHeight: 17 },
  pill: { backgroundColor: 'rgba(255,255,255,0.22)', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3 },
  pillText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 12 },
});

export default AppControlBars;
