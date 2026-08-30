import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
  Linking,
  Platform,
} from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@/src/lib/icons';
import { useAppConfig, currentAppVersion } from '@/src/services/appSettings';
import { PHONE_MAX_WIDTH } from '@/src/lib/layout';

export default function ForceUpdateScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { config } = useAppConfig();

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? '#FFFFFF' : '#212121';

  // Store links. `config.updateUrl` (admin panel → App Control) wins, and is the
  // only way to get a working iOS link until the App Store listing exists — the
  // fallback below is the store home page, not this app.
  //
  // The Android package MUST match app.json → android.package. It previously read
  // `com.tophunt.app`, which is not this app's id, so the one button on the
  // force-update screen opened a Play Store "item not found" page — for users who
  // by definition cannot use the app until they update.
  const openStore = () => {
    const url =
      config?.updateUrl ||
      (Platform.OS === 'ios'
        ? 'https://apps.apple.com/'
        : 'https://play.google.com/store/apps/details?id=in.tophunt.app');
    Linking.openURL(url).catch(() => {});
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      {/*
        Scrollable, because this screen is a hard gate: the user cannot use the app
        until they press Update. On a short window the centred content overflowed
        and the button was clipped off the bottom with nothing to scroll — leaving
        no way forward at all.
      */}
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.iconContainer}>
          <Ionicons name="rocket-outline" size={100} color="#7C3AED" />
        </View>

        <Text style={[styles.title, { color: textColor }]}>Update Required</Text>

        <Text style={[styles.description, { color: isDark ? '#BDBDBD' : '#616161' }]}>
          A newer version of the app is available. Please update to continue enjoying TopHunt.
        </Text>

        <View style={styles.infoCard}>
          <Text style={styles.infoText}>
            Your version: {currentAppVersion()}
            {config?.minAppVersion ? `  •  Required: ${config.minAppVersion}` : ''}
          </Text>
        </View>

        <TouchableOpacity style={styles.updateButton} onPress={openStore}>
          <Ionicons name="download-outline" size={20} color="#FFF" />
          <Text style={styles.updateText}>Update Now</Text>
        </TouchableOpacity>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  // flexGrow, not flex — inside a ScrollView `flex: 1` sets `flex-basis: 0`,
  // collapsing the content box back to the viewport and re-clipping the content.
  content: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30, paddingVertical: 24, width: '100%', maxWidth: PHONE_MAX_WIDTH, alignSelf: 'center' },
  iconContainer: { marginBottom: 30, backgroundColor: '#7C3AED15', padding: 30, borderRadius: 100 },
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginBottom: 16, textAlign: 'center' },
  description: { fontSize: 16, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 24, marginBottom: 30 },
  infoCard: { backgroundColor: '#7C3AED10', padding: 16, borderRadius: 15, borderWidth: 1, borderColor: '#7C3AED30', width: '100%', marginBottom: 30 },
  infoText: { color: '#7C3AED', fontFamily: 'Urbanist-Medium', textAlign: 'center', fontSize: 14 },
  updateButton: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 36, borderRadius: 100, backgroundColor: '#7C3AED' },
  updateText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16, marginLeft: 6 },
});
