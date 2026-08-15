import React from 'react';
import { View, Text, StyleSheet, SafeAreaView, useColorScheme, TouchableOpacity, Linking, Platform } from 'react-native';
import { Colors } from '@/constants/theme';
import { Ionicons } from '@expo/vector-icons';
import { useAppConfig, currentAppVersion } from '@/src/services/appSettings';

export default function ForceUpdateScreen() {
  const colorScheme = useColorScheme();
  const isDark = colorScheme === 'dark';
  const { config } = useAppConfig();

  const backgroundColor = isDark ? Colors.dark.background : Colors.light.background;
  const textColor = isDark ? '#FFFFFF' : '#212121';

  const openStore = () => {
    const url =
      config?.updateUrl ||
      (Platform.OS === 'ios'
        ? 'https://apps.apple.com/'
        : 'https://play.google.com/store/apps/details?id=com.tophunt.app');
    Linking.openURL(url).catch(() => {});
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor }]}>
      <View style={styles.content}>
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
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 30 },
  iconContainer: { marginBottom: 30, backgroundColor: '#7C3AED15', padding: 30, borderRadius: 100 },
  title: { fontSize: 28, fontFamily: 'Urbanist-Bold', marginBottom: 16, textAlign: 'center' },
  description: { fontSize: 16, fontFamily: 'Urbanist-Regular', textAlign: 'center', lineHeight: 24, marginBottom: 30 },
  infoCard: { backgroundColor: '#7C3AED10', padding: 16, borderRadius: 15, borderWidth: 1, borderColor: '#7C3AED30', width: '100%', marginBottom: 30 },
  infoText: { color: '#7C3AED', fontFamily: 'Urbanist-Medium', textAlign: 'center', fontSize: 14 },
  updateButton: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 36, borderRadius: 100, backgroundColor: '#7C3AED' },
  updateText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16, marginLeft: 6 },
});
