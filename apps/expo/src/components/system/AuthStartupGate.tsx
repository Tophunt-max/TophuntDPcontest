import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Image } from 'expo-image';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { Colors } from '@/constants/theme';

/** Stable first paint while Firebase restores persistence; no guest controls. */
export function AuthStartupGate({
  failed = false,
  onRetry,
  onContinue,
}: {
  failed?: boolean;
  onRetry?: () => void;
  onContinue?: () => void;
}) {
  const dark = useColorScheme() === 'dark';
  const bg = dark ? Colors.dark.background : Colors.light.background;
  const text = dark ? '#FFF' : '#212121';
  const sub = dark ? '#A0A0A0' : '#666';
  return (
    <View style={[styles.root, { backgroundColor: bg }]} accessibilityState={{ busy: !failed }}>
      <Image source={require('../../../assets/images/splesh.png')} style={styles.logo} contentFit="contain" />
      <Text style={[styles.name, { color: text }]}>TopHunt</Text>
      <Text style={[styles.tagline, { color: sub }]}>{failed ? 'Saved session restore nahi ho paya.' : 'Aapka session restore ho raha hai…'}</Text>
      {failed ? (
        <View style={styles.actions}>
          <TouchableOpacity style={styles.primary} onPress={onRetry} accessibilityRole="button">
            <Text style={styles.primaryText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={onContinue} accessibilityRole="button">
            <Text style={[styles.secondaryText, { color: sub }]}>Continue as guest</Text>
          </TouchableOpacity>
          <Text style={[styles.note, { color: sub }]}>Aapka saved login delete nahi kiya gaya.</Text>
        </View>
      ) : (
        <ActivityIndicator color="#FF4D67" style={{ marginTop: 24 }} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28 },
  logo: { width: 112, height: 112 },
  name: { fontFamily: 'Urbanist-Bold', fontSize: 34, marginTop: 18 },
  tagline: { fontFamily: 'Urbanist-Medium', fontSize: 14, marginTop: 8, textAlign: 'center' },
  actions: { width: '100%', maxWidth: 320, marginTop: 24 },
  primary: { height: 48, borderRadius: 24, backgroundColor: '#FF4D67', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  secondary: { height: 44, alignItems: 'center', justifyContent: 'center', marginTop: 8 },
  secondaryText: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
  note: { fontFamily: 'Urbanist-Regular', fontSize: 11, textAlign: 'center', marginTop: 8 },
});
