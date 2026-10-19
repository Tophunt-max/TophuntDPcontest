import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@/src/lib/icons';
import { APP_CONFIG_QUERY_KEY } from '@/src/services/appSettings';
import { useAppControl, useViewer } from '@/src/hooks/useAppControl';
import { setStaffBypass } from '@/src/lib/controlStore';
import { formatCountdown, serverNow } from '@/src/lib/appControl';
import { PHONE_MAX_WIDTH } from '@/src/lib/layout';

/**
 * Shown while App Control's maintenance is on (manual or scheduled). Leaves by
 * itself the moment it ends — pushed live, or at the scheduled minute.
 *
 *  - "Check Again" really checks (it used to do nothing);
 *  - a countdown when the admin set an end / expected-back time;
 *  - staff (admin / moderator) can enter the app anyway, and sign in from here.
 */
export default function MaintenanceScreen() {
  const isDark = useColorScheme() === 'dark';
  const router = useRouter();
  const queryClient = useQueryClient();
  const { control, config } = useAppControl();
  const viewer = useViewer();
  const [checking, setChecking] = useState(false);
  const [, setTick] = useState(0);

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? '#FFFFFF' : '#212121';
  const sub = isDark ? '#BDBDBD' : '#616161';
  const m = control.maintenance;
  const left = m.endsAt ? m.endsAt - serverNow(config) : null;

  // Countdown refresh, once a minute is enough for "~25 min".
  useEffect(() => {
    if (!m.endsAt) return;
    const t = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [m.endsAt]);

  const checkAgain = async () => {
    setChecking(true);
    try {
      await queryClient.refetchQueries({ queryKey: APP_CONFIG_QUERY_KEY });
    } finally {
      setChecking(false);
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {/* Scrollable: the admin-written message can be any length. */}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.iconContainer}>
          <Ionicons name="construct-outline" size={90} color="#FF4D67" />
        </View>

        <Text style={[styles.title, { color: textColor }]}>Under Maintenance</Text>

        <Text style={[styles.description, { color: sub }]}>
          {m.message.trim() || 'Hum TopHunt ko behtar bana rahe hain. Thodi der mein wapas aate hain!'}
        </Text>

        <View style={styles.infoCard}>
          {left !== null && left > 0 ? (
            <>
              <Text style={styles.infoLabel}>Wapas aane mein lagbhag</Text>
              <Text style={styles.countdown}>{formatCountdown(left)}</Text>
            </>
          ) : (
            <Text style={styles.infoText}>Maintenance khatam hote hi app apne aap khul jaayega.</Text>
          )}
        </View>

        <TouchableOpacity style={styles.refreshButton} onPress={checkAgain} disabled={checking} accessibilityRole="button">
          {checking ? <ActivityIndicator color="#FFF" /> : <Text style={styles.refreshText}>Check Again</Text>}
        </TouchableOpacity>

        {viewer.isStaff ? (
          <TouchableOpacity
            style={[styles.secondary, { borderColor: isDark ? '#35383F' : '#E5E7EB' }]}
            onPress={() => {
              setStaffBypass(true);
              router.replace('/');
            }}
            accessibilityRole="button"
          >
            <Text style={[styles.secondaryText, { color: textColor }]}>Admin: app mein jao</Text>
          </TouchableOpacity>
        ) : !viewer.signedIn ? (
          <TouchableOpacity onPress={() => router.push('/auth/login' as any)} accessibilityRole="button" style={styles.link}>
            <Text style={[styles.linkText, { color: sub }]}>Staff login</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // flexGrow, not flex: inside a ScrollView `flex: 1` collapses the content box.
  content: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 30,
    paddingVertical: 24,
    width: '100%',
    maxWidth: PHONE_MAX_WIDTH,
    alignSelf: 'center',
  },
  iconContainer: { marginBottom: 26, backgroundColor: '#FF4D6715', padding: 28, borderRadius: 100 },
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginBottom: 14, textAlign: 'center' },
  description: { fontSize: 16, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 24, marginBottom: 24 },
  infoCard: {
    backgroundColor: '#FF4D6710',
    padding: 18,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: '#FF4D6730',
    width: '100%',
    alignItems: 'center',
  },
  infoLabel: { color: '#FF4D67', fontFamily: 'Urbanist-Medium', fontSize: 13 },
  countdown: { color: '#FF4D67', fontFamily: 'Urbanist-Bold', fontSize: 26, marginTop: 4 },
  infoText: { color: '#FF4D67', fontFamily: 'Urbanist-Medium', textAlign: 'center', fontSize: 14 },
  refreshButton: {
    marginTop: 32,
    minWidth: 170,
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 30,
    borderRadius: 100,
    backgroundColor: '#FF4D67',
  },
  refreshText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  secondary: { marginTop: 14, borderWidth: 1, borderRadius: 100, paddingVertical: 10, paddingHorizontal: 24 },
  secondaryText: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
  link: { marginTop: 18, padding: 6 },
  linkText: { fontFamily: 'Urbanist-Medium', fontSize: 13, textDecorationLine: 'underline' },
});
