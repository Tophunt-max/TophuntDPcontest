import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@/src/lib/icons';
import { currentAppVersion } from '@/src/services/appSettings';
import { useAppControl } from '@/src/hooks/useAppControl';
import { snoozeUpdate } from '@/src/lib/controlStore';
import { PHONE_MAX_WIDTH } from '@/src/lib/layout';

/**
 * App Control → Force Update. Native only (the web build is always current).
 *
 *  - HARD: the user cannot continue until they update (the server also refuses
 *    this build's writes).
 *  - SOFT: "Baad mein" snoozes it for 24h for this minimum version.
 * The store link is the admin's (per platform), else this app's Play listing.
 */
export default function ForceUpdateScreen() {
  const isDark = useColorScheme() === 'dark';
  const router = useRouter();
  const { control } = useAppControl();
  const u = control.update;
  const soft = u.required === 'soft';

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? '#FFFFFF' : '#212121';

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {/* Scrollable: on a short window the button must never be clipped off. */}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.iconContainer}>
          <Ionicons name="rocket-outline" size={90} color="#7C3AED" />
        </View>

        <Text style={[styles.title, { color: textColor }]}>{soft ? 'Naya update aa gaya!' : 'Update Required'}</Text>

        <Text style={[styles.description, { color: isDark ? '#BDBDBD' : '#616161' }]}>
          {u.message.trim() ||
            (soft
              ? 'TopHunt ka naya version available hai — naye features aur fixes ke saath.'
              : 'TopHunt ka naya version zaroori hai. Aage badhne ke liye app update karo.')}
        </Text>

        <View style={styles.infoCard}>
          <Text style={styles.infoText}>
            Aapka version: {currentAppVersion()}
            {u.minVersion ? `  •  Zaroori: ${u.minVersion}` : ''}
          </Text>
        </View>

        <TouchableOpacity style={styles.updateButton} onPress={() => Linking.openURL(u.url).catch(() => {})} accessibilityRole="button">
          <Ionicons name="download-outline" size={20} color="#FFF" />
          <Text style={styles.updateText}>Update Now</Text>
        </TouchableOpacity>

        {soft ? (
          <TouchableOpacity
            style={styles.later}
            onPress={() => {
              snoozeUpdate(u.minVersion);
              router.replace('/');
            }}
            accessibilityRole="button"
          >
            <Text style={[styles.laterText, { color: isDark ? '#BDBDBD' : '#616161' }]}>Baad mein</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30, paddingVertical: 24, width: '100%', maxWidth: PHONE_MAX_WIDTH, alignSelf: 'center' },
  iconContainer: { marginBottom: 28, backgroundColor: '#7C3AED15', padding: 28, borderRadius: 100 },
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginBottom: 14, textAlign: 'center' },
  description: { fontSize: 16, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 24, marginBottom: 26 },
  infoCard: { backgroundColor: '#7C3AED10', padding: 16, borderRadius: 15, borderWidth: 1, borderColor: '#7C3AED30', width: '100%', marginBottom: 28 },
  infoText: { color: '#7C3AED', fontFamily: 'Urbanist-Medium', textAlign: 'center', fontSize: 14 },
  updateButton: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 36, borderRadius: 100, backgroundColor: '#7C3AED' },
  updateText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16, marginLeft: 6 },
  later: { marginTop: 16, padding: 8 },
  laterText: { fontFamily: 'Urbanist-SemiBold', fontSize: 15 },
});
