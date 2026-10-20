import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { SplashVisual } from '@/src/components/system/SplashVisual';

/**
 * First paint while Firebase restores persistence.
 *
 * Uses the canonical OLD splash visual — not a separate “session restore” screen —
 * so the Instagram-style auth gate fixes guest flicker without changing the
 * design the user already knows. Only the rare 15s recovery state adds controls.
 */
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
  const sub = dark ? '#A0A0A0' : '#666';

  if (!failed) return <SplashVisual />;

  return (
    <SplashVisual
      loading={false}
      footer={
        <View style={styles.actions}>
          <Text style={[styles.message, { color: sub }]}>Saved session restore nahi ho paya.</Text>
          <TouchableOpacity style={styles.primary} onPress={onRetry} accessibilityRole="button">
            <Text style={styles.primaryText}>Retry</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.secondary} onPress={onContinue} accessibilityRole="button">
            <Text style={[styles.secondaryText, { color: sub }]}>Continue as guest</Text>
          </TouchableOpacity>
          <Text style={[styles.note, { color: sub }]}>Aapka saved login delete nahi kiya gaya.</Text>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  actions: { width: '100%', maxWidth: 320, alignItems: 'center' },
  message: { fontFamily: 'Urbanist-Medium', fontSize: 13, textAlign: 'center', marginBottom: 12 },
  primary: { width: '100%', height: 46, borderRadius: 23, backgroundColor: '#FF4D67', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#FFF', fontFamily: 'Urbanist-Bold', fontSize: 16 },
  secondary: { height: 42, alignItems: 'center', justifyContent: 'center', marginTop: 6, paddingHorizontal: 16 },
  secondaryText: { fontFamily: 'Urbanist-SemiBold', fontSize: 14 },
  note: { fontFamily: 'Urbanist-Regular', fontSize: 11, textAlign: 'center', marginTop: 2 },
});
