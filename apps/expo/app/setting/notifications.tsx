import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';


import { Ionicons } from '@/src/lib/icons';
import { BackButton } from '@/src/components/ui/BackButton';
import { Colors } from '@/constants/theme';
import {
  notificationService,
  type NotificationPrefs,
} from '@/src/services/notifications/notificationService';
import {
  NOTIFICATION_CATEGORIES,
  type NotificationCategory,
} from '@/src/services/notifications/notificationMeta';
import { useToast } from '@/src/components/toast/ToastProvider';

/**
 * Notification preferences.
 *
 * Until now the app had no notification settings at all — ~40 notification types
 * fired with no way to opt out, which is both a UX problem and something app
 * store reviews flag.
 *
 * Important behaviour to keep in mind when editing this screen: these toggles
 * only stop the OS **push**. The in-app notifications list still receives
 * everything, so turning a category off never leaves a gap in the user's history
 * (and nobody misses a payout confirmation because they muted notifications).
 * The copy below says so explicitly.
 */

/** Quiet-hours presets, kept simple rather than shipping a full time picker. */
const QUIET_PRESETS: { label: string; start: number | null; end: number | null }[] = [
  { label: 'Off', start: null, end: null },
  { label: '10pm – 7am', start: 22, end: 7 },
  { label: '11pm – 8am', start: 23, end: 8 },
  { label: 'Midnight – 6am', start: 0, end: 6 },
];

function formatHour(h: number): string {
  const suffix = h < 12 ? 'am' : 'pm';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${suffix}`;
}

export default function NotificationSettingsScreen() {

  const isDark = useColorScheme() === 'dark';
  const { addToast } = useToast();

  const textColor = isDark ? '#fff' : '#212121';
  const subTextColor = isDark ? '#9E9E9E' : '#616161';
  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const cardColor = isDark ? '#1F222A' : '#F7F7F9';
  const borderColor = isDark ? '#35383F' : '#EEEEEE';

  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);
  const [loading, setLoading] = useState(true);
  /** Keys currently in flight, so only the touched row shows a pending state. */
  const [saving, setSaving] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await notificationService.getPreferences();
        if (!cancelled) setPrefs(p);
      } catch {
        if (!cancelled) addToast('Could not load notification settings.', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addToast]);

  /**
   * Optimistically apply the patch, then reconcile with whatever the server
   * returns. On failure the previous value is restored, so the switch can never
   * be left showing a state that was not actually saved.
   */
  const patch = useCallback(
    async (key: string, next: Partial<NotificationPrefs>) => {
      if (!prefs) return;
      const previous = prefs;
      setPrefs({ ...prefs, ...next });
      setSaving((s) => new Set(s).add(key));
      try {
        const saved = await notificationService.updatePreferences(next);
        setPrefs(saved);
      } catch {
        setPrefs(previous);
        addToast('Could not save that change.', 'error');
      } finally {
        setSaving((s) => {
          const copy = new Set(s);
          copy.delete(key);
          return copy;
        });
      }
    },
    [prefs, addToast],
  );

  const renderHeader = () => (
    <View style={[styles.header, { borderBottomColor: borderColor }]}>
      <BackButton size={24} color={textColor} style={styles.backBtn} />
      <Text style={[styles.headerTitle, { color: textColor }]}>Notifications</Text>
    </View>
  );

  if (loading) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        {renderHeader()}
        <View style={styles.center}>
          <ActivityIndicator color="#FF4D67" />
        </View>
      </SafeAreaView>
    );
  }

  if (!prefs) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor }]}>
        {renderHeader()}
        <View style={styles.center}>
          <Text style={{ color: subTextColor }}>Settings unavailable right now.</Text>
        </View>
      </SafeAreaView>
    );
  }

  const pushOff = !prefs.push;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {renderHeader()}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Master switch */}
        <View style={[styles.card, { backgroundColor: cardColor }]}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={[styles.rowTitle, { color: textColor }]}>Push notifications</Text>
              <Text style={[styles.rowDesc, { color: subTextColor }]}>
                Turn off to stop all push alerts on this account
              </Text>
            </View>
            <Switch
              value={prefs.push}
              disabled={saving.has('push')}
              onValueChange={(v) => patch('push', { push: v })}
              trackColor={{ false: '#767577', true: '#FF4D67' }}
              thumbColor="#FFFFFF"
            />
          </View>
        </View>

        <Text style={[styles.note, { color: subTextColor }]}>
          These settings only affect push alerts. Everything still appears in your
          notifications list, so you will not miss anything.
        </Text>

        {/* Per-category */}
        <Text style={[styles.sectionTitle, { color: textColor }]}>What to notify me about</Text>
        <View style={[styles.card, { backgroundColor: cardColor, opacity: pushOff ? 0.5 : 1 }]}>
          {NOTIFICATION_CATEGORIES.map((cat, index) => (
            <View
              key={cat.key}
              style={[
                styles.row,
                index < NOTIFICATION_CATEGORIES.length - 1 && {
                  borderBottomWidth: StyleSheet.hairlineWidth,
                  borderBottomColor: borderColor,
                },
              ]}
            >
              <Ionicons name={cat.icon as any} size={22} color={textColor} style={styles.rowIcon} />
              <View style={styles.rowText}>
                <Text style={[styles.rowTitle, { color: textColor }]}>{cat.title}</Text>
                <Text style={[styles.rowDesc, { color: subTextColor }]}>{cat.description}</Text>
              </View>
              <Switch
                value={prefs[cat.key as NotificationCategory]}
                // Disabled while the master switch is off — leaving these
                // tappable would imply they do something when they cannot.
                disabled={pushOff || saving.has(cat.key)}
                onValueChange={(v) => patch(cat.key, { [cat.key]: v } as Partial<NotificationPrefs>)}
                trackColor={{ false: '#767577', true: '#FF4D67' }}
                thumbColor="#FFFFFF"
              />
            </View>
          ))}
        </View>

        {/* Quiet hours */}
        <Text style={[styles.sectionTitle, { color: textColor }]}>Quiet hours</Text>
        <Text style={[styles.note, { color: subTextColor }]}>
          No push alerts during this window, in your local time.
        </Text>
        <View style={[styles.card, { backgroundColor: cardColor, opacity: pushOff ? 0.5 : 1 }]}>
          {QUIET_PRESETS.map((preset, index) => {
            const active = prefs.quietStart === preset.start && prefs.quietEnd === preset.end;
            return (
              <TouchableOpacity
                key={preset.label}
                disabled={pushOff || saving.has('quiet')}
                onPress={() => patch('quiet', { quietStart: preset.start, quietEnd: preset.end })}
                style={[
                  styles.row,
                  index < QUIET_PRESETS.length - 1 && {
                    borderBottomWidth: StyleSheet.hairlineWidth,
                    borderBottomColor: borderColor,
                  },
                ]}
              >
                <View style={styles.rowText}>
                  <Text style={[styles.rowTitle, { color: textColor }]}>{preset.label}</Text>
                </View>
                {active && <Ionicons name="checkmark" size={22} color="#FF4D67" />}
              </TouchableOpacity>
            );
          })}
        </View>

        {prefs.quietStart !== null && prefs.quietEnd !== null && (
          <Text style={[styles.note, { color: subTextColor }]}>
            Currently quiet from {formatHour(prefs.quietStart)} to {formatHour(prefs.quietEnd)}.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  backBtn: { padding: 4, marginRight: 4 },
  headerTitle: { fontSize: 20, fontFamily: 'Urbanist-Bold' },
  content: { padding: 16, paddingBottom: 40 },
  sectionTitle: {
    fontSize: 15,
    fontFamily: 'Urbanist-Bold',
    marginTop: 24,
    marginBottom: 10,
  },
  card: { borderRadius: 14, overflow: 'hidden' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  rowIcon: { width: 24, textAlign: 'center' },
  rowText: { flex: 1 },
  rowTitle: { fontSize: 15, fontFamily: 'Urbanist-SemiBold' },
  rowDesc: { fontSize: 12, fontFamily: 'Urbanist-Regular', marginTop: 2 },
  note: {
    fontSize: 12,
    fontFamily: 'Urbanist-Regular',
    marginTop: 10,
    lineHeight: 17,
  },
});
